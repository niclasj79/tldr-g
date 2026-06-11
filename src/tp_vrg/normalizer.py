"""
Entity Normalizer — deterministic ID canonicalization and fuzzy deduplication.

Sits between LLM extraction and storage in the ingestion pipeline.
Normalizes entity_ids, fuzzy-matches against existing graph nodes,
and rewrites edges and passages to maintain referential integrity.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from rapidfuzz import fuzz, process

from tp_vrg.models import EdgeData, ExtractionResult, NodeData


@dataclass
class MergeAction:
    """Record of a single merge decision (for audit/debug)."""

    old_id: str
    canonical_id: str
    reason: str  # "id_normalization" | "fuzzy_match" | "exact_duplicate"
    similarity: float  # 1.0 for exact, 0.0-1.0 for fuzzy


@dataclass
class NormalizationResult:
    """Output of the normalization pass."""

    result: ExtractionResult
    id_map: dict[str, str]  # old_id -> canonical_id
    merges: list[MergeAction]
    nodes_merged: int
    edges_remapped: int


def normalize_entity_id(raw_id: str) -> str:
    """
    Deterministic string canonicalization.

    Steps:
    1. Unicode NFKC (handles accents, ligatures)
    2. Lowercase
    3. Replace all non-alphanumeric characters with underscore
    4. Collapse consecutive underscores to single underscore
    5. Strip leading/trailing underscores

    Examples:
        "OpenAI_Inc" -> "openai_inc"
        "GPT-4"      -> "gpt_4"
        "Sam Altman"  -> "sam_altman"
        "open--ai"    -> "open_ai"
        ""            -> ""
    """
    if not raw_id:
        return ""
    normalized = unicodedata.normalize("NFKC", raw_id)
    normalized = normalized.lower()
    normalized = re.sub(r"[^a-z0-9]", "_", normalized)
    normalized = re.sub(r"_+", "_", normalized)
    normalized = normalized.strip("_")
    return normalized


def _fuzzy_best_match(
    candidate: str,
    choices: list[str],
    threshold: float,
) -> tuple[str | None, float]:
    """
    Find the best fuzzy match for candidate among choices.

    Returns (best_match, similarity) or (None, 0.0).
    Uses rapidfuzz; it is a base dependency because normalization runs in the
    default ingestion path.
    """
    if not choices:
        return None, 0.0

    result = process.extractOne(
        candidate,
        choices,
        scorer=fuzz.ratio,
        score_cutoff=threshold * 100,
    )
    if result is not None:
        return result[0], result[1] / 100.0
    return None, 0.0


def build_id_map(
    new_ids: list[str],
    existing_ids: set[str],
    existing_categories: dict[str, str],
    new_categories: dict[str, str],
    fuzzy_threshold: float = 0.85,
) -> tuple[dict[str, str], list[MergeAction]]:
    """
    Build a mapping from raw extracted IDs to canonical IDs.

    Process:
    1. Normalize each new ID via normalize_entity_id()
    2. If normalized ID exactly matches existing ID, map to it
    3. If normalized ID already mapped (within same batch), map to same canonical
    4. Otherwise, fuzzy-match against same-category existing IDs
    5. If best match >= fuzzy_threshold, map to it
    6. If no match found, normalized ID becomes the canonical ID

    Returns:
        (id_map dict, merge_actions list)
    """
    id_map: dict[str, str] = {}
    merges: list[MergeAction] = []
    # Track canonical values we've already assigned to catch within-batch collisions
    norm_to_canonical: dict[str, str] = {}

    for raw_id in new_ids:
        norm_id = normalize_entity_id(raw_id)

        # 1. Check for exact match after normalization against existing IDs
        if norm_id in existing_ids:
            id_map[raw_id] = norm_id
            norm_to_canonical[norm_id] = norm_id
            if raw_id != norm_id:
                merges.append(
                    MergeAction(raw_id, norm_id, "id_normalization", 1.0)
                )
            continue

        # 2. Check if this normalized ID was already assigned in this batch
        if norm_id in norm_to_canonical:
            canonical = norm_to_canonical[norm_id]
            id_map[raw_id] = canonical
            if raw_id != norm_id:
                merges.append(
                    MergeAction(raw_id, canonical, "id_normalization", 1.0)
                )
            continue

        # 3. Fuzzy match against same-category existing IDs
        new_cat = new_categories.get(raw_id, "")
        same_cat_ids = [
            eid
            for eid in existing_ids
            if existing_categories.get(eid, "") == new_cat
        ]

        best_match, score = _fuzzy_best_match(
            norm_id, same_cat_ids, fuzzy_threshold
        )
        if best_match is not None:
            id_map[raw_id] = best_match
            norm_to_canonical[norm_id] = best_match
            merges.append(MergeAction(raw_id, best_match, "fuzzy_match", score))
        else:
            id_map[raw_id] = norm_id
            norm_to_canonical[norm_id] = norm_id
            if raw_id != norm_id:
                merges.append(
                    MergeAction(raw_id, norm_id, "id_normalization", 1.0)
                )

    return id_map, merges


def apply_normalization(
    result: ExtractionResult,
    id_map: dict[str, str],
) -> tuple[ExtractionResult, int]:
    """
    Rewrite entity_ids in nodes and edges using the id_map.

    Returns (rewritten_result, edges_remapped_count).
    """
    # -- Nodes --
    seen_canonical: dict[str, NodeData] = {}
    for node in result.nodes:
        canonical = id_map.get(node.entity_id, node.entity_id)
        node.entity_id = canonical
        if node.parent_id:
            node.parent_id = id_map.get(node.parent_id, node.parent_id)

        # Collision: two nodes -> same ID. Keep the one with richer lod_1.
        if canonical in seen_canonical:
            existing = seen_canonical[canonical]
            if len(node.lod_1) > len(existing.lod_1):
                seen_canonical[canonical] = node
        else:
            seen_canonical[canonical] = node

    # -- Edges --
    edges_remapped = 0
    seen_edges: set[tuple[str, str, str]] = set()
    deduped_edges: list[EdgeData] = []

    for edge in result.edges:
        old_src, old_tgt = edge.source, edge.target
        edge.source = id_map.get(edge.source, edge.source)
        edge.target = id_map.get(edge.target, edge.target)
        if edge.source != old_src or edge.target != old_tgt:
            edges_remapped += 1
        if edge.source == edge.target:  # Self-loop after merge
            continue
        edge_key = (edge.source, edge.target, edge.relation)
        if edge_key not in seen_edges:
            seen_edges.add(edge_key)
            deduped_edges.append(edge)

    return (
        ExtractionResult(nodes=list(seen_canonical.values()), edges=deduped_edges),
        edges_remapped,
    )


def normalize_extraction(
    result: ExtractionResult,
    existing_ids: set[str],
    existing_categories: dict[str, str],
    fuzzy_threshold: float = 0.85,
) -> NormalizationResult:
    """Main entry point: normalize + fuzzy-match + rewrite an ExtractionResult."""
    new_categories = {n.entity_id: n.category for n in result.nodes}
    new_ids = [n.entity_id for n in result.nodes]

    id_map, merges = build_id_map(
        new_ids, existing_ids, existing_categories, new_categories, fuzzy_threshold
    )
    rewritten, edges_remapped = apply_normalization(result, id_map)
    nodes_merged = sum(1 for old, new in id_map.items() if old != new)

    return NormalizationResult(
        result=rewritten,
        id_map=id_map,
        merges=merges,
        nodes_merged=nodes_merged,
        edges_remapped=edges_remapped,
    )


class EntityNormalizer:
    """
    Configurable entity normalizer. Called from engine.py.

    Holds configuration (threshold, enabled flags) and provides
    a single normalize() method for the engine to call.
    """

    def __init__(
        self,
        fuzzy_threshold: float = 0.85,
        fuzzy_enabled: bool = True,
    ) -> None:
        self.fuzzy_threshold = fuzzy_threshold
        self.fuzzy_enabled = fuzzy_enabled

    def normalize(
        self,
        result: ExtractionResult,
        storage=None,  # StorageBackend (duck-typed)
        existing_ids: set[str] | None = None,
        existing_categories: dict[str, str] | None = None,
    ) -> NormalizationResult:
        """
        Normalize an extraction result against the current graph state.

        Reads existing IDs and categories either from a caller-provided cache
        (existing_ids + existing_categories) or from storage (read-only).
        Returns a NormalizationResult with rewritten nodes/edges.
        """
        if existing_ids is None or existing_categories is None:
            if storage is None:
                raise ValueError(
                    "EntityNormalizer.normalize requires either storage or cached index."
                )
            existing_nodes = storage.get_all_nodes()
            existing_ids = set(existing_nodes.keys())
            existing_categories = {
                eid: node.category for eid, node in existing_nodes.items()
            }

        threshold = self.fuzzy_threshold if self.fuzzy_enabled else 1.0

        return normalize_extraction(
            result, existing_ids, existing_categories, threshold
        )
