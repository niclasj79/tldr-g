"""Render-affinity edge bake (L3 / RTWM) — co-render traces -> Asset-rung edges.

The Layer-3 community-detection signal per
``docs/design/arch-render-affinity-community-detection-2026-05-14.md``:
Assets co-rendered in the same answer (or co-retrieved by the same
hypothetical question) bind together — the Hebbian "fire together, wire
together" rule applied to render traffic. Two trace sources:

- **provenance** (real usage; the durable gets-sharper-with-use channel):
  every ``answers`` row in provenance.db is one render event; its
  ``answer_citations.segment_id`` values ARE graph passage_ids (the F16
  dual-write contract) -> map to ``passages.asset_id`` -> a co-render set.
- **hype** (synthetic cold-start; load-bearing while real history is thin):
  a deterministic capped sample of the stored HyPE question embeddings
  (``question_embeddings``, id format ``{passage_id}__q{n}``) is replayed as
  synthetic queries — batch cosine top-K against the canonical passage
  embeddings (one numpy matmul; NOT per-query vec0 scans) -> the retrieved
  set's Assets form a synthetic co-render set.

Pair weighting: per-trace-normalized — each trace distributes total mass 1
across its asset pairs (1/n_pairs each), so large renders don't dominate
(RTWM's co-firing normalization). Raw ``trace_count`` is kept alongside.

Default OFF (``TPVRG_RENDER_AFFINITY``); bounded
(``TPVRG_RENDER_AFFINITY_MAX_QUESTIONS`` / ``..._K``); cardinality-probed;
writes only the sibling ``render_affinity_edges`` table (Systemic Layer-2,
re-bakeable; never touches ``edges``).
"""

from __future__ import annotations

import logging
import os
import sqlite3
import uuid
from collections import defaultdict
from collections.abc import Iterable, Sequence
from datetime import datetime, timezone

import numpy as np

from tp_vrg.cardinality import probe
from tp_vrg.storage.render_affinity_edges import (
    RenderAffinityEdge,
    init_schema,
    read_render_affinity_edges,
    render_affinity_enabled,
    replace_render_affinity_edges,
)

logger = logging.getLogger(__name__)

ASSET_RUNG = "asset"
MAX_QUESTIONS_ENV = "TPVRG_RENDER_AFFINITY_MAX_QUESTIONS"
TOP_K_ENV = "TPVRG_RENDER_AFFINITY_K"
DEFAULT_MAX_QUESTIONS = 2000
DEFAULT_TOP_K = 10


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def resolve_max_questions(raw: str | int | None = None) -> int:
    """Resolve the HyPE synthetic-trace sample cap (sentinel pattern)."""
    value = os.environ.get(MAX_QUESTIONS_ENV) if raw is None else raw
    if value is None or str(value).strip() == "":
        return DEFAULT_MAX_QUESTIONS
    try:
        cap = int(str(value).strip())
    except ValueError:
        return DEFAULT_MAX_QUESTIONS
    return cap if cap > 0 else DEFAULT_MAX_QUESTIONS


def resolve_top_k(raw: str | int | None = None) -> int:
    """Resolve the synthetic-retrieval top-K (sentinel pattern)."""
    value = os.environ.get(TOP_K_ENV) if raw is None else raw
    if value is None or str(value).strip() == "":
        return DEFAULT_TOP_K
    try:
        k = int(str(value).strip())
    except ValueError:
        return DEFAULT_TOP_K
    return k if k > 1 else DEFAULT_TOP_K


def _passage_to_asset(conn) -> dict[str, str]:
    """passage_id -> Asset-rung community id (INV-2 on empty).

    Reads the PERSISTED Asset-rung partition (``community_partitions``) — the
    id-space the partition pipeline (attribution edges, the Island fold,
    Leiden) operates over — NOT the ``passages.asset_id`` overlay column
    (a separate Authorial-overlay surface that may be lazily backfilled).
    The two id spaces must not be mixed: render-affinity edges are folded
    into partition edges keyed by partition community ids.
    """
    mapping = {
        str(member_id): str(community_id)
        for member_id, community_id in conn.execute(
            "SELECT member_id, community_id FROM community_partitions WHERE rung = ?",
            (ASSET_RUNG,),
        )
    }
    if not mapping:
        raise ValueError(
            "Cannot bake render-affinity edges: the Asset-rung partition is not "
            "persisted (bake the partitions first — janitor task bake_partitions)"
        )
    return mapping


