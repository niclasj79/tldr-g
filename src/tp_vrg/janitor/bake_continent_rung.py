"""Continent-rung partition bake over the inter-Island graph."""

from __future__ import annotations

import asyncio
from collections import Counter, defaultdict
from collections.abc import Iterable

import networkx as nx

from tp_vrg.janitor.bake_island_rung import (
    PARTITION_RANDOM_SEED,
    PARTITION_RESOLUTION,
    PartitionAlgorithm,
    get_partition_algorithm,
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

CONTINENT_RUNG = "continent"
ISLAND_RUNG = "island"
CONTINENT_ID_PREFIX = "continent:lv2_"


def _read_island_ids(conn) -> list[str]:
    island_partition = read_partition(ISLAND_RUNG, conn)
    island_ids = sorted(island_partition)
    if not island_ids:
        raise ValueError("Cannot bake Continent-rung partition: Island-rung partition is empty")
    return island_ids


def _validate_island_edges(
    island_ids: list[str],
    island_edges: list[tuple[str, str, int]],
) -> None:
    island_id_set = set(island_ids)
    unknown = sorted(
        {
            community_id
            for community_a, community_b, _weight in island_edges
            for community_id in (community_a, community_b)
            if community_id not in island_id_set
        }
    )
    if unknown:
        raise ValueError(
            "Inter-Island edges reference communities missing from the Island-rung "
            f"partition: {unknown[:10]}"
        )


def _singleton_partition(island_ids: list[str]) -> dict[str, list[str]]:
    return _communities_to_partition(([island_id] for island_id in island_ids), island_ids)


def _communities_to_partition(
    communities: Iterable[Iterable[str]],
    expected_island_ids: list[str],
) -> dict[str, list[str]]:
    groups = [sorted(dict.fromkeys(group)) for group in communities]
    groups = [group for group in groups if group]
    groups.sort(key=lambda group: (group[0], len(group), group))

    assigned = [island_id for group in groups for island_id in group]
    expected = sorted(expected_island_ids)
    if sorted(assigned) != expected or len(assigned) != len(set(assigned)):
        raise ValueError("Community algorithm did not assign each Island exactly once")

    return {
        f"{CONTINENT_ID_PREFIX}{idx:04d}": group
        for idx, group in enumerate(groups)
    }


def _run_leiden(
    island_ids: list[str],
    island_edges: list[tuple[str, str, int]],
) -> dict[str, list[str]]:
    if not island_edges:
        return _singleton_partition(island_ids)

    try:
        import igraph as ig
        import leidenalg
    except ImportError as exc:  # pragma: no cover - exercised only in missing-dep envs.
        raise ImportError(
            "Leiden partitioning requires the 'leidenalg' and 'igraph' packages. "
            "Install the project dependencies before baking Continent-rung partitions."
        ) from exc

    index_by_island = {island_id: idx for idx, island_id in enumerate(island_ids)}
    graph = ig.Graph()
    graph.add_vertices(len(island_ids))
    graph.vs["name"] = island_ids
    graph.add_edges(
        [
            (index_by_island[community_a], index_by_island[community_b])
            for community_a, community_b, _ in island_edges
        ]
    )
    weights = [max(1, int(weight)) for _community_a, _community_b, weight in island_edges]
    partition = leidenalg.find_partition(
        graph,
        leidenalg.RBConfigurationVertexPartition,
        weights=weights,
        resolution_parameter=PARTITION_RESOLUTION,
        seed=PARTITION_RANDOM_SEED,
    )

    communities: dict[int, list[str]] = defaultdict(list)
    for island_id, community_idx in zip(island_ids, partition.membership, strict=True):
        communities[int(community_idx)].append(island_id)
    return _communities_to_partition(communities.values(), island_ids)


def _run_louvain(
    island_ids: list[str],
    island_edges: list[tuple[str, str, int]],
) -> dict[str, list[str]]:
    if not island_edges:
        return _singleton_partition(island_ids)

    graph = nx.Graph()
    graph.add_nodes_from(island_ids)
    graph.add_weighted_edges_from(
        (community_a, community_b, max(1, int(weight)))
        for community_a, community_b, weight in island_edges
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
        for island_id, community_idx in assignments.items():
            grouped[int(community_idx)].append(island_id)
        return _communities_to_partition(grouped.values(), island_ids)
    except (ImportError, AttributeError):
        communities = nx.community.louvain_communities(
            graph,
            weight="weight",
            resolution=PARTITION_RESOLUTION,
            seed=PARTITION_RANDOM_SEED,
        )
        return _communities_to_partition(communities, island_ids)


def bake_continent_rung_partition(
    island_rung_edges: list[tuple[str, str, int]],
    conn,
) -> dict[str, list[str]]:
    """Build and persist Continent-rung membership from the inter-Island graph."""
    island_ids = _read_island_ids(conn)
    _validate_island_edges(island_ids, island_rung_edges)

    algorithm: PartitionAlgorithm = get_partition_algorithm()
    if algorithm == "leiden":
        partition = _run_leiden(island_ids, island_rung_edges)
    else:
        partition = _run_louvain(island_ids, island_rung_edges)

    clear_rung(CONTINENT_RUNG, conn)
    for community_id, member_ids in partition.items():
        write_partition(CONTINENT_RUNG, community_id, member_ids, algorithm, conn)
    return partition


async def bake_continent_rung_partition_async(
    island_rung_edges: list[tuple[str, str, int]],
    conn,
) -> dict[str, list[str]]:
    """Event-loop-safe Continent-rung partition bake for async janitor callers."""
    return await asyncio.to_thread(bake_continent_rung_partition, island_rung_edges, conn)


def bake_continent_rung_labels(
    partition: dict[str, list[str]],
    conn,
) -> dict[str, tuple[str, str]]:
    """Persist Continent labels from the most frequent member-Island label."""
    island_labels = read_labels(ISLAND_RUNG, conn)
    labels: dict[str, tuple[str, str]] = {}
    for continent_id, island_ids in sorted(partition.items()):
        counter: Counter[str] = Counter()
        for island_id in island_ids:
            label, _source = island_labels.get(island_id, (island_id, "top_entity_name"))
            counter.update([label])
        if not counter:
            raise ValueError(f"Cannot label Continent community {continent_id!r}: no Islands found")
        top_count = max(counter.values())
        top_labels = sorted(label for label, count in counter.items() if count == top_count)
        label = top_labels[0][:50]
        labels[continent_id] = (label, "top_entity_name")
        write_label(CONTINENT_RUNG, continent_id, label, "top_entity_name", conn)
    return labels


def compute_inter_continent_edges(
    partition: dict[str, list[str]],
    island_rung_edges: list[tuple[str, str, int]],
) -> list[tuple[str, str, int]]:
    """Aggregate L2-weighted inter-Island edges into inter-Continent edges."""
    island_to_continent: dict[str, str] = {}
    duplicates: set[str] = set()
    for continent_id, island_ids in partition.items():
        for island_id in island_ids:
            if island_id in island_to_continent:
                duplicates.add(island_id)
            island_to_continent[island_id] = continent_id
    if duplicates:
        raise ValueError(
            "Continent-rung partition assigns Islands to multiple communities: "
            f"{sorted(duplicates)[:10]}"
        )
    if not island_to_continent:
        raise ValueError("Cannot compute inter-Continent edges for an empty partition")

    counts: dict[tuple[str, str], int] = defaultdict(int)
    for island_a, island_b, weight in island_rung_edges:
        continent_a = island_to_continent.get(island_a)
        continent_b = island_to_continent.get(island_b)
        if continent_a is None or continent_b is None:
            raise ValueError(
                "Inter-Island edge references an Island missing from the Continent-rung "
                f"partition: {island_a!r}, {island_b!r}"
            )
        if continent_a == continent_b:
            continue
        community_a, community_b = sorted((continent_a, continent_b))
        counts[(community_a, community_b)] += int(weight)

    return [
        (community_a, community_b, weight)
        for (community_a, community_b), weight in sorted(counts.items())
    ]


def bake_continent_rung_edges(
    partition: dict[str, list[str]],
    island_rung_edges: list[tuple[str, str, int]],
    conn,
) -> list[tuple[str, str, int]]:
    """Persist L2-weighted inter-Continent edges and return the baked edge list."""
    edges = compute_inter_continent_edges(partition, island_rung_edges)
    write_community_edges(CONTINENT_RUNG, edges, conn)
    return read_community_edges(CONTINENT_RUNG, conn)


def bake_continent_rung(conn, *, recompute_centroids: bool = True) -> dict[str, list[str]]:
    """Bake Continent membership, labels, inter-Continent edges, and centroids."""
    island_edges = read_community_edges(ISLAND_RUNG, conn)
    partition = bake_continent_rung_partition(island_edges, conn)
    bake_continent_rung_labels(partition, conn)
    bake_continent_rung_edges(partition, island_edges, conn)
    if recompute_centroids:
        recompute_centroids_for_rung(CONTINENT_RUNG, conn)
    return partition
