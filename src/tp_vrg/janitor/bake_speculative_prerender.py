"""Pattern 2 LOW LOD speculative pre-render bake task.

Implements the design-doc lifecycle: predict likely next query clusters, render
their representatives at LOW LOD, and store invalidation-aware cache bundles.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass
import re
import time

from tp_vrg.intent import IntentSignal, classify_intent
from tp_vrg.janitor.query_shape_cluster import (
    DEFAULT_HISTORY_WINDOW_HOURS,
    DEFAULT_TOP_N_CLUSTERS,
    QueryEvent,
    cluster_query_shapes,
    read_recent_query_events,
)
from tp_vrg.storage.speculative_cache import DEFAULT_MAX_CACHE_BYTES, upsert_bundle

LOW_LOD_TIER = 1
DEFAULT_MAX_BUNDLE_CHARS = 4000
Renderer = Callable[[str, object], bytes | str]


@dataclass(frozen=True)
class BakeSummary:
    clusters_seen: int
    bundles_baked: int
    invalidation_token: str
    baked_at: float
    cluster_ids: tuple[str, ...]


def _table_exists(conn, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _last_partition_bake(conn) -> str:
    if not _table_exists(conn, "community_partitions"):
        return ""
    row = conn.execute("SELECT MAX(baked_at) FROM community_partitions").fetchone()
    return str(row[0] or "")


def current_graph_state_token(conn, *, last_bake_at: float | None = None) -> str:
    """Return the Pattern 2 graph-state hash for speculative cache freshness."""
    if last_bake_at is None:
        from tp_vrg.janitor.cache_invalidation import compute_graph_state_hash

        return compute_graph_state_hash(conn)
    from tp_vrg.janitor.cache_invalidation import compute_graph_state_hash

    previous = _last_partition_bake(conn)
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('last_bake_at', ?)",
            (str(last_bake_at),),
        )
        conn.commit()
        return compute_graph_state_hash(conn)
    finally:
        if previous:
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES ('last_bake_at', ?)",
                (previous,),
            )
            conn.commit()


def _terms(query: str) -> list[str]:
    return [term for term in re.findall(r"[A-Za-z0-9_]{3,}", query.lower())[:8]]


def default_low_lod_renderer(query: str, conn, *, max_chars: int = DEFAULT_MAX_BUNDLE_CHARS) -> str:
    """Render a compact LOD_1-style bundle from passage snippets."""
    if not _table_exists(conn, "passages"):
        raise ValueError("Cannot render speculative bundle: passages table is missing")
    rows = conn.execute("SELECT passage_id, raw_text, source_label FROM passages ORDER BY passage_id").fetchall()
    if not rows:
        raise ValueError("Cannot render speculative bundle: passages table is empty")
    terms = _terms(query)
    selected = [
        row for row in rows
        if not terms or any(term in str(row[1]).lower() or term in str(row[2]).lower() for term in terms)
    ][:8] or rows[:8]
    parts = [f"LOD_1 speculative bundle\nQuery: {query.strip()}"]
    for passage_id, raw_text, source_label in selected:
        snippet = " ".join(str(raw_text).split())[:360]
        parts.append(f"[{passage_id}] {source_label}: {snippet}")
    bundle = "\n".join(parts)
    return bundle[:max_chars]


def _bundle_bytes(bundle: bytes | str) -> bytes:
    data = bundle.encode("utf-8") if isinstance(bundle, str) else bytes(bundle)
    if not data:
        raise ValueError("LOW LOD renderer produced an empty speculative bundle")
    return data


def bake_speculative_prerender_cache(
    conn,
    *,
    history_events: Sequence[QueryEvent | str] | None = None,
    render_low_lod: Renderer | None = None,
    top_n: int = DEFAULT_TOP_N_CLUSTERS,
    window_hours: int = DEFAULT_HISTORY_WINDOW_HOURS,
    classify: Callable[[str], IntentSignal] = classify_intent,
    invalidation_token: str | None = None,
    max_cache_bytes: int = DEFAULT_MAX_CACHE_BYTES,
) -> BakeSummary:
    """Bake Pattern 2 speculative bundles for the top predicted query clusters."""
    baked_at = time.time()
    events = list(history_events) if history_events is not None else read_recent_query_events(conn, window_hours=window_hours)
    clusters = cluster_query_shapes(events, top_n=top_n, classify=classify)
    token = invalidation_token or current_graph_state_token(conn, last_bake_at=None)
    renderer = render_low_lod or default_low_lod_renderer
    baked_ids: list[str] = []
    for cluster in clusters:
        bundle = _bundle_bytes(renderer(cluster.representative_query_text, conn))
        upsert_bundle(
            cluster.cluster_id,
            cluster.representative_query_text,
            cluster.cluster_centroid,
            bundle,
            LOW_LOD_TIER,
            token,
            conn,
            baked_at=baked_at,
            max_cache_bytes=max_cache_bytes,
        )
        baked_ids.append(cluster.cluster_id)
    return BakeSummary(len(clusters), len(baked_ids), token, baked_at, tuple(baked_ids))


async def bake_speculative_prerender_cache_async(conn, **kwargs: object) -> BakeSummary:
    """Event-loop-safe wrapper for async Janitor callers."""
    return await asyncio.to_thread(bake_speculative_prerender_cache, conn, **kwargs)
