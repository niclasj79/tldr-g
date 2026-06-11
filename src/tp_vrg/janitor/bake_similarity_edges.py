"""Janitor-owned bake for bounded materialized similarity edges."""

from __future__ import annotations

from datetime import datetime, timezone
import logging
import os
import time
import uuid

import numpy as np

from tp_vrg.cardinality import probe
from tp_vrg.storage.per_rung_centroids import top_k_centroids
from tp_vrg.storage.similarity_edges import (
    SimilarityEdge,
    init_schema,
    replace_similarity_edges,
    resolve_model_id,
    similarity_edges_enabled,
)

logger = logging.getLogger(__name__)

SIMILARITY_EDGES_TASK = "bake_similarity_edges"
ASSET_RUNG = "asset"
PASSAGE_RUNG = "passage"
DEFAULT_SIMILARITY_TOP_K = 10
SIMILARITY_HUB_CAP_ENV = "TPVRG_SIMILARITY_EDGES_HUB_CAP"
SIMILARITY_COSINE_FLOOR_ENV = "TPVRG_SIMILARITY_EDGES_COSINE_FLOOR"
SIMILARITY_MUTUAL_ENV = "TPVRG_SIMILARITY_EDGES_MUTUAL"
_ASSET_MAX_INTERMEDIATE = 100_000
_ASSET_MAX_WALL_S = 300.0
_PASSAGE_MAX_INTERMEDIATE = 1_000_000
_PASSAGE_MAX_WALL_S = 600.0


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _centroid_rows(conn, rung: str) -> list[tuple[str, bytes]]:
    return [
        (str(community_id), bytes(blob))
        for community_id, blob in conn.execute(
            """
            SELECT community_id, centroid_blob
            FROM community_centroids
            WHERE rung = ?
            ORDER BY community_id
            """,
            (rung,),
        ).fetchall()
    ]


def _table_exists(conn, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _passage_rows(conn) -> list[tuple[str, bytes]]:
    if not _table_exists(conn, "passage_embedding_store"):
        raise ValueError(
            "Cannot bake passage similarity edges: passage_embedding_store is missing"
        )
    rows = conn.execute(
        """
        SELECT id, embedding
        FROM passage_embedding_store
        ORDER BY id
        """
    ).fetchall()
    return [(str(passage_id), bytes(blob)) for passage_id, blob in rows]


def _blob_to_vector(blob: bytes, *, label: str) -> np.ndarray:
    vector = np.frombuffer(bytes(blob), dtype=np.float32)
    if vector.size == 0:
        raise ValueError(f"{label} has an empty centroid vector")
    if not np.all(np.isfinite(vector)):
        raise ValueError(f"{label} contains non-finite values")
    return vector


def resolve_similarity_hub_cap(
    *,
    source_count: int,
    k: int,
    raw_cap: str | None = None,
) -> int:
    """Resolve the target in-degree cap for passage similarity edges."""
    raw = os.environ.get(SIMILARITY_HUB_CAP_ENV) if raw_cap is None else raw_cap
    if raw is not None and str(raw).strip():
        try:
            cap = int(str(raw).strip())
        except ValueError as exc:
            raise ValueError(f"{SIMILARITY_HUB_CAP_ENV} must be an integer > 0") from exc
        if cap <= 0:
            raise ValueError(f"{SIMILARITY_HUB_CAP_ENV} must be an integer > 0")
        return cap
    return max(int(k), min(100, int(k) * 10, max(1, int(source_count))))


def resolve_similarity_cosine_floor(raw: str | float | None = None) -> float:
    """Resolve the cosine-similarity floor for baked similarity edges.

    Edges whose cosine is strictly less than the floor are dropped during the
    bake. A floor of ``0.0`` (the default) is the off state — the floor check
    is skipped entirely so the output is byte-identical to a floorless bake.
    Resolution order mirrors :func:`resolve_similarity_hub_cap`: an explicit
    kwarg wins, then the ``TPVRG_SIMILARITY_EDGES_COSINE_FLOOR`` env var, then
    the ``0.0`` default. Valid floors live in ``[0.0, 1.0]``.
    """
    if raw is None:
        raw = os.environ.get(SIMILARITY_COSINE_FLOOR_ENV)
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return 0.0
    try:
        floor = float(str(raw).strip()) if isinstance(raw, str) else float(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"{SIMILARITY_COSINE_FLOOR_ENV} must be a float in [0.0, 1.0]"
        ) from exc
    if not (0.0 <= floor <= 1.0):
        raise ValueError(
            f"{SIMILARITY_COSINE_FLOOR_ENV} must be in [0.0, 1.0]; got {floor!r}"
        )
    return floor


_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"", "0", "false", "no", "off"}


