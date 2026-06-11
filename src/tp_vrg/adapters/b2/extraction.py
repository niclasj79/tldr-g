"""B2 registration wrappers for extraction providers."""

from __future__ import annotations

from ..contracts import CostEstimate
from ..registry import get_registry


class Gliner2ExtractionAdapter:
    """Adapter wrapper for the existing GLiNER2 extraction provider."""

    component_id = "gliner2"
    component_family = "extraction"

    def availability_check(self) -> bool:
        try:
            from tp_vrg import models
            from tp_vrg.llm_service import GLiNERSpacyProvider

            return models.NER_BACKEND == self.component_id and GLiNERSpacyProvider is not None
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


class AnthropicExtractionAdapter:
    """Stub for a future Anthropic extraction provider registration."""

    component_id = "api_anthropic"
    component_family = "extraction"

    def availability_check(self) -> bool:
        return False

    def cost_estimate(self, work_item) -> CostEstimate:
        raise NotImplementedError


class LocalQwenExtractionAdapter:
    """Stub for a future local Qwen extraction provider registration."""

    component_id = "local_qwen"
    component_family = "extraction"

    def availability_check(self) -> bool:
        return False

    def cost_estimate(self, work_item) -> CostEstimate:
        raise NotImplementedError


def register_defaults() -> None:
    registry = get_registry()
    registry.register("B2", "gliner2", Gliner2ExtractionAdapter())
