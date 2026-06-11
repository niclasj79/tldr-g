"""B2 registration wrappers for embedding providers."""

from __future__ import annotations

import inspect

from ..contracts import CostEstimate
from ..registry import get_registry


class BgeEmbeddingAdapter:
    """Adapter wrapper for the existing bge-large-en-v1.5 embedding provider."""

    component_id = "bge-large-en-v1.5"
    component_family = "embedding"

    def availability_check(self) -> bool:
        try:
            from tp_vrg.embeddings import SentenceTransformerProvider

            default_model = inspect.signature(
                SentenceTransformerProvider.__init__
            ).parameters["model_name"].default
            return str(default_model).endswith(self.component_id)
        except Exception:
            return False

    def cost_estimate(self, work_item) -> CostEstimate:
        return CostEstimate(
            compute_ms=None,
            tokens_in=None,
            tokens_out=None,
            cryptographic_ops=0,
            confidence=0.0,
        )


class E5MultilingualEmbeddingAdapter:
    """Stub for a future multilingual embedding swap-out."""

    component_id = "e5-multilingual"
    component_family = "embedding"

    def availability_check(self) -> bool:
        return False

    def cost_estimate(self, work_item) -> CostEstimate:
        raise NotImplementedError


def register_defaults() -> None:
    registry = get_registry()
    registry.register("B2", "bge-large-en-v1.5", BgeEmbeddingAdapter())