def resolve_similarity_mutual(raw: bool | str | None = None) -> bool:
    """Resolve whether to enforce mutual-kNN (symmetric edge filtering).

    When ``True``, edge ``A->B`` survives only if ``B->A`` is also a candidate
    (already-floor-survived, already-hub-capped). When ``False`` (the default
    off state), the bake emits the standard directed-kNN edge set. Resolution
    order matches :func:`resolve_similarity_cosine_floor`: explicit kwarg wins,
    then ``TPVRG_SIMILARITY_EDGES_MUTUAL`` env var, then ``False``.
    """
    if isinstance(raw, bool):
        return raw
    if raw is None:
        raw = os.environ.get(SIMILARITY_MUTUAL_ENV)
    if raw is None:
        return False
    normalized = str(raw).strip().lower()
    if normalized in _TRUTHY:
        return True
    if normalized in _FALSY:
        return False
    raise ValueError(
        f"{SIMILARITY_MUTUAL_ENV} must be a truthy/falsy string; got {raw!r}"
    )


def _filter_to_mutual_subset(
    edges: list[SimilarityEdge],
) -> tuple[list[SimilarityEdge], int]:
    """Drop directed edges that have no symmetric mate in the candidate set.

    Operates on the post-floor, post-hub-cap edge set; the contract's
    "mutual operates on the floor-surviving candidate set" condition. Returns
    the surviving edges + the count dropped (for the bake summary).
    """
    if not edges:
        return edges, 0
    candidate_pairs = {(edge.src_id, edge.tgt_id) for edge in edges}
    survivors = [
        edge for edge in edges if (edge.tgt_id, edge.src_id) in candidate_pairs
    ]
    return survivors, len(edges) - len(survivors)


def _top_k_passages(
    conn,
    query: np.ndarray,
    limit: int,
) -> list[tuple[str, float]]:
    if not _table_exists(conn, "passage_embeddings"):
        raise ValueError("Cannot bake passage similarity edges: passage_embeddings is missing")
    if limit <= 0:
        return []
    rows = conn.execute(
        """
        SELECT id, vec_distance_cosine(embedding, ?) AS dist
        FROM passage_embeddings
        ORDER BY dist
        LIMIT ?
        """,
        (query.astype(np.float32).tobytes(), int(limit)),
    ).fetchall()
    return [(str(passage_id), 1.0 - float(distance)) for passage_id, distance in rows]


def _bake_asset_similarity_edges(
    conn,
    *,
    k: int,
    model_id: str,
    run_id: str,
    cardinality_strict: bool,
    max_intermediate: int | None,
    max_wall_s: float | None,
    cosine_floor: float,
    mutual: bool,
) -> dict[str, object]:
    rows = _centroid_rows(conn, ASSET_RUNG)
    if not rows:
        raise ValueError(
            "Cannot bake Asset similarity edges: no Asset centroids found. "
            "Run the partition/centroid bake first."
        )

    created_at = _utc_now()
    edges: list[SimilarityEdge] = []
    edges_dropped_by_floor = 0
    edges_dropped_by_mutual = 0
    floor_active = cosine_floor > 0.0
    with probe(
        "bake.similarity_edges.asset",
        input_rows=len(rows),
        max_intermediate=max_intermediate,
        max_wall_s=max_wall_s,
        strict=cardinality_strict,
    ) as cardinality_probe:
        for community_id, blob in rows:
            query = _blob_to_vector(blob, label=f"asset centroid {community_id!r}")
            rank = 1
            for result in top_k_centroids(ASSET_RUNG, query, k + 1, conn):
                cardinality_probe.intermediate += 1
                if result.community_id == community_id:
                    continue
                similarity = float(result.similarity)
                if floor_active and similarity < cosine_floor:
                    edges_dropped_by_floor += 1
                    continue
                edges.append(
                    SimilarityEdge(
                        src_id=community_id,
                        tgt_id=result.community_id,
                        rung=ASSET_RUNG,
                        cosine=similarity,
                        rank=rank,
                        model_id=model_id,
                        created_at=created_at,
                        run_id=run_id,
                    )
                )
                rank += 1
                if rank > k:
                    break
        if mutual:
            edges, edges_dropped_by_mutual = _filter_to_mutual_subset(edges)
        cardinality_probe.output = len(edges)

    written = replace_similarity_edges(ASSET_RUNG, edges, conn)
    return {
        "rung": ASSET_RUNG,
        "input_count": len(rows),
        "edge_count": written,
        "hubs_capped": 0,
        "cosine_floor": float(cosine_floor),
        "edges_dropped_by_floor": edges_dropped_by_floor,
        "mutual": bool(mutual),
        "edges_dropped_by_mutual": edges_dropped_by_mutual,
    }


