"""Island-rung partition bake over the inter-Asset graph."""

from __future__ import annotations

import asyncio
from collections import Counter, defaultdict
from collections.abc import Iterable
import json
import os
import sqlite3
from typing import Literal

import networkx as nx

from tp_vrg.algebra.inversion import aggregate_bundle_attribution
from tp_vrg.models import (
    DEFAULT_PARTITION_ALGORITHM,
    PARTITION_SIMILARITY_WEIGHT_ENV,
    PARTITION_USE_SIMILARITY_ENV,
    TPVRG_PARTITION_SIMILARITY_WEIGHT,
    TPVRG_PARTITION_USE_SIMILARITY,
)
from tp_vrg.storage.community_partitions import (
    clear_rung,
    read_community_edges,
    read_labels,
    read_partition,
    write_community_edges,
    write_label,
    write_partition,
)
from tp_vrg.storage.per_rung_centroids import recompute_centroids_for_rung

PartitionAlgorithm = Literal["leiden", "louvain"]

ISLAND_RUNG = "island"
ASSET_RUNG = "asset"
ISLAND_ID_PREFIX = "island:lv1_"
PARTITION_ALGORITHM_ENV = "TPVRG_PARTITION_ALGORITHM"
PARTITION_RANDOM_SEED = 42
# Leiden community-granularity knob (γ for RBConfigurationVertexPartition); env-tunable
# (mirrors TPVRG_PARTITION_SIMILARITY_WEIGHT). Default 1.0 is byte-identical. γ>1 → more,
# smaller communities; γ<1 → fewer, larger. Never varied before 2026-06-08 — the partition-
# degeneracy sweep revealed it was a hardcoded constant (the granularity knob we should have
# been sweeping instead of the saturated similarity weight). Both island + continent rungs use it.
PARTITION_RESOLUTION = float((os.environ.get("TPVRG_PARTITION_RESOLUTION") or "1.0").strip())
_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"", "0", "false", "no", "off"}


def get_partition_algorithm(raw_value: str | None = None) -> PartitionAlgorithm:
    """Resolve the active partition algorithm from env or canonical default."""
    configured = os.environ.get(PARTITION_ALGORITHM_ENV) if raw_value is None else raw_value
    candidate = (configured or DEFAULT_PARTITION_ALGORITHM).strip().lower()
    if candidate not in {"leiden", "louvain"}:
        raise ValueError(
            f"{PARTITION_ALGORITHM_ENV}={candidate!r} not in ['leiden', 'louvain']"
        )
    return candidate  # type: ignore[return-value]


def partition_similarity_objective_enabled(raw_value: str | None = None) -> bool:
    """Resolve whether Asset similarity edges feed the Island partition objective."""
    configured = (
        os.environ.get(PARTITION_USE_SIMILARITY_ENV)
        if raw_value is None
        else raw_value
    )
    if configured is None:
        return TPVRG_PARTITION_USE_SIMILARITY
    candidate = str(configured).strip().lower()
    if candidate in _TRUE_VALUES:
        return True
    if candidate in _FALSE_VALUES:
        return False
    raise ValueError(
        f"{PARTITION_USE_SIMILARITY_ENV}={candidate!r} must be one of "
        f"{sorted(_TRUE_VALUES | _FALSE_VALUES)}"
    )


def get_partition_similarity_weight(raw_value: str | None = None) -> float:
    """Resolve the cosine-to-integer multiplier for partition similarity edges."""
    configured = (
        os.environ.get(PARTITION_SIMILARITY_WEIGHT_ENV)
        if raw_value is None
        else raw_value
    )
    if configured is None or not str(configured).strip():
        weight = TPVRG_PARTITION_SIMILARITY_WEIGHT
    else:
        try:
            weight = float(str(configured).strip())
        except ValueError as exc:
            raise ValueError(f"{PARTITION_SIMILARITY_WEIGHT_ENV} must be > 0") from exc
    if weight <= 0.0:
        raise ValueError(f"{PARTITION_SIMILARITY_WEIGHT_ENV} must be > 0")
    return weight


def _read_asset_ids(conn) -> list[str]:
    asset_partition = read_partition(ASSET_RUNG, conn)
    asset_ids = sorted(asset_partition)
    if not asset_ids:
        raise ValueError("Cannot bake Island-rung partition: Asset-rung partition is empty")
    return asset_ids


