"""Sibling-table storage helpers for baked render-affinity edges (L3 / RTWM).

Render-affinity is the Layer-3 community-detection signal per
``docs/design/arch-render-affinity-community-detection-2026-05-14.md``:
*"co-rendered => co-community"* (Hebbian). Where similarity edges connect
content that LOOKS alike, render-affinity edges connect Assets that are USED
together — co-cited in the same answers (real traces from the Provenance
Layer) or co-retrieved by the same hypothetical question (HyPE synthetic
cold-start). These are the only edges that can bridge topically-dissimilar
Assets, which the 2026-06-11 weighting-invariance verdict proved no
re-weighting of existing edges can do.

Mirrors ``similarity_edges.py`` (the sibling-table discipline): default-OFF,
bounded, re-bakeable Systemic Layer-2 state; never touches the relational
``edges`` table.
"""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone

RenderAffinityRung = str

RENDER_AFFINITY_ENV = "TPVRG_RENDER_AFFINITY"
VALID_RENDER_AFFINITY_RUNGS = {"asset"}
VALID_RENDER_AFFINITY_SOURCES = {"provenance", "hype", "merged"}


@dataclass(frozen=True)
class RenderAffinityEdge:
    """One undirected co-render edge (src_id < tgt_id canonical order)."""

    src_id: str
    tgt_id: str
    rung: RenderAffinityRung
    weight: float          # per-trace-normalized co-render mass (each trace sums to 1)
    trace_count: int       # raw number of traces the pair co-occurred in
    source: str            # 'provenance' | 'hype' | 'merged'
    created_at: str
    run_id: str


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def render_affinity_enabled(env: Mapping[str, str] | None = None) -> bool:
    """Return whether the render-affinity substrate is enabled (default OFF)."""
    env_map = os.environ if env is None else env
    raw = (env_map.get(RENDER_AFFINITY_ENV) or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def validate_rung(rung: str) -> RenderAffinityRung:
    if rung not in VALID_RENDER_AFFINITY_RUNGS:
        raise ValueError(
            f"Unknown render-affinity rung {rung!r}; expected {sorted(VALID_RENDER_AFFINITY_RUNGS)}"
        )
    return rung


def validate_source(source: str) -> str:
    if source not in VALID_RENDER_AFFINITY_SOURCES:
        raise ValueError(
            f"Unknown render-affinity source {source!r}; "
            f"expected {sorted(VALID_RENDER_AFFINITY_SOURCES)}"
        )
    return source


def render_affinity_table_exists(conn) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?",
        ("render_affinity_edges",),
    ).fetchone()
    return row is not None


def init_schema(conn) -> None:
    """Create the sibling render-affinity table. Idempotent."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS render_affinity_edges (
          src_id TEXT NOT NULL,
          tgt_id TEXT NOT NULL,
          rung TEXT NOT NULL,
          weight REAL NOT NULL CHECK (weight > 0),
          trace_count INTEGER NOT NULL CHECK (trace_count > 0),
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          run_id TEXT NOT NULL,
          PRIMARY KEY (src_id, tgt_id, rung),
          CHECK (src_id < tgt_id)
        );

        CREATE INDEX IF NOT EXISTS idx_render_affinity_rung_src
          ON render_affinity_edges (rung, src_id);
        CREATE INDEX IF NOT EXISTS idx_render_affinity_run
          ON render_affinity_edges (run_id);
        """
    )
    conn.commit()


def replace_render_affinity_edges(
    rung: str,
    edges: Sequence[RenderAffinityEdge],
    conn,
) -> int:
    """Replace the baked render-affinity edges for one rung (INV-2 on shape)."""
    resolved_rung = validate_rung(rung)
    init_schema(conn)
    rows: list[tuple[str, str, str, float, int, str, str, str]] = []
    for edge in edges:
        if edge.rung != resolved_rung:
            raise ValueError(
                f"Cannot write {edge.rung!r} edge while replacing {resolved_rung!r}"
            )
        if edge.src_id == edge.tgt_id:
            continue
        if edge.weight <= 0:
            raise ValueError("render-affinity edge weight must be > 0")
        if edge.trace_count <= 0:
            raise ValueError("render-affinity trace_count must be > 0")
        src, tgt = sorted((str(edge.src_id), str(edge.tgt_id)))
        rows.append(
            (
                src,
                tgt,
                resolved_rung,
                float(edge.weight),
                int(edge.trace_count),
                validate_source(edge.source),
                str(edge.created_at),
                str(edge.run_id),
            )
        )

    conn.execute("DELETE FROM render_affinity_edges WHERE rung = ?", (resolved_rung,))
    if rows:
        conn.executemany(
            """
            INSERT INTO render_affinity_edges
              (src_id, tgt_id, rung, weight, trace_count, source, created_at, run_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
    conn.commit()
    return len(rows)


def read_render_affinity_edges(
    rung: str,
    conn,
) -> list[RenderAffinityEdge]:
    """Read all baked render-affinity edges for one rung (canonical order)."""
    resolved_rung = validate_rung(rung)
    if not render_affinity_table_exists(conn):
        return []
    return [
        RenderAffinityEdge(
            src_id=str(row[0]),
            tgt_id=str(row[1]),
            rung=resolved_rung,
            weight=float(row[2]),
            trace_count=int(row[3]),
            source=str(row[4]),
            created_at=str(row[5]),
            run_id=str(row[6]),
        )
        for row in conn.execute(
            """
            SELECT src_id, tgt_id, weight, trace_count, source, created_at, run_id
            FROM render_affinity_edges
            WHERE rung = ?
            ORDER BY src_id, tgt_id
            """,
            (resolved_rung,),
        )
    ]


def render_affinity_counts(conn) -> dict[str, int]:
    """Edge counts per rung (0s when the table is absent)."""
    counts = {rung: 0 for rung in sorted(VALID_RENDER_AFFINITY_RUNGS)}
    if not render_affinity_table_exists(conn):
        return counts
    for rung, count in conn.execute(
        "SELECT rung, COUNT(*) FROM render_affinity_edges GROUP BY rung"
    ):
        if rung in counts:
            counts[str(rung)] = int(count)
    return counts


__all__ = (
    "RenderAffinityEdge",
    "RENDER_AFFINITY_ENV",
    "VALID_RENDER_AFFINITY_RUNGS",
    "VALID_RENDER_AFFINITY_SOURCES",
    "render_affinity_enabled",
    "validate_rung",
    "validate_source",
    "render_affinity_table_exists",
    "init_schema",
    "replace_render_affinity_edges",
    "read_render_affinity_edges",
    "render_affinity_counts",
)
