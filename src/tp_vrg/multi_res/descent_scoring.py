"""Intent-aware scoring defaults for multi-resolution descent."""

from __future__ import annotations

from collections.abc import Mapping
import math
import os

from tp_vrg.storage.community_partitions import Rung
from tp_vrg.storage.per_rung_centroids import VALID_CENTROID_RUNGS

DESCENT_TOP_M: Mapping[Rung, int] = {
    "continent": int(os.environ.get("TPVRG_DESCENT_TOP_M_CONTINENT", "8")),
    "island": int(os.environ.get("TPVRG_DESCENT_TOP_M_ISLAND", "9")),
    "asset": int(os.environ.get("TPVRG_DESCENT_TOP_M_ASSET", "8")),
}
THETA_BASE: Mapping[Rung, float] = {
    "continent": float(os.environ.get("TPVRG_THETA_BASE_CONTINENT", "0.35")),
    "island": float(os.environ.get("TPVRG_THETA_BASE_ISLAND", "0.45")),
    "asset": float(os.environ.get("TPVRG_THETA_BASE_ASSET", "0.45")),
}


def validate_level(level: str) -> Rung:
    if level not in VALID_CENTROID_RUNGS:
        raise ValueError(f"Unknown descent level {level!r}; expected {list(VALID_CENTROID_RUNGS)}")
    return level  # type: ignore[return-value]


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, float(value)))


def intent_value(intent: object, name: str, default: float = 0.0) -> float:
    value = intent.get(name, default) if isinstance(intent, Mapping) else getattr(intent, name, default)
    try:
        return clamp(float(value))
    except (TypeError, ValueError):
        return default


def content_axis(intent: object, name: str) -> float:
    axes = intent.get("content_axes", {}) if isinstance(intent, Mapping) else getattr(intent, "content_axes", {})
    if not isinstance(axes, Mapping):
        return 0.0
    try:
        return clamp(float(axes.get(name, 0.0)))
    except (TypeError, ValueError):
        return 0.0


def descent_top_m(level: str, intent: object | None = None) -> int:
    """Return empirical per-rung beam defaults from EXP-058/062/067."""
    return DESCENT_TOP_M[validate_level(level)]


def descent_min_score(level: str, intent: object | None = None) -> float:
    """Return the v1 pruning floor; traversal threshold does the real cutting."""
    validate_level(level)
    return 0.0


def traversal_threshold(level: str, intent: object) -> float:
    resolved = validate_level(level)
    return clamp(
        THETA_BASE[resolved]
        + 0.15 * intent_value(intent, "specificity", 0.5)
        - 0.12 * intent_value(intent, "exhaustiveness", 0.5)
        - 0.05 * intent_value(intent, "reasoning_depth", 0.0),
        0.20,
        0.80,
    )


def bundle_pull_score(weight: float, max_weight: float, intent: object) -> float:
    """Score a baked same-rung bundle edge for traversal."""
    max_weight = max(float(max_weight), float(weight), 1.0)
    weight_score = math.log1p(max(float(weight), 0.0)) / math.log1p(max_weight)
    structural_bias = (
        0.85
        + 0.20 * intent_value(intent, "reasoning_depth", 0.0)
        + 0.10 * intent_value(intent, "exhaustiveness", 0.5)
        - 0.10 * intent_value(intent, "specificity", 0.5)
    )
    return clamp(weight_score * structural_bias)


def level_weights(intent: object, level: str) -> dict[str, float]:
    """Return normalized intent-aware combination weights."""
    validate_level(level)
    specificity = intent_value(intent, "specificity", 0.5)
    reasoning = intent_value(intent, "reasoning_depth", 0.0)
    weights = {
        "cosine": 0.45 + 0.20 * content_axis(intent, "factual") + 0.15 * specificity - 0.15 * reasoning,
        "bundle": 0.35 + 0.25 * reasoning + 0.10 * content_axis(intent, "temporal") - 0.10 * specificity,
        "parent": 0.10 + 0.10 * (1.0 - specificity),
        "cell_prior": 0.0,
    }
    positive = {key: max(0.0, value) for key, value in weights.items()}
    total = sum(positive.values()) or 1.0
    return {key: value / total for key, value in positive.items()}
