"""Engine integration helpers for multi-resolution descent."""

from __future__ import annotations

from typing import Any

from tp_vrg.admission import apply_descent_scope
from tp_vrg.multi_res.descent_algorithm import GraphScope, macro_retrieve


def _table_exists(conn, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def has_started_multires_substrate(conn) -> bool:
    """Return True once a graph has the centroid store this sprint consumes."""
    return _table_exists(conn, "community_centroids")


async def scoped_macro_search(
    query: str,
    *,
    intent: object,
    storage: Any,
    embedder: Any,
    retriever: Any,
) -> list[str]:
    """Return passage ids, preferring descent when the baked substrate exists."""
    conn = getattr(storage, "_conn", None)
    if conn is None or not has_started_multires_substrate(conn):
        return await retriever.macro_search(query, intent=intent)

    query_embedding = await embedder.embed(query)
    scope = macro_retrieve(
        query,
        conn=conn,
        graph_scope=GraphScope(),
        mode_profile="standard",
        query_embedding=query_embedding,
        intent=intent,
    )
    if scope.skipped:
        return await retriever.macro_search(query, intent=intent)
    return apply_descent_scope(list(scope.passage_ids), scope)
