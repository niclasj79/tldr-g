"""Manifold contract namespace -- STAGED next-queue substrate (not yet engine-wired).

These frozen, hashable dataclasses are the typed CONTRACTS for query / temporal /
render manifold positions and their composition (ComposedScoringContext is "the
composed context the scorer/retriever consume during ranking + admission"). They
are a FORWARD ABSTRACTION: built with test coverage ahead of their consumers. The
engine today computes the equivalent information inline (intent dicts, temporal
strings, render-confidence floats); wiring the engine to construct + consume these
objects is the render+query manifold arc of the next focus queue, sequenced AFTER
the 5-goal proof-drain per docs/design/manifold-substrate-synthesis-2026-06-06.md
section 5.

INV-7 disposition (founder 2026-06-08): the product / benchmark entry points are
NON-consumers BY DESIGN (staged, not a capability-leverage violation). See
the capability leverage audit note. When wiring
begins, prefer the additive-telemetry form first (construct + emit alongside the
existing computation, assert equivalent, byte-identical renders) before any
decision-routing A/B.
"""

from .composition import (
    ComposedScoringContext,
    MultiResolutionTemporalContext,
    PerRungTemporalEvidence,
)
from .query import QueryManifold
from .render import RenderManifoldEvidence
from .temporal import (
    TemporalEnvelope,
    TemporalManifoldEvidence,
    TemporalReference,
    ValidityEvidence,
)

__all__ = [
    "QueryManifold",
    "RenderManifoldEvidence",
    "TemporalReference",
    "TemporalEnvelope",
    "ValidityEvidence",
    "TemporalManifoldEvidence",
    "ComposedScoringContext",
    "PerRungTemporalEvidence",
    "MultiResolutionTemporalContext",
]
