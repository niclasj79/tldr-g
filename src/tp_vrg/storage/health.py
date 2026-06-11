"""SQLite health projection over an isolated read connection."""

from __future__ import annotations

from pathlib import Path
import sqlite3

from tp_vrg.storage.connection_isolation import isolated_sqlite_connection


def _meta_value(conn: sqlite3.Connection, key: str) -> str | None:
    try:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    except sqlite3.Error:
        return None
    return row[0] if row else None


def _count_rows(conn: sqlite3.Connection, table: str) -> int:
    try:
        row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
    except sqlite3.Error:
        return 0
    return int(row[0]) if row else 0


def _days_since(conn: sqlite3.Connection, timestamp: str) -> float | None:
    row = conn.execute(
        "SELECT (julianday('now') - julianday(?))",
        (timestamp,),
    ).fetchone()
    if row is None or row[0] is None:
        return None
    return float(row[0])


def _read_integrity_cache(
    conn: sqlite3.Connection,
    *,
    stale_days: float = 7.0,
) -> dict[str, str | None]:
    result = _meta_value(conn, "integrity_last_check_result")
    checked_at = _meta_value(conn, "integrity_last_check_at")
    if not result or not checked_at:
        status = "unknown"
    elif result != "ok":
        status = "degraded"
    else:
        age_days = _days_since(conn, checked_at)
        status = "unknown" if age_days is None else "stale" if age_days >= stale_days else "ok"

    return {
        "integrity": status,
        "integrity_last_checked_at": checked_at,
        "integrity_check_result": result,
    }


def _read_fts5_sync_cache(
    conn: sqlite3.Connection,
    *,
    stale_days: float = 7.0,
) -> dict[str, object]:
    status = _meta_value(conn, "fts5_sync_status")
    checked_at = _meta_value(conn, "fts5_sync_last_check_at")
    if not status or not checked_at:
        status = "unknown"
    elif status == "ok":
        age_days = _days_since(conn, checked_at)
        if age_days is None:
            status = "unknown"
        elif age_days >= stale_days:
            status = "stale"

    if status == "ok":
        fts5_in_sync: bool | None = True
    elif status == "desynced":
        fts5_in_sync = False
    else:
        fts5_in_sync = None

    node_rows = _meta_value(conn, "fts5_sync_node_rows")
    passage_rows = _meta_value(conn, "fts5_sync_passage_rows")
    return {
        "fts5_sync_status": status,
        "fts5_sync_last_checked_at": checked_at,
        "fts5_in_sync": fts5_in_sync,
        "fts5_rows": int(node_rows) if node_rows is not None else None,
        "passage_fts_rows": int(passage_rows) if passage_rows is not None else None,
    }


def collect_sqlite_health(
    path: str | Path,
    *,
    cached_connected_components: int | None = None,
) -> dict[str, object]:
    """Return SQLite health without using ``SQLiteBackend._conn``."""
    with isolated_sqlite_connection(path, read_only=True, load_vec=True) as conn:
        node_count = _count_rows(conn, "nodes")
        edge_count = _count_rows(conn, "edges")
        passage_count = _count_rows(conn, "passages")
        vec0_rows = _count_rows(conn, "node_embeddings")
        vec_store_rows = _count_rows(conn, "node_embedding_store")

        fts5_cache = _read_fts5_sync_cache(conn)
        fts5_rows = fts5_cache["fts5_rows"]
        fts5_in_sync = fts5_cache["fts5_in_sync"]

        try:
            row = conn.execute(
                """
                SELECT COUNT(*) FROM edges e
                WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE entity_id = e.source)
                   OR NOT EXISTS (SELECT 1 FROM nodes WHERE entity_id = e.target)
                """
            ).fetchone()
            orphaned_edges = int(row[0]) if row else 0
        except sqlite3.Error:
            orphaned_edges = 0

        if node_count == 0:
            connected_components = 0
        elif cached_connected_components is not None:
            connected_components = cached_connected_components
        else:
            connected_components = -1

        integrity_cache = _read_integrity_cache(conn)
        integrity = integrity_cache["integrity"]
        integrity_check_result = integrity_cache["integrity_check_result"]

        issues: list[str] = []
        if integrity == "degraded":
            issues.append(f"integrity_check failed: {integrity_check_result}")
        if orphaned_edges > 0:
            issues.append(f"{orphaned_edges} orphaned edge(s) detected")
        if fts5_in_sync is False:
            issues.append(f"FTS5 desync: cached {fts5_rows} rows vs {node_count} nodes")

        schema_version = _meta_value(conn, "schema_version") or "1"
        return {
            "status": "degraded" if issues else "ok",
            "issues": issues,
            "schema_version": schema_version,
            "node_count": node_count,
            "edge_count": edge_count,
            "passage_count": passage_count,
            "vec0_rows": vec0_rows,
            "vec_store_rows": vec_store_rows,
            "fts5_rows": fts5_rows,
            "fts5_in_sync": fts5_in_sync,
            "fts5_sync_status": fts5_cache["fts5_sync_status"],
            "fts5_sync_last_checked_at": fts5_cache["fts5_sync_last_checked_at"],
            "passage_fts_rows": fts5_cache["passage_fts_rows"],
            "orphaned_edges": orphaned_edges,
            "connected_components": connected_components,
            "integrity": integrity,
            "integrity_last_checked_at": integrity_cache["integrity_last_checked_at"],
            "integrity_check_result": integrity_check_result,
            "health_mode": "full",
            "orphaned_edges_status": "computed",
        }


