"""
Dynamic Token Governor — enforces token budgets via continuous LOD_Z allocation.

Liquid LOD Phase B: replaces the old 3-phase discrete coarsening with
proportional budget allocation.  Each node receives a token_budget proportional
to its relevance score; the renderer then uses extractive sentence selection
(compression.py) to fill that budget from LOD_0 text.

Budget allocation algorithm:
  0a. Adaptive admission: when score distribution has measurable MAD, trim
     candidates by median + t*MAD before the rank cap applies as a ceiling.
  0b. Candidate cap: keep only the top (node_budget // MIN_BUDGET_PER_NODE) nodes
     by score. Prevents LOD_2 flood when the candidate pool is large relative to
     the budget. This is the architectural precursor to Liquid LOD Phase C
     (intent vector projection will replace score-based ranking here).
  1. Distribute total node_budget proportionally to scores.
  2. Cap each node at its full LOD_0 cost (can't render more than verbatim text).
  3. Redistribute surplus from capped nodes proportionally to uncapped nodes.
  4. Guarantee: highest-scored node always gets at least its full LOD_0 budget.
  5. Drop nodes with budget < MIN_NODE_TOKENS (1 token).
  6. Set assigned_lod for backward compatibility (logging, metrics, legacy tests).
"""

from __future__ import annotations

import logging

from tp_vrg.models import (
    LOD0_INVARIANT_ENABLED,
    LODLevel,
    MAX_NODES_DEFAULT,
    MIN_BUDGET_PER_NODE,
    NodeData,
    ScoredNode,
    TokenProfile,
)
from tp_vrg.scoring import _compute_mad
from tp_vrg.tokens import estimate_tokens

MIN_NODE_TOKENS = 1  # drop only nodes with zero budget (can't render anything)

logger = logging.getLogger(__name__)


