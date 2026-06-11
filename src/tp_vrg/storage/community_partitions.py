"""SQLite schema and CRUD helpers for per-rung community partitions."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import math
import os
from collections import defaultdict
from collections.abc import Iterator, Mapping
from datetime import datetime, timezone
from typing import Literal

Rung = Literal["asset", "island", "continent"]

_VALID_RUNGS = {"asset", "island", "continent"}
# "portable_artifact_import": membership reconstructed from an imported
# community-rung PortableArtifact (rung-migration step 4) rather than baked —
# the destination may re-bake over it at any time (Systemic Layer-2 state).
_VALID_ALGORITHMS = {
    "leiden",
    "louvain",
    "file_no_chunk_suffix_proxy",
    "portable_artifact_import",
}
_VALID_LABEL_SOURCES = {
    "asset_label_fallback",
    "file_no_chunk_suffix",
    "top_entity_name",
    "llm_summary",
    "portable_artifact_import",
}
HUB_CAP_PERCENTILE_ENV = "TPVRG_BAKE_HUB_CAP_PERCENTILE"


@dataclass(frozen=True)
class BoundaryHubCap:
    """Resolved hub cap for the bake boundary-edge stream."""

    percentile: float
    threshold: int
    hub_count: int
    capped_memberships: int
    entity_count: int


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_rung(rung: str) -> None:
    if rung not in _VALID_RUNGS:
        raise ValueError(f"Unknown community rung {rung!r}; expected {sorted(_VALID_RUNGS)}")


def _validate_algorithm(algorithm: str) -> None:
    if algorithm not in _VALID_ALGORITHMS:
        raise ValueError(
            f"Unknown partition algorithm {algorithm!r}; expected {sorted(_VALID_ALGORITHMS)}"
        )


def _validate_label_source(source: str) -> None:
    if source not in _VALID_LABEL_SOURCES:
        raise ValueError(
            f"Unknown community label source {source!r}; expected {sorted(_VALID_LABEL_SOURCES)}"
        )


def _dedupe_sorted(values: list[str]) -> list[str]:
    return sorted(dict.fromkeys(values))


def _nearest_rank_percentile(values: list[int], percentile: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = max(0, math.ceil((percentile / 100.0) * len(ordered)) - 1)
    return max(1, int(ordered[index]))


def resolve_boundary_hub_cap(
    entity_communities: Mapping[str, set[str]],
    *,
    raw_percentile: str | None = None,
) -> BoundaryHubCap | None:
    """Resolve the optional hub cap for boundary-edge aggregation.

    DEFAULT OFF: when the env flag is unset/blank, return ``None`` without
    walking the entity map. This keeps the current bake path byte-identical and
    avoids hub-set work when the quality lever is disabled.
    """
    raw = os.environ.get(HUB_CAP_PERCENTILE_ENV) if raw_percentile is None else raw_percentile
    if raw is None or not str(raw).strip():
        return None
    try:
        percentile = float(str(raw).strip())
    except ValueError as exc:
        raise ValueError(f"{HUB_CAP_PERCENTILE_ENV} must be a number > 0 and <= 100") from exc
    if percentile <= 0.0 or percentile > 100.0:
        raise ValueError(f"{HUB_CAP_PERCENTILE_ENV} must be > 0 and <= 100")

    counts = [len(communities) for communities in entity_communities.values() if communities]
    threshold = _nearest_rank_percentile(counts, percentile)
    hub_counts = [count for count in counts if count > threshold]
    return BoundaryHubCap(
        percentile=percentile,
        threshold=threshold,
        hub_count=len(hub_counts),
        capped_memberships=sum(count - threshold for count in hub_counts),
        entity_count=len(counts),
    )


def init_schema(conn) -> None:
    """Run the three-table community partition migration. Idempotent."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS community_partitions (
          rung TEXT NOT NULL,
          community_id TEXT NOT NULL,
          member_id TEXT NOT NULL,
          algorithm TEXT NOT NULL,
          baked_at TEXT NOT NULL,
          PRIMARY KEY (rung, community_id, member_id)
        );

        CREATE INDEX IF NOT EXISTS idx_community_partitions_member
          ON community_partitions (rung, member_id);

        CREATE TABLE IF NOT EXISTS community_labels (
          rung TEXT NOT NULL,
          community_id TEXT NOT NULL,
          label TEXT NOT NULL,
          label_source TEXT NOT NULL,
          computed_at TEXT NOT NULL,
          PRIMARY KEY (rung, community_id)
        );

        CREATE TABLE IF NOT EXISTS community_edges (
          rung TEXT NOT NULL,
          community_a TEXT NOT NULL,
          community_b TEXT NOT NULL,
          weight INTEGER NOT NULL,
          computed_at TEXT NOT NULL,
          PRIMARY KEY (rung, community_a, community_b)
        );
        """
    )
    conn.commit()


def clear_rung(rung: str, conn) -> None:
    """Delete partition, label, and edge rows for a rung before a full re-bake."""
    _validate_rung(rung)
    init_schema(conn)
    conn.execute("DELETE FROM community_partitions WHERE rung = ?", (rung,))
    conn.execute("DELETE FROM community_labels WHERE rung = ?", (rung,))
    conn.execute("DELETE FROM community_edges WHERE rung = ?", (rung,))
    conn.commit()


def write_partition(
    rung: str,
    community_id: str,
    member_ids: list[str],
    algorithm: str,
    conn,
) -> None:
    """Insert or replace membership rows for one community."""
    _validate_rung(rung)
    _validate_algorithm(algorithm)
    init_schema(conn)
    baked_at = _utc_now()
    members = _dedupe_sorted(member_ids)
    conn.execute(
        "DELETE FROM community_partitions WHERE rung = ? AND community_id = ?",
        (rung, community_id),
    )
    if members:
        conn.executemany(
            """
            INSERT INTO community_partitions
              (rung, community_id, member_id, algorithm, baked_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            [(rung, community_id, member_id, algorithm, baked_at) for member_id in members],
        )
    conn.commit()


