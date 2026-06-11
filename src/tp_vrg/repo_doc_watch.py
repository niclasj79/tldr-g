"""Read-only repo documentation change detection.

Phase 1 only: report repo docs whose content hash is not already reflected in
the existing ingestion_progress table. This module does not ingest files and
does not write progress rows.
"""

from __future__ import annotations

import hashlib
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Literal, Sequence

from tp_vrg import ingestion_progress


DEFAULT_ROOTS: tuple[str, ...] = ("docs", ".claude/plans")
DEFAULT_IGNORE_DIRS: frozenset[str] = frozenset(
    {"_archive", "_closed", ".git", "node_modules"}
)
REPO_DOC_SOURCE_TYPE = "repo-doc"
_PROGRESS_TABLE = "ingestion_progress"
_REQUIRED_PROGRESS_COLUMNS = frozenset(
    {
        "source_id",
        "source_path",
        "source_type",
        "total_units",
        "completed_units",
        "last_completed_unit_id",
        "started_at",
        "last_updated_at",
        "completed_at",
        "status",
        "error_detail",
    }
)
_VALID_PROGRESS_STATUSES = frozenset(
    {
        ingestion_progress.INGESTION_RUNNING,
        ingestion_progress.INGESTION_PAUSED,
        ingestion_progress.INGESTION_COMPLETED,
        ingestion_progress.INGESTION_FAILED,
    }
)
_PROCESSED_STATUSES = frozenset(
    {
        ingestion_progress.INGESTION_RUNNING,
        ingestion_progress.INGESTION_COMPLETED,
    }
)


@dataclass(frozen=True)
class ChangedDoc:
    relpath: str
    abspath: str
    sha256: str
    mtime: float
    reason: Literal["new", "changed"]


def repo_doc_source_id(relpath: str) -> str:
    """Stable source identity for a repo doc path."""
    return f"{REPO_DOC_SOURCE_TYPE}:{relpath}"


def repo_doc_unit_id(relpath: str, sha256: str) -> str:
    """Content-version identity stored as last_completed_unit_id."""
    return f"{REPO_DOC_SOURCE_TYPE}:{relpath}:sha256:{sha256}"


def iter_repo_docs(
    repo_root: Path | str,
    roots: Sequence[str] = DEFAULT_ROOTS,
    *,
    ignore_dirs: frozenset[str] | set[str] | tuple[str, ...] = DEFAULT_IGNORE_DIRS,
) -> Iterator[Path]:
    """Yield Markdown docs under configured repo roots in deterministic order."""
    root_path = Path(repo_root).expanduser().resolve()
    if not root_path.exists():
        raise FileNotFoundError(f"Repo root does not exist: {root_path}")
    if not root_path.is_dir():
        raise NotADirectoryError(f"Repo root is not a directory: {root_path}")

    ignored = set(ignore_dirs)
    docs: list[Path] = []
    for root in roots:
        scan_root = root_path / root
        if not scan_root.exists():
            raise FileNotFoundError(f"Repo doc root does not exist: {scan_root}")
        if not scan_root.is_dir():
            raise NotADirectoryError(f"Repo doc root is not a directory: {scan_root}")
        docs.extend(_walk_markdown(scan_root, ignored))

    yield from sorted(docs, key=lambda path: _repo_relpath(root_path, path))


def fingerprint(path: Path | str) -> tuple[str, float]:
    """Return the full sha256 hex digest and mtime for a file."""
    p = Path(path).expanduser()
    if not p.is_file():
        raise FileNotFoundError(f"Repo doc is not a file: {p}")
    content = p.read_bytes()
    return hashlib.sha256(content).hexdigest(), p.stat().st_mtime


