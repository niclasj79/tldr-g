"""Temporal manifold evidence contract definitions."""

from __future__ import annotations

from collections.abc import Mapping as MappingABC
from collections.abc import Sequence as SequenceABC
from dataclasses import dataclass, fields, is_dataclass
from typing import Mapping


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
class TemporalReference:
    """Query-side temporal reference (the 'when' the query asks about)."""

    anchor_start: float | None
    anchor_end: float | None
    inferred_from: str  # "explicit" | "implicit" | "default-now"


@dataclass(frozen=True)
class TemporalEnvelope:
    """Subject-side temporal extent (when a passage/node/bundle is valid)."""

    envelope_id: int | None
    anchor_start: float | None
    anchor_end: float | None
    durability_class: str | None
    confidence: float


@dataclass(frozen=True)
class ValidityEvidence:
    """Per-claim validity tracker for supersession + currency reasoning."""

    evidence_id: int | None
    claim_id: str
    evidence_type: str  # "supersession" | "confirmation" | "contradiction" | "decay"
    weight: float
    timestamp: float


@dataclass(frozen=True)
class TemporalManifoldEvidence:
    """Aggregated temporal evidence for downstream composition."""

    query_reference: TemporalReference | None
    candidate_envelopes: Mapping[str, TemporalEnvelope]
    validity_evidence: Mapping[str, tuple[ValidityEvidence, ...]]

    def __hash__(self) -> int:
        return hash(
            (
                self.query_reference,
                _hashable(self.candidate_envelopes),
                _hashable(self.validity_evidence),
            )
        )


__all__ = (
    "TemporalReference",
    "TemporalEnvelope",
    "ValidityEvidence",
    "TemporalManifoldEvidence",
)
