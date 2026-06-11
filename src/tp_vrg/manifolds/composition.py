"""Composition contracts across query, temporal, and render manifolds."""

from __future__ import annotations

from collections.abc import Mapping as MappingABC
from collections.abc import Sequence as SequenceABC
from dataclasses import dataclass, fields, is_dataclass
from typing import Mapping, Sequence

from .query import QueryManifold
from .render import RenderManifoldEvidence
from .temporal import TemporalEnvelope, TemporalManifoldEvidence


def _hashable(value: object) -> object:
    if is_dataclass(value):
        return tuple((field.name, _hashable(getattr(value, field.name))) for field in fields(value))
    if isinstance(value, MappingABC):
        return tuple(sorted((key, _hashable(item)) for key, item in value.items()))
    if isinstance(value, (str, bytes)):
        return value
    if isinstance(value, SequenceABC):
        return tuple(_hashable(item) for item in value)
    try:
        hash(value)
    except TypeError:
        return repr(value)
    return value


@dataclass(frozen=True)
class ComposedScoringContext:
    """The composed context the scorer/retriever consume during ranking + admission."""

    query: QueryManifold
    temporal: TemporalManifoldEvidence
    render: RenderManifoldEvidence | None
    budget: object

    def __hash__(self) -> int:
        return hash(
            (
                self.query,
                self.temporal,
                self.render,
                _hashable(self.budget),
            )
        )


@dataclass(frozen=True)
class PerRungTemporalEvidence:
    """
    For each rung in {Continent, Island, Asset, Passage}, aggregate temporal
    envelopes of member entities so multi-resolution descent can score
    communities by temporal-relevance to query.
    """

    rung: str  # "continent" | "island" | "asset" | "passage"
    community_id: str
    aggregate_envelope: TemporalEnvelope
    member_envelope_count: int
    confidence: float


@dataclass(frozen=True)
class MultiResolutionTemporalContext:
    """Multi-resolution descent consumes this; keyed by rung name."""

    per_rung_evidence: Mapping[str, Sequence[PerRungTemporalEvidence]]

    def __hash__(self) -> int:
        return hash(_hashable(self.per_rung_evidence))


__all__ = (
    "ComposedScoringContext",
    "PerRungTemporalEvidence",
    "MultiResolutionTemporalContext",
)