def _bake_passage_similarity_edges(
    conn,
    *,
    k: int,
    model_id: str,
    run_id: str,
    cardinality_strict: bool,
    max_intermediate: int | None,
    max_wall_s: float | None,
    hub_cap: int | None,
    cosine_floor: float,
    mutual: bool,
) -> dict[str, object]:
    rows = _passage_rows(conn)
    if not rows:
        raise ValueError("Cannot bake passage similarity edges: no passage embeddings found")

    resolved_hub_cap = (
        resolve_similarity_hub_cap(source_count=len(rows), k=k)
        if hub_cap is None
        else int(hub_cap)
    )
    if resolved_hub_cap <= 0:
        raise ValueError("passage similarity hub cap must be > 0")

    candidate_limit = min(len(rows), max(k + 1, (k * 4) + 1, resolved_hub_cap + k + 1))
    created_at = _utc_now()
    edges: list[SimilarityEdge] = []
    target_degree: dict[str, int] = {}
    hubs_capped = 0
    edges_dropped_by_floor = 0
    edges_dropped_by_mutual = 0
    floor_active = cosine_floor > 0.0

    with probe(
        "bake.similarity_edges.passage",
        input_rows=len(rows),
        max_intermediate=max_intermediate,
        max_wall_s=max_wall_s,
        strict=cardinality_strict,
    ) as cardinality_probe:
        for passage_id, blob in rows:
            query = _blob_to_vector(blob, label=f"passage embedding {passage_id!r}")
            rank = 1
            for target_id, similarity in _top_k_passages(conn, query, candidate_limit):
                cardinality_probe.intermediate += 1
                if target_id == passage_id:
                    continue
                if floor_active and similarity < cosine_floor:
                    edges_dropped_by_floor += 1
                    continue
                if target_degree.get(target_id, 0) >= resolved_hub_cap:
                    hubs_capped += 1
                    continue
                edges.append(
                    SimilarityEdge(
                        src_id=passage_id,
                        tgt_id=target_id,
                        rung=PASSAGE_RUNG,
                        cosine=float(similarity),
                        rank=rank,
                        model_id=model_id,
                        created_at=created_at,
                        run_id=run_id,
                    )
                )
                target_degree[target_id] = target_degree.get(target_id, 0) + 1
                rank += 1
                if rank > k:
                    break
        if mutual:
            edges, edges_dropped_by_mutual = _filter_to_mutual_subset(edges)
        cardinality_probe.output = len(edges)

    written = replace_similarity_edges(PASSAGE_RUNG, edges, conn)
    return {
        "rung": PASSAGE_RUNG,
        "input_count": len(rows),
        "edge_count": written,
        "hubs_capped": hubs_capped,
        "hub_cap": resolved_hub_cap,
        "cosine_floor": float(cosine_floor),
        "edges_dropped_by_floor": edges_dropped_by_floor,
        "mutual": bool(mutual),
        "edges_dropped_by_mutual": edges_dropped_by_mutual,
    }


