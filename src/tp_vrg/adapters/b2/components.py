"""Base B2 component adapter stub."""

from __future__ import annotations

from ..contracts import CostEstimate


class BaseComponentAdapter:
    """Stub for swappable engine components."""

    component_id = "base-component"
    component_family = "component"

    def availability_check(self) -> bool:
        return True

    def cost_estimate(self, work_item) -> CostEstimate:
        raise NotImplementedError
