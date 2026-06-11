"""
Semantic Relevance Scorer — the core heuristic engine.

Combines six signals into a composite relevance score per node:
  1. Semantic Proximity (S): cosine similarity between query and node embeddings
  2. Topological Weight (T): backbone centrality (structural hub detection)
  3. Graph Distance (D): inverse-distance decay from anchor nodes
  4. Parent Signal (P): sibling-chunk boost for nodes sharing a parent with anchors
  5. Recency (R): inverse half-life decay from node creation time
  6. Temporal Proximity (TP): distance from query reference date to node's temporal
     context (F14). Active only when temporal_ref_year is set and weight > 0.

Score is normalized by the active weight sum:
  score = (w_s*S + w_t*T + w_d*D + w_p*P + w_r*R + w_tp*TP) / active_weights

where active_weights = w_s + w_t + w_d + w_r + (w_p if node has parent_id else 0).
This guarantees score ∈ [0.0, 1.0].

The composite score determines LOD assignment:
  score >= high_threshold -> LOD_0 (full detail)
  score >= low_threshold  -> LOD_1 (summary)
  score < low_threshold   -> LOD_2 (label only)
"""

from __future__ import annotations

from datetime import datetime, timezone
import os
import statistics

import numpy as np

from tp_vrg.embeddings import EmbeddingProvider, cosine_similarity
from tp_vrg.models import (
    DEFAULT_KOLMOGOROV_DECAY_EXPONENT,
    LODLevel,
    NodeData,
    ScoredNode,
    WH_TYPE_CATEGORY_PRIOR,
    WH_TYPE_PRIOR_BOOST,
)

DEFAULT_WEIGHT_SEMANTIC: float = float(os.environ.get("TPVRG_W_SEMANTIC", "0.70"))
DEFAULT_WEIGHT_TOPOLOGICAL: float = float(os.environ.get("TPVRG_W_TOPOLOGICAL", "0.15"))
DEFAULT_WEIGHT_DISTANCE: float = float(os.environ.get("TPVRG_W_DISTANCE", "0.10"))
DEFAULT_WEIGHT_PARENT: float = float(os.environ.get("TPVRG_W_PARENT", "0.10"))
DEFAULT_WEIGHT_RECENCY: float = float(os.environ.get("TPVRG_W_RECENCY", "0.05"))
DEFAULT_LOD0_THRESHOLD: float = float(os.environ.get("TPVRG_LOD0_THRESHOLD", "0.60"))
DEFAULT_LOD1_THRESHOLD: float = float(os.environ.get("TPVRG_LOD1_THRESHOLD", "0.15"))
DEFAULT_LOD_THRESHOLDS: tuple[float, float] = (DEFAULT_LOD0_THRESHOLD, DEFAULT_LOD1_THRESHOLD)
DEFAULT_LOD0_SLOTS: int = int(os.environ.get("TPVRG_LOD0_SLOTS", "4"))
DEFAULT_LOD1_FRACTION: float = float(os.environ.get("TPVRG_LOD1_FRACTION", "0.15"))


def _compute_mad(scores: list[float]) -> tuple[float, float]:
    """Return (median, MAD) for scores.

    MAD is the median absolute deviation from the median. Empty and
    single-score inputs are degenerate for admission, so callers should fall
    through to the existing rank cap when ``mad == 0.0``.
    """
    if len(scores) < 2:
        return (0.0, 0.0)
    med = statistics.median(scores)
    mad = statistics.median(abs(score - med) for score in scores)
    return (med, mad)


def _intent_to_mad_t(intent) -> float:
    """Map intent reasoning depth to a MAD admission multiplier."""
    depth = getattr(intent, "reasoning_depth", 0.0) or 0.0
    if depth > 0.7:
        return 2.0
    if depth > 0.4:
        return 1.0
    return -1.0