def bake_similarity_edges(
    conn,
    *,
    rung: str = ASSET_RUNG,
    k: int = DEFAULT_SIMILARITY_TOP_K,
    model_id: str | None = None,
    run_id: str | None = None,
    enabled: bool | None = None,
    hub_cap: int | None = None,
    cosine_floor: float | None = None,
    mutual: bool | None = None,
    cardinality_strict: bool = False,
    max_intermediate: int | None = None,
    max_wall_s: float | None = None,
) -> dict[str, object]:
    """Bake one rung of directed k-nearest-neighbor similarity edges.

    ``cosine_floor`` (or the ``TPVRG_SIMILARITY_EDGES_COSINE_FLOOR`` env var
    when the kwarg is left ``None``) drops candidate edges whose cosine is
    strictly less than the floor; floor=0.0 is the default off state and
    produces byte-identical output to a floorless bake.

    ``mutual`` (or ``TPVRG_SIMILARITY_EDGES_MUTUAL`` when the kwarg is left
    ``None``) enables mutual-kNN: only the symmetric subset of the
    (already-floor- and hub-cap-survived) edges is kept. Default off →
    byte-identical to today's directed-kNN bake.
    """
    if k <= 0:
        raise ValueError("k must be > 0")
    if enabled is None:
        enabled = similarity_edges_enabled()
    started = time.perf_counter()
    resolved_model_id = resolve_model_id(model_id)
    resolved_run_id = run_id or uuid.uuid4().hex
    resolved_cosine_floor = resolve_similarity_cosine_floor(cosine_floor)
    resolved_mutual = resolve_similarity_mutual(mutual)
    if not enabled:
        return {
            "enabled": False,
            "rung": rung,
            "k": int(k),
            "model_id": resolved_model_id,
            "run_id": resolved_run_id,
            "edge_count": 0,
            "hubs_capped": 0,
            "cosine_floor": resolved_cosine_floor,
            "edges_dropped_by_floor": 0,
            "mutual": resolved_mutual,
            "edges_dropped_by_mutual": 0,
            "wall_time_s": time.perf_counter() - started,
        }

    init_schema(conn)
    if rung == ASSET_RUNG:
        summary = _bake_asset_similarity_edges(
            conn,
            k=int(k),
            model_id=resolved_model_id,
            run_id=resolved_run_id,
            cardinality_strict=cardinality_strict,
            max_intermediate=(
                _ASSET_MAX_INTERMEDIATE if max_intermediate is None else max_intermediate
            ),
            max_wall_s=_ASSET_MAX_WALL_S if max_wall_s is None else max_wall_s,
            cosine_floor=resolved_cosine_floor,
            mutual=resolved_mutual,
        )
    elif rung == PASSAGE_RUNG:
        summary = _bake_passage_similarity_edges(
            conn,
            k=int(k),
            model_id=resolved_model_id,
            run_id=resolved_run_id,
            cardinality_strict=cardinality_strict,
            max_intermediate=(
                _PASSAGE_MAX_INTERMEDIATE if max_intermediate is None else max_intermediate
            ),
            max_wall_s=_PASSAGE_MAX_WALL_S if max_wall_s is None else max_wall_s,
            hub_cap=hub_cap,
            cosine_floor=resolved_cosine_floor,
            mutual=resolved_mutual,
        )
    else:
        raise ValueError(f"Unknown similarity-edge rung {rung!r}; expected asset or passage")

    wall_time_s = time.perf_counter() - started
    result = {
        "enabled": True,
        "k": int(k),
        "model_id": resolved_model_id,
        "run_id": resolved_run_id,
        "wall_time_s": wall_time_s,
        **summary,
    }
    logger.info(
        "[bake] similarity_edges rung=%s k=%d edges=%d hubs_capped=%d "
        "floor=%.3f dropped_floor=%d mutual=%s dropped_mutual=%d wall_s=%.2f",
        result["rung"],
        int(k),
        int(result["edge_count"]),
        int(result["hubs_capped"]),
        float(result.get("cosine_floor", 0.0)),
        int(result.get("edges_dropped_by_floor", 0)),
        bool(result.get("mutual", False)),
        int(result.get("edges_dropped_by_mutual", 0)),
        wall_time_s,
    )
    return result


__all__ = [
    "ASSET_RUNG",
    "DEFAULT_SIMILARITY_TOP_K",
    "PASSAGE_RUNG",
    "SIMILARITY_COSINE_FLOOR_ENV",
    "SIMILARITY_EDGES_TASK",
    "SIMILARITY_HUB_CAP_ENV",
    "SIMILARITY_MUTUAL_ENV",
    "bake_similarity_edges",
    "resolve_similarity_cosine_floor",
    "resolve_similarity_hub_cap",
    "resolve_similarity_mutual",
]