# SOTA: Frame budget enforcement — adopted from real-time 3D rendering (game engines, ~1990s)
# The concept of a hard output budget with progressive quality coarsening is standard in
# graphics; the application to LLM token budgets is novel to TP-VRG.
class TokenGovernor:
    """Enforces token budgets via continuous LOD_Z proportional allocation."""

    @staticmethod
    def compute_pools(profile: TokenProfile) -> tuple[int, int, int]:
        """Partition ``profile.max_tokens`` into (node, edge, boundary) budgets.

        Uses the pool ratios on the profile. When using a bare
        ``TokenProfile(name=..., max_tokens=N)`` with default ratios
        (1.0 / 0.0 / 0.0), the full budget goes to nodes and edge/boundary
        rendering uses the Phase A count-based fallbacks.
        """
        node_budget = int(profile.max_tokens * profile.node_pool_ratio)
        edge_budget = int(profile.max_tokens * profile.edge_pool_ratio)
        boundary_budget = int(profile.max_tokens * profile.boundary_pool_ratio)
        return node_budget, edge_budget, boundary_budget

    def apply_budget(
        self,
        scored_nodes: list[ScoredNode],
        profile: TokenProfile,
        nodes: dict[str, NodeData],
        *,
        max_nodes_override: int | None = None,
        mad_t_override: float | None = None,
    ) -> list[ScoredNode]:
        """
        Assign per-node token budgets proportional to relevance scores (LOD_Z).

        Each surviving node gets a token_budget field set.  The renderer
        (engine._format_context) uses compress(node.lod_0, query, token_budget)
        to fill that budget extractively from the passage text.

        assigned_lod is also set for backward compatibility:
          - LOD_0: budget >= full lod_0 cost
          - LOD_1: budget >= lod_1 cost (will still render via compression)
          - LOD_2: budget < lod_1 cost (name/category label only)

        max_nodes_override (C.2 Traversal Modulation): when provided, overrides
        both profile.max_nodes and MAX_NODES_DEFAULT for this call. Produced by
        IntentSignal.modulation_profile() — e.g. exhaustive queries raise the
        ceiling; specific factoid queries lower it.

        mad_t_override: optional MAD-threshold multiplier. When provided and
        score distribution is non-degenerate, candidates below median + t*MAD
        are removed before the rank cap applies.

        Returns the (possibly trimmed) list of scored_nodes.
        """
        node_budget, _, _ = self.compute_pools(profile)

        if not scored_nodes or node_budget <= 0:
            return scored_nodes

        # --- Pass 0a: MAD-adaptive admission ---------------------------------
        # Adaptive cap-size based on score distribution. Bimodal distributions
        # admit narrowly; flat/degenerate distributions fall through unchanged.
        # Source: STEAL from RampLabs Latent Briefing (April 2026).
        if mad_t_override is not None and len(scored_nodes) >= 3:
            scores = [sn.score for sn in scored_nodes]
            median, mad = _compute_mad(scores)
            if mad > 0.0:
                threshold = median + mad_t_override * mad
                admitted = [sn for sn in scored_nodes if sn.score >= threshold]
                if not admitted:
                    admitted = [max(scored_nodes, key=lambda sn: sn.score)]
                scored_nodes = admitted

        # --- Pass 0b: candidate cap ------------------------------------------
        # Two-tier cap: the lower of (a) the hard ceiling (profile or C.2 override)
        # and (b) the budget-derived limit (node_budget // MIN_BUDGET_PER_NODE).
        #
        # (a) Hard ceiling separates "breadth" from "budget depth". A large budget
        #     should deepen detail on the same ~50 nodes, not widen to hundreds of
        #     shallow LOD_2 labels (the root cause of 25k budget scoring worse than
        #     5k). C.2 allows intent-driven adjustment of this ceiling.
        #
        # (b) Budget-derived limit prevents rendering nodes that would each receive
        #     fewer than MIN_BUDGET_PER_NODE tokens — they'd be LOD_2 noise.
        #
        # scored_nodes is sorted by score descending (invariant: engine calls
        # _expand_by_passage which re-sorts before passing here).
        if max_nodes_override is not None:
            hard_ceiling = max_nodes_override
        else:
            hard_ceiling = profile.max_nodes if profile.max_nodes is not None else MAX_NODES_DEFAULT
        budget_ceiling = max(1, node_budget // MIN_BUDGET_PER_NODE)
        max_nodes = min(hard_ceiling, budget_ceiling)
        if len(scored_nodes) > max_nodes:
            scored_nodes = scored_nodes[:max_nodes]

        total_score = sum(sn.score for sn in scored_nodes) or 1.0

        # Precompute LOD costs for each node
        lod0_costs: dict[str, int] = {}
        lod1_costs: dict[str, int] = {}
        for sn in scored_nodes:
            node = nodes.get(sn.entity_id)
            if node:
                lod0_costs[sn.entity_id] = estimate_tokens(node.lod_0)
                lod1_costs[sn.entity_id] = estimate_tokens(node.lod_1)

        # --- Pass 1: proportional raw allocation, capped at LOD_0 cost -------
        for sn in scored_nodes:
            raw_share = int(sn.score / total_score * node_budget)
            lod0 = lod0_costs.get(sn.entity_id, raw_share)
            sn.token_budget = min(raw_share, lod0)

        # --- Pass 2: redistribute surplus from capped nodes ------------------
        # Nodes whose proportional share exceeded their LOD_0 cost freed budget.
        surplus = node_budget - sum(sn.token_budget for sn in scored_nodes)
        if surplus > 0:
            uncapped = [
                sn for sn in scored_nodes
                if sn.token_budget < lod0_costs.get(sn.entity_id, 0)
            ]
            uncapped_score = sum(sn.score for sn in uncapped) or 1.0
            for sn in uncapped:
                lod0 = lod0_costs.get(sn.entity_id, 0)
                extra = int(sn.score / uncapped_score * surplus)
                sn.token_budget = min(sn.token_budget + extra, lod0)

        # --- Pass 3: protection guarantee ------------------------------------
        # Invariant: the highest-scored node always gets at least its full LOD_0
        # budget, by stealing from lower-scored nodes if proportional allocation
        # left it short.
        #
        # B3 audit (2026-04-22): structured log + env flag TPVRG_LOD0_INVARIANT
        # let measurement count how often this invariant is the *active*
        # constraint (best.token_budget < lod0 after Pass 2) and compare
        # accuracy with invariant on vs off.
        #
        # Separately from the invariant, the unconditional MIN_NODE_TOKENS floor
        # on the top node (guaranteeing a non-empty render) is always applied.
        if scored_nodes:
            best = max(scored_nodes, key=lambda sn: sn.score)
            lod0 = lod0_costs.get(best.entity_id, 0)
            invariant_active = best.token_budget < lod0
            if invariant_active:
                budget_pre = best.token_budget
                shortfall_at_entry = lod0 - budget_pre
                if LOD0_INVARIANT_ENABLED:
                    # Steal from the lowest-scored nodes if necessary
                    shortfall = shortfall_at_entry
                    others = sorted(
                        [sn for sn in scored_nodes if sn is not best],
                        key=lambda sn: sn.score,
                    )
                    for donor in others:
                        if shortfall <= 0:
                            break
                        give = min(shortfall, max(0, donor.token_budget - MIN_NODE_TOKENS))
                        donor.token_budget -= give
                        shortfall -= give
                    best.token_budget = lod0 - max(0, shortfall)
                    logger.info(
                        "B3_INVARIANT_ACTIVE_APPLIED score=%.4f budget_pre=%d lod0_cost=%d "
                        "shortfall_resolved=%d tokens_added=%d",
                        best.score,
                        budget_pre,
                        lod0,
                        shortfall_at_entry - shortfall,
                        best.token_budget - budget_pre,
                    )
                else:
                    logger.info(
                        "B3_INVARIANT_ACTIVE_BYPASSED score=%.4f budget_pre=%d lod0_cost=%d "
                        "shortfall_would_be=%d",
                        best.score,
                        budget_pre,
                        lod0,
                        shortfall_at_entry,
                    )
            # Always guarantee the best node has at least MIN_NODE_TOKENS
            best.token_budget = max(best.token_budget, MIN_NODE_TOKENS)

        # --- Pass 4: drop below-minimum + set estimated_tokens + assigned_lod -
        surviving: list[ScoredNode] = []
        for sn in scored_nodes:
            if sn.token_budget < MIN_NODE_TOKENS:
                continue  # drop — can't render meaningfully
            sn.estimated_tokens = sn.token_budget
            # Set assigned_lod for backward compat
            lod0 = lod0_costs.get(sn.entity_id, 0)
            lod1 = lod1_costs.get(sn.entity_id, 0)
            if sn.token_budget >= lod0:
                sn.assigned_lod = LODLevel.LOD_0
            elif sn.token_budget >= lod1:
                sn.assigned_lod = LODLevel.LOD_1
            else:
                sn.assigned_lod = LODLevel.LOD_2
            surviving.append(sn)

        return surviving
