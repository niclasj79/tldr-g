"""Per-rung centroid query helper for the multi-resolution descent.

Descent uses centroid cosine as an entry signal, then composes with the
structured bundle substrate. Missing centroids are stale substrate, not a cue to
fall back to a flat passage scan.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

import numpy as np

from tp_vrg.multi_res.errors import StaleSubstrateError
from tp_vrg.storage.community_partitions import Rung
from tp_vrg.storage.per_rung_centroids import (
    CENTROID_INDEX_TABLES,
    VALID_CENTROID_RUNGS,
    CentroidSearchResult,
    resolve_embedding_dim,
    top_k_centroids,
)


@dataclass(frozen=True)
class Candidate:
    """One candidate community on a multi-resolution rung."""

    community_id: str
    level: str
    score: float
    source_seed: str | None = None
    source: str = "centroid"
    via_bundle: str | None = None
    sigma_family: str | None = None
    parent_score: float = 0.0


def _validate_level(level: str) -> Rung:
    if level not in VALID_CENTROID_RUNGS:
        raise ValueError(
            f"Unknown centroid level {level!r}; expected {list(VALID_CENTROID_RUNGS)}"
        )
    return level  # type: ignore[return-value]


def _table_exists(conn, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _stale_centroid_message(level: str) -> str:
    return (
        f"Missing community centroids for {level}; run Item 3 centroid recompute "
        "before multi-resolution descent"
    )


def _require_centroid_substrate(level: Rung, conn) -> None:
    table_name = CENTROID_INDEX_TABLES[level]
    if not _table_exists(conn, "community_centroids") or not _table_exists(conn, table_name):
        raise StaleSubstrateError(_stale_centroid_message(level))

    store_count = int(
        conn.execute(
            "SELECT COUNT(*) FROM community_centroids WHERE rung = ?",
            (level,),
        ).fetchone()[0]
    )
    index_count = int(conn.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0])
    if store_count <= 0:
        raise StaleSubstrateError(_stale_centroid_message(level))
    if index_count <= 0:
        raise StaleSubstrateError(
            f"Centroid vec0 index is empty for {level}; run Item 3 centroid recompute"
        )


def _unique_restrictions(restrict_to: Iterable[str] | None) -> list[str] | None:
    if restrict_to is None:
        return None
    return sorted({str(community_id) for community_id in restrict_to if community_id})


def _as_query_vector(
    query_embedding: Sequence[float] | np.ndarray,
    *,
    dim: int,
) -> np.ndarray:
    vector = np.asarray(query_embedding, dtype=np.float32)
    if vector.shape != (dim,):
        raise ValueError(f"query_embedding has dimension {vector.size}; expected {dim}")
    if not np.all(np.isfinite(vector)):
        raise ValueError("query_embedding contains non-finite values")
    return vector


def _restricted_top_k(
    level: Rung,
    query_embedding: Sequence[float] | np.ndarray,
    restrict_to: list[str],
    k: int,
    conn,
    *,
    embedding_dim: int | None,
) -> list[CentroidSearchResult]:
    dim = resolve_embedding_dim(conn, embedding_dim)
    query = _as_query_vector(query_embedding, dim=dim)
    if float(np.linalg.norm(query)) == 0.0:
        return []

    table_name = CENTROID_INDEX_TABLES[level]
    placeholders = ",".join("?" for _ in restrict_to)
    rows = conn.execute(
        f"""
        SELECT v.id, vec_distance_cosine(v.embedding, ?) AS dist, c.member_count
        FROM {table_name} AS v
        JOIN community_centroids AS c
          ON c.rung = ? AND c.community_id = v.id
        WHERE v.id IN ({placeholders})
        ORDER BY dist
        LIMIT ?
        """,
        (query.astype(np.float32).tobytes(), level, *restrict_to, int(k)),
    ).fetchall()
    return [
        CentroidSearchResult(
            community_id=str(community_id),
            similarity=1.0 - float(distance),
            member_count=int(member_count),
        )
        for community_id, distance, member_count in rows
    ]


def cosine_top_k(
    query_embedding: Sequence[float] | np.ndarray,
    level: str,
    conn,
    *,
    restrict_to: Iterable[str] | None = None,
    k: int = 8,
    embedding_dim: int | None = None,
) -> list[Candidate]:
    """Return top centroid candidates for ``level``, optionally scoped to ids."""
    resolved_level = _validate_level(level)
    if k <= 0:
        return []

    _require_centroid_substrate(resolved_level, conn)
    restrictions = _unique_restrictions(restrict_to)
    if restrictions == []:
        return []

    if restrictions is None:
        results = top_k_centroids(
            resolved_level,
            query_embedding,
            int(k),
            conn,
            embedding_dim=embedding_dim,
        )
    else:
        results = _restricted_top_k(
            resolved_level,
            query_embedding,
            restrictions,
            int(k),
            conn,
            embedding_dim=embedding_dim,
        )

    return [
        Candidate(
            community_id=result.community_id,
            level=resolved_level,
            score=float(result.similarity),
            source_seed=None,
            source="centroid",
        )
        for result in results
    ]


__all__ = ["Candidate", "cosine_top_k"]
