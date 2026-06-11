"""Query manifold contract definitions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

from .temporal import TemporalReference


def _hashable_mapping(mapping: Mapping[str, float]) -> tuple[tuple[str, float], ...]:
    return tuple(sorted(mapping.items()))


def _hashable_sequence(sequence: Sequence[float] | None) -> tuple[float, ...] | None:
    if sequence is None:
        return None
    return tuple(sequence)


@dataclass(frozen=True)
class QueryManifold:
    """Immutable per-query first-class manifold object."""

    raw_query: str
    normalized_query: str
    embedding: Sequence[float] | None
    intent_axes: Mapping[str, float]
    wh_type: str | None
    root_verb: str | None
    named_entities: tuple[str, ...]
    temporal_reference: TemporalReference | None
    specificity: float
    exhaustiveness: float
    reasoning_depth: int

    def __hash__(self) -> int:
        return hash(
            (
                self.raw_query,
                self.normalized_query,
                _hashable_sequence(self.embedding),
                _hashable_mapping(self.intent_axes),
                self.wh_type,
                self.root_verb,
                self.named_entities,
                self.temporal_reference,
                self.specificity,
                self.exhaustiveness,
                self.reasoning_depth,
            )
        )


__all__ = ("QueryManifold",)
