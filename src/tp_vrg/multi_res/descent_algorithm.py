"""Recursive Continent -> Island -> Asset descent orchestration."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

import numpy as np

from tp_vrg.cardinality import probe
from tp_vrg.intent import classify_intent
from tp_vrg.multi_res.centroid_query import Candidate
from tp_vrg.multi_res.descent_scoring import validate_level
from tp_vrg.multi_res.descent_step import descent_step
from tp_vrg.multi_res.entry_seed import seed_entry_level
from tp_vrg.multi_res.errors import StaleSubstrateError
from tp_vrg.storage.community_partitions import Rung, read_partition

LEVEL_ORDER: tuple[Rung, ...] = ("continent", "island", "asset")
CHILD_LEVEL: Mapping[Rung, Rung] = {"continent": "island", "island": "asset"}
DEFAULT_PASSAGE_SCOPE_BUDGET = 50


@dataclass(frozen=True)
class GraphScope:
    """Optional allowed community ids per rung."""

    allowed_by_level: Mapping[str, Sequence[str]] = field(default_factory=dict)

    def allowed_communities(self, level: str) -> list[str] | None:
        allowed = self.allowed_by_level.get(level)
        if allowed is None:
            return None
        return [str(community_id) for community_id in allowed]


@dataclass(frozen=True)
class LevelTrace:
    """Telemetry for one descent rung."""

    level: str
    candidate_ids: tuple[str, ...]
    candidate_count: int
    pruned_to: int
    bottomed_out: bool = False
    bottom_out_reason: str | None = None


@dataclass(frozen=True)
class PassageScope:
    """Bounded passage-rung scope returned by macro descent."""

    passage_ids: tuple[str, ...]
    descent_trace: tuple[LevelTrace, ...]
    final_beam: tuple[Candidate, ...]
    skipped: bool = False
    skip_reason: str | None = None


def should_skip_multires(intent: object, mode_profile: object | None, graph_scope: GraphScope) -> bool:
    """Skip the ladder for narrow exact lookups; Item 5 wires the single-resolution path."""
    profile_name = str(getattr(mode_profile, "name", mode_profile or "standard")).lower()
    if profile_name == "lean":
        return True
    specificity = float(getattr(intent, "specificity", 0.5) or 0.5)
    reasoning = float(getattr(intent, "reasoning_depth", 0.0) or 0.0)
    exhaustiveness = float(getattr(intent, "exhaustiveness", 0.5) or 0.5)
    return specificity >= 0.85 and reasoning <= 0.3 and exhaustiveness <= 0.6


def choose_entry_level(intent: object, graph_scope: GraphScope) -> Rung:
    """Default to the Continent rung for single-Mega corpora."""
    return "continent"


def levels_from_top_down(entry_level: str, stop_at: str = "passage") -> list[Rung]:
    resolved = validate_level(entry_level)
    start = LEVEL_ORDER.index(resolved)
    return list(LEVEL_ORDER[start:])


def descend_to_children(beam: Sequence[Candidate], level: str, conn) -> list[Candidate]:
    """Map parent beam communities to child-rung candidate scope."""
    resolved = validate_level(level)
    if resolved not in CHILD_LEVEL:
        return list(beam)
    child_level = CHILD_LEVEL[resolved]
    partition = read_partition(resolved, conn)
    if not partition:
        raise StaleSubstrateError(
            f"Missing {resolved} partition; run bake_partitions before multi-resolution descent"
        )
    children: list[Candidate] = []
    for parent in beam:
        member_ids = partition.get(parent.community_id)
        if not member_ids:
            continue
        for child_id in member_ids:
            children.append(
                Candidate(
                    community_id=str(child_id),
                    level=child_level,
                    score=parent.score,
                    source_seed=parent.community_id,
                    source="parent",
                    parent_score=parent.score,
                )
            )
    if not children:
        raise StaleSubstrateError(
            f"{resolved} partition has no children for current beam; substrate may be stale"
        )
    return children


def should_bottom_out(intent: object, beam: Sequence[Candidate], level: str) -> tuple[bool, str | None]:
    """Bottom out early only for high-confidence specific queries."""
    if not beam or level == "continent":
        return False, None
    specificity = float(getattr(intent, "specificity", 0.5) or 0.5)
    best = max(candidate.score for candidate in beam)
    if specificity >= 0.75 and len(beam) <= 2 and best >= 0.55:
        return True, f"high_specificity_confident_{level}_beam"
    return False, None


def _asset_ids_for(level: str, community_id: str, conn) -> list[str]:
    if level == "asset":
        return [community_id]
    partition = read_partition(level, conn)
    if not partition:
        raise StaleSubstrateError(f"Missing {level} partition; run bake_partitions")
    child_ids = partition.get(community_id, [])
    if level == "island":
        return [str(child_id) for child_id in child_ids]
    assets: list[str] = []
    for island_id in child_ids:
        assets.extend(_asset_ids_for("island", str(island_id), conn))
    return assets


def materialize_passage_scope(
    beam: Sequence[Candidate],
    conn,
    *,
    max_passages: int = DEFAULT_PASSAGE_SCOPE_BUDGET,
) -> tuple[str, ...]:
    """Resolve the final community beam to bounded passage ids."""
    asset_partition = read_partition("asset", conn)
    if not asset_partition:
        raise StaleSubstrateError("Missing Asset partition; run bake_partitions")
    passage_ids: list[str] = []
    seen: set[str] = set()
    for candidate in sorted(beam, key=lambda item: item.score, reverse=True):
        for asset_id in _asset_ids_for(candidate.level, candidate.community_id, conn):
            for passage_id in asset_partition.get(asset_id, []):
                if passage_id in seen:
                    continue
                seen.add(passage_id)
                passage_ids.append(str(passage_id))
                if len(passage_ids) >= max_passages:
                    return tuple(passage_ids)
    return tuple(passage_ids)


def passage_scope_budget(intent: object, mode_profile: object | None) -> int:
    return DEFAULT_PASSAGE_SCOPE_BUDGET


def _initial_entry_seed(
    query: str,
    query_embedding: Sequence[float] | np.ndarray,
    entry_level: str,
    graph_scope: GraphScope,
    conn,
    intent: object,
) -> list[Candidate]:
    return seed_entry_level(
        query,
        query_embedding,
        intent,
        entry_level,
        graph_scope,
        conn,
    )


def macro_retrieve(
    query: str,
    *,
    conn,
    graph_scope: GraphScope | None = None,
    mode_profile: object | None = None,
    query_embedding: Sequence[float] | np.ndarray | None = None,
    intent: object | None = None,
) -> PassageScope:
    """Run the recursive macro descent and return a bounded passage scope."""
    graph_scope = graph_scope or GraphScope()
    intent = intent or classify_intent(query)
    if should_skip_multires(intent, mode_profile, graph_scope):
        scope = PassageScope((), (), (), skipped=True, skip_reason="narrow_factual")
        from tp_vrg.multi_res.telemetry import record_descent_scope

        record_descent_scope(scope)
        return scope
    if query_embedding is None:
        raise ValueError("query_embedding is required until Item 5 engine integration supplies it")

    entry_level = choose_entry_level(intent, graph_scope)
    beam = _initial_entry_seed(query, query_embedding, entry_level, graph_scope, conn, intent)
    if not beam:
        raise StaleSubstrateError("Entry-level descent seed is empty; substrate may be stale")

    trace: list[LevelTrace] = []
    for level in levels_from_top_down(entry_level):
        scope = [candidate.community_id for candidate in beam if candidate.level == level]
        with probe(f"descent.{level}", input_rows=len(beam), strict=False) as cardinality_probe:
            cardinality_probe.intermediate = len(scope)
            beam = descent_step(query_embedding, intent, level, beam, conn, restrict_to=scope)
            cardinality_probe.output = len(beam)
        if not beam:
            raise StaleSubstrateError(f"Descent produced empty {level} beam; substrate may be stale")
        bottomed_out, reason = should_bottom_out(intent, beam, level)
        trace.append(
            LevelTrace(
                level=level,
                candidate_ids=tuple(candidate.community_id for candidate in beam),
                candidate_count=len(beam),
                pruned_to=len(beam),
                bottomed_out=bottomed_out,
                bottom_out_reason=reason,
            )
        )
        if bottomed_out or level == "asset":
            break
        beam = descend_to_children(beam, level, conn)

    passages = materialize_passage_scope(
        beam,
        conn,
        max_passages=passage_scope_budget(intent, mode_profile),
    )
    scope = PassageScope(tuple(passages), tuple(trace), tuple(beam))
    from tp_vrg.multi_res.telemetry import record_descent_scope

    record_descent_scope(scope)
    return scope


__all__ = [
    "GraphScope",
    "LevelTrace",
    "PassageScope",
    "choose_entry_level",
    "descend_to_children",
    "levels_from_top_down",
    "macro_retrieve",
    "materialize_passage_scope",
    "should_bottom_out",
    "should_skip_multires",
]
