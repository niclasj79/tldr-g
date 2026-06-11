"""One rung of the multi-resolution descent.

This module consumes baked community centroids plus same-rung bundle edges. The
bundle substrate is the closure-preserving object; centroid cosine is only one
seed signal for the descent beam.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass

import numpy as np

from tp_vrg.models import RELATION_CLASSES
from tp_vrg.multi_res.centroid_query import Candidate, cosine_top_k
from tp_vrg.multi_res.descent_scoring import (
    DESCENT_TOP_M,
    bundle_pull_score as _bundle_pull_score,
    descent_min_score,
    descent_top_m,
    level_weights,
    traversal_threshold,
    validate_level,
)
from tp_vrg.storage.community_partitions import Rung, init_schema


@dataclass(frozen=True)
class CommunityBundleEdge:
    """One same-rung baked bundle edge from a seed to a neighbor."""

    source_id: str
    neighbor_id: str
    level: str
    weight: float
    max_weight: float
    sigma_family: str | None = None

    @property
    def bundle_id(self) -> str:
        return f"{self.level}:{self.source_id}->{self.neighbor_id}"


def bundle_pull_score(bundle: CommunityBundleEdge, intent: object, level: str) -> float:
    return _bundle_pull_score(bundle.weight, bundle.max_weight, intent)


def _max_edge_weight(level: Rung, conn) -> float:
    row = conn.execute(
        "SELECT MAX(weight) FROM community_edges WHERE rung = ?",
        (level,),
    ).fetchone()
    return max(float(row[0] or 1.0), 1.0)


def bundle_neighbors(
    community_id: str,
    level: str,
    conn,
    *,
    restrict_to: Iterable[str] | None = None,
) -> list[CommunityBundleEdge]:
    """Return same-level neighbors for one seed community."""
    resolved = validate_level(level)
    init_schema(conn)
    scope = {str(item) for item in restrict_to} if restrict_to is not None else None
    rows = conn.execute(
        """
        SELECT community_a, community_b, weight
        FROM community_edges
        WHERE rung = ? AND (community_a = ? OR community_b = ?)
        ORDER BY weight DESC, community_a, community_b
        """,
        (resolved, community_id, community_id),
    ).fetchall()
    max_weight = _max_edge_weight(resolved, conn)
    neighbors: list[CommunityBundleEdge] = []
    for community_a, community_b, weight in rows:
        neighbor_id = str(community_b) if str(community_a) == community_id else str(community_a)
        if scope is not None and neighbor_id not in scope:
            continue
        neighbors.append(
            CommunityBundleEdge(
                source_id=community_id,
                neighbor_id=neighbor_id,
                level=resolved,
                weight=float(weight),
                max_weight=max_weight,
            )
        )
    return neighbors


def dominant_sigma_family(candidate: Candidate, level: str | None = None) -> str:
    """Return the candidate's named sigma axis for diversity pruning."""
    if candidate.sigma_family in RELATION_CLASSES:
        return candidate.sigma_family
    return candidate.sigma_family or "unknown"


def score_combine(
    *,
    cosine_seeds: Sequence[Candidate],
    traversal_expansions: Sequence[Candidate],
    intent: object,
    level: str,
    parent_scores: Mapping[str, float] | None = None,
) -> list[Candidate]:
    """Combine centroid, bundle, and inherited parent signals per community."""
    weights = level_weights(intent, level)
    parent_scores = parent_scores or {}
    by_id: dict[str, dict[str, object]] = {}

    def ensure(candidate: Candidate) -> dict[str, object]:
        return by_id.setdefault(
            candidate.community_id,
            {
                "candidate": candidate,
                "cosine": 0.0,
                "bundle": 0.0,
                "parent": max(parent_scores.get(candidate.community_id, 0.0), candidate.parent_score),
            },
        )

    for candidate in cosine_seeds:
        ensure(candidate)["cosine"] = max(float(ensure(candidate)["cosine"]), candidate.score)
    for candidate in traversal_expansions:
        entry = ensure(candidate)
        entry["bundle"] = max(float(entry["bundle"]), candidate.score)
        entry["candidate"] = candidate

    combined: list[Candidate] = []
    for entry in by_id.values():
        candidate = entry["candidate"]
        assert isinstance(candidate, Candidate)
        score = (
            weights["cosine"] * float(entry["cosine"])
            + weights["bundle"] * float(entry["bundle"])
            + weights["parent"] * float(entry["parent"])
        )
        combined.append(
            Candidate(
                community_id=candidate.community_id,
                level=candidate.level,
                score=float(score),
                source_seed=candidate.source_seed,
                source="combined",
                via_bundle=candidate.via_bundle,
                sigma_family=candidate.sigma_family,
                parent_score=float(entry["parent"]),
            )
        )
    return sorted(combined, key=lambda candidate: candidate.score, reverse=True)


