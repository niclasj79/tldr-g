"""
SNR (Signal-to-Noise Ratio) metric for TP-VRG context quality evaluation.

Two metrics provided:

1. compute_snr() — text-based, for external/general use.
   Checks entity name presence in rendered text; weights by character fraction.
   SNR = recall × (1 + precision). Range ≈ 0–2.

2. compute_lod_snr() — LOD-level aware, used by the eval battery.
   Uses last_scored_nodes output to weight LOD_0 > LOD_1 > LOD_2.
   Range: 0.0 (nothing found) to 3.0 (all ground truth at LOD_0, no waste).
   This is the primary metric for parameter optimization.
"""

from __future__ import annotations

from tp_vrg.models import LODLevel, NodeData, ScoredNode
from tp_vrg.tokens import estimate_tokens

# LOD-level signal weights: LOD_0 = verbatim text (highest value),
# LOD_1 = summary, LOD_2 = label only (minimal signal)
_LOD_WEIGHTS: dict[LODLevel, float] = {
    LODLevel.LOD_0: 3.0,
    LODLevel.LOD_1: 1.5,
    LODLevel.LOD_2: 0.1,
}


def compute_lod_snr(
    scored_nodes: list[ScoredNode],
    all_nodes: dict[str, NodeData],
    ground_truth_names: list[str],
) -> float:
    """
    LOD-level aware SNR. Primary metric used by the eval battery.

    Assigns each ground-truth entity a weight based on its LOD assignment:
      LOD_0 → 3.0  (verbatim text rendered — high signal)
      LOD_1 → 1.5  (summary rendered — medium signal)
      LOD_2 → 0.1  (label only — minimal signal)
      missing → 0.0 (not in scored set)

    SNR = (sum of LOD weights for found GT entities) / (len(GT) × 3.0)
    Range: 0.0 to 1.0. Multiply by 3.0 to get the 0–3 scale.

    Returns value in [0.0, 3.0].
    """
    if not ground_truth_names or not scored_nodes:
        return 0.0

    # Build name → LOD mapping (case-insensitive)
    name_to_lod: dict[str, LODLevel] = {}
    for sn in scored_nodes:
        node = all_nodes.get(sn.entity_id)
        if node:
            name_to_lod[node.name.lower()] = sn.assigned_lod

    max_signal = float(len(ground_truth_names)) * 3.0
    if max_signal == 0:
        return 0.0

    signal = sum(
        _LOD_WEIGHTS.get(name_to_lod.get(name.lower(), LODLevel.LOD_2), 0.0)
        for name in ground_truth_names
    )
    return signal / max_signal * 3.0


def entities_in_context(context: str, entity_names: list[str]) -> list[str]:
    """Return which entity names appear (case-insensitive) in the rendered context string."""
    context_lower = context.lower()
    return [name for name in entity_names if name.lower() in context_lower]


def compute_snr(
    rendered_context: str,
    ground_truth_entities: list[str],
    total_rendered_tokens: int | None = None,
) -> float:
    """
    Compute SNR for a rendered context against known ground-truth entities.

    Args:
        rendered_context:     The full rendered context string from render_context().
        ground_truth_entities: Entity names that SHOULD appear in a high-quality
                               context (i.e., the correct answer is among them).
        total_rendered_tokens: Pre-computed token count for rendered_context.
                               If None, computed via estimate_tokens().

    Returns:
        snr >= 0.0. Higher is better. Typical useful range: 1.0–3.0.
        Returns 0.0 if ground_truth_entities is empty or context is empty.
    """
    if not ground_truth_entities or not rendered_context.strip():
        return 0.0

    # Recall component: fraction of ground-truth entities found in context
    found = entities_in_context(rendered_context, ground_truth_entities)
    recall = len(found) / len(ground_truth_entities)

    if recall == 0.0:
        return 0.0

    # Precision component: ratio of ground-truth tokens to total rendered tokens
    if total_rendered_tokens is None:
        total_rendered_tokens = estimate_tokens(rendered_context)

    if total_rendered_tokens == 0:
        return 0.0

    # Sum tokens attributable to each found ground-truth entity
    # Proxy: count characters per entity mention divided by total, scaled to tokens
    signal_chars = sum(len(name) for name in found)
    total_chars = max(1, len(rendered_context))
    char_fraction = signal_chars / total_chars
    signal_tokens = int(total_rendered_tokens * char_fraction)

    precision = signal_tokens / total_rendered_tokens

    return recall * (1.0 + precision)
