"""
Shared query-stats helpers used by api_server (HTTP endpoints) AND
mcp_server (MCP tool functions).

This module exists to prevent the drift that hit the 2026-04-21 UX-10
incident (/answer/stream shipped a reduced stats block that skipped the
savings computation entirely — invisible in tests, visible on demo) and
the 2026-05-14 API-STATS-TELEMETRY-PASSAGE-MODE-ZERO bug (mcp_server
+ api_server /metrics both counted `_active_lods` only, missing the
passage-mode case where `_active_lods` is `{}` and the engine used
`_last_rendered_passage_ids` instead).

Both endpoints + both surfaces (HTTP + MCP) MUST use these helpers so
all four sites report identical stats. New endpoints/tools that report
query stats should also import from here.

Per [[../../docs/diagnostics/2026-05-14-cockpit-substrate-coherent-reframe.md]] §3 +
[[../../GOTCHAS.md]] entry "/health wedge after backbone-load (2026-05-17)".
"""

from __future__ import annotations

from typing import Any

from tp_vrg.tokens import estimate_tokens


def lod_distribution_from_last_query(mem: Any) -> tuple[dict[str, int], int]:
    """Return (lod_counts, nodes_used) for the last query on *mem*.

    Handles BOTH:
    - entity-mode: `mem._active_lods` is populated with {entity_id: LODLevel}
      — counts LOD distribution from there.
    - passage-mode: `mem._active_lods` is `{}` (engine ran passage-only
      strategy) — falls back to `mem._last_rendered_passage_ids` and reports
      all passages as LOD_0 (since passages don't have a variable-LOD
      scheme; they're rendered verbatim).

    The passage-mode fallback is the fix for the
    `[API-STATS-TELEMETRY-PASSAGE-MODE-ZERO]` bug
    (execution-horizon.md § Dogfooding-Blocking Bug Cluster).
    """
    lod_counts: dict[str, int] = {"LOD_0": 0, "LOD_1": 0, "LOD_2": 0}
    active_lods = getattr(mem, "_active_lods", {}) or {}
    nodes_used = len(active_lods)

    for lod in active_lods.values():
        # LODLevel enum has .value; plain ints pass through unchanged
        lod_value = getattr(lod, "value", lod)
        key = f"LOD_{lod_value}"
        lod_counts[key] = lod_counts.get(key, 0) + 1

    if nodes_used == 0:
        # Passage-mode fallback: engine rendered passages directly without
        # entity-LOD assignment. Count from _last_rendered_passage_ids and
        # bucket them all as LOD_0 (passages are verbatim, no LOD reduction).
        rendered_pids = list(
            dict.fromkeys(getattr(mem, "_last_rendered_passage_ids", []) or [])
        )
        if rendered_pids:
            nodes_used = len(rendered_pids)
            lod_counts["LOD_0"] = nodes_used

    return lod_counts, nodes_used


def compute_query_stats(mem: Any, tokens_used: int) -> dict[str, Any]:
    """Compute per-query token stats for the last query on *mem*.

    Returns the canonical stats dict shape consumed by /query, /answer,
    /answer/stream, tp_vrg_query, and any other surface that reports
    per-query statistics. Eight fields (six original + two U13 additions
    2026-05-21 per [[prd-cockpit-ux-sprint-2026-04-12.md]] §U13 footer
    acceptance criteria):
      - nodes_used: int
      - tokens_used: int
      - lod_distribution: dict[str, int] (LOD_0 / LOD_1 / LOD_2)
      - tokens_saved_this_query: int
      - savings_pct_this_query: float (rounded to 1 decimal)
      - counterfactual_all_lod0: int
      - render_confidence: float | None (L score from C.3 Unified Render
        Selector decision; None if no render decision logged)
      - selected_strategy: str | None (winning strategy from the same
        decision; None if no decision logged)

    Handles both entity-mode and passage-mode (see
    `lod_distribution_from_last_query` for the fallback semantics).
    """
    lod_counts, nodes_used = lod_distribution_from_last_query(mem)
    counterfactual_all_lod0 = 0

    active_lods = getattr(mem, "_active_lods", {}) or {}
    if active_lods:
        # Entity-mode: counterfactual is each node's lod_0 text rendered fully
        for node_id in active_lods.keys():
            node = mem._storage.get_node(node_id)
            if node:
                counterfactual_all_lod0 += estimate_tokens(node.lod_0)
    elif nodes_used > 0:
        # Passage-mode: counterfactual is each passage's raw_text rendered
        rendered_pids = list(
            dict.fromkeys(getattr(mem, "_last_rendered_passage_ids", []) or [])
        )
        if rendered_pids:
            storage = getattr(mem, "_storage", None)
            passages: dict[str, Any] = {}
            if storage is not None and hasattr(storage, "get_passages_batch"):
                passages = storage.get_passages_batch(rendered_pids)
            for pid in rendered_pids:
                passage = passages.get(pid)
                if (
                    passage is None
                    and storage is not None
                    and hasattr(storage, "get_passage")
                ):
                    passage = storage.get_passage(pid)
                if passage:
                    counterfactual_all_lod0 += estimate_tokens(passage.raw_text)

    tokens_saved = max(0, counterfactual_all_lod0 - tokens_used)
    savings_pct = (
        (tokens_saved / counterfactual_all_lod0 * 100)
        if counterfactual_all_lod0 > 0
        else 0.0
    )

    # U13 additions (2026-05-21): expose render confidence + selected
    # strategy for the Cockpit footer. Both come from the most recent
    # query's render decision; safe-fallback to None when no decision
    # was logged (e.g., empty graph, mock mode).
    render_confidence_dict = getattr(mem, "_last_render_confidence", None)
    render_confidence_value: float | None = None
    if isinstance(render_confidence_dict, dict):
        raw = render_confidence_dict.get("L")
        if raw is not None:
            try:
                render_confidence_value = float(raw)
            except (TypeError, ValueError):
                render_confidence_value = None

    render_decision_dict = getattr(mem, "_last_render_decision", None)
    selected_strategy_value: str | None = None
    if isinstance(render_decision_dict, dict):
        strat = render_decision_dict.get("selected_strategy")
        if strat is not None:
            selected_strategy_value = str(strat)

    # Visible-intelligence fields (2026-06-10): signals the engine already
    # computes, exposed so surfaces can SHOW the reasoning rather than hide
    # it — deterministic sub-query decomposition, the speculative
    # pre-render prediction outcome, and whether the cross-encoder
    # reranker is active. All safe-fallback when absent.
    sub_queries = list(getattr(mem, "_last_sub_queries", []) or [])
    decomposition_strategy = str(
        getattr(mem, "_last_decomposition_strategy", "direct") or "direct"
    )
    speculative = getattr(mem, "_last_speculative_hit", None)
    if not isinstance(speculative, dict):
        speculative = None
    reranker = getattr(mem, "_cross_encoder_reranker", None)
    reranker_active = reranker is not None
    reranker_model = (
        str(getattr(reranker, "model_name", "") or "") if reranker_active else None
    )

    return {
        "nodes_used": nodes_used,
        "tokens_used": tokens_used,
        "lod_distribution": lod_counts,
        "tokens_saved_this_query": tokens_saved,
        "savings_pct_this_query": round(savings_pct, 1),
        "counterfactual_all_lod0": counterfactual_all_lod0,
        "render_confidence": render_confidence_value,
        "selected_strategy": selected_strategy_value,
        "sub_queries": sub_queries,
        "decomposition_strategy": decomposition_strategy,
        "speculative": speculative,
        "reranker_active": reranker_active,
        "reranker_model": reranker_model,
    }
