"""Cockpit Inspect counters and snapshot helpers."""

from __future__ import annotations

from pathlib import Path
import sqlite3
import time
from typing import Any

from tp_vrg.storage.connection_isolation import isolated_sqlite_connection


COUNTER_KEYS: dict[str, str] = {
    "query": "cockpit_query_count",
    "janitor": "cockpit_janitor_pass_count",
    "merge": "cockpit_merge_count",
}


def init_stats_snapshot_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS stats_snapshots (
            snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
            captured_at REAL NOT NULL,
            reason TEXT NOT NULL,
            node_count INTEGER NOT NULL,
            edge_count INTEGER NOT NULL,
            passage_count INTEGER NOT NULL,
            community_count INTEGER NOT NULL,
            query_count INTEGER NOT NULL,
            janitor_pass_count INTEGER NOT NULL,
            merge_count INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_stats_snapshots_captured_at
        ON stats_snapshots(captured_at)
        """
    )


def bump_counter(conn: sqlite3.Connection, counter: str, amount: int = 1) -> int:
    """Increment a cockpit counter stored in meta and return its new value."""
    if counter not in COUNTER_KEYS:
        raise ValueError(f"Unknown cockpit counter: {counter}")
    init_stats_snapshot_schema(conn)
    key = COUNTER_KEYS[counter]
    current = _meta_int(conn, key)
    updated = current + int(amount)
    conn.execute(
        """
        INSERT INTO meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (key, str(updated)),
    )
    conn.commit()
    return updated


def reset_counter(conn: sqlite3.Connection, counter: str) -> None:
    if counter not in COUNTER_KEYS:
        raise ValueError(f"Unknown cockpit counter: {counter}")
    conn.execute(
        """
        INSERT INTO meta(key, value) VALUES (?, '0')
        ON CONFLICT(key) DO UPDATE SET value = '0'
        """,
        (COUNTER_KEYS[counter],),
    )
    conn.commit()


def record_stats_snapshot(
    conn: sqlite3.Connection,
    *,
    reason: str,
    captured_at: float | None = None,
) -> dict[str, Any]:
    """Persist a point-in-time Inspect counter snapshot."""
    init_stats_snapshot_schema(conn)
    snapshot = _current_counts(conn)
    snapshot["captured_at"] = float(captured_at if captured_at is not None else time.time())
    snapshot["reason"] = reason
    conn.execute(
        """
        INSERT INTO stats_snapshots(
            captured_at,
            reason,
            node_count,
            edge_count,
            passage_count,
            community_count,
            query_count,
            janitor_pass_count,
            merge_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            snapshot["captured_at"],
            snapshot["reason"],
            snapshot["node_count"],
            snapshot["edge_count"],
            snapshot["passage_count"],
            snapshot["community_count"],
            snapshot["query_count"],
            snapshot["janitor_pass_count"],
            snapshot["merge_count"],
        ),
    )
    conn.commit()
    return snapshot


def collect_inspect_summary(path: str | Path) -> dict[str, Any]:
    """Read the Cockpit Inspect summary without touching the engine connection."""
    db_path = Path(path)
    with isolated_sqlite_connection(db_path, read_only=True) as conn:
        return collect_inspect_summary_from_conn(conn, graph_file_bytes=_file_size(db_path))


def collect_inspect_summary_from_conn(
    conn: sqlite3.Connection,
    *,
    graph_file_bytes: int | None = None,
) -> dict[str, Any]:
    init_readable = _table_exists(conn, "stats_snapshots")
    current = _current_counts(conn)
    latest = _snapshot_row(
        conn,
        "SELECT * FROM stats_snapshots ORDER BY captured_at DESC, snapshot_id DESC LIMIT 1",
    ) if init_readable else None
    baseline = _baseline_snapshot(conn) if init_readable else None
    snapshot_count = _count_rows(conn, "stats_snapshots") if init_readable else 0

    return {
        "status": "ok",
        **current,
        "graph_file_bytes": graph_file_bytes,
        "graph_file_mb": round(graph_file_bytes / 1_048_576, 2) if graph_file_bytes is not None else None,
        "latest_snapshot": latest,
        "baseline_snapshot": baseline,
        "snapshot_count": snapshot_count,
        "deltas_24h": _deltas(current, baseline),
    }


def _baseline_snapshot(conn: sqlite3.Connection) -> dict[str, Any] | None:
    cutoff = time.time() - 86_400
    row = _snapshot_row(
        conn,
        """
        SELECT * FROM stats_snapshots
        WHERE captured_at <= ?
        ORDER BY captured_at DESC, snapshot_id DESC
        LIMIT 1
        """,
        (cutoff,),
    )
    if row is not None:
        return row
    return _snapshot_row(
        conn,
        "SELECT * FROM stats_snapshots ORDER BY captured_at ASC, snapshot_id ASC LIMIT 1",
    )


def _snapshot_row(
    conn: sqlite3.Connection,
    sql: str,
    params: tuple[Any, ...] = (),
) -> dict[str, Any] | None:
    original_factory = conn.row_factory
    try:
        conn.row_factory = sqlite3.Row
        row = conn.execute(sql, params).fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.row_factory = original_factory
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}


def _current_counts(conn: sqlite3.Connection) -> dict[str, int]:
    return {
        "node_count": _count_rows(conn, "nodes"),
        "edge_count": _count_rows(conn, "edges"),
        "passage_count": _count_rows(conn, "passages"),
        "community_count": _count_rows(conn, "community_centroids"),
        "query_count": _meta_int(conn, COUNTER_KEYS["query"]),
        "janitor_pass_count": _meta_int(conn, COUNTER_KEYS["janitor"]),
        "merge_count": _meta_int(conn, COUNTER_KEYS["merge"]),
    }


def _deltas(current: dict[str, int], baseline: dict[str, Any] | None) -> dict[str, int]:
    keys = (
        "node_count",
        "edge_count",
        "passage_count",
        "community_count",
        "query_count",
        "janitor_pass_count",
        "merge_count",
    )
    if baseline is None:
        return {key: 0 for key in keys}
    return {key: int(current.get(key, 0)) - int(baseline.get(key, 0) or 0) for key in keys}


def _meta_int(conn: sqlite3.Connection, key: str) -> int:
    if not _table_exists(conn, "meta"):
        return 0
    try:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    except sqlite3.Error:
        return 0
    if row is None:
        return 0
    try:
        return int(row[0])
    except (TypeError, ValueError):
        return 0


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    try:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?",
            (table_name,),
        ).fetchone()
    except sqlite3.Error:
        return False
    return row is not None


def _count_rows(conn: sqlite3.Connection, table_name: str) -> int:
    if not _table_exists(conn, table_name):
        return 0
    try:
        row = conn.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()
    except sqlite3.Error:
        return 0
    return int(row[0]) if row else 0


def _file_size(path: Path) -> int | None:
    try:
        return path.stat().st_size
    except OSError:
        return None