def read_partition(rung: str, conn) -> dict[str, list[str]]:
    """Return ``{community_id: [member_ids]}`` for a rung."""
    _validate_rung(rung)
    init_schema(conn)
    rows = conn.execute(
        """
        SELECT community_id, member_id
        FROM community_partitions
        WHERE rung = ?
        ORDER BY community_id, member_id
        """,
        (rung,),
    ).fetchall()
    partition: dict[str, list[str]] = {}
    for community_id, member_id in rows:
        partition.setdefault(community_id, []).append(member_id)
    return partition


def write_label(rung: str, community_id: str, label: str, source: str, conn) -> None:
    """Insert or replace one community label."""
    _validate_rung(rung)
    _validate_label_source(source)
    init_schema(conn)
    conn.execute(
        """
        INSERT INTO community_labels
          (rung, community_id, label, label_source, computed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(rung, community_id) DO UPDATE SET
          label = excluded.label,
          label_source = excluded.label_source,
          computed_at = excluded.computed_at
        """,
        (rung, community_id, label, source, _utc_now()),
    )
    conn.commit()


def read_labels(rung: str, conn) -> dict[str, tuple[str, str]]:
    """Return ``{community_id: (label, label_source)}`` for a rung."""
    _validate_rung(rung)
    init_schema(conn)
    rows = conn.execute(
        """
        SELECT community_id, label, label_source
        FROM community_labels
        WHERE rung = ?
        ORDER BY community_id
        """,
        (rung,),
    ).fetchall()
    return {community_id: (label, source) for community_id, label, source in rows}


