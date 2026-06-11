"""Hierarchical edge bundle algebra primitives."""

from __future__ import annotations

from .aggregation import (
    aggregate_entity_set,
    aggregate_rho,
    aggregate_sigma,
    aggregate_tau,
    aggregate_w,
    histogram_centroid,
    histogram_variance,
)
from .bundle import Bundle, N_TEMPORAL_BINS, bundle_key
from .inheritance import aggregate_bundle
from .invalidation import mark_stale, propagate_staleness
from .inversion import (
    aggregate_bundle_attribution,
    aggregate_bundle_attribution_float,
    bundle_attribute_inter_community_edge,
    relation_to_class,
)
from .persistence import load_bundle, migrate, save_bundle

__all__ = (
    "Bundle",
    "N_TEMPORAL_BINS",
    "aggregate_bundle",
    "aggregate_entity_set",
    "aggregate_rho",
    "aggregate_sigma",
    "aggregate_tau",
    "aggregate_w",
    "aggregate_bundle_attribution",
    "aggregate_bundle_attribution_float",
    "bundle_key",
    "bundle_attribute_inter_community_edge",
    "histogram_centroid",
    "histogram_variance",
    "load_bundle",
    "mark_stale",
    "migrate",
    "propagate_staleness",
    "relation_to_class",
    "save_bundle",
)