def collect_sqlite_health_snapshot(
    path: str | Path,
    *,
    node_count: int,
    edge_count: int,
    passage_count: int | None = None,
    cached_connected_components: int | None = None,
) -> dict[str, object]:
    """Return the latency-sensitive health projection for polling endpoints.

    This intentionally avoids graph-wide row scans. Expensive verification
    remains Janitor-owned and is exposed here only via cached meta rows.
    """
    db_path = Path(path)
    with isolated_sqlite_connection(db_path, read_only=True) as conn:
        fts5_cache = _read_fts5_sync_cache(conn)
        integrity_cache = _read_integrity_cache(conn)
        integrity = integrity_cache["integrity"]
        integrity_check_result = integrity_cache["integrity_check_result"]
        cached_passages = _meta_value(conn, "fts5_sync_passage_count")

        resolved_passage_count = passage_count
        if resolved_passage_count is None and cached_passages is not None:
            try:
                resolved_passage_count = int(cached_passages)
            except ValueError:
                resolved_passage_count = None

        if node_count == 0:
            connected_components = 0
        elif cached_connected_components is not None:
            connected_components = cached_connected_components
        else:
            connected_components = -1

        issues: list[str] = []
        if integrity == "degraded":
            issues.append(f"integrity_check failed: {integrity_check_result}")
        if fts5_cache["fts5_in_sync"] is False:
            issues.append(
                f"FTS5 desync: cached {fts5_cache['fts5_rows']} rows vs {node_count} nodes"
            )

        try:
            graph_file_bytes: int | None = db_path.stat().st_size
        except OSError:
            graph_file_bytes = None

        schema_version = _meta_value(conn, "schema_version") or "1"
        return {
            "status": "degraded" if issues else "ok",
            "issues": issues,
            "schema_version": schema_version,
            "node_count": node_count,
            "edge_count": edge_count,
            "passage_count": resolved_passage_count,
            "vec0_rows": None,
            "vec_store_rows": None,
            "fts5_rows": fts5_cache["fts5_rows"],
            "fts5_in_sync": fts5_cache["fts5_in_sync"],
            "fts5_sync_status": fts5_cache["fts5_sync_status"],
            "fts5_sync_last_checked_at": fts5_cache["fts5_sync_last_checked_at"],
            "passage_fts_rows": fts5_cache["passage_fts_rows"],
            "orphaned_edges": None,
            "orphaned_edges_status": "not_computed",
            "connected_components": connected_components,
            "integrity": integrity,
            "integrity_last_checked_at": integrity_cache["integrity_last_checked_at"],
            "integrity_check_result": integrity_check_result,
            "graph_file_bytes": graph_file_bytes,
            "health_mode": "cached",
        }
