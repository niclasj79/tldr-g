"""Asset-rung partition bake using the file_no_chunk_suffix proxy."""

from __future__ import annotations

import re
from collections import defaultdict

from tp_vrg.cardinality import probe
from tp_vrg.storage.community_partitions import (
    clear_rung,
    entity_community_map,
    init_schema,
    iter_boundary_edges,
    read_community_edges,
    resolve_boundary_hub_cap,
    write_community_edges,
    write_label,
    write_partition,
)
from tp_vrg.storage.per_rung_centroids import recompute_centroids_for_rung

ASSET_ALGORITHM = "file_no_chunk_suffix_proxy"
ASSET_RUNG = "asset"
_CHUNK_SUFFIX_RE = re.compile(r"\[chunk-\d+\]$")
_MISSING_SOURCE_GROUP = "__missing_source_label__"
_INTER_ASSET_MAX_INTERMEDIATE = 1_000_000_000
_INTER_ASSET_MAX_WALL_S = 300.0


def file_no_chunk_suffix(source_label: str) -> str:
    """Return the EXP-067 Asset proxy: full source label minus trailing chunk suffix."""
    label = (source_label or "").strip()
    if not label:
        return _MISSING_SOURCE_GROUP
    return _CHUNK_SUFFIX_RE.sub("", label)


def asset_community_id(group_name: str) -> str:
    """Return the stable Asset-rung community id for a file proxy group."""
    return f"asset:{group_name}"


def _read_passage_sources(conn) -> list[tuple[str, str]]:
    rows = conn.execute(
        """
        SELECT passage_id, source_label
        FROM passages
        ORDER BY passage_id
        """
    ).fetchall()
    return [(str(passage_id), str(source_label or "")) for passage_id, source_label in rows]


def bake_asset_rung_partition(conn) -> dict[str, list[str]]:
    """Build and persist the Asset-rung partition from file_no_chunk_suffix.

    Each unique file_no_chunk_suffix value defines one Asset-rung community.
    Member passages are all passages with that proxy value.
    """
    rows = _read_passage_sources(conn)
    if not rows:
        raise ValueError("Cannot bake Asset-rung partition: passages table is empty")

    grouped: dict[str, list[str]] = defaultdict(list)
    for passage_id, source_label in rows:
        grouped[asset_community_id(file_no_chunk_suffix(source_label))].append(passage_id)

    partition = {community_id: sorted(member_ids) for community_id, member_ids in sorted(grouped.items())}
    clear_rung(ASSET_RUNG, conn)
    for community_id, member_ids in partition.items():
        write_partition(ASSET_RUNG, community_id, member_ids, ASSET_ALGORITHM, conn)
    return partition


def _asset_group_from_community_id(community_id: str) -> str:
    prefix = "asset:"
    return community_id[len(prefix):] if community_id.startswith(prefix) else community_id


def bake_asset_rung_labels(
    partition: dict[str, list[str]],
    conn,
) -> dict[str, tuple[str, str]]:
    """Persist stub labels for Asset-rung communities.

    Label text is the file_no_chunk_suffix proxy value, truncated to 50 chars.
    """
    labels: dict[str, tuple[str, str]] = {}
    for community_id in sorted(partition):
        group_name = _asset_group_from_community_id(community_id)
        label = group_name[:50]
        labels[community_id] = (label, "file_no_chunk_suffix")
        write_label(ASSET_RUNG, community_id, label, "file_no_chunk_suffix", conn)
    return labels


def _passage_to_asset(partition: dict[str, list[str]]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    duplicates: set[str] = set()
    for community_id, member_ids in partition.items():
        for member_id in member_ids:
            if member_id in mapping:
                duplicates.add(member_id)
            mapping[member_id] = community_id
    if duplicates:
        raise ValueError(
            "Asset-rung partition assigns passages to multiple communities: "
            f"{sorted(duplicates)[:10]}"
        )
    return mapping


def compute_inter_asset_edges(
    partition: dict[str, list[str]],
    conn,
    *,
    cardinality_strict: bool = False,
    max_intermediate: int | None = _INTER_ASSET_MAX_INTERMEDIATE,
    max_wall_s: float | None = _INTER_ASSET_MAX_WALL_S,
) -> list[tuple[str, str, int]]:
    """Aggregate entity-edge contributions into canonical inter-Asset edges."""
    passage_assets = _passage_to_asset(partition)
    if not passage_assets:
        raise ValueError("Cannot compute inter-Asset edges for an empty partition")

    init_schema(conn)
    persisted_count = conn.execute(
        "SELECT COUNT(*) FROM community_partitions WHERE rung = ?",
        (ASSET_RUNG,),
    ).fetchone()[0]
    if int(persisted_count) == 0:
        raise ValueError(
            "Cannot compute inter-Asset edges: Asset-rung partition is not persisted"
        )

    # Count distinct edges crossing each canonical Asset pair by STREAMING the
    # deduped entity->community memberships. Joining passage_entities twice on
    # entity_id (the naive form) fans out to (passages-with-src) x
    # (passages-with-tgt) rows per edge — ~3.2B intermediate rows on the real
    # 97K graph (a >1h single-core wedge / temp-disk exhaustion). An entity
    # belongs to a SET of communities, not a list of passages; streaming
    # distinct memberships yields identical COUNT(DISTINCT edge) output with
    # bounded memory (the weights dict) and no fan-out materialization.
    community_map = entity_community_map(ASSET_RUNG, conn)
    hub_cap = resolve_boundary_hub_cap(community_map)
    edge_count = int(conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0])
    weights: dict[tuple[str, str], int] = defaultdict(int)
    with probe(
        "bake.inter_asset_edges",
        input_rows=edge_count,
        max_intermediate=max_intermediate,
        max_wall_s=max_wall_s,
        strict=cardinality_strict,
    ) as cardinality_probe:
        for _source, _target, _relation, _weight, community_a, community_b in iter_boundary_edges(
            community_map, conn, hub_cap=hub_cap
        ):
            cardinality_probe.intermediate += 1
            weights[(community_a, community_b)] += 1
        cardinality_probe.output = len(weights)

    return [
        (community_a, community_b, weight)
        for (community_a, community_b), weight in sorted(weights.items())
    ]


def bake_asset_rung_edges(
    partition: dict[str, list[str]],
    conn,
) -> list[tuple[str, str, int]]:
    """Persist simple-count inter-Asset edges and return the baked edge list."""
    edges = compute_inter_asset_edges(partition, conn)
    write_community_edges(ASSET_RUNG, edges, conn)
    return read_community_edges(ASSET_RUNG, conn)


def bake_asset_rung(conn, *, recompute_centroids: bool = True) -> dict[str, list[str]]:
    """Bake Asset membership, labels, edges, and derived centroids."""
    partition = bake_asset_rung_partition(conn)
    bake_asset_rung_labels(partition, conn)
    bake_asset_rung_edges(partition, conn)
    if recompute_centroids:
        recompute_centroids_for_rung(ASSET_RUNG, conn)
    return partition
