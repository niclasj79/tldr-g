"""Entry-rung seed handling for the multi-resolution descent.

The query-family cell interface is intentionally present but cold in this
sprint. Pattern 2 will populate cell hits; today cosine over baked centroids is
the active entry path.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

from tp_vrg.multi_res.centroid_query import Candidate, cosine_top_k
from tp_vrg.multi_res.descent_scoring import descent_top_m, validate_level
from tp_vrg.multi_res.descent_step import score_combine

ENTRY_COSINE_TOP_K = 8


@dataclass(frozen=True)
class QueryFamilyCell:
    """Result of a per-rung query-family lookup."""

    hit: bool
    version_is_fresh: bool = False
    visible_communities: tuple[Candidate, ...] = field(default_factory=tuple)
    rendered_bundle: bytes | None = None
    cache_cluster_id: str | None = None
    cache_reason: str = "miss"
    cache_similarity: float = 0.0


def query_family_cell_lookup(
    query: str,
    intent: object,
    level: str,
    graph_scope: object,
) -> QueryFamilyCell:
    """Return a Pattern 2 speculative cache cell hit when one is current."""
    validate_level(level)
    conn = getattr(graph_scope, "_conn", None) or getattr(graph_scope, "conn", None)
    if conn is None:
        return QueryFamilyCell(hit=False, cache_reason="no_connection")
    try:
        from tp_vrg.janitor.bake_speculative_prerender import current_graph_state_token
        from tp_vrg.janitor.query_shape_cluster import intent_to_sigma_fingerprint
        from tp_vrg.storage.speculative_cache import lookup_bundle

        result = lookup_bundle(
            query,
            intent_to_sigma_fingerprint(intent),
            intent,
            conn,
            current_invalidation_token=current_graph_state_token(conn),
        )
    except Exception as exc:
        return QueryFamilyCell(hit=False, cache_reason=f"lookup_error:{exc}")
    if not result.hit:
        return QueryFamilyCell(
            hit=False,
            cache_cluster_id=result.cluster_id,
            cache_reason=result.reason,
            cache_similarity=result.similarity,
        )
    return QueryFamilyCell(
        hit=True,
        version_is_fresh=True,
        rendered_bundle=result.rendered_bundle,
        cache_cluster_id=result.cluster_id,
        cache_reason=result.reason,
        cache_similarity=result.similarity,
    )


def entry_cosine_top_k(level: str, intent: object) -> int:
    validate_level(level)
    return ENTRY_COSINE_TOP_K


def entry_top_m(level: str, intent: object) -> int:
    return descent_top_m(level, intent)


def _allowed_communities(graph_scope: object, level: str) -> list[str] | None:
    allowed_fn = getattr(graph_scope, "allowed_communities", None)
    if callable(allowed_fn):
        return allowed_fn(level)
    return None


def seed_entry_level(
    query: str,
    query_embedding: Sequence[float] | np.ndarray,
    intent: object,
    level: str,
    graph_scope: object,
    conn,
) -> list[Candidate]:
    """Seed the entry level from query-family cell hits plus centroid cosine."""
    resolved = validate_level(level)
    cell = query_family_cell_lookup(query, intent, resolved, graph_scope)
    cell_seeds = list(cell.visible_communities) if cell.hit and cell.version_is_fresh else []
    cosine_seeds = cosine_top_k(
        query_embedding,
        resolved,
        conn,
        restrict_to=_allowed_communities(graph_scope, resolved),
        k=entry_cosine_top_k(resolved, intent),
    )
    combined = score_combine(
        cosine_seeds=cosine_seeds,
        traversal_expansions=cell_seeds,
        intent=intent,
        level=resolved,
    )
    return combined[: entry_top_m(resolved, intent)]


__all__ = [
    "ENTRY_COSINE_TOP_K",
    "QueryFamilyCell",
    "entry_cosine_top_k",
    "entry_top_m",
    "query_family_cell_lookup",
    "seed_entry_level",
]
