"""Closed-form inheritance for hierarchical edge bundles."""

from __future__ import annotations

from datetime import datetime

import numpy as np

from .aggregation import (
    aggregate_entity_set,
    aggregate_rho,
    aggregate_sigma,
    aggregate_tau,
    aggregate_w,
)
from .bundle import Bundle


def _resolve_boundary_id(
    child_bundles: list[Bundle],
    explicit_id: str | None,
    *,
    field_name: str,
) -> str:
    if explicit_id is not None:
        return str(explicit_id)

    values = {getattr(bundle, field_name) for bundle in child_bundles}
    if len(values) == 1:
        return next(iter(values))

    raise ValueError(
        f"{field_name} must be provided when child bundles do not share one boundary"
    )


def _normalize_tau_for_storage(
    weighted_histogram: np.ndarray, total_weight: float
) -> np.ndarray:
    if total_weight <= 0.0:
        return weighted_histogram
    return weighted_histogram / total_weight


def aggregate_bundle(
    child_bundles: list[Bundle],
    target_level: int,
    *,
    community_a_id: str | None = None,
    community_b_id: str | None = None,
    computed_at: datetime | None = None,
) -> Bundle:
    """Build a target-level bundle from one rung of child bundles.

    The caller groups children by the target boundary. When the child bundles
    already carry that same boundary identity, the IDs can be inferred.
    """
    if target_level < 1:
        raise ValueError("target_level must be at least 1")
    if not child_bundles and (community_a_id is None or community_b_id is None):
        raise ValueError("empty inheritance requires explicit community IDs")
    if any(bundle.level != target_level - 1 for bundle in child_bundles):
        raise ValueError("Inheritance: all children must be at level L")

    total_weight = aggregate_w(child_bundles)
    weighted_tau = aggregate_tau(child_bundles)

    kwargs: dict[str, object] = {}
    if computed_at is not None:
        kwargs["computed_at"] = computed_at

    return Bundle(
        community_a_id=_resolve_boundary_id(
            child_bundles, community_a_id, field_name="community_a_id"
        ),
        community_b_id=_resolve_boundary_id(
            child_bundles, community_b_id, field_name="community_b_id"
        ),
        level=target_level,
        w=total_weight,
        sigma=aggregate_sigma(child_bundles),
        entity_set=aggregate_entity_set(child_bundles),
        tau=_normalize_tau_for_storage(weighted_tau, total_weight),
        rho=aggregate_rho(child_bundles),
        evidence=tuple(bundle.bundle_id for bundle in child_bundles),
        **kwargs,
    )


__all__ = ("aggregate_bundle",)
