"""Pure aggregation rules for hierarchical edge bundles."""

from __future__ import annotations

import numpy as np

from tp_vrg.models import RELATION_CLASS_COUNT, RELATION_CLASS_INDEX

from .bundle import Bundle, N_TEMPORAL_BINS


def _positive_weight_bundles(child_bundles: list[Bundle]) -> list[Bundle]:
    return [bundle for bundle in child_bundles if bundle.w > 0.0]


def aggregate_w(child_bundles: list[Bundle]) -> float:
    """w(B') = sum w(B_i)."""
    return float(sum(bundle.w for bundle in child_bundles))


def aggregate_sigma(child_bundles: list[Bundle], normalize: bool = True) -> np.ndarray:
    """Weighted mean of relation-class probability vectors."""
    weighted_children = _positive_weight_bundles(child_bundles)
    if not weighted_children:
        return np.zeros(RELATION_CLASS_COUNT, dtype=np.float64)

    total_weight = aggregate_w(weighted_children)
    accumulator = np.zeros(RELATION_CLASS_COUNT, dtype=np.float64)
    for bundle in weighted_children:
        accumulator = accumulator + bundle.w * bundle.sigma

    result = accumulator / total_weight
    if normalize:
        vector_sum = float(result.sum())
        if vector_sum > 0.0:
            result = result / vector_sum
    return result


def aggregate_entity_set(child_bundles: list[Bundle]) -> frozenset[str]:
    """Union bridge-entity IDs from all child bundles."""
    entity_ids: set[str] = set()
    for bundle in child_bundles:
        entity_ids.update(bundle.entity_set)
    return frozenset(entity_ids)


def aggregate_tau(child_bundles: list[Bundle]) -> np.ndarray:
    """Weighted histogram aggregation for temporal distribution."""
    accumulator = np.zeros(N_TEMPORAL_BINS, dtype=np.float64)
    for bundle in _positive_weight_bundles(child_bundles):
        accumulator = accumulator + bundle.w * bundle.tau
    return accumulator


def aggregate_rho(child_bundles: list[Bundle]) -> dict[str, float]:
    """Class-aware density aggregation.

    Canonical five-axis classes use class volume ``w * sigma[class]``. Other
    production relation labels, such as EXP-050's top-20 strings, fall back to
    bundle weight so the corrected class-aware density measurement remains
    representable before full edge-vocabulary canonicalization ships.
    """
    weighted_children = _positive_weight_bundles(child_bundles)
    totals: dict[str, float] = {}
    volumes: dict[str, float] = {}

    for bundle in weighted_children:
        for relation_class, density in bundle.rho.items():
            if relation_class in RELATION_CLASS_INDEX:
                class_volume = bundle.w * float(
                    bundle.sigma[RELATION_CLASS_INDEX[relation_class]]
                )
            else:
                class_volume = bundle.w
            if class_volume <= 0.0:
                continue
            totals[relation_class] = (
                totals.get(relation_class, 0.0) + density * class_volume
            )
            volumes[relation_class] = volumes.get(relation_class, 0.0) + class_volume

    return {
        relation_class: totals[relation_class] / volume
        for relation_class, volume in volumes.items()
        if volume > 0.0
    }


def histogram_centroid(histogram: np.ndarray) -> float | None:
    """Return the derived centroid from an aggregated temporal histogram."""
    values = np.asarray(histogram, dtype=np.float64)
    total = float(values.sum())
    if total <= 0.0:
        return None
    bins = np.arange(values.shape[0], dtype=np.float64)
    return float(np.dot(bins, values) / total)


def histogram_variance(histogram: np.ndarray) -> float | None:
    """Return the derived variance from an aggregated temporal histogram."""
    centroid = histogram_centroid(histogram)
    if centroid is None:
        return None
    values = np.asarray(histogram, dtype=np.float64)
    total = float(values.sum())
    bins = np.arange(values.shape[0], dtype=np.float64)
    return float(np.dot((bins - centroid) ** 2, values) / total)


__all__ = (
    "aggregate_w",
    "aggregate_sigma",
    "aggregate_entity_set",
    "aggregate_tau",
    "aggregate_rho",
    "histogram_centroid",
    "histogram_variance",
)
