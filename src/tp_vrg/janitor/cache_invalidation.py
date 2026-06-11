"""Pattern 2 speculative-cache graph-state invalidation.

Invalidation token format: SHA256 over node_count, edge_count, last_bake_at,
and partition_version. Any mismatch is a cache miss; stale bundles are removed
on mutation events and by the 7-day TTL cap.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import time

from tp_vrg.storage.speculative_cache import configured_ttl_days, invalidate_all_stale

TOKEN_META_KEY = "speculative_prerender_graph_state_token"
TOKEN_UPDATED_META_KEY = "speculative_prerender_graph_state_token_updated_at"
LAST_INVALIDATED_META_KEY = "speculative_prerender_last_invalidated_count"
LAST_INVALIDATED_AT_META_KEY = "speculative_prerender_last_invalidated_at"


@dataclass(frozen=True)
class InvalidationEvent:
    invalidation_token: str
    removed_count: int
    mutation_kind: str


def _table_exists(conn, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _count(conn, table_name: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]) if _table_exists(conn, table_name) else 0


def _ensure_meta(conn) -> None:
    conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.commit()


def _meta_value(conn, key: str) -> str:
    if not _table_exists(conn, "meta"):
        return ""
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return str(row[0]) if row else ""


def _set_meta(conn, key: str, value: str) -> None:
    _ensure_meta(conn)
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, value))
    conn.commit()


def _last_partition_bake(conn) -> str:
    if not _table_exists(conn, "community_partitions"):
        return _meta_value(conn, "last_bake_at")
    row = conn.execute("SELECT MAX(baked_at) FROM community_partitions").fetchone()
    return str(row[0] or _meta_value(conn, "last_bake_at"))


def compute_graph_state_hash(conn) -> str:
    payload = {
        "node_count": _count(conn, "nodes"),
        "edge_count": _count(conn, "edges"),
        "last_bake_at": _last_partition_bake(conn),
        "partition_version": _meta_value(conn, "partition_version"),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def refresh_graph_state_token(conn) -> str:
    token = compute_graph_state_hash(conn)
    _set_meta(conn, TOKEN_META_KEY, token)
    _set_meta(conn, TOKEN_UPDATED_META_KEY, str(time.time()))
    return token


def invalidate_speculative_cache_for_mutation(
    conn,
    *,
    mutation_kind: str = "unknown",
    ttl_days: float | None = None,
) -> InvalidationEvent:
    """Refresh the graph-state token and drop stale Pattern 2 cache bundles."""
    token = refresh_graph_state_token(conn)
    removed = invalidate_all_stale(
        conn,
        token,
        ttl_days=ttl_days if ttl_days is not None else configured_ttl_days(),
    )
    _set_meta(conn, LAST_INVALIDATED_META_KEY, str(removed))
    _set_meta(conn, LAST_INVALIDATED_AT_META_KEY, str(time.time()))
    return InvalidationEvent(token, removed, mutation_kind)


def invalidation_stats(conn) -> dict[str, object]:
    last_at = float(_meta_value(conn, LAST_INVALIDATED_AT_META_KEY) or 0.0)
    last_count = int(_meta_value(conn, LAST_INVALIDATED_META_KEY) or 0)
    return {
        "last_invalidated_count": last_count,
        "last_invalidated_at": last_at or None,
        "invalidated_last_24h": last_count if last_at and time.time() - last_at <= 86400 else 0,
    }