class RelevanceScorer:
    """
    Composite relevance scorer with dynamic denominator normalization.

    score(node) = (w_s*S + w_t*T + w_d*D + w_p*P + w_r*R + w_tp*TP) / active_weights

    Where:
      S = cosine_similarity(query_embedding, node_embedding)  [0, 1]
      T = normalized_backbone_centrality(node)                [0, 1]
      D = 1 / (1 + hop_distance)^decay_exponent              (0, 1]
      P = parent_document_signal(node, anchors)              {0, 1}
      R = 1 / (1 + age_days / half_life_days)                (0, 1]
      active_weights = w_s + w_t + w_d + w_r + (w_p if node.parent_id else 0)

    R=0.0 when no timestamps are provided (backward-compatible default).
    The normalization guarantees score ∈ [0.0, 1.0], making LOD thresholds
    semantically stable regardless of which signals are active.
    """

    def __init__(
        self,
        weight_semantic: float = DEFAULT_WEIGHT_SEMANTIC,
        weight_topological: float = DEFAULT_WEIGHT_TOPOLOGICAL,
        weight_distance: float = DEFAULT_WEIGHT_DISTANCE,
        weight_parent: float = DEFAULT_WEIGHT_PARENT,
        weight_recency: float = DEFAULT_WEIGHT_RECENCY,
        recency_half_life_days: float = 30.0,
        category_half_lives: dict[str, float] | None = None,
        lod_thresholds: tuple[float, float] = DEFAULT_LOD_THRESHOLDS,
        lod0_slots: int = DEFAULT_LOD0_SLOTS,
        lod1_fraction: float = DEFAULT_LOD1_FRACTION,
        use_rank_assignment: bool = True,
        decay_exponent: float = DEFAULT_KOLMOGOROV_DECAY_EXPONENT,
    ) -> None:
        self.w_s = weight_semantic
        self.w_t = weight_topological
        self.w_d = weight_distance
        self.w_p = weight_parent
        self.w_r = weight_recency
        self.recency_half_life_days = recency_half_life_days
        # SOTA: Category-specific temporal decay — adopted from Hindsight (arXiv:2512.12818)
        # Different entity types decay at different rates. Scientific facts are durable;
        # personal preferences are transient. Default half-lives calibrated from
        # Hindsight's entity-type-specific λ values.
        self.category_half_lives: dict[str, float] = category_half_lives or {
            # Durable knowledge (slow decay)
            "concept": 365.0,
            "organization": 365.0,
            "technology": 180.0,
            "law": 730.0,
            "scientific_fact": 1900.0,
            # Medium decay
            "event": 90.0,
            "product": 120.0,
            "location": 365.0,
            "person": 180.0,
            # Transient (fast decay)
            "preference": 60.0,
            "transaction": 90.0,
            "status": 30.0,
            "date": 30.0,
        }
        self.threshold_high = lod_thresholds[0]
        self.threshold_low = lod_thresholds[1]
        self.lod0_slots = lod0_slots
        self.lod1_fraction = lod1_fraction
        self.use_rank_assignment = use_rank_assignment
        self._decay_exponent = decay_exponent

    async def score_nodes(
        self,
        query_embedding: np.ndarray,
        nodes: dict[str, NodeData],
        distances: dict[str, int],
        centralities: dict[str, float],
        embedder: EmbeddingProvider,
        *,
        timestamps: dict[str, str] | None = None,
        weight_overrides: dict[str, float] | None = None,
        temporal_ref_year: int | None = None,
        passage_temporals: dict[str, tuple[int, int]] | None = None,
        passage_entity_map: dict[str, list[str]] | None = None,
        intent=None,
    ) -> list[ScoredNode]:
        """
        Score all nodes and assign LOD levels based on composite relevance.

        Includes parent document signal: nodes sharing a parent with high-scoring
        anchors get a relevance boost, enabling sibling context retrieval.

        Includes recency signal: nodes ingested more recently score higher via
        half-life decay R = 1/(1 + age_days/half_life_days). Pass timestamps
        as {entity_id: created_at_iso} from storage.get_node_timestamps().
        When timestamps is None, recency signal is 0.0 for all nodes (backward
        compatible — no change in scoring behavior).

        weight_overrides (C.2 Traversal Modulation): optional dict of per-call
        weight overrides produced by IntentSignal.modulation_profile(). Recognised
        keys: weight_semantic, weight_topological, weight_distance, weight_recency.
        Overrides are applied only for this call — instance defaults are unchanged.

        Returns a list of ScoredNode objects sorted by score descending.
        """
        # Apply C.2 weight overrides for this scoring pass (instance unchanged)
        w_s = weight_overrides.get("weight_semantic", self.w_s) if weight_overrides else self.w_s
        w_t = weight_overrides.get("weight_topological", self.w_t) if weight_overrides else self.w_t
        w_d = weight_overrides.get("weight_distance", self.w_d) if weight_overrides else self.w_d
        w_p = self.w_p  # parent signal not yet modulated
        w_r = weight_overrides.get("weight_recency", self.w_r) if weight_overrides else self.w_r
        # F14: temporal_proximity weight — 0.0 by default, injected via intent modulation
        w_tp = weight_overrides.get("weight_temporal_proximity", 0.0) if weight_overrides else 0.0

        # Normalize centralities to [0, 1] so betweenness/PageRank/degree all
        # share the same downstream score range despite different distributions.
        max_centrality = max(centralities.values()) if centralities else 0.0
        norm_factor = max_centrality if max_centrality > 0 else 1.0

        # Pre-compute reference time for recency calculation
        now_utc = datetime.now(timezone.utc) if timestamps else None

        scored: list[ScoredNode] = []
        anchor_parents: set[str] = set()  # Collect parent IDs of high-scoring anchors

        for eid, node in nodes.items():
            # Semantic proximity
            if node.embedding is not None:
                node_emb = np.array(node.embedding, dtype=np.float32)
                sem = cosine_similarity(query_embedding, node_emb)
                # Clamp to [0, 1] — cosine sim can be negative
                sem = max(0.0, sem)
            else:
                sem = 0.0

            # Topological weight (normalized backbone centrality)
            raw_centrality = centralities.get(eid, 0.0)
            topo = raw_centrality / norm_factor

            # SOTA: Kolmogorov power-law distance decay — adopted from Kolmogorov, 1941.
            hop = distances.get(eid, 999)
            dist_signal = 1.0 / ((1.0 + hop) ** self._decay_exponent)

            # Track anchor parent IDs (nodes with good semantic proximity)
            if sem > 0.3 and node.parent_id:
                anchor_parents.add(node.parent_id)

            # Parent document signal (boost for sibling chunks)
            parent_signal = self._parent_signal(node, anchor_parents)

            # Recency signal — R = 1/(1 + age_days/half_life)
            # Only computed (and included in denominator) when timestamps are provided.
            # When timestamps=None: recency=0.0 and w_r excluded from active_weights,
            # preserving identical scoring behaviour to the pre-recency system.
            recency = self._recency_signal(eid, timestamps, now_utc, category=node.category)

            # F14: Temporal proximity signal — active only when temporal_ref_year is set
            # and weight_temporal_proximity > 0 (injected via intent modulation)
            temporal_prox = 0.0
            if temporal_ref_year is not None and w_tp > 0:
                temporal_prox = self._temporal_proximity(
                    node, temporal_ref_year, passage_temporals or {}, passage_entity_map or {}
                )

            # Dynamic denominator: include w_r only when timestamps provided;
            # include w_p only if node has a parent_id.
            # F14: include w_tp only when temporal_ref_year is set.
            # Uses the (possibly overridden) local w_* variables from C.2.
            active_weights = w_s + w_t + w_d
            if timestamps is not None:
                active_weights += w_r
            if node.parent_id is not None:
                active_weights += w_p
            if temporal_ref_year is not None and w_tp > 0:
                active_weights += w_tp

            # Composite score (normalized to [0, 1])
            raw_score = (
                w_s * sem
                + w_t * topo
                + w_d * dist_signal
                + w_p * parent_signal
                + w_r * recency
                + w_tp * temporal_prox
            )
            if intent is not None:
                wh_type = getattr(intent, "wh_type", "")
                expected = WH_TYPE_CATEGORY_PRIOR.get(wh_type, set())
                category = (node.category or "").lower()
                if expected and category in expected:
                    raw_score += WH_TYPE_PRIOR_BOOST
            score = raw_score / active_weights if active_weights > 0 else 0.0
            score = min(score, 1.0)

            # LOD assignment
            lod = self._assign_lod(score)

            scored.append(
                ScoredNode(
                    entity_id=eid,
                    score=score,
                    semantic_proximity=sem,
                    topological_weight=topo,
                    graph_distance=hop,
                    parent_signal=parent_signal,
                    recency_signal=recency,
                    assigned_lod=lod,
                )
            )

        scored.sort(key=lambda sn: sn.score, reverse=True)

        # Apply rank-based LOD assignment (guarantees LOD_0 nodes exist)
        if self.use_rank_assignment:
            scored = self._assign_lod_ranked(scored)

        return scored

    @staticmethod
    def _parent_signal(node: NodeData, anchor_parents: set[str]) -> float:
        """
        Compute parent document signal boost.

        Returns 1.0 if node shares a parent with any anchor node, 0.0 otherwise.
        This boosts chunk nodes that are siblings of directly relevant nodes,
        enabling retrieval of related sections without overriding semantic relevance.
        """
        if node.parent_id and node.parent_id in anchor_parents:
            return 1.0
        return 0.0

    def _recency_signal(
        self,
        entity_id: str,
        timestamps: dict[str, str] | None,
        now_utc: datetime | None,
        category: str = "",
    ) -> float:
        """
        Compute temporal recency signal via category-aware half-life decay.

        R = 1 / (1 + age_days / half_life_days)

        Half-life varies by entity category (SOTA steal from Hindsight):
        scientific facts decay slowly (~1900 days), personal preferences
        decay fast (~60 days). Falls back to self.recency_half_life_days
        for unknown categories.

        Returns 0.0 when no timestamps provided (backward-compatible default).
        Returns 1.0 for nodes with no timestamp entry (treated as brand-new).
        SQLite stores created_at as 'YYYY-MM-DD HH:MM:SS' (no timezone); assumed UTC.
        """
        if timestamps is None or now_utc is None:
            return 0.0
        ts_str = timestamps.get(entity_id)
        if not ts_str:
            return 1.0  # No timestamp → treat as maximally recent
        try:
            created = datetime.fromisoformat(ts_str).replace(tzinfo=timezone.utc)
            age_days = (now_utc - created).total_seconds() / 86400.0
            age_days = max(0.0, age_days)
            # Category-specific half-life (fall back to default if unknown)
            half_life = self.category_half_lives.get(
                category.lower(), self.recency_half_life_days
            )
            return 1.0 / (1.0 + age_days / half_life)
        except (ValueError, OSError):
            return 1.0  # Unparseable timestamp → treat as recent (safe default)

    @staticmethod
    def _temporal_proximity(
        node: NodeData,
        temporal_ref_year: int,
        passage_temporals: dict[str, tuple[int, int]],
        passage_entity_map: dict[str, list[str]],
    ) -> float:
        """F14: Compute temporal proximity between query reference date and node's temporal context.

        For TEMPORAL_ANCHOR nodes: direct year-to-year distance decay.
        For regular nodes: find the node's passage, use passage temporal_min/max.
        Returns 0.0 if no temporal metadata available.

        Half-life of 10 years: score = 1/(1 + distance/10).
        Within range: 1.0.  10 years away: 0.5.  20 years: 0.33.
        """
        # TEMPORAL_ANCHOR nodes: direct match
        if node.category == "temporal_anchor":
            try:
                node_year = int(node.name)
                distance = abs(node_year - temporal_ref_year)
                return 1.0 / (1.0 + distance / 10.0)
            except ValueError:
                return 0.0

        # Regular nodes: use passage temporal range
        best_score = 0.0
        for pid, (tmin, tmax) in passage_temporals.items():
            entity_ids = passage_entity_map.get(pid, [])
            if node.entity_id in entity_ids:
                if tmin <= temporal_ref_year <= tmax:
                    best_score = max(best_score, 1.0)
                else:
                    dist = min(abs(temporal_ref_year - tmin), abs(temporal_ref_year - tmax))
                    best_score = max(best_score, 1.0 / (1.0 + dist / 10.0))

        return best_score

    def _assign_lod(self, score: float) -> LODLevel:
        """Assign LOD tier from composite score (threshold-based fallback)."""
        if score >= self.threshold_high:
            return LODLevel.LOD_0
        elif score >= self.threshold_low:
            return LODLevel.LOD_1
        else:
            return LODLevel.LOD_2

    def _assign_lod_ranked(self, scored_nodes: list[ScoredNode]) -> list[ScoredNode]:
        """
        Rank-based LOD assignment: top N get LOD_0, next fraction get LOD_1,
        rest get LOD_2.

        Guarantees at least 1 LOD_0 node per query regardless of absolute score
        values, solving the "0 LOD_0 nodes" problem seen with real embeddings.
        """
        n = len(scored_nodes)
        if n == 0:
            return scored_nodes

        lod0_count = min(self.lod0_slots, max(1, n))
        lod1_count = max(1, int(n * self.lod1_fraction))

        for i, sn in enumerate(scored_nodes):  # already sorted by score desc
            if i < lod0_count:
                sn.assigned_lod = LODLevel.LOD_0
            elif i < lod0_count + lod1_count:
                sn.assigned_lod = LODLevel.LOD_1
            else:
                sn.assigned_lod = LODLevel.LOD_2

        return scored_nodes
