"""Bundle-algebra inversion for partition-edge weighting.

Item 1 verified the forward inheritance rules exactly: w=sum, sigma is a
weighted mean, and E is a union. This module uses those closed-form properties
as an L2 partition-objective projection. The current community edge store is
integer-weighted, so fractional attribution scores are scaled before they are
fed to Leiden; the scale preserves ordering, not physical bundle weight units.
"""

from __future__ import annotations

import itertools
import os

import numpy as np

from tp_vrg.cardinality import assert_free_disk_for_bake, probe
from tp_vrg.algebra.bundle import Bundle
from tp_vrg.models import RELATION_CLASS_COUNT, RELATION_CLASS_INDEX
from tp_vrg.storage.community_partitions import (
    entity_community_map,
    init_schema,
    iter_boundary_edges,
    resolve_boundary_hub_cap,
)

ATTRIBUTION_WEIGHT_SCALE = 1000

# Bounded-memory incidence chunk for the vectorized bundle inversion. The real
# 97K graph streams ~163M (edge, community-pair) incidences; the inversion holds
# at most this many incidence rows (a few int64/float64 columns + a tuple list)
# in RAM at once, so transient memory is O(_BAKE_INVERSION_CHUNK_DEFAULT) plus
# the per-pair accumulator arrays (n_pairs x RELATION_CLASS_COUNT). Tighten via
# the TPVRG_BAKE_INVERSION_CHUNK env var if needed.
_BAKE_INVERSION_CHUNK_DEFAULT = 1_000_000

_TEMPORAL_MARKERS = ("time", "date", "year", "occurred", "before", "after", "follows")
_CAUSAL_MARKERS = ("cause", "because", "lead", "depend", "require", "block", "enable")
_EPISODIC_MARKERS = ("said", "asked", "wrote", "message", "chat", "session", "meeting")
_AUTHORIAL_MARKERS = ("author", "created", "source", "from", "owner", "signed")


def relation_to_class(relation: str) -> str:
    """Map production relation labels onto the canonical sigma alphabet."""
    candidate = (relation or "").strip().lower()
    if candidate in RELATION_CLASS_INDEX:
        return candidate
    if any(marker in candidate for marker in _TEMPORAL_MARKERS):
        return "temporal"
    if any(marker in candidate for marker in _CAUSAL_MARKERS):
        return "causal"
    if any(marker in candidate for marker in _EPISODIC_MARKERS):
        return "episodic"
    if any(marker in candidate for marker in _AUTHORIAL_MARKERS):
        return "authorial"
    return "factual"


def _multinomial_share(relation_class: str, candidate_bundle: Bundle) -> float:
    sigma_value = float(candidate_bundle.sigma[RELATION_CLASS_INDEX[relation_class]])
    if sigma_value <= 0.0:
        return 0.0
    positive = candidate_bundle.sigma[candidate_bundle.sigma > 0.0]
    baseline = float(positive.mean()) if positive.size else 0.0
    return baseline / sigma_value if baseline > 0.0 else 0.0


def bundle_attribute_inter_community_edge(
    edge: tuple[str, str, str],
    candidate_bundle: Bundle,
    *,
    edge_weight: float = 1.0,
    density_factor: float = 1.0,
) -> float:
    """Return an edge's L2 contribution share for one candidate bundle.

    Per Inversion B: contribution = (w_e / w_total) *
    multinomial_share(sigma_e, sigma_B) * density_factor(e). Relation classes
    absent from sigma_B contribute zero. The caller may multiply the returned
    share by candidate_bundle.w to recover a partition-objective edge weight.
    """
    _source, _target, relation = edge
    if candidate_bundle.w <= 0.0 or edge_weight <= 0.0 or density_factor <= 0.0:
        return 0.0
    relation_class = relation_to_class(relation)
    return (
        float(edge_weight)
        / float(candidate_bundle.w)
        * _multinomial_share(relation_class, candidate_bundle)
        * float(density_factor)
    )


def _membership_cte() -> str:
    # DISTINCT (entity_id, community_id) — feeds _entity_community_counts only.
    # (The edge aggregation itself streams via storage.iter_boundary_edges to
    # avoid the passage x passage fan-out; see aggregate_bundle_attribution_float.)
    return """
    rung_membership AS (
        SELECT DISTINCT pe.entity_id AS entity_id, asset.community_id AS community_id
        FROM passage_entities AS pe
        JOIN community_partitions AS asset
          ON asset.rung = 'asset'
         AND asset.member_id = pe.passage_id
    )
    """


def _validate_rung(rung: str) -> str:
    if rung != "asset":
        raise ValueError("L2 bundle attribution currently supports the asset rung")
    return rung


def _entity_community_counts(rung: str, conn) -> dict[str, int]:
    query = f"""
        WITH {_membership_cte()}
        SELECT entity_id, COUNT(DISTINCT community_id)
        FROM rung_membership
        GROUP BY entity_id
    """
    return {str(entity_id): int(count) for entity_id, count in conn.execute(query).fetchall()}