def build_traces_from_provenance(
    graph_conn,
    prov_conn,
) -> list[frozenset[str]]:
    """One co-render Asset set per provenance answer (the REAL-usage source)."""
    passage_assets = _passage_to_asset(graph_conn)
    per_answer: dict[str, set[str]] = defaultdict(set)
    unmapped = 0
    for answer_id, segment_id in prov_conn.execute(
        "SELECT answer_id, segment_id FROM answer_citations"
    ):
        asset_id = passage_assets.get(str(segment_id))
        if asset_id is None:
            unmapped += 1
            continue
        per_answer[str(answer_id)].add(asset_id)
    if unmapped:
        logger.info(
            "render-affinity provenance source: %d citations had no asset-mapped "
            "passage (different corpus era or pre-Asset ingest) — counted, skipped.",
            unmapped,
        )
    return [frozenset(assets) for assets in per_answer.values() if len(assets) >= 2]


def _load_passage_matrix(conn) -> tuple[list[str], np.ndarray]:
    """Canonical passage embeddings (BLOB store) as an L2-normalized matrix."""
    ids: list[str] = []
    blobs: list[bytes] = []
    for passage_id, blob in conn.execute(
        "SELECT id, embedding FROM passage_embedding_store ORDER BY id"
    ):
        ids.append(str(passage_id))
        blobs.append(blob)
    if not ids:
        raise ValueError(
            "Cannot build HyPE synthetic traces: passage_embedding_store is empty"
        )
    matrix = np.frombuffer(b"".join(blobs), dtype=np.float32).reshape(len(ids), -1)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return ids, matrix / norms


def _sample_question_embeddings(
    conn, *, cap: int
) -> tuple[list[str], np.ndarray]:
    """Deterministic capped sample of stored HyPE question embeddings.

    Requires sqlite-vec loaded on ``conn`` (question embeddings are vec0-only).
    ORDER BY id makes the sample reproducible across runs (INV-6 spirit).
    """
    ids: list[str] = []
    blobs: list[bytes] = []
    for question_id, blob in conn.execute(
        "SELECT id, embedding FROM question_embeddings ORDER BY id LIMIT ?",
        (cap,),
    ):
        ids.append(str(question_id))
        blobs.append(blob)
    if not ids:
        raise ValueError(
            "Cannot build HyPE synthetic traces: question_embeddings is empty "
            "(HyPE generation runs at ingest)"
        )
    matrix = np.frombuffer(b"".join(blobs), dtype=np.float32).reshape(len(ids), -1)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return ids, matrix / norms


def build_traces_from_hype(
    conn,
    *,
    max_questions: int | None = None,
    top_k: int | None = None,
) -> list[frozenset[str]]:
    """Synthetic co-render traces: replay stored HyPE questions as queries.

    One numpy batch matmul (Q x P^T) replaces per-question vec0 scans —
    seconds instead of ~1.1s/query on a 23K-passage corpus.
    """
    cap = resolve_max_questions(max_questions)
    k = resolve_top_k(top_k)
    passage_assets = _passage_to_asset(conn)

    passage_ids, passage_matrix = _load_passage_matrix(conn)
    question_ids, question_matrix = _sample_question_embeddings(conn, cap=cap)
    if passage_matrix.shape[1] != question_matrix.shape[1]:
        raise ValueError(
            "Embedding dimension mismatch between passages "
            f"({passage_matrix.shape[1]}) and HyPE questions "
            f"({question_matrix.shape[1]}) — mixed-model stores (INV-6)"
        )

    sims = question_matrix @ passage_matrix.T  # (Q, P) cosine (both normalized)
    k_eff = min(k, sims.shape[1])
    top_idx = np.argpartition(-sims, kth=k_eff - 1, axis=1)[:, :k_eff]

    traces: list[frozenset[str]] = []
    for row in top_idx:
        assets = {
            passage_assets[passage_ids[i]]
            for i in row
            if passage_ids[i] in passage_assets
        }
        if len(assets) >= 2:
            traces.append(frozenset(assets))
    logger.info(
        "render-affinity hype source: %d questions sampled (cap=%d, k=%d) -> "
        "%d multi-asset synthetic traces",
        len(question_ids), cap, k_eff, len(traces),
    )
    return traces