def write_community_edges(
    rung: str,
    edges: list[tuple[str, str, int]],
    conn,
) -> None:
    """Replace inter-community edges for one rung using canonical undirected pairs."""
    _validate_rung(rung)
    init_schema(conn)
    computed_at = _utc_now()
    aggregated: dict[tuple[str, str], int] = {}
    for community_a, community_b, weight in edges:
        if community_a == community_b:
            continue
        if weight <= 0:
            continue
        a, b = sorted((community_a, community_b))
        aggregated[(a, b)] = aggregated.get((a, b), 0) + int(weight)

    conn.execute("DELETE FROM community_edges WHERE rung = ?", (rung,))
    if aggregated:
        conn.executemany(
            """
            INSERT INTO community_edges
              (rung, community_a, community_b, weight, computed_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (rung, community_a, community_b, weight, computed_at)
                for (community_a, community_b), weight in sorted(aggregated.items())
            ],
        )
    conn.commit()


def read_community_edges(rung: str, conn) -> list[tuple[str, str, int]]:
    """Return ``[(community_a, community_b, weight)]`` for a rung."""
    _validate_rung(rung)
    init_schema(conn)
    rows = conn.execute(
        """
        SELECT community_a, community_b, weight
        FROM community_edges
        WHERE rung = ?
        ORDER BY community_a, community_b
        """,
        (rung,),
    ).fetchall()
    return [(community_a, community_b, int(weight)) for community_a, community_b, weight in rows]


def entity_community_map(rung: str, conn) -> dict[str, set[str]]:
    """Return ``entity_id -> {community_id}`` for ``rung`` (DISTINCT memberships).

    RAM-bounded: one entry per distinct (entity, community) membership, NOT per
    passage. This is the substrate the inter-community edge aggregation streams
    against to avoid the passage x passage fan-out (see ``iter_boundary_edges``).
    """
    _validate_rung(rung)
    init_schema(conn)
    mapping: dict[str, set[str]] = defaultdict(set)
    for entity_id, community_id in conn.execute(
        """
        SELECT DISTINCT pe.entity_id, cp.community_id
        FROM passage_entities AS pe
        JOIN community_partitions AS cp
          ON cp.rung = ?
         AND cp.member_id = pe.passage_id
        """,
        (rung,),
    ):
        mapping[str(entity_id)].add(str(community_id))
    return mapping


def _stable_cap_sort_key(entity_id: str, community_id: str, salt: str) -> tuple[int, str]:
    payload = f"{entity_id}\0{community_id}\0{salt}".encode("utf-8", errors="surrogatepass")
    digest = hashlib.blake2b(payload, digest_size=8).digest()
    return int.from_bytes(digest, "big"), community_id


def _cap_endpoint_communities(
    entity_id: str,
    communities: set[str],
    hub_cap: BoundaryHubCap,
    *,
    salt: str,
) -> tuple[str, ...] | set[str]:
    if len(communities) <= hub_cap.threshold:
        return communities
    ranked = sorted(
        communities,
        key=lambda community_id: _stable_cap_sort_key(entity_id, community_id, salt),
    )
    return tuple(ranked[: hub_cap.threshold])


def iter_boundary_edges(
    entity_communities: Mapping[str, set[str]],
    conn,
    *,
    hub_cap: BoundaryHubCap | None = None,
) -> Iterator[tuple[str, str, str, float, str, str]]:
    """Yield ``(source, target, relation, weight, community_a, community_b)`` for
    every edge crossing a community boundary, deduped to distinct canonical
    community pairs per edge.

    Memory is bounded by the caller-owned ``entity_communities`` map plus one
    edge row at a time — NOT by the passage x passage fan-out. Materializing that
    fan-out in SQL is ~3.2B intermediate rows on a real 97K graph (a >1h
    single-core wedge or temp-disk exhaustion); streaming distinct (entity,
    community) memberships collapses it to bounded work. The caller owns the map
    so multi-pass aggregations (e.g. bundle inversion) build it once.
    """
    if hub_cap is None:
        for source, target, relation, weight in conn.execute(
            "SELECT source, target, relation, COALESCE(weight, 1.0) FROM edges"
        ):
            src_communities = entity_communities.get(str(source))
            tgt_communities = entity_communities.get(str(target))
            if not src_communities or not tgt_communities:
                continue
            seen: set[tuple[str, str]] = set()
            for community_a in src_communities:
                for community_b in tgt_communities:
                    if community_a == community_b:
                        continue
                    pair = (
                        (community_a, community_b)
                        if community_a < community_b
                        else (community_b, community_a)
                    )
                    if pair in seen:
                        continue
                    seen.add(pair)
                    yield str(source), str(target), str(relation), float(weight), pair[0], pair[1]
        return

    for source, target, relation, weight in conn.execute(
        "SELECT source, target, relation, COALESCE(weight, 1.0) FROM edges"
    ):
        source_id = str(source)
        target_id = str(target)
        relation_id = str(relation)
        src_raw = entity_communities.get(source_id)
        tgt_raw = entity_communities.get(target_id)
        if not src_raw or not tgt_raw:
            continue
        src_communities = _cap_endpoint_communities(
            source_id,
            src_raw,
            hub_cap,
            salt=f"source\0{target_id}\0{relation_id}",
        )
        tgt_communities = _cap_endpoint_communities(
            target_id,
            tgt_raw,
            hub_cap,
            salt=f"target\0{source_id}\0{relation_id}",
        )
        if not src_communities or not tgt_communities:
            continue
        seen: set[tuple[str, str]] = set()
        for community_a in src_communities:
            for community_b in tgt_communities:
                if community_a == community_b:
                    continue
                pair = (
                    (community_a, community_b)
                    if community_a < community_b
                    else (community_b, community_a)
                )
                if pair in seen:
                    continue
                seen.add(pair)
                yield source_id, target_id, relation_id, float(weight), pair[0], pair[1]
