"""LangChain outbound adapter stub."""

from __future__ import annotations

from ..contracts import CostEstimate


class LangChainOutboundAdapter:
    """Stub for future LangChain outbound support."""

    def availability_check(self) -> bool:
        try:
            import langchain  # noqa: F401
            return True
        except ImportError:
            return False

    def cost_estimate(self, work_item) -> CostEstimate:
        raise NotImplementedError

    def emit(self, kro, target):
        raise NotImplementedError

    @property
    def framework_target(self) -> str:
        return "langchain"
