"""Stale-bit propagation for cached hierarchical edge bundles."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from typing import Any

from .bundle import bundle_key
from .persistence import migrate


_ENTITY_KEYS = (
    "entity_id",
    "entity_ids",
    "node_id",
    "node_ids",
    "source",
    "target",
    "endpoints",
    "entities",
)
_EVIDENCE_KEYS = ("edge_id", "edge_ids", "evidence", "evidence_ids")


def _json_from_blob(blob: bytes) -> Any:
    return json.loads(blob.decode("utf-8"))


def _as_string_ids(value: Any) -> set[str]:
    if value is None:
        return set()
    if isinstance(value, str):
        return {value}
    if isinstance(value, bytes):
        return {value.decode("utf-8")}
    if isinstance(value, dict):
        ids: set[str] = set()
        for key in ("id", "edge_id", "entity_id", "node_id", "source", "target"):
            ids.update(_as_string_ids(value.get(key)))
        return ids
    if isinstance(value, Iterable):
        ids: set[str] = set()
        for item in value:
            ids.update(_as_string_ids(item))
        return ids
    return {str(value)}


def _extract_entities(graph_mutation: dict[str, Any]) -> set[str]:
    entity_ids: set[str] = set()
    for key in _ENTITY_KEYS:
        entity_ids.update(_as_string_ids(graph_mutation.get(key)))

    edge = graph_mutation.get("edge")
    if isinstance(edge, dict):
        entity_ids.update(_as_string_ids(edge.get("source")))
        entity_ids.update(_as_string_ids(edge.get("target")))
        entity_ids.update(_as_string_ids(edge.get("endpoints")))
    return entity_ids


def _extract_evidence(graph_mutation: dict[str, Any]) -> set[str]:
    evidence_ids: set[str] = set()
    for key in _EVIDENCE_KEYS:
        evidence_ids.update(_as_string_ids(graph_mutation.get(key)))

    edge = graph_mutation.get("edge")
    if isinstance(edge, dict):
        evidence_ids.update(_as_string_ids(edge.get("id")))
        evidence_ids.update(_as_string_ids(edge.get("edge_id")))
    return evidence_ids


def _bundle_identity(row: sqlite3.Row | tuple[Any, ...]) -> tuple[str, str, int]:
    return (str(row[0]), str(row[1]), int(row[2]))


def _bundle_id(row: sqlite3.Row | tuple[Any, ...]) -> str:
    community_a_id, community_b_id, level = _bundle_identity(row)
    return bundle_key(community_a_id, community_b_id, level)


def _fresh_bundle_rows(conn: sqlite3.Connection, *, level: int | None = None) -> list[Any]:
    if level is None:
        return conn.execute(
            """
            SELECT community_a_id, community_b_id, level, entity_set_blob,
                   evidence_blob
            FROM bundles
            WHERE stale = 0
            ORDER BY level, community_a_id, community_b_id
            """
        ).fetchall()

    return conn.execute(
        """
        SELECT community_a_id, community_b_id, level, entity_set_blob,
               evidence_blob
        FROM bundles
        WHERE stale = 0 AND level = ?
        ORDER BY community_a_id, community_b_id
        """,
        (int(level),),
    ).fetchall()


def _mark_bundle_identities_stale(
    conn: sqlite3.Connection, bundle_identities: set[tuple[str, str, int]]
) -> int:
    newly_stale = 0
    for community_a_id, community_b_id, level in sorted(bundle_identities):
        cursor = conn.execute(
            """
            UPDATE bundles
            SET stale = 1
            WHERE community_a_id = ?
              AND community_b_id = ?
              AND level = ?
              AND stale = 0
            """,
            (community_a_id, community_b_id, int(level)),
        )
        newly_stale += int(cursor.rowcount)
    conn.commit()
    return newly_stale


def _stale_bundle_ids(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute(
        """
        SELECT community_a_id, community_b_id, level
        FROM bundles
        WHERE stale = 1
        """
    ).fetchall()
    return {_bundle_id(row) for row in rows}


def mark_stale(graph_mutation: dict[str, Any], conn: sqlite3.Connection) -> int:
    """Mark level-1 bundles stale for an entity or edge mutation."""
    migrate(conn)
    mutated_entities = _extract_entities(graph_mutation)
    mutated_evidence = _extract_evidence(graph_mutation)
    if not mutated_entities and not mutated_evidence:
        return 0

    affected: set[tuple[str, str, int]] = set()
    for row in _fresh_bundle_rows(conn, level=1):
        community_a_id, community_b_id, level = _bundle_identity(row)
        entity_set = {str(entity_id) for entity_id in _json_from_blob(row[3])}
        evidence = {str(edge_id) for edge_id in _json_from_blob(row[4])}
        boundary_ids = {community_a_id, community_b_id}

        if (
            entity_set & mutated_entities
            or boundary_ids & mutated_entities
            or evidence & mutated_evidence
        ):
            affected.add((community_a_id, community_b_id, level))

    return _mark_bundle_identities_stale(conn, affected)


def propagate_staleness(conn: sqlite3.Connection) -> int:
    """Propagate stale bundle markers upward through evidence pointers."""
    migrate(conn)
    total_newly_stale = 0

    while True:
        stale_ids = _stale_bundle_ids(conn)
        affected: set[tuple[str, str, int]] = set()
        for row in _fresh_bundle_rows(conn):
            evidence = {str(edge_id) for edge_id in _json_from_blob(row[4])}
            if evidence & stale_ids:
                affected.add(_bundle_identity(row))

        newly_stale = _mark_bundle_identities_stale(conn, affected)
        if newly_stale == 0:
            return total_newly_stale
        total_newly_stale += newly_stale


__all__ = ("mark_stale", "propagate_staleness")
