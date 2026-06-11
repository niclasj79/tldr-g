"""Checkpoint/resume helpers for long-running ingestion jobs."""

from __future__ import annotations

import hashlib
import sqlite3
import time
from pathlib import Path
from typing import Any

from tp_vrg.data_dir import ensure_data_dir_layout, get_data_dir, get_graph_db_path


INGESTION_RUNNING = "running"
INGESTION_PAUSED = "paused"
INGESTION_COMPLETED = "completed"
INGESTION_FAILED = "failed"


def _now_ts() -> int:
    return int(time.time())


def _db_path() -> Path:
    data_dir = get_data_dir()
    ensure_data_dir_layout(data_dir)
    return get_graph_db_path(data_dir)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()))
    conn.row_factory = sqlite3.Row
    return conn


def make_chatgpt_source_id(source_path: str) -> str:
    return str(Path(source_path).expanduser())


def make_file_source_id(source_path: str | Path, content: bytes) -> str:
    path_str = str(Path(source_path).expanduser())
    short_hash = hashlib.sha256(content).hexdigest()[:12]
    return f"{path_str}:{short_hash}"


def start_source(
    source_path: str,
    source_type: str,
    *,
    source_id: str | None = None,
    total_units: int | None = None,
) -> str:
    sid = source_id or str(Path(source_path).expanduser())
    now = _now_ts()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO ingestion_progress (
                source_id, source_path, source_type, total_units,
                completed_units, last_completed_unit_id,
                started_at, last_updated_at, completed_at, status, error_detail
            ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?, NULL, ?, NULL)
            ON CONFLICT(source_id) DO UPDATE SET
                source_path=excluded.source_path,
                source_type=excluded.source_type,
                total_units=COALESCE(excluded.total_units, ingestion_progress.total_units),
                last_updated_at=excluded.last_updated_at,
                status=CASE
                    WHEN ingestion_progress.status = ? THEN ingestion_progress.status
                    ELSE ?
                END,
                error_detail=NULL
            """,
            (
                sid,
                str(Path(source_path).expanduser()),
                source_type,
                total_units,
                now,
                now,
                INGESTION_RUNNING,
                INGESTION_COMPLETED,
                INGESTION_RUNNING,
            ),
        )
        conn.commit()
    return sid


def get_resume_point(source_id: str) -> str | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT last_completed_unit_id FROM ingestion_progress WHERE source_id = ?",
            (source_id,),
        ).fetchone()
    if row is None:
        return None
    return row["last_completed_unit_id"]


def mark_unit_complete(source_id: str, unit_id: str) -> None:
    now = _now_ts()
    with _connect() as conn:
        conn.execute(
            """
            UPDATE ingestion_progress
            SET
                completed_units = completed_units + 1,
                last_completed_unit_id = ?,
                last_updated_at = ?,
                status = ?
            WHERE source_id = ?
            """,
            (unit_id, now, INGESTION_RUNNING, source_id),
        )
        conn.commit()


def mark_source_complete(source_id: str) -> None:
    now = _now_ts()
    with _connect() as conn:
        conn.execute(
            """
            UPDATE ingestion_progress
            SET status = ?, completed_at = ?, last_updated_at = ?
            WHERE source_id = ?
            """,
            (INGESTION_COMPLETED, now, now, source_id),
        )
        conn.commit()


def mark_source_failed(source_id: str, error: str) -> None:
    now = _now_ts()
    with _connect() as conn:
        conn.execute(
            """
            UPDATE ingestion_progress
            SET status = ?, error_detail = ?, last_updated_at = ?
            WHERE source_id = ?
            """,
            (INGESTION_FAILED, error[:2000], now, source_id),
        )
        conn.commit()


def is_unit_already_processed(source_id: str, unit_id: str) -> bool:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT 1
            FROM ingestion_progress
            WHERE source_id = ?
              AND status IN (?, ?)
              AND last_completed_unit_id = ?
            """,
            (source_id, INGESTION_RUNNING, INGESTION_COMPLETED, unit_id),
        ).fetchone()
    return row is not None


def list_active_sources() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT
                source_id,
                source_path,
                source_type,
                total_units,
                completed_units,
                last_completed_unit_id,
                started_at,
                last_updated_at,
                completed_at,
                status,
                error_detail
            FROM ingestion_progress
            ORDER BY last_updated_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def _table_exists(conn: sqlite3.Connection) -> bool:
    """Return True if the ingestion_progress table exists (i.e., item 1's
    migration has run against this DB). False on fresh graphs that haven't
    had the engine initialize yet — CLI commands like --list-resumable
    should handle this gracefully instead of surfacing a SQL error."""
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ingestion_progress'"
    ).fetchone()
    return row is not None


def get_source(source_id: str) -> dict[str, Any] | None:
    """Fetch a single source row by source_id, or None if not found.

    Returns None on fresh graphs where the table hasn't been created yet
    (engine init applies the schema migration — pure-CLI flows like --resume
    may run before the engine initializes)."""
    with _connect() as conn:
        if not _table_exists(conn):
            return None
        row = conn.execute(
            """
            SELECT
                source_id,
                source_path,
                source_type,
                total_units,
                completed_units,
                last_completed_unit_id,
                started_at,
                last_updated_at,
                completed_at,
                status,
                error_detail
            FROM ingestion_progress
            WHERE source_id = ?
            """,
            (source_id,),
        ).fetchone()
    return dict(row) if row is not None else None


def list_resumable_sources() -> list[dict[str, Any]]:
    """All non-completed sources, newest-updated first.

    Used by the `--list-resumable` CLI flag. Completed sources are excluded
    because they have no resume point to continue from (use `--fresh` if
    you want to re-ingest from scratch). Returns [] on fresh graphs where
    the table hasn't been created yet.
    """
    with _connect() as conn:
        if not _table_exists(conn):
            return []
        rows = conn.execute(
            """
            SELECT
                source_id,
                source_path,
                source_type,
                total_units,
                completed_units,
                last_completed_unit_id,
                started_at,
                last_updated_at,
                completed_at,
                status,
                error_detail
            FROM ingestion_progress
            WHERE status != ?
            ORDER BY last_updated_at DESC
            """,
            (INGESTION_COMPLETED,),
        ).fetchall()
    return [dict(row) for row in rows]


def fast_hash_file(path: str | Path, *, sample_bytes: int = 1_000_000) -> str:
    """Fast file fingerprint: sha256 of (first 1MB, file size).

    Safe for detecting most content changes — a content-prepend shifts
    everything in the first 1MB and a size change yields a different hash.
    Avoids the multi-second full-file hash on large inputs like 169MB
    ChatGPT exports.

    Returns a 16-char hex digest. Raises FileNotFoundError if the path
    doesn't exist.
    """
    p = Path(path).expanduser()
    if not p.is_file():
        raise FileNotFoundError(f"Not a file: {p}")
    size = p.stat().st_size
    sha = hashlib.sha256()
    with p.open("rb") as fh:
        sha.update(fh.read(sample_bytes))
    sha.update(str(size).encode("utf-8"))
    return sha.hexdigest()[:16]
