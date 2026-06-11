"""Render manifold evidence contract definitions."""

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
class RenderManifoldEvidence:
    """Wraps render-trace metadata for downstream composition."""

    prior_render_affinity: Mapping[str, float]
    render_trace_context: Mapping[str, object]
    confidence_target: Mapping[str, object]

    def __hash__(self) -> int:
        return hash(
            (
                _hashable(self.prior_render_affinity),
                _hashable(self.render_trace_context),
                _hashable(self.confidence_target),
            )
        )


__all__ = ("RenderManifoldEvidence",)