def _validate_asset_edges(
    asset_ids: list[str],
    asset_edges: list[tuple[str, str, int]],
) -> None:
    asset_id_set = set(asset_ids)
    unknown = sorted(
        {
            community_id
            for community_a, community_b, _weight in asset_edges
            for community_id in (community_a, community_b)
            if community_id not in asset_id_set
        }
    )
    if unknown:
        raise ValueError(
            "Inter-Asset edges reference communities missing from the Asset-rung "
            f"partition: {unknown[:10]}"
        )


def _cosine_to_partition_weight(cosine: float, multiplier: float) -> int:
    if cosine <= 0.0:
        return 0
    return max(1, int(round(float(cosine) * multiplier)))


def _merge_asset_edge_weights(
    asset_edges: Iterable[tuple[str, str, int]],
    similarity_edges: Iterable[tuple[str, str, int]],
) -> list[tuple[str, str, int]]:
    counts: dict[tuple[str, str], int] = defaultdict(int)
    for edge_iter in (asset_edges, similarity_edges):
        for asset_a, asset_b, weight in edge_iter:
            if asset_a == asset_b or int(weight) <= 0:
                continue
            community_a, community_b = sorted((str(asset_a), str(asset_b)))
            counts[(community_a, community_b)] += int(weight)
    return [
        (community_a, community_b, weight)
        for (community_a, community_b), weight in sorted(counts.items())
    ]


def fold_partition_similarity_edges(
    asset_edges: list[tuple[str, str, int]],
    conn,
) -> list[tuple[str, str, int]]:
    """Fold baked Asset similarity edges into the Island partition graph.

    DEFAULT OFF: when the flag is unset/false, return the existing edge list
    directly and do not touch the similarity-edge schema or storage path.
    """
    if not partition_similarity_objective_enabled():
        return asset_edges

    asset_ids = _read_asset_ids(conn)
    asset_id_set = set(asset_ids)
    multiplier = get_partition_similarity_weight()

    from tp_vrg.storage.similarity_edges import read_similarity_edges

    similarity_asset_edges: list[tuple[str, str, int]] = []
    for edge in read_similarity_edges(ASSET_RUNG, conn, src_ids=asset_ids):
        src_id = str(edge.src_id)
        tgt_id = str(edge.tgt_id)
        if src_id not in asset_id_set or tgt_id not in asset_id_set:
            continue
        weight = _cosine_to_partition_weight(float(edge.cosine), multiplier)
        if weight <= 0:
            continue
        community_a, community_b = sorted((src_id, tgt_id))
        similarity_asset_edges.append((community_a, community_b, weight))

    return _merge_asset_edge_weights(asset_edges, similarity_asset_edges)


def _singleton_partition(asset_ids: list[str]) -> dict[str, list[str]]:
    return _communities_to_partition(([asset_id] for asset_id in asset_ids), asset_ids)


def _communities_to_partition(
    communities: Iterable[Iterable[str]],
    expected_asset_ids: list[str],
) -> dict[str, list[str]]:
    groups = [sorted(dict.fromkeys(group)) for group in communities]
    groups = [group for group in groups if group]
    groups.sort(key=lambda group: (group[0], len(group), group))

    assigned = [asset_id for group in groups for asset_id in group]
    expected = sorted(expected_asset_ids)
    if sorted(assigned) != expected or len(assigned) != len(set(assigned)):
        raise ValueError("Community algorithm did not assign each Asset exactly once")

    return {
        f"{ISLAND_ID_PREFIX}{idx:04d}": group
        for idx, group in enumerate(groups)
    }