def accumulate_pairs(
    trace_sets: Iterable[tuple[str, Sequence[frozenset[str]]]],
) -> dict[tuple[str, str], dict]:
    """Per-trace-normalized pair accumulation across labeled sources.

    Each trace distributes total mass 1 across its C(n,2) pairs so large
    renders don't dominate (the RTWM co-firing normalization).
    """
    pairs: dict[tuple[str, str], dict] = {}
    for source, traces in trace_sets:
        for trace in traces:
            assets = sorted(trace)
            n = len(assets)
            if n < 2:
                continue
            n_pairs = n * (n - 1) // 2
            share = 1.0 / n_pairs
            for i in range(n):
                for j in range(i + 1, n):
                    key = (assets[i], assets[j])
                    entry = pairs.get(key)
                    if entry is None:
                        entry = {"weight": 0.0, "trace_count": 0, "sources": set()}
                        pairs[key] = entry
                    entry["weight"] += share
                    entry["trace_count"] += 1
                    entry["sources"].add(source)
    return pairs


def bake_render_affinity_edges(
    conn,
    *,
    prov_conn=None,
    max_questions: int | None = None,
    top_k: int | None = None,
    include_hype: bool = True,
    include_provenance: bool = True,
    run_id: str | None = None,
) -> dict[str, object]:
    """Build co-render traces from the enabled sources and bake the edges.

    ``conn`` = graph DB (sqlite-vec loaded if the HyPE source is used);
    ``prov_conn`` = provenance DB (read-only is fine) for the real-trace
    source — skipped gracefully (and counted) when absent.
    """
    init_schema(conn)
    resolved_run = run_id or uuid.uuid4().hex
    now = _utc_now()

    sources: list[tuple[str, Sequence[frozenset[str]]]] = []
    summary: dict[str, object] = {
        "rung": ASSET_RUNG,
        "run_id": resolved_run,
        "provenance_traces": 0,
        "hype_traces": 0,
    }

    if include_provenance and prov_conn is not None:
        prov_traces = build_traces_from_provenance(conn, prov_conn)
        sources.append(("provenance", prov_traces))
        summary["provenance_traces"] = len(prov_traces)
    if include_hype:
        hype_traces = build_traces_from_hype(
            conn, max_questions=max_questions, top_k=top_k
        )
        sources.append(("hype", hype_traces))
        summary["hype_traces"] = len(hype_traces)

    total_traces = int(summary["provenance_traces"]) + int(summary["hype_traces"])
    with probe(
        "bake.render_affinity_traces",
        input_rows=total_traces,
    ) as cardinality_probe:
        pairs = accumulate_pairs(sources)
        cardinality_probe.intermediate = sum(
            entry["trace_count"] for entry in pairs.values()
        )
        cardinality_probe.output = len(pairs)

    edges = [
        RenderAffinityEdge(
            src_id=src,
            tgt_id=tgt,
            rung=ASSET_RUNG,
            weight=float(entry["weight"]),
            trace_count=int(entry["trace_count"]),
            source=("merged" if len(entry["sources"]) > 1 else next(iter(entry["sources"]))),
            created_at=now,
            run_id=resolved_run,
        )
        for (src, tgt), entry in pairs.items()
    ]
    written = replace_render_affinity_edges(ASSET_RUNG, edges, conn)
    summary["edge_count"] = written
    logger.info(
        "render-affinity bake: %d traces (%d provenance + %d hype) -> %d edges "
        "(run %s)",
        total_traces, summary["provenance_traces"], summary["hype_traces"],
        written, resolved_run,
    )
    return summary


def open_provenance_readonly(path=None) -> sqlite3.Connection | None:
    """Best-effort read-only provenance connection for the janitor task."""
    from tp_vrg.data_dir import get_provenance_db_path

    resolved = get_provenance_db_path() if path is None else path
    try:
        if not resolved.exists():
            return None
        return sqlite3.connect(f"file:{resolved}?mode=ro", uri=True)
    except sqlite3.Error:
        logger.warning("render-affinity: provenance DB unreadable at %s", resolved)
        return None


__all__ = (
    "ASSET_RUNG",
    "DEFAULT_MAX_QUESTIONS",
    "DEFAULT_TOP_K",
    "MAX_QUESTIONS_ENV",
    "TOP_K_ENV",
    "accumulate_pairs",
    "bake_render_affinity_edges",
    "build_traces_from_hype",
    "build_traces_from_provenance",
    "open_provenance_readonly",
    "render_affinity_enabled",
    "read_render_affinity_edges",
    "resolve_max_questions",
    "resolve_top_k",
)
