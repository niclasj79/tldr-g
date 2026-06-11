"""Graph-view shape helpers for the multi-resolution graph browser endpoint.

This module powers the `/graph/view` HTTP API endpoint and its MCP-side
equivalent. It produces bounded, server-fed geometry for the Cockpit's
2D multi-resolution graph browser per [[prd-cockpit-ux-sprint-2026-04-12.md]]
U9 (reframed 2026-05-21 per Codex commit `419366d`).

Design principles:

1. **Doctrine A — read-paths-never-compute.** This module never runs community
   detection, graph-wide NetworkX construction, or expensive layout computation
   on a hot read path. It reads from already-baked Janitor partitions /
   centroids / community_edges tables.

2. **Stable layout cache.** Coordinates are deterministic per (rung, parent_id)
   given a fixed `graph_state_token`. Cache invalidation is implicit through
   the token: clients that pass a stale token see the latest token in the
   response and decide whether to refetch.

3. **Bounded geometry.** Each response returns ≤`DEFAULT_TOP_K` nodes/edges
   (default 1500). Larger sets are top-K-by-member-count for nodes and
   top-K-by-weight for edges; the response includes `truncated` flag and
   `total_*` fields so the client can show "showing N of M" UI.

4. **Stale-substrate signaling.** If the `community_centroids` /
   `community_partitions` substrate is missing or empty, the response returns
   `{available: False, reason: ...}` instead of silently falling back to a
   misleading flat-graph view.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, asdict
from typing import Any, Mapping

from tp_vrg.storage.per_rung_centroids import (
    VALID_CENTROID_RUNGS,
    centroid_counts,
)


VALID_VIEW_RUNGS: tuple[str, ...] = ("continent", "island", "asset", "passage")
DEFAULT_TOP_K = 1500
LAYOUT_VERSION = "v1-deterministic-circular"
_LAYOUT_CACHE_MAX = 64
_LAYOUT_CACHE: dict[tuple[str, str, str, int], dict[str, tuple[float, float]]] = {}


@dataclass(frozen=True)
class GraphViewNode:
    """One node in the multi-resolution graph browser geometry."""

    id: str
    label: str
    label_source: str
    member_count: int
    child_count: int
    parent_id: str | None
    rung: str
    x: float
    y: float
    top_entities: list[dict[str, Any]]
    source_names: list[str]
    passage_count: int
    representative_passages: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class GraphViewEdge:
    """One edge between two nodes at the same rung."""

    source: str
    target: str
    weight: int
    rung: str
    relation_mix: list[dict[str, Any]]
    density: float
    recency: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _community_centroids_table_exists(conn) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master "
        "WHERE type = 'table' AND name = 'community_centroids'"
    ).fetchone()
    return row is not None


def _table_exists(conn, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master "
        "WHERE type IN ('table', 'virtual table') AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _read_partition(rung: str, conn) -> dict[str, list[str]]:
    """Return ``{community_id: [member_ids]}`` without mutating schema."""
    if rung not in VALID_CENTROID_RUNGS or not _table_exists(conn, "community_partitions"):
        return {}
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
        partition.setdefault(str(community_id), []).append(str(member_id))
    return partition


def _read_labels(rung: str, conn) -> dict[str, tuple[str, str]]:
    if rung not in VALID_CENTROID_RUNGS or not _table_exists(conn, "community_labels"):
        return {}
    rows = conn.execute(
        """
        SELECT community_id, label, label_source
        FROM community_labels
        WHERE rung = ?
        ORDER BY community_id
        """,
        (rung,),
    ).fetchall()
    return {str(community_id): (str(label), str(source)) for community_id, label, source in rows}


def _read_community_edges(rung: str, conn) -> list[tuple[str, str, int]]:
    if rung not in VALID_CENTROID_RUNGS or not _table_exists(conn, "community_edges"):
        return []
    rows = conn.execute(
        """
        SELECT community_a, community_b, weight
        FROM community_edges
        WHERE rung = ?
        ORDER BY community_a, community_b
        """,
        (rung,),
    ).fetchall()
    return [(str(a), str(b), int(weight)) for a, b, weight in rows]


def _safe_scalar(conn, sql: str, default: Any = None) -> Any:
    try:
        row = conn.execute(sql).fetchone()
    except Exception:
        return default
    if row is None:
        return default
    return row[0]


def compute_graph_state_token(conn) -> str:
    """Produce a stable token over the current partition + centroid state.

    The token changes whenever any rung's centroid count, partition row count,
    or community-edge count changes. Lightweight: three COUNT(*) queries.
    Returns a 16-character hex hash suitable for cache keying.
    """
    if not _community_centroids_table_exists(conn):
        return "no-substrate"

    centroid_count = sum(centroid_counts(conn).values())
    partition_row_count = _safe_scalar(conn, "SELECT COUNT(*) FROM community_partitions", 0)
    edge_row_count = _safe_scalar(conn, "SELECT COUNT(*) FROM community_edges", 0)
    label_row_count = _safe_scalar(conn, "SELECT COUNT(*) FROM community_labels", 0)
    partition_max = _safe_scalar(conn, "SELECT MAX(baked_at) FROM community_partitions", "")
    edge_max = _safe_scalar(conn, "SELECT MAX(computed_at) FROM community_edges", "")
    label_max = _safe_scalar(conn, "SELECT MAX(computed_at) FROM community_labels", "")
    passage_max = _safe_scalar(conn, "SELECT MAX(ingested_at) FROM passages", "")

    digest_input = (
        f"centroids={centroid_count}|partitions={partition_row_count}|"
        f"edges={edge_row_count}|labels={label_row_count}|"
        f"partition_max={partition_max}|edge_max={edge_max}|"
        f"label_max={label_max}|passage_max={passage_max}"
    )
    return hashlib.sha256(digest_input.encode("utf-8")).hexdigest()[:16]


def substrate_availability(conn) -> dict[str, Any]:
    """Check whether the multi-resolution substrate is queryable.

    Returns a dict with `available` flag and per-rung counts. Used by callers
    that need to surface "Bake graph structure" UI when substrate is missing
    rather than silent fall-through to flat-graph rendering.
    """
    if not _community_centroids_table_exists(conn):
        return {
            "available": False,
            "reason": "substrate_missing",
            "detail": "community_centroids table not initialized",
        }

    counts = centroid_counts(conn)
    total = sum(counts.values())
    if total == 0:
        return {
            "available": False,
            "reason": "substrate_empty",
            "detail": "no centroid rows; partition bake required",
            "counts": counts,
        }
    if not _table_exists(conn, "community_partitions"):
        return {
            "available": False,
            "reason": "partition_missing",
            "detail": "community_partitions table not initialized",
            "counts": counts,
        }
    partition_rows = _safe_scalar(conn, "SELECT COUNT(*) FROM community_partitions", 0)
    if int(partition_rows or 0) == 0:
        return {
            "available": False,
            "reason": "partition_empty",
            "detail": "no partition rows; partition bake required",
            "counts": counts,
        }

    return {
        "available": True,
        "counts": counts,
    }


def _parent_rung_for(rung: str) -> str | None:
    if rung == "continent":
        return None
    if rung == "island":
        return "continent"
    if rung == "asset":
        return "island"
    if rung == "passage":
        return "asset"
    raise ValueError(f"Unknown rung {rung!r}")


def _build_parent_index(conn, parent_rung: str | None) -> dict[str, str]:
    """Return {child_id: parent_id} for the hierarchy level above `parent_rung`.

    If `parent_rung` is None (we're at continent), returns empty dict.
    Otherwise reads the parent rung's partition and inverts to a child->parent
    lookup so we can answer "which parent does this child belong to?"
    """
    if parent_rung is None:
        return {}
    partition = _read_partition(parent_rung, conn)
    index: dict[str, str] = {}
    for parent_id, member_ids in partition.items():
        for member_id in member_ids:
            index[str(member_id)] = str(parent_id)
    return index


def _deterministic_position(community_id: str, slot: int, total: int) -> tuple[float, float]:
    """Deterministic circular layout: distribute communities on a unit circle.

    Coordinates are stable per community_id + slot index. Clients can apply
    further force-direction client-side starting from these positions, but
    the server-provided coordinates ensure consistency across reloads.
    """
    if total <= 0:
        return (0.0, 0.0)
    # Mix community_id into the angle so neighboring slots aren't always at
    # identical angles; small perturbation keeps determinism.
    hashed = int(hashlib.md5(community_id.encode("utf-8")).hexdigest()[:8], 16)
    perturb = (hashed % 1000) / 1000.0  # 0..1
    angle = 2.0 * math.pi * (slot + 0.15 * perturb) / total
    radius = 1.0
    return (round(radius * math.cos(angle), 4), round(radius * math.sin(angle), 4))


def _layout_positions(
    graph_state_token: str,
    rung: str,
    parent_id: str | None,
    community_ids: list[str],
) -> dict[str, tuple[float, float]]:
    """Return cached deterministic positions for the visible node set."""
    cache_key = (graph_state_token, rung, str(parent_id or ""), len(community_ids))
    cached = _LAYOUT_CACHE.get(cache_key)
    if cached is not None and set(cached) == set(community_ids):
        return cached

    positions = {
        community_id: _deterministic_position(community_id, slot, len(community_ids))
        for slot, community_id in enumerate(community_ids)
    }
    if len(_LAYOUT_CACHE) >= _LAYOUT_CACHE_MAX:
        _LAYOUT_CACHE.pop(next(iter(_LAYOUT_CACHE)))
    _LAYOUT_CACHE[cache_key] = positions
    return positions


def _child_rung_for(rung: str) -> str | None:
    if rung == "continent":
        return "island"
    if rung == "island":
        return "asset"
    if rung == "asset":
        return None  # children of asset are passages; not in community_partitions
    if rung == "passage":
        return None
    raise ValueError(f"Unknown rung {rung!r}")


def _descendant_passage_ids(
    conn,
    rung: str,
    community_id: str,
    member_ids: list[str],
    *,
    limit: int = 250,
) -> list[str]:
    if rung == "passage":
        return [community_id]
    if rung == "asset":
        return list(member_ids)[:limit]
    if rung == "island":
        asset_partition = _read_partition("asset", conn)
        passages: list[str] = []
        for asset_id in member_ids:
            passages.extend(asset_partition.get(str(asset_id), []))
            if len(passages) >= limit:
                break
        return passages[:limit]
    if rung == "continent":
        island_partition = _read_partition("island", conn)
        asset_partition = _read_partition("asset", conn)
        passages = []
        for island_id in member_ids:
            for asset_id in island_partition.get(str(island_id), []):
                passages.extend(asset_partition.get(str(asset_id), []))
                if len(passages) >= limit:
                    return passages[:limit]
        return passages[:limit]
    return []


def _placeholders(count: int) -> str:
    return ",".join("?" for _ in range(count))


def _passage_details(conn, passage_ids: list[str], *, limit: int = 3) -> tuple[list[str], list[dict[str, Any]]]:
    if not passage_ids or not _table_exists(conn, "passages"):
        return [], []
    subset = passage_ids[: max(limit, 1) * 20]
    rows = conn.execute(
        f"""
        SELECT passage_id, source_label, raw_text
        FROM passages
        WHERE passage_id IN ({_placeholders(len(subset))})
        ORDER BY source_label, passage_id
        """,
        subset,
    ).fetchall()
    source_names: list[str] = []
    representative: list[dict[str, Any]] = []
    for passage_id, source_label, raw_text in rows:
        label = str(source_label or "")
        if label and label not in source_names:
            source_names.append(label)
        if len(representative) < limit:
            text = str(raw_text or "")
            representative.append(
                {
                    "passage_id": str(passage_id),
                    "source_label": label,
                    "preview": text[:240],
                }
            )
    return source_names[:5], representative


def _top_entities(conn, passage_ids: list[str], *, limit: int = 5) -> list[dict[str, Any]]:
    if not passage_ids or not _table_exists(conn, "passage_entities") or not _table_exists(conn, "nodes"):
        return []
    subset = passage_ids[:500]
    rows = conn.execute(
        f"""
        SELECT pe.entity_id, COALESCE(n.name, pe.entity_id) AS name, COUNT(*) AS mentions
        FROM passage_entities pe
        LEFT JOIN nodes n ON n.entity_id = pe.entity_id
        WHERE pe.passage_id IN ({_placeholders(len(subset))})
        GROUP BY pe.entity_id, name
        ORDER BY mentions DESC, name ASC
        LIMIT ?
        """,
        [*subset, int(limit)],
    ).fetchall()
    return [
        {"id": str(entity_id), "name": str(name), "count": int(count)}
        for entity_id, name, count in rows
    ]


def _passage_view(conn, parent_id: str | None, top_k: int, graph_state_token: str) -> dict[str, Any]:
    if parent_id is None:
        return {
            "available": False,
            "reason": "parent_id_required",
            "detail": "passage rung requires parent_id (asset_id) to avoid unbounded responses",
            "rung": "passage",
            "parent_id": parent_id,
            "layout_version": LAYOUT_VERSION,
            "graph_state_token": graph_state_token,
            "nodes": [],
            "edges": [],
            "total_nodes": 0,
            "total_edges": 0,
            "truncated": False,
        }
    asset_partition = _read_partition("asset", conn)
    passage_ids = asset_partition.get(str(parent_id), [])
    total_nodes = len(passage_ids)
    visible = passage_ids[:top_k]
    positions = _layout_positions(graph_state_token, "passage", parent_id, visible)
    source_names, representative = _passage_details(conn, visible, limit=top_k)
    details_by_id = {row["passage_id"]: row for row in representative}
    nodes = [
        GraphViewNode(
            id=str(passage_id),
            label=details_by_id.get(str(passage_id), {}).get("source_label") or str(passage_id),
            label_source="source_label",
            member_count=1,
            child_count=0,
            parent_id=parent_id,
            rung="passage",
            x=positions[str(passage_id)][0],
            y=positions[str(passage_id)][1],
            top_entities=_top_entities(conn, [str(passage_id)]),
            source_names=source_names,
            passage_count=1,
            representative_passages=[
                details_by_id[str(passage_id)]
            ] if str(passage_id) in details_by_id else [],
        )
        for passage_id in visible
    ]
    return {
        "available": True,
        "rung": "passage",
        "parent_id": parent_id,
        "layout_version": LAYOUT_VERSION,
        "graph_state_token": graph_state_token,
        "counts": centroid_counts(conn),
        "nodes": [n.to_dict() for n in nodes],
        "edges": [],
        "total_nodes": total_nodes,
        "total_edges": 0,
        "truncated": total_nodes > top_k,
    }


def get_graph_view(
    conn,
    rung: str,
    *,
    parent_id: str | None = None,
    top_k: int = DEFAULT_TOP_K,
) -> dict[str, Any]:
    """Return bounded graph-view geometry for one rung.

    Reads from baked partition / label / edge / centroid tables only. No
    community detection, no graph-wide NetworkX, no expensive layout compute.

    Args:
        conn: SQLite connection (ideally from `isolated_sqlite_connection`).
        rung: one of continent / island / asset / passage.
        parent_id: optional filter; if rung is island, parent_id is the
            continent_id; if rung is asset, parent_id is the island_id.
            Required for asset rung to avoid unbounded responses on large graphs.
        top_k: hard ceiling on returned nodes (default 1500).

    Returns:
        {
          available: bool,
          reason: str | absent,
          rung: str,
          parent_id: str | None,
          layout_version: str,
          graph_state_token: str,
          nodes: [GraphViewNode dicts],
          edges: [GraphViewEdge dicts],
          total_nodes: int,
          total_edges: int,
          truncated: bool,
        }
    """
    if rung not in VALID_VIEW_RUNGS:
        return {
            "available": False,
            "reason": "invalid_rung",
            "detail": f"rung must be one of {VALID_VIEW_RUNGS}",
        }

    top_k = max(1, min(int(top_k), DEFAULT_TOP_K))
    graph_state_token = compute_graph_state_token(conn)

    availability = substrate_availability(conn)
    if not availability["available"]:
        return {
            **availability,
            "rung": rung,
            "parent_id": parent_id,
            "layout_version": LAYOUT_VERSION,
            "graph_state_token": graph_state_token,
            "nodes": [],
            "edges": [],
            "total_nodes": 0,
            "total_edges": 0,
            "truncated": False,
        }

    if rung == "passage":
        return _passage_view(conn, parent_id, top_k, graph_state_token)

    # Reject asset rung without parent_id filter (unbounded for typical graphs).
    if rung == "asset" and parent_id is None:
        return {
            "available": False,
            "reason": "parent_id_required",
            "detail": "asset rung requires parent_id (island_id) to avoid unbounded responses",
            "rung": rung,
            "parent_id": parent_id,
            "layout_version": LAYOUT_VERSION,
            "graph_state_token": graph_state_token,
            "nodes": [],
            "edges": [],
            "total_nodes": 0,
            "total_edges": 0,
            "truncated": False,
        }

    # Read partition + labels for this rung.
    partition = _read_partition(rung, conn)
    labels_map = _read_labels(rung, conn)

    # If parent_id given, restrict to members of the parent.
    if parent_id is not None:
        parent_rung = _parent_rung_for(rung)
        if parent_rung is not None:
            # parent_id should correspond to an entry in the parent's partition
            # whose member_ids are the IDs of this rung's communities.
            parent_partition = _read_partition(parent_rung, conn)
            allowed_ids = set(parent_partition.get(str(parent_id), []))
            if not allowed_ids:
                return {
                    "available": False,
                    "reason": "parent_not_found_or_empty",
                    "detail": f"parent_id={parent_id!r} has no members at rung={parent_rung!r}",
                    "rung": rung,
                    "parent_id": parent_id,
                    "layout_version": LAYOUT_VERSION,
                    "graph_state_token": graph_state_token,
                    "nodes": [],
                    "edges": [],
                    "total_nodes": 0,
                    "total_edges": 0,
                    "truncated": False,
                }
            partition = {cid: members for cid, members in partition.items() if cid in allowed_ids}

    # Build parent index for parent_id field on each node.
    parent_rung = _parent_rung_for(rung)
    parent_index = _build_parent_index(conn, parent_rung)

    # Sort by member count (descending) and cap at top_k.
    community_items = sorted(
        partition.items(),
        key=lambda item: (-len(item[1]), str(item[0])),
    )
    total_nodes = len(community_items)
    truncated = total_nodes > top_k
    community_items = community_items[:top_k]
    visible_ids = {cid for cid, _ in community_items}

    # Compute child counts from the child rung's partition (assets have islands
    # as parents; so to count children of an island, read asset partition and
    # count how many assets are members of this island).
    child_rung = _child_rung_for(rung)
    child_counts: dict[str, int] = {}
    if child_rung is not None:
        child_partition = _read_partition(child_rung, conn)
        # child_partition maps child_id -> list of grandchild_ids; the parent
        # of each child is found via the inverted parent_index of the child rung.
        child_to_parent = _build_parent_index(conn, rung)
        for child_id in child_partition.keys():
            parent_of_child = child_to_parent.get(str(child_id))
            if parent_of_child is not None:
                child_counts[parent_of_child] = child_counts.get(parent_of_child, 0) + 1

    # Build node list with deterministic circular positions.
    nodes: list[GraphViewNode] = []
    positions = _layout_positions(
        graph_state_token,
        rung,
        parent_id,
        [str(community_id) for community_id, _member_ids in community_items],
    )
    for community_id, member_ids in community_items:
        label_tuple = labels_map.get(community_id)
        if label_tuple is not None:
            label, label_source = label_tuple
        else:
            label = community_id
            label_source = "fallback_id"
        x, y = positions[str(community_id)]
        descendant_passages = _descendant_passage_ids(conn, rung, str(community_id), list(member_ids))
        source_names, representative_passages = _passage_details(conn, descendant_passages)
        nodes.append(
            GraphViewNode(
                id=str(community_id),
                label=str(label),
                label_source=str(label_source),
                member_count=len(member_ids),
                child_count=child_counts.get(str(community_id), 0),
                parent_id=parent_index.get(str(community_id)),
                rung=rung,
                x=x,
                y=y,
                top_entities=_top_entities(conn, descendant_passages),
                source_names=source_names,
                passage_count=len(descendant_passages),
                representative_passages=representative_passages,
            )
        )

    # Read edges for this rung, filtered to visible nodes.
    raw_edges = _read_community_edges(rung, conn)
    visible_edges = [
        (a, b, w) for a, b, w in raw_edges
        if a in visible_ids and b in visible_ids
    ]
    total_edges = len(visible_edges)
    # Sort by weight descending, cap at top_k for bounded response.
    visible_edges.sort(key=lambda row: (-row[2], row[0], row[1]))
    edge_truncated = total_edges > top_k
    visible_edges = visible_edges[:top_k]

    edges: list[GraphViewEdge] = [
        GraphViewEdge(
            source=str(a),
            target=str(b),
            weight=int(w),
            rung=rung,
            relation_mix=[],
            density=round(float(w) / max(1, len(partition.get(a, [])) * len(partition.get(b, []))), 4),
            recency=None,
        )
        for a, b, w in visible_edges
    ]

    return {
        "available": True,
        "rung": rung,
        "parent_id": parent_id,
        "layout_version": LAYOUT_VERSION,
        "graph_state_token": graph_state_token,
        "counts": availability.get("counts", {}),
        "nodes": [n.to_dict() for n in nodes],
        "edges": [e.to_dict() for e in edges],
        "total_nodes": total_nodes,
        "total_edges": total_edges,
        "truncated": truncated or edge_truncated,
    }


__all__ = [
    "DEFAULT_TOP_K",
    "LAYOUT_VERSION",
    "VALID_VIEW_RUNGS",
    "GraphViewEdge",
    "GraphViewNode",
    "compute_graph_state_token",
    "get_graph_view",
    "substrate_availability",
]