def _run_leiden(
    asset_ids: list[str],
    asset_edges: list[tuple[str, str, int]],
) -> dict[str, list[str]]:
    if not asset_edges:
        return _singleton_partition(asset_ids)

    try:
        import igraph as ig
        import leidenalg
    except ImportError as exc:  # pragma: no cover - exercised only in missing-dep envs.
        raise ImportError(
            "Leiden partitioning requires the 'leidenalg' and 'igraph' packages. "
            "Install the project dependencies before baking Island-rung partitions."
        ) from exc

    index_by_asset = {asset_id: idx for idx, asset_id in enumerate(asset_ids)}
    graph = ig.Graph()
    graph.add_vertices(len(asset_ids))
    graph.vs["name"] = asset_ids
    graph.add_edges(
        [
            (index_by_asset[community_a], index_by_asset[community_b])
            for community_a, community_b, _ in asset_edges
        ]
    )
    weights = [max(1, int(weight)) for _community_a, _community_b, weight in asset_edges]
    partition = leidenalg.find_partition(
        graph,
        leidenalg.RBConfigurationVertexPartition,
        weights=weights,
        resolution_parameter=PARTITION_RESOLUTION,
        seed=PARTITION_RANDOM_SEED,
    )

    communities: dict[int, list[str]] = defaultdict(list)
    for asset_id, community_idx in zip(asset_ids, partition.membership, strict=True):
        communities[int(community_idx)].append(asset_id)
    return _communities_to_partition(communities.values(), asset_ids)


def _run_louvain(
    asset_ids: list[str],
    asset_edges: list[tuple[str, str, int]],
) -> dict[str, list[str]]:
    if not asset_edges:
        return _singleton_partition(asset_ids)

    graph = nx.Graph()
    graph.add_nodes_from(asset_ids)
    graph.add_weighted_edges_from(
        (community_a, community_b, max(1, int(weight)))
        for community_a, community_b, weight in asset_edges
    )

    try:
        from community import community_louvain

        assignments = community_louvain.best_partition(
            graph,
            weight="weight",
            resolution=PARTITION_RESOLUTION,
            random_state=PARTITION_RANDOM_SEED,
        )
        grouped: dict[int, list[str]] = defaultdict(list)
        for asset_id, community_idx in assignments.items():
            grouped[int(community_idx)].append(asset_id)
        return _communities_to_partition(grouped.values(), asset_ids)
    except (ImportError, AttributeError):
        communities = nx.community.louvain_communities(
            graph,
            weight="weight",
            resolution=PARTITION_RESOLUTION,
            seed=PARTITION_RANDOM_SEED,
        )
        return _communities_to_partition(communities, asset_ids)


def bake_island_rung_partition(
    asset_rung_edges: list[tuple[str, str, int]],
    conn,
) -> dict[str, list[str]]:
    """Build and persist Island-rung membership from the inter-Asset graph."""
    asset_ids = _read_asset_ids(conn)
    _validate_asset_edges(asset_ids, asset_rung_edges)

    algorithm = get_partition_algorithm()
    if algorithm == "leiden":
        partition = _run_leiden(asset_ids, asset_rung_edges)
    else:
        partition = _run_louvain(asset_ids, asset_rung_edges)

    clear_rung(ISLAND_RUNG, conn)
    for community_id, member_ids in partition.items():
        write_partition(ISLAND_RUNG, community_id, member_ids, algorithm, conn)
    return partition


async def bake_island_rung_partition_async(
    asset_rung_edges: list[tuple[str, str, int]],
    conn,
) -> dict[str, list[str]]:
    """Event-loop-safe Island-rung partition bake for async janitor callers."""
    return await asyncio.to_thread(bake_island_rung_partition, asset_rung_edges, conn)


def _read_asset_passage_ids(conn) -> dict[str, list[str]]:
    return read_partition(ASSET_RUNG, conn)


def _read_passage_entity_ids(conn) -> dict[str, list[str]]:
    try:
        rows = conn.execute("SELECT passage_id, entity_ids FROM passages").fetchall()
    except sqlite3.OperationalError as exc:
        raise ValueError("Cannot label Island-rung partitions: passages table is missing") from exc

    passage_entities: dict[str, list[str]] = {}
    for passage_id, entity_ids_json in rows:
        try:
            parsed = json.loads(entity_ids_json or "[]")
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid entity_ids JSON for passage {passage_id!r}") from exc
        if not isinstance(parsed, list):
            raise ValueError(f"Passage {passage_id!r} entity_ids is not a JSON list")
        passage_entities[str(passage_id)] = [str(entity_id) for entity_id in parsed if entity_id]
    return passage_entities


def _read_entity_names(conn) -> dict[str, str]:
    try:
        rows = conn.execute("SELECT entity_id, name FROM nodes").fetchall()
    except sqlite3.OperationalError as exc:
        raise ValueError("Cannot label Island-rung partitions: nodes table is missing") from exc
    return {str(entity_id): str(name or entity_id) for entity_id, name in rows}


