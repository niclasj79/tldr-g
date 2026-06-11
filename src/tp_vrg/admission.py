"""C.4 Dress-Code Governor: evaluative admission gate.

LOD_0 max-pool sentence scan determines whether a candidate node's content
actually serves the query intent.  Nodes that fail both intent and bridge
channels are rejected BEFORE the Token Governor allocates budget.

Pipeline position: after scoring + rerank, before governor.apply_budget().

Two-pass design:
  Pass 1 — VIP:  admit nodes whose LOD_0 peak sentence score >= intent threshold
                  OR whose LOD_0 mentions 2+ high-centrality entities (bridge).
  Pass 2 — Guest List:  rejected nodes that have a STRUCTURAL edge from an
                  admitted VIP are re-admitted at reduced score (topological recall).

Design: design/dress-code-governor.md
"""

from __future__ import annotations

import logging
import os

from tp_vrg.compression import query_words, split_sentences
from tp_vrg.intent import IntentSignal, intent_sentence_score
from tp_vrg.models import NodeData, ScoredNode

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configurable thresholds — calibrate from FRAMES pilot data (RQ-DCG-1)
# ---------------------------------------------------------------------------

DEFAULT_INTENT_THRESHOLD: float = float(
    os.environ.get("TPVRG_ADMISSION_INTENT_THRESHOLD", "0.15")
)
DEFAULT_BRIDGE_THRESHOLD: float = float(
    os.environ.get("TPVRG_ADMISSION_BRIDGE_THRESHOLD", "0.10")
)
TIER_2_SCORE_FACTOR: float = float(
    os.environ.get("TPVRG_TIER2_SCORE_FACTOR", "0.5")
)  # topologically recalled nodes get reduced score


def apply_descent_scope(passage_ids: list[str], descent_scope: object | None = None) -> list[str]:
    """Restrict passage candidates to a multi-resolution descent scope."""
    if descent_scope is None:
        return passage_ids
    scoped_ids = getattr(descent_scope, "passage_ids", None)
    if not scoped_ids:
        return []
    allowed = set(scoped_ids)
    return [passage_id for passage_id in passage_ids if passage_id in allowed]


# ---------------------------------------------------------------------------
# Channel 1: Intent max-pool
# ---------------------------------------------------------------------------


def admission_score(
    lod_0_text: str,
    intent: IntentSignal,
    qwords: frozenset[str],
) -> float:
    """Max-pool: peak sentence relevance across full LOD_0 text.

    Returns the highest ``intent_sentence_score`` across all sentences.
    O(S) where S = number of sentences.  No sorting, no compression.
    """
    sentences = split_sentences(lod_0_text)
    if not sentences:
        return 0.0
    return max(
        intent_sentence_score(s, intent, qwords)
        for s in sentences
    )


# ---------------------------------------------------------------------------
# Channel 2: Bridge detection (entity density)
# ---------------------------------------------------------------------------


def bridge_score(
    lod_0_text: str,
    high_centrality_names: set[str],
) -> float:
    """Entity density: does any sentence mention 2+ high-centrality entities?

    Checks if entity **names** (lowercased) appear as substrings in the
    sentence text.  Returns a normalized score: ``(matches - 1) / N`` where
    N = total high-centrality entity count, clamped to [0, 1].

    A score > 0 means the sentence bridges multiple important entities —
    potentially a multi-hop link even if it has low semantic similarity
    to the query.
    """
    if not high_centrality_names:
        return 0.0

    sentences = split_sentences(lod_0_text)
    if not sentences:
        return 0.0

    # Pre-lowercase for matching
    names_lower = {name.lower() for name in high_centrality_names}
    n = max(1, len(names_lower))

    best = 0.0
    for sent in sentences:
        sent_lower = sent.lower()
        matches = sum(1 for name in names_lower if name in sent_lower)
        if matches >= 2:
            score = (matches - 1) / n
            best = max(best, min(score, 1.0))

    return best


# ---------------------------------------------------------------------------
# Two-pass admission gate
# ---------------------------------------------------------------------------


def admission_gate(
    scored_nodes: list[ScoredNode],
    nodes: dict[str, NodeData],
    intent: IntentSignal,
    qwords: frozenset[str],
    high_centrality_names: set[str],
    structural_adj: dict[str, set[str]],
    *,
    intent_threshold: float = DEFAULT_INTENT_THRESHOLD,
    bridge_threshold: float = DEFAULT_BRIDGE_THRESHOLD,
) -> list[ScoredNode]:
    """Two-pass admission gate (Dress-Code Governor).

    Parameters
    ----------
    scored_nodes : list[ScoredNode]
        Pre-scored candidate nodes (after rerank, before governor).
    nodes : dict[str, NodeData]
        Full node data keyed by entity_id.
    intent : IntentSignal
        Classified query intent.
    qwords : frozenset[str]
        Query keywords (from ``compression.query_words``).
    high_centrality_names : set[str]
        Names of high-centrality entities for bridge detection.
    structural_adj : dict[str, set[str]]
        Pre-built adjacency map: entity_id → set of structural neighbor IDs.
    intent_threshold : float
        Minimum admission_score for Tier 1 entry (default 0.15).
    bridge_threshold : float
        Minimum bridge_score for Tier 1 entry (default 0.10).

    Returns
    -------
    list[ScoredNode]
        Admitted nodes sorted by score descending, ready for Governor.
    """
    if not scored_nodes:
        return []

    admitted: list[ScoredNode] = []
    rejected: list[ScoredNode] = []
    admitted_ids: set[str] = set()

    # ── Pass 1: Direct admission (VIP + Bridge) ──────────────────
    for sn in scored_nodes:
        node = nodes.get(sn.entity_id)
        if node is None:
            rejected.append(sn)
            continue

        lod_0 = node.lod_0 or ""
        intent_peak = admission_score(lod_0, intent, qwords)
        bridge_peak = bridge_score(lod_0, high_centrality_names)

        if intent_peak >= intent_threshold or bridge_peak >= bridge_threshold:
            admitted.append(sn)
            admitted_ids.add(sn.entity_id)
        else:
            rejected.append(sn)

    # ── Pass 2: Topological recall (Guest List) ───────────────────
    recalled = 0
    for sn in rejected:
        for admitted_id in admitted_ids:
            neighbors = structural_adj.get(admitted_id, set())
            if sn.entity_id in neighbors:
                sn.score = sn.score * TIER_2_SCORE_FACTOR
                admitted.append(sn)
                admitted_ids.add(sn.entity_id)
                recalled += 1
                break  # one connection is enough

    # Sort descending by score (Governor expects this order)
    admitted.sort(key=lambda s: s.score, reverse=True)

    # Graceful degradation: if admission rejected EVERYTHING, fall back to
    # original list.  An empty admission means the thresholds are too
    # aggressive for this query/graph — better to over-include than return
    # nothing.  Log a warning so threshold calibration is flagged.
    if not admitted and scored_nodes:
        logger.warning(
            "C.4 admission: ALL %d nodes rejected — falling back to unfiltered "
            "(thresholds may need calibration: intent=%.2f, bridge=%.2f)",
            len(scored_nodes), intent_threshold, bridge_threshold,
        )
        return scored_nodes

    logger.debug(
        "C.4 admission: %d/%d admitted (Pass 1: %d VIP, Pass 2: %d recalled, %d rejected)",
        len(admitted),
        len(scored_nodes),
        len(admitted) - recalled,
        recalled,
        len(scored_nodes) - len(admitted),
    )

    return admitted