def _inversion_chunk_size() -> int:
    """Resolve the bounded-memory incidence chunk size (env-overridable)."""
    raw = os.environ.get("TPVRG_BAKE_INVERSION_CHUNK", "").strip()
    if raw:
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value > 0:
            return value
    return _BAKE_INVERSION_CHUNK_DEFAULT


def aggregate_bundle_attribution_float(
    rung: str,
    conn,
    *,
    cardinality_strict: bool = False,
    max_intermediate: int | None = None,
    max_wall_s: float | None = None,
) -> list[tuple[str, str, float]]:
    """Return fractional L2 inter-community weights for one rung.

    Streams distinct (edge, community-pair) incidences twice over a single
    RAM-bounded ``entity_id -> {community}`` map instead of materializing the
    passage x passage edge fan-out (~3.2B rows on a real 97K graph — a >1h wedge
    / temp-disk exhaustion). Pass 1 accumulates each pair's bundle inputs (sigma
    weight-sums + total weight); pass 2 projects each edge's density-weighted
    contribution into its pair.

    The per-incidence work is **vectorized**: incidences are read in bounded
    chunks (``_inversion_chunk_size``) and reduced with bulk NumPy
    group-aggregation (``np.add.at``) rather than a per-incidence one-hot
    allocation + multinomial-share call. The ~163M-incidence loop that walked
    NumPy element-by-element (the ~40-min island-rung bake sink) collapses to a
    handful of whole-array ops per chunk. **The bundle math is unchanged** — only
    how it is computed; output matches the prior grouped form up to
    floating-point summation order (the equivalence test is the seatbelt).
    """
    resolved_rung = _validate_rung(rung)
    init_schema(conn)
    # Free-space preflight: fail loudly here (clear, actionable) rather than mid-stream
    # with SQLite "database or disk is full" (the 2026-06-04 island-rung incident).
    assert_free_disk_for_bake(conn, stage=f"bake.inversion.{resolved_rung}")
    counts = _entity_community_counts(resolved_rung, conn)
    community_map = entity_community_map(resolved_rung, conn)
    # Hub capping only downselects positive incidence rows before the same
    # weighted-sum / weighted-mean sigma aggregation, so the closed-form bundle
    # algebra remains in its linear regime.
    hub_cap = resolve_boundary_hub_cap(community_map)
    chunk_size = _inversion_chunk_size()

    # Stable (community_a, community_b) -> dense pair-id assignment, shared by
    # both passes so the per-pair accumulator rows line up.
    pair_index: dict[tuple[str, str], int] = {}
    pair_keys: list[tuple[str, str]] = []
    # relation-string -> RELATION_CLASS_INDEX cache (the substring classification
    # is computed once per distinct relation, not once per incidence).
    relation_class_cache: dict[str, int] = {}

    def _relation_class_id(relation: str) -> int:
        cached = relation_class_cache.get(relation)
        if cached is None:
            cached = RELATION_CLASS_INDEX[relation_to_class(relation)]
            relation_class_cache[relation] = cached
        return cached

    # Pass 1 — per-pair weight-sums. ``sigma_sums[pair, class]`` is the
    # group-by (pair, relation_class) weight sum; ``total_weight[pair]`` the
    # group-by pair weight sum. Both grow as new pairs appear across chunks.
    sigma_sums = np.zeros((0, RELATION_CLASS_COUNT), dtype=np.float64)
    total_weight = np.zeros(0, dtype=np.float64)

    def _grow_pass1(required: int) -> None:
        nonlocal sigma_sums, total_weight
        current = total_weight.shape[0]
        if required <= current:
            return
        new_capacity = max(required, current * 2, 1024)
        grown_sigma = np.zeros((new_capacity, RELATION_CLASS_COUNT), dtype=np.float64)
        grown_sigma[:current] = sigma_sums
        grown_total = np.zeros(new_capacity, dtype=np.float64)
        grown_total[:current] = total_weight
        sigma_sums = grown_sigma
        total_weight = grown_total

    edge_count = int(conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0])
    with probe(
        "bake.inversion_attribution",
        input_rows=edge_count,
        max_intermediate=max_intermediate,
        max_wall_s=max_wall_s,
        strict=cardinality_strict,
    ) as cardinality_probe:
        stream = iter_boundary_edges(community_map, conn, hub_cap=hub_cap)
        while True:
            chunk = list(itertools.islice(stream, chunk_size))
            if not chunk:
                break
            cardinality_probe.intermediate += len(chunk)
            pair_ids: list[int] = []
            class_ids: list[int] = []
            weights: list[float] = []
            for source, target, relation, weight, community_a, community_b in chunk:
                key = (community_a, community_b)
                pair_id = pair_index.get(key)
                if pair_id is None:
                    pair_id = len(pair_keys)
                    pair_index[key] = pair_id
                    pair_keys.append(key)
                pair_ids.append(pair_id)
                class_ids.append(_relation_class_id(relation))
                weights.append(weight)
            _grow_pass1(len(pair_keys))
            pair_arr = np.asarray(pair_ids, dtype=np.int64)
            class_arr = np.asarray(class_ids, dtype=np.int64)
            # Mirror ``float(weight or 1.0)``: a falsy (zero) weight becomes 1.0.
            weight_arr = np.asarray(weights, dtype=np.float64)
            edge_weight = np.where(weight_arr != 0.0, weight_arr, 1.0)
            np.add.at(total_weight, pair_arr, edge_weight)
            np.add.at(sigma_sums, (pair_arr, class_arr), edge_weight)
        cardinality_probe.output = len(pair_keys)

    n_pairs = len(pair_keys)
    if n_pairs == 0:
        return []

    sigma_sums = sigma_sums[:n_pairs]
    total_weight = total_weight[:n_pairs]

    # Per-pair normalized sigma (legacy: sums / total_weight when positive, else
    # the raw sums) and baseline = mean of the pair's positive sigma entries.
    sigma = sigma_sums.copy()
    positive_total = total_weight > 0.0
    sigma[positive_total] = sigma_sums[positive_total] / total_weight[positive_total, None]
    positive_sigma = sigma > 0.0
    positive_count = positive_sigma.sum(axis=1)
    positive_sum = np.where(positive_sigma, sigma, 0.0).sum(axis=1)
    baseline = np.zeros(n_pairs, dtype=np.float64)
    has_positive = positive_count > 0
    baseline[has_positive] = positive_sum[has_positive] / positive_count[has_positive]

    # Pass 2 — project each incidence's density-weighted contribution. With
    # bundle.w == total_weight[pair], the per-edge formula
    # ``bundle.w * (edge_weight / bundle.w) * share * density`` reduces to
    # ``edge_weight * share * density`` where ``share = baseline / sigma_value``
    # (multinomial_share, zero when sigma_value<=0 or baseline<=0). Guards mirror
    # bundle_attribute_inter_community_edge (zero when w<=0, edge_weight<=0,
    # or density<=0).
    projected = np.zeros(n_pairs, dtype=np.float64)
    stream = iter_boundary_edges(community_map, conn, hub_cap=hub_cap)
    while True:
        chunk = list(itertools.islice(stream, chunk_size))
        if not chunk:
            break
        pair_ids = []
        class_ids = []
        weights = []
        densities: list[float] = []
        for source, target, relation, weight, community_a, community_b in chunk:
            pair_ids.append(pair_index[(community_a, community_b)])
            class_ids.append(_relation_class_id(relation))
            weights.append(weight)
            densities.append(1.0 / max(counts.get(source, 1), counts.get(target, 1), 1))
        pair_arr = np.asarray(pair_ids, dtype=np.int64)
        class_arr = np.asarray(class_ids, dtype=np.int64)
        weight_arr = np.asarray(weights, dtype=np.float64)
        density_arr = np.asarray(densities, dtype=np.float64)
        edge_weight = np.where(weight_arr != 0.0, weight_arr, 1.0)

        sigma_value = sigma[pair_arr, class_arr]
        pair_baseline = baseline[pair_arr]
        share = np.zeros(pair_arr.shape[0], dtype=np.float64)
        share_valid = (sigma_value > 0.0) & (pair_baseline > 0.0)
        share[share_valid] = pair_baseline[share_valid] / sigma_value[share_valid]

        contribution = edge_weight * share * density_arr
        guard = (total_weight[pair_arr] > 0.0) & (edge_weight > 0.0) & (density_arr > 0.0)
        np.add.at(projected, pair_arr, np.where(guard, contribution, 0.0))

    result = [
        (pair_keys[pair_id][0], pair_keys[pair_id][1], float(projected[pair_id]))
        for pair_id in range(n_pairs)
        if projected[pair_id] > 0.0
    ]
    result.sort(key=lambda item: (item[0], item[1]))
    return result


def aggregate_bundle_attribution(
    rung: str,
    conn,
    *,
    scale: int = ATTRIBUTION_WEIGHT_SCALE,
) -> list[tuple[str, str, int]]:
    """Return positive integer L2 weights ready for existing Leiden/storage code."""
    if scale <= 0:
        raise ValueError("scale must be > 0")
    return [
        (community_a, community_b, max(1, int(round(weight * scale))))
        for community_a, community_b, weight in aggregate_bundle_attribution_float(rung, conn)
    ]


__all__ = (
    "ATTRIBUTION_WEIGHT_SCALE",
    "aggregate_bundle_attribution",
    "aggregate_bundle_attribution_float",
    "bundle_attribute_inter_community_edge",
    "relation_to_class",
)
