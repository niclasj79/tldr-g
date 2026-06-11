"""Sibling-table storage helpers for baked similarity edges."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import os
from collections.abc import Iterable, Mapping, Sequence

SimilarityRung = str

SIMILARITY_EDGES_ENV = "TPVRG_SIMILARITY_EDGES"
SIMILARITY_EDGE_MODEL_ID_ENV = "TPVRG_SIMILARITY_EDGES_MODEL_ID"
DEFAULT_SIMILARITY_EDGE_MODEL_ID = "BAAI/bge-large-en-v1.5"
VALID_SIMILARITY_RUNGS = {"asset", "passage"}


@dataclass(frozen=True)
class SimilarityEdge:
    """One directed baked k-nearest-neighbor edge."""

    src_id: str
    tgt_id: str
    rung: SimilarityRung
    cosine: float
    rank: int
    model_id: str
    created_at: str
    run_id: str


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def similarity_edges_enabled(env: Mapping[str, str] | None = None) -> bool:
    """Return whether the similarity-edge substrate is enabled."""
    env_map = os.environ if env is None else env
    raw = (env_map.get(SIMILARITY_EDGES_ENV) or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def resolve_model_id(
    model_id: str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> str:
    """Resolve the lineage tag persisted on baked similarity edges."""
    if model_id is not None and str(model_id).strip():
        return str(model_id).strip()
    env_map = os.environ if env is None else env
    raw = (env_map.get(SIMILARITY_EDGE_MODEL_ID_ENV) or "").strip()
    return raw or DEFAULT_SIMILARITY_EDGE_MODEL_ID


def validate_rung(rung: str) -> SimilarityRung:
    if rung not in VALID_SIMILARITY_RUNGS:
        raise ValueError(
            f"Unknown similarity-edge rung {rung!r}; expected {sorted(VALID_SIMILARITY_RUNGS)}"
        )
    return rung


def _empty_counts() -> dict[str, int]:
    return {rung: 0 for rung in sorted(VALID_SIMILARITY_RUNGS)}


def similarity_edges_table_exists(conn) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?",
        ("similarity_edges",),
    ).fetchone()
    return row is not None


def init_schema(conn) -> None:
    """Create the sibling similarity-edge table. Idempotent."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS similarity_edges (
          src_id TEXT NOT NULL,
          tgt_id TEXT NOT NULL,
          rung TEXT NOT NULL,
          cosine REAL NOT NULL,
          rank INTEGER NOT NULL CHECK (rank > 0),
          model_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          run_id TEXT NOT NULL,
          PRIMARY KEY (src_id, tgt_id, rung),
          CHECK (src_id <> tgt_id)
        );

        CREATE INDEX IF NOT EXISTS idx_similarity_edges_rung_src_rank
          ON similarity_edges (rung, src_id, rank);
        CREATE INDEX IF NOT EXISTS idx_similarity_edges_rung_tgt
          ON similarity_edges (rung, tgt_id);
        CREATE INDEX IF NOT EXISTS idx_similarity_edges_run
          ON similarity_edges (run_id);
        """
    )
    conn.commit()


def clear_similarity_edges(rung: str, conn) -> None:
    """Delete all baked similarity edges for one rung."""
    resolved_rung = validate_rung(rung)
    init_schema(conn)
    conn.execute("DELETE FROM similarity_edges WHERE rung = ?", (resolved_rung,))
    conn.commit()


def replace_similarity_edges(
    rung: str,
    edges: Sequence[SimilarityEdge],
    conn,
) -> int:
    """Replace the baked similarity edges for one rung."""
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
        if edge.rank <= 0:
            raise ValueError("similarity edge rank must be > 0")
        rows.append(
            (
                str(edge.src_id),
                str(edge.tgt_id),
                resolved_rung,
                float(edge.cosine),
                int(edge.rank),
                str(edge.model_id),
                str(edge.created_at),
                str(edge.run_id),
            )
        )

    conn.execute("DELETE FROM similarity_edges WHERE rung = ?", (resolved_rung,))
    if rows:
        conn.executemany(
            """
            INSERT INTO similarity_edges
              (src_id, tgt_id, rung, cosine, rank, model_id, created_at, run_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
    conn.commit()
    return len(rows)


def read_similarity_edges(
    rung: str,
    conn,
    *,
    src_ids: Iterable[str] | None = None,
) -> list[SimilarityEdge]:
    """Read baked similarity edges for a rung, ordered by source then rank."""
    resolved_rung = validate_rung(rung)
    init_schema(conn)
    params: list[object] = [resolved_rung]
    where = "WHERE rung = ?"
    if src_ids is not None:
        ids = [str(src_id) for src_id in src_ids]
        if not ids:
            return []
        placeholders = ",".join("?" for _ in ids)
        where += f" AND src_id IN ({placeholders})"
        params.extend(ids)
    rows = conn.execute(
        f"""
        SELECT src_id, tgt_id, rung, cosine, rank, model_id, created_at, run_id
        FROM similarity_edges
        {where}
        ORDER BY src_id, rank, tgt_id
        """,
        tuple(params),
    ).fetchall()
    return [
        SimilarityEdge(
            src_id=str(src_id),
            tgt_id=str(tgt_id),
            rung=str(rung_value),
            cosine=float(cosine),
            rank=int(rank),
            model_id=str(model_id),
            created_at=str(created_at),
            run_id=str(run_id),
        )
        for src_id, tgt_id, rung_value, cosine, rank, model_id, created_at, run_id in rows
    ]


def similarity_edge_counts(conn) -> dict[str, int]:
    """Return baked similarity-edge counts per rung."""
    init_schema(conn)
    rows = conn.execute(
        """
        SELECT rung, COUNT(*)
        FROM similarity_edges
        GROUP BY rung
        """
    ).fetchall()
    counts = {rung: 0 for rung in sorted(VALID_SIMILARITY_RUNGS)}
    counts.update({str(rung): int(count) for rung, count in rows})
    return counts


def similarity_edges_health(conn) -> dict[str, object]:
    """Return a compact health block without creating the table on old graphs."""
    if not similarity_edges_table_exists(conn):
        return {
            "available": False,
            "enabled": similarity_edges_enabled(),
            "total_count": 0,
            "counts_by_rung": _empty_counts(),
            "latest_created_at": None,
            "latest_run_id": None,
            "latest_model_id": None,
        }

    rows = conn.execute(
        """
        SELECT rung, COUNT(*)
        FROM similarity_edges
        GROUP BY rung
        """
    ).fetchall()
    counts = _empty_counts()
    counts.update({str(rung): int(count) for rung, count in rows})
    latest = conn.execute(
        """
        SELECT created_at, run_id, model_id
        FROM similarity_edges
        ORDER BY created_at DESC, run_id DESC
        LIMIT 1
        """
    ).fetchone()
    return {
        "available": True,
        "enabled": similarity_edges_enabled(),
        "total_count": sum(counts.values()),
        "counts_by_rung": counts,
        "latest_created_at": str(latest[0]) if latest else None,
        "latest_run_id": str(latest[1]) if latest else None,
        "latest_model_id": str(latest[2]) if latest else None,
    }


def _degree_stats(conn, id_column: str) -> dict[str, dict[str, object]]:
    if id_column not in {"src_id", "tgt_id"}:
        raise ValueError("id_column must be src_id or tgt_id")
    rows = conn.execute(
        f"""
        SELECT rung, COUNT(*) AS node_count, MIN(degree), MAX(degree), AVG(degree)
        FROM (
          SELECT rung, {id_column}, COUNT(*) AS degree
          FROM similarity_edges
          GROUP BY rung, {id_column}
        )
        GROUP BY rung
        """
    ).fetchall()
    stats = {
        rung: {
            "nodes_with_edges": 0,
            "min": 0,
            "max": 0,
            "avg": 0.0,
        }
        for rung in sorted(VALID_SIMILARITY_RUNGS)
    }
    for rung, node_count, min_degree, max_degree, avg_degree in rows:
        stats[str(rung)] = {
            "nodes_with_edges": int(node_count),
            "min": int(min_degree or 0),
            "max": int(max_degree or 0),
            "avg": round(float(avg_degree or 0.0), 4),
        }
    return stats


def similarity_edges_diagnostics(conn, *, sample_limit: int = 10) -> dict[str, object]:
    """Return count, degree, and sample edge diagnostics for operator inspection."""
    health = similarity_edges_health(conn)
    if not health["available"]:
        return {
            **health,
            "degree_distribution": {"out": {}, "in": {}},
            "sample_top_k": {rung: [] for rung in sorted(VALID_SIMILARITY_RUNGS)},
        }

    limit = max(1, int(sample_limit))
    samples: dict[str, list[dict[str, object]]] = {}
    for rung in sorted(VALID_SIMILARITY_RUNGS):
        rows = conn.execute(
            """
            SELECT src_id, tgt_id, cosine, rank, model_id, created_at, run_id
            FROM similarity_edges
            WHERE rung = ?
            ORDER BY src_id, rank, tgt_id
            LIMIT ?
            """,
            (rung, limit),
        ).fetchall()
        samples[rung] = [
            {
                "src_id": str(src_id),
                "tgt_id": str(tgt_id),
                "cosine": float(cosine),
                "rank": int(rank),
                "model_id": str(model_id),
                "created_at": str(created_at),
                "run_id": str(run_id),
            }
            for src_id, tgt_id, cosine, rank, model_id, created_at, run_id in rows
        ]

    return {
        **health,
        "degree_distribution": {
            "out": _degree_stats(conn, "src_id"),
            "in": _degree_stats(conn, "tgt_id"),
        },
        "sample_top_k": samples,
    }


__all__ = [
    "DEFAULT_SIMILARITY_EDGE_MODEL_ID",
    "SIMILARITY_EDGES_ENV",
    "SIMILARITY_EDGE_MODEL_ID_ENV",
    "SimilarityEdge",
    "SimilarityRung",
    "VALID_SIMILARITY_RUNGS",
    "clear_similarity_edges",
    "init_schema",
    "read_similarity_edges",
    "replace_similarity_edges",
    "resolve_model_id",
    "similarity_edge_counts",
    "similarity_edges_diagnostics",
    "similarity_edges_enabled",
    "similarity_edges_health",
    "similarity_edges_table_exists",
    "validate_rung",
]