def prune_level_candidates(
    candidates: Sequence[Candidate],
    *,
    max_items: int,
    min_score: float = 0.0,
    diversity_key: Callable[[Candidate], str] = dominant_sigma_family,
) -> list[Candidate]:
    """Prune a level beam while preserving at least one strong candidate per family."""
    eligible = [candidate for candidate in candidates if candidate.score >= min_score]
    ordered = sorted(eligible, key=lambda candidate: candidate.score, reverse=True)
    selected: list[Candidate] = []
    selected_ids: set[str] = set()
    seen_families: set[str] = set()
    for candidate in ordered:
        family = diversity_key(candidate)
        if family in seen_families:
            continue
        selected.append(candidate)
        selected_ids.add(candidate.community_id)
        seen_families.add(family)
        if len(selected) >= max_items:
            return selected
    for candidate in ordered:
        if candidate.community_id in selected_ids:
            continue
        selected.append(candidate)
        if len(selected) >= max_items:
            break
    return selected


def descent_step(
    query_embedding: Sequence[float] | np.ndarray,
    intent: object,
    level: str,
    beam: Sequence[Candidate],
    conn,
    *,
    restrict_to: Iterable[str] | None = None,
    k: int | None = None,
    max_items: int | None = None,
) -> list[Candidate]:
    """Run one centroid + bundle expansion + prune step for a descent rung."""
    resolved = validate_level(level)
    top_m = max_items or descent_top_m(resolved, intent)
    scope = list(dict.fromkeys(str(item) for item in restrict_to)) if restrict_to is not None else None
    centroid_seeds = cosine_top_k(
        query_embedding,
        resolved,
        conn,
        restrict_to=scope,
        k=k or top_m,
    )

    traversal_expansions: list[Candidate] = []
    threshold = traversal_threshold(resolved, intent)
    for seed in centroid_seeds:
        for bundle in bundle_neighbors(seed.community_id, resolved, conn, restrict_to=scope):
            pull = bundle_pull_score(bundle, intent, resolved)
            if pull < threshold:
                continue
            traversal_expansions.append(
                Candidate(
                    community_id=bundle.neighbor_id,
                    level=resolved,
                    score=pull,
                    source_seed=seed.community_id,
                    source="bundle",
                    via_bundle=bundle.bundle_id,
                    sigma_family=bundle.sigma_family,
                )
            )

    parent_scores = {candidate.community_id: candidate.score for candidate in beam}
    combined = score_combine(
        cosine_seeds=centroid_seeds,
        traversal_expansions=traversal_expansions,
        intent=intent,
        level=resolved,
        parent_scores=parent_scores,
    )
    return prune_level_candidates(
        combined,
        max_items=top_m,
        min_score=descent_min_score(resolved, intent),
        diversity_key=dominant_sigma_family,
    )


__all__ = [
    "CommunityBundleEdge",
    "DESCENT_TOP_M",
    "bundle_neighbors",
    "bundle_pull_score",
    "descent_min_score",
    "descent_step",
    "descent_top_m",
    "dominant_sigma_family",
    "prune_level_candidates",
    "score_combine",
    "traversal_threshold",
]
