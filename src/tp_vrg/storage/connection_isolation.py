"""Dedicated SQLite connection helpers for latency-sensitive read paths."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
import sqlite3


DEFAULT_BUSY_TIMEOUT_SECONDS = 5.0


def _read_only_uri(path: Path) -> str:
    return f"{path.resolve().as_uri()}?mode=ro"


@contextmanager
def isolated_sqlite_connection(
    path: str | Path,
    *,
    read_only: bool = True,
    timeout_seconds: float = DEFAULT_BUSY_TIMEOUT_SECONDS,
    load_vec: bool = False,
) -> Iterator[sqlite3.Connection]:
    """Open a short-lived SQLite connection outside the engine connection.

    Use this for Cockpit/status/health reads that must not queue behind long
    graph work running on ``SQLiteBackend._conn``. Callers own transaction
    scope by using the connection inside the context manager only.
    """
    db_path = Path(path)
    if read_only and not db_path.exists():
        raise FileNotFoundError(db_path)

    if read_only:
        conn = sqlite3.connect(
            _read_only_uri(db_path),
            uri=True,
            timeout=timeout_seconds,
            check_same_thread=False,
        )
    else:
        conn = sqlite3.connect(
            str(db_path),
            timeout=timeout_seconds,
            check_same_thread=False,
        )

    try:
        conn.execute(f"PRAGMA busy_timeout={int(timeout_seconds * 1000)}")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA temp_store=MEMORY")
        if read_only:
            conn.execute("PRAGMA query_only=ON")
        else:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")

        if load_vec:
            import sqlite_vec

            conn.enable_load_extension(True)
            try:
                sqlite_vec.load(conn)
            finally:
                conn.enable_load_extension(False)

        yield conn
    finally:
        conn.close()
