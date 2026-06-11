"""Cockpit graph-glance projection over an isolated SQLite connection."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any
import json

from tp_vrg.storage.connection_isolation import isolated_sqlite_connection


def strip_chunk_suffix(label: str) -> str:
    """Remove trailing ``[chunk-N]`` suffix from a passage source label."""
    idx = label.find("[chunk-")
    return label[:idx].strip() if idx != -1 else label.strip()


def collect_graph_glance_summary(path: str | Path) -> dict[str, Any]:
    """Return Cockpit source summary without touching the engine connection."""
    with isolated_sqlite_connection(path, read_only=True) as conn:
        return _collect_graph_glance_summary(conn)


def _collect_graph_glance_summary(conn: Any) -> dict[str, Any]:
    passage_rows = conn.execute(
        "SELECT source_label, entity_ids FROM passages"
    ).fetchall()

    entity_to_source: dict[str, str] = {}
    source_meta: dict[str, list[Any]] = {}

    for raw_label, entity_ids_json in passage_rows:
        clean = strip_chunk_suffix(raw_label or "") or "(unnamed)"

        if clean not in source_meta:
            source_meta[clean] = [0, None]
        source_meta[clean][0] += 1

        try:
            eids = json.loads(entity_ids_json or "[]")
        except Exception:
            eids = []
        for eid in eids:
            entity_to_source.setdefault(eid, clean)

    last_at_rows = conn.execute(
        "SELECT source_label, MAX(ingested_at) FROM passages GROUP BY source_label"
    ).fetchall()
    for raw_label, last_at in last_at_rows:
        clean = strip_chunk_suffix(raw_label or "") or "(unnamed)"
        if clean in source_meta and last_at is not None:
            current = source_meta[clean][1]
            if current is None or last_at > current:
                source_meta[clean][1] = last_at

    edge_count: dict[str, int] = defaultdict(int)
    edge_rows = conn.execute("SELECT source, target FROM edges").fetchall()
    for src_eid, tgt_eid in edge_rows:
        source = entity_to_source.get(src_eid)
        target = entity_to_source.get(tgt_eid)
        if source:
            edge_count[source] += 1
        if target:
            edge_count[target] += 1

    sources = [
        {
            "source": label,
            "count": meta[0],
            "last_at": meta[1],
            "edge_count": edge_count.get(label, 0),
        }
        for label, meta in source_meta.items()
    ]
    sources.sort(key=lambda row: (row["edge_count"], row["last_at"] or 0), reverse=True)

    return {
        "sources": sources,
        "total_passages": sum(row["count"] for row in sources),
    }