def detect_changed_repo_docs(
    repo_root: Path | str,
    conn: sqlite3.Connection,
    roots: Sequence[str] = DEFAULT_ROOTS,
    *,
    ignore_dirs: frozenset[str] | set[str] | tuple[str, ...] = DEFAULT_IGNORE_DIRS,
) -> list[ChangedDoc]:
    """Return new or changed repo docs according to ingestion_progress.

    The source row is keyed by stable repo-relative path. The unit id is keyed
    by full content hash, mirroring the existing progress-table pattern where
    a source has a last completed unit.
    """
    _validate_progress_table(conn)

    root_path = Path(repo_root).expanduser().resolve()
    changed: list[ChangedDoc] = []
    for path in iter_repo_docs(root_path, roots, ignore_dirs=ignore_dirs):
        relpath = _repo_relpath(root_path, path)
        sha256, mtime = fingerprint(path)
        source_id = repo_doc_source_id(relpath)
        unit_id = repo_doc_unit_id(relpath, sha256)
        reason = _change_reason(conn, source_id, unit_id, relpath)
        if reason is None:
            continue
        changed.append(
            ChangedDoc(
                relpath=relpath,
                abspath=str(path),
                sha256=sha256,
                mtime=mtime,
                reason=reason,
            )
        )
    return changed


def _walk_markdown(root: Path, ignored: set[str]) -> Iterator[Path]:
    for child in sorted(root.iterdir(), key=lambda path: path.name.lower()):
        if child.is_dir():
            if child.name in ignored:
                continue
            yield from _walk_markdown(child, ignored)
            continue
        if child.is_file() and child.suffix.lower() == ".md":
            yield child


def _repo_relpath(repo_root: Path, path: Path) -> str:
    return path.relative_to(repo_root).as_posix()


def _validate_progress_table(conn: sqlite3.Connection) -> None:
    rows = conn.execute(f"PRAGMA table_info({_PROGRESS_TABLE})").fetchall()
    columns = {str(row[1]) for row in rows}
    if not columns:
        raise RuntimeError(f"{_PROGRESS_TABLE} table does not exist")
    missing = _REQUIRED_PROGRESS_COLUMNS - columns
    if missing:
        missing_list = ", ".join(sorted(missing))
        raise RuntimeError(f"{_PROGRESS_TABLE} table is missing columns: {missing_list}")


def _change_reason(
    conn: sqlite3.Connection,
    source_id: str,
    unit_id: str,
    relpath: str,
) -> Literal["new", "changed"] | None:
    row = conn.execute(
        """
        SELECT source_id, source_type, last_completed_unit_id, status
        FROM ingestion_progress
        WHERE source_id = ?
        """,
        (source_id,),
    ).fetchone()
    if row is None:
        return "new"

    row_source_id, source_type, last_unit_id, status = row
    if row_source_id != source_id:
        raise RuntimeError(f"Malformed ingestion_progress row for {source_id}: source_id mismatch")
    if source_type != REPO_DOC_SOURCE_TYPE:
        raise RuntimeError(
            f"Malformed ingestion_progress row for {source_id}: expected source_type "
            f"{REPO_DOC_SOURCE_TYPE!r}, got {source_type!r}"
        )
    if status not in _VALID_PROGRESS_STATUSES:
        raise RuntimeError(
            f"Malformed ingestion_progress row for {source_id}: invalid status {status!r}"
        )
    if last_unit_id is not None and not isinstance(last_unit_id, str):
        raise RuntimeError(
            f"Malformed ingestion_progress row for {source_id}: last_completed_unit_id "
            "must be text or NULL"
        )
    expected_prefix = repo_doc_unit_id(relpath, "")
    if last_unit_id is not None and not last_unit_id.startswith(expected_prefix):
        raise RuntimeError(
            f"Malformed ingestion_progress row for {source_id}: last_completed_unit_id "
            "does not match repo-doc unit convention"
        )
    if status in _PROCESSED_STATUSES and last_unit_id == unit_id:
        return None
    return "changed"


__all__ = [
    "ChangedDoc",
    "DEFAULT_IGNORE_DIRS",
    "DEFAULT_ROOTS",
    "detect_changed_repo_docs",
    "fingerprint",
    "iter_repo_docs",
    "repo_doc_source_id",
    "repo_doc_unit_id",
]
