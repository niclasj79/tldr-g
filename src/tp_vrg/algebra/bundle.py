"""Bundle data model for closed-form multi-resolution edge aggregation."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable

import numpy as np

from tp_vrg.models import RELATION_CLASS_COUNT

N_TEMPORAL_BINS: int = 16


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def bundle_key(community_a_id: str, community_b_id: str, level: int) -> str:
    """Return the stable evidence key for a bundle row."""
    return f"L{int(level)}:{community_a_id}->{community_b_id}"


def _as_float_array(
    value: Iterable[float] | np.ndarray,
    *,
    expected_shape: tuple[int, ...],
    field_name: str,
) -> np.ndarray:
    arr = np.asarray(value, dtype=np.float64)
    if arr.shape != expected_shape:
        raise ValueError(
            f"{field_name} must have shape {expected_shape}, got {arr.shape}"
        )
    copied = arr.copy()
    copied.setflags(write=False)
    return copied


def _normalize_computed_at(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


@dataclass(frozen=True)
class Bundle:
    """A bundle of below-level edges crossing one community boundary."""

    community_a_id: str
    community_b_id: str
    level: int
    w: float
    sigma: np.ndarray
    entity_set: frozenset[str] = field(default_factory=frozenset)
    tau: np.ndarray = field(
        default_factory=lambda: np.zeros(N_TEMPORAL_BINS, dtype=np.float64)
    )
    rho: dict[str, float] = field(default_factory=dict)
    evidence: tuple[str, ...] = field(default_factory=tuple)
    computed_at: datetime = field(default_factory=_utc_now)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "sigma",
            _as_float_array(
                self.sigma,
                expected_shape=(RELATION_CLASS_COUNT,),
                field_name="sigma",
            ),
        )
        object.__setattr__(
            self,
            "tau",
            _as_float_array(
                self.tau,
                expected_shape=(N_TEMPORAL_BINS,),
                field_name="tau",
            ),
        )
        object.__setattr__(self, "w", float(self.w))
        object.__setattr__(self, "level", int(self.level))
        object.__setattr__(
            self,
            "entity_set",
            frozenset(str(entity_id) for entity_id in self.entity_set),
        )
        object.__setattr__(
            self,
            "rho",
            {str(relation_class): float(density) for relation_class, density in self.rho.items()},
        )
        object.__setattr__(
            self,
            "evidence",
            tuple(str(edge_id) for edge_id in self.evidence),
        )
        object.__setattr__(
            self,
            "computed_at",
            _normalize_computed_at(self.computed_at),
        )

    @property
    def bundle_id(self) -> str:
        return bundle_key(self.community_a_id, self.community_b_id, self.level)

    @property
    def sigma_vector(self) -> np.ndarray:
        return self.sigma

    @property
    def temporal_histogram(self) -> np.ndarray:
        return self.tau

    @property
    def density_by_class(self) -> dict[str, float]:
        return dict(self.rho)

    @property
    def bridge_entities(self) -> frozenset[str]:
        return self.entity_set

    @property
    def σ(self) -> np.ndarray:
        return self.sigma

    @property
    def E(self) -> frozenset[str]:
        return self.entity_set

    @property
    def τ(self) -> np.ndarray:
        return self.tau

    @property
    def ρ(self) -> dict[str, float]:
        return dict(self.rho)
