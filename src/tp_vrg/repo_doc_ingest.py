"""Repo documentation ingestion Janitor operation.

Phase 2 of passive repo-doc ingestion reuses the Phase 1 detector and the
existing ``ingestion_progress`` table. It intentionally routes changed docs
through ``LODGraphMemory.ingest`` instead of creating a parallel ingest path.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
import os
import sqlite3
from typing import Any, Mapping, Sequence

from tp_vrg import ingestion_progress
from tp_vrg.repo_doc_watch import (
    DEFAULT_ROOTS,
    REPO_DOC_SOURCE_TYPE,
    ChangedDoc,
    detect_changed_repo_docs,
    iter_repo_docs,
    repo_doc_source_id,
    repo_doc_unit_id,
)


REPO_INGEST_TASK = "repo_ingest_new_docs"
TIER3_REPO_INGEST_OP_ID = "T3-REPO-INGEST-NEW-DOCS"
REPO_INGEST_NIGHTLY_ENV = "TPVRG_REPO_INGEST_NIGHTLY"
REPO_INGEST_LAST_AT_KEY = "repo_ingest_last_at"
REPO_DOCS_INGESTED_COUNT_KEY = "repo_docs_ingested_count"

_repo_ingest_lock: asyncio.Lock | None = None


class RepoDocIngestError(RuntimeError):
    """Raised when a repo doc ingest would otherwise silently corrupt freshness."""


def repo_doc_ingest_summary(
    repo_root: Path | str,
    conn: sqlite3.Connection,
    roots: Sequence[str] = DEFAULT_ROOTS,
) -> dict[str, Any]:
    """Return a read-only summary of pending repo-doc ingestion work."""
    root_path = Path(repo_root).expanduser().resolve()
    total_docs = sum(1 for _ in iter_repo_docs(root_path, roots))
    changed = detect_changed_repo_docs(root_path, conn, roots)
    return {
        "ingested": 0,
        "skipped": max(0, total_docs - len(changed)),
        "failed": 0,
        "doc_paths": [],
        "pending": len(changed),
        "pending_doc_paths": [doc.relpath for doc in changed],
    }


async def ingest_changed_repo_docs(
    memory_or_engine: Any,
    repo_root: Path | str,
    roots: Sequence[str] = DEFAULT_ROOTS,
    *,
    mark: bool = True,
    rebake: bool = False,
) -> dict[str, Any]:
    """Ingest changed repo docs through the canonical engine ingest entrypoint.

    ``detect_changed_repo_docs`` owns change detection. ``memory.ingest`` owns
    graph ingestion. ``ingestion_progress`` owns dedup/resume state. This op
    composes those existing surfaces and does not introduce a new tracking table.
    """
    lock = _get_repo_ingest_lock()
    if lock.locked():
        raise RepoDocIngestError("repo-doc ingestion is already running")
    async with lock:
        return await _ingest_changed_repo_docs_locked(
            memory_or_engine,
            repo_root,
            roots,
            mark=mark,
            rebake=rebake,
        )


async def _ingest_changed_repo_docs_locked(
    memory_or_engine: Any,
    repo_root: Path | str,
    roots: Sequence[str],
    *,
    mark: bool,
    rebake: bool,
) -> dict[str, Any]:
    conn = _sqlite_connection_for_memory(memory_or_engine)
    root_path = Path(repo_root).expanduser().resolve()
    total_docs = sum(1 for _ in iter_repo_docs(root_path, roots))
    changed = detect_changed_repo_docs(root_path, conn, roots)
    summary: dict[str, Any] = {
        "ingested": 0,
        "skipped": max(0, total_docs - len(changed)),
        "failed": 0,
        "doc_paths": [],
    }

    failures: list[dict[str, str]] = []
    for doc in changed:
        source_id = repo_doc_source_id(doc.relpath)
        unit_id = repo_doc_unit_id(doc.relpath, doc.sha256)
        try:
            if mark:
                ingestion_progress.start_source(
                    doc.abspath,
                    REPO_DOC_SOURCE_TYPE,
                    source_id=source_id,
                    total_units=1,
                )
            text = Path(doc.abspath).read_text(encoding="utf-8")
            result = await _canonical_ingest(memory_or_engine, text, source=doc.relpath)
            node_count = len(getattr(result, "nodes", []) or [])
            if node_count <= 0:
                raise RepoDocIngestError(
                    f"Repo doc ingest produced 0 nodes: {doc.relpath}"
                )
            if mark:
                ingestion_progress.mark_unit_complete(source_id, unit_id)
                ingestion_progress.mark_source_complete(source_id)
            summary["ingested"] += 1
            summary["doc_paths"].append(doc.relpath)
        except Exception as exc:
            summary["failed"] += 1
            failures.append({"relpath": doc.relpath, "error": str(exc)})
            if mark:
                ingestion_progress.mark_source_failed(source_id, str(exc))
            break

    if failures:
        summary["failures"] = failures
        raise RepoDocIngestError(
            f"repo-doc ingestion failed for {failures[0]['relpath']}: "
            f"{failures[0]['error']}"
        )

    if rebake and summary["ingested"] > 0:
        summary["rebake"] = await _rebake_partitions(memory_or_engine)
    elif rebake:
        summary["rebake"] = "skipped_no_ingested_docs"
    if summary["ingested"] > 0:
        summary["watermark"] = record_repo_ingest_watermark(
            conn,
            ingested_count=int(summary["ingested"]),
        )
    return summary


async def _canonical_ingest(memory_or_engine: Any, text: str, *, source: str) -> Any:
    ingest = getattr(memory_or_engine, "ingest", None)
    if ingest is None:
        raise TypeError("repo-doc ingest requires a memory/engine object with ingest(...)")
    return await ingest(text, source=source, suppress_backbone=True)


def _sqlite_connection_for_memory(memory_or_engine: Any) -> sqlite3.Connection:
    storage = getattr(memory_or_engine, "_storage", None)
    if storage is None:
        storage = getattr(memory_or_engine, "storage", None)
    conn = getattr(storage, "conn", None)
    if conn is None:
        conn = getattr(storage, "_conn", None)
    if not isinstance(conn, sqlite3.Connection):
        raise RuntimeError("repo-doc ingestion requires SQLite-backed storage")
    return conn


async def _rebake_partitions(memory_or_engine: Any) -> dict[str, object]:
    from tp_vrg.janitor import GraphJanitor

    return await GraphJanitor(memory_or_engine).bake_partitions()


def _get_repo_ingest_lock() -> asyncio.Lock:
    global _repo_ingest_lock
    if _repo_ingest_lock is None:
        _repo_ingest_lock = asyncio.Lock()
    return _repo_ingest_lock


def read_repo_ingest_watermark(conn: sqlite3.Connection) -> dict[str, object]:
    return {
        "repo_ingest_last_at": _meta_value(conn, REPO_INGEST_LAST_AT_KEY),
        "repo_docs_ingested_count": _meta_int(conn, REPO_DOCS_INGESTED_COUNT_KEY),
    }


def record_repo_ingest_watermark(
    conn: sqlite3.Connection,
    *,
    ingested_count: int,
) -> dict[str, object]:
    if ingested_count <= 0:
        return read_repo_ingest_watermark(conn)
    _ensure_meta(conn)
    now = datetime.now(timezone.utc).isoformat()
    total = _meta_int(conn, REPO_DOCS_INGESTED_COUNT_KEY) + ingested_count
    _set_meta_value(conn, REPO_INGEST_LAST_AT_KEY, now)
    _set_meta_value(conn, REPO_DOCS_INGESTED_COUNT_KEY, str(total))
    conn.commit()
    return {
        "repo_ingest_last_at": now,
        "repo_docs_ingested_count": total,
    }


def _ensure_meta(conn: sqlite3.Connection) -> None:
    conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")


def _meta_value(conn: sqlite3.Connection, key: str) -> str | None:
    try:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    except sqlite3.Error:
        return None
    return str(row[0]) if row else None


def _meta_int(conn: sqlite3.Connection, key: str) -> int:
    value = _meta_value(conn, key)
    if value is None or value == "":
        return 0
    try:
        return int(value)
    except ValueError as exc:
        raise RepoDocIngestError(f"Malformed repo-doc ingest watermark {key}: {value}") from exc


def _set_meta_value(conn: sqlite3.Connection, key: str, value: str) -> None:
    _ensure_meta(conn)
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
        (key, value),
    )


def repo_ingest_nightly_enabled(env: Mapping[str, str] | None = None) -> bool:
    env_map = env if env is not None else os.environ
    return _truthy(env_map.get(REPO_INGEST_NIGHTLY_ENV, ""))


def repo_ingest_pre_authorized(
    queue_entry: Mapping[str, object],
    *,
    env: Mapping[str, str] | None = None,
) -> bool:
    pre_authorized = queue_entry.get("pre-authorized")
    if pre_authorized is None:
        pre_authorized = queue_entry.get("pre_authorized")
    return repo_ingest_nightly_enabled(env) and pre_authorized is True


async def run_pre_authorized_repo_ingest(
    memory_or_engine: Any,
    repo_root: Path | str,
    queue_entry: Mapping[str, object],
    roots: Sequence[str] = DEFAULT_ROOTS,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    if not repo_ingest_nightly_enabled(env):
        return {
            "status": "skipped",
            "op_id": TIER3_REPO_INGEST_OP_ID,
            "reason": f"{REPO_INGEST_NIGHTLY_ENV} is not enabled",
        }
    if not repo_ingest_pre_authorized(queue_entry, env=env):
        return {
            "status": "skipped",
            "op_id": TIER3_REPO_INGEST_OP_ID,
            "reason": "queue entry is not pre-authorized",
        }
    summary = await ingest_changed_repo_docs(
        memory_or_engine,
        repo_root,
        roots,
        rebake=True,
    )
    return {"status": "ok", "op_id": TIER3_REPO_INGEST_OP_ID, **summary}


def _truthy(value: object) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


__all__ = [
    "REPO_INGEST_NIGHTLY_ENV",
    "REPO_INGEST_TASK",
    "RepoDocIngestError",
    "REPO_DOCS_INGESTED_COUNT_KEY",
    "REPO_INGEST_LAST_AT_KEY",
    "TIER3_REPO_INGEST_OP_ID",
    "ingest_changed_repo_docs",
    "read_repo_ingest_watermark",
    "record_repo_ingest_watermark",
    "repo_doc_ingest_summary",
    "repo_ingest_nightly_enabled",
    "repo_ingest_pre_authorized",
    "run_pre_authorized_repo_ingest",
]