def bake_island_rung_labels(
    partition: dict[str, list[str]],
    conn,
) -> dict[str, tuple[str, str]]:
    """Persist Island labels from the most frequent entity name in member Assets."""
    asset_passages = _read_asset_passage_ids(conn)
    passage_entities = _read_passage_entity_ids(conn)
    entity_names = _read_entity_names(conn)
    asset_labels = read_labels(ASSET_RUNG, conn)

    labels: dict[str, tuple[str, str]] = {}
    for island_id, asset_ids in sorted(partition.items()):
        counter: Counter[str] = Counter()
        for asset_id in asset_ids:
            for passage_id in asset_passages.get(asset_id, []):
                counter.update(passage_entities.get(passage_id, []))
        if counter:
            top_count = max(counter.values())
            top_entity_ids = sorted(
                entity_id for entity_id, count in counter.items() if count == top_count
            )
            top_entity_id = top_entity_ids[0]
            label = entity_names.get(top_entity_id, top_entity_id)[:50]
            source = "top_entity_name"
        else:
            fallback_counter: Counter[str] = Counter()
            for asset_id in asset_ids:
                fallback_label, _fallback_source = asset_labels.get(asset_id, (asset_id, "asset_id"))
                fallback_counter.update([fallback_label])
            if not fallback_counter:
                raise ValueError(f"Cannot label Island community {island_id!r}: no Assets found")
            top_count = max(fallback_counter.values())
            top_labels = sorted(
                label for label, count in fallback_counter.items() if count == top_count
            )
            label = top_labels[0][:50]
            source = "asset_label_fallback"

        labels[island_id] = (label, source)
        write_label(ISLAND_RUNG, island_id, label, source, conn)
    return labels


def compute_inter_island_edges(
    partition: dict[str, list[str]],
    asset_rung_edges: list[tuple[str, str, int]],
) -> list[tuple[str, str, int]]:
    """Aggregate L2-weighted inter-Asset edges into inter-Island edges."""
    asset_to_island: dict[str, str] = {}
    duplicates: set[str] = set()
    for island_id, asset_ids in partition.items():
        for asset_id in asset_ids:
            if asset_id in asset_to_island:
                duplicates.add(asset_id)
            asset_to_island[asset_id] = island_id
    if duplicates:
        raise ValueError(
            "Island-rung partition assigns Assets to multiple communities: "
            f"{sorted(duplicates)[:10]}"
        )
    if not asset_to_island:
        raise ValueError("Cannot compute inter-Island edges for an empty partition")

    counts: dict[tuple[str, str], int] = defaultdict(int)
    for asset_a, asset_b, weight in asset_rung_edges:
        island_a = asset_to_island.get(asset_a)
        island_b = asset_to_island.get(asset_b)
        if island_a is None or island_b is None:
            raise ValueError(
                "Inter-Asset edge references an Asset missing from the Island-rung partition: "
                f"{asset_a!r}, {asset_b!r}"
            )
        if island_a == island_b:
            continue
        community_a, community_b = sorted((island_a, island_b))
        counts[(community_a, community_b)] += int(weight)

    return [
        (community_a, community_b, weight)
        for (community_a, community_b), weight in sorted(counts.items())
    ]


def bake_island_rung_edges(
    partition: dict[str, list[str]],
    asset_rung_edges: list[tuple[str, str, int]],
    conn,
) -> list[tuple[str, str, int]]:
    """Persist L2-weighted inter-Island edges and return the baked edge list."""
    edges = compute_inter_island_edges(partition, asset_rung_edges)
    write_community_edges(ISLAND_RUNG, edges, conn)
    return read_community_edges(ISLAND_RUNG, conn)


def bake_island_rung(conn, *, recompute_centroids: bool = True) -> dict[str, list[str]]:
    """Bake Island membership, labels, inter-Island edges, and derived centroids."""
    asset_edges = aggregate_bundle_attribution(ASSET_RUNG, conn)
    asset_edges = fold_partition_similarity_edges(asset_edges, conn)
    partition = bake_island_rung_partition(asset_edges, conn)
    bake_island_rung_labels(partition, conn)
    bake_island_rung_edges(partition, asset_edges, conn)
    if recompute_centroids:
        recompute_centroids_for_rung(ISLAND_RUNG, conn)
    return partition
