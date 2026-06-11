"""Base B3 augmentation overlay adapter stub."""

from __future__ import annotations

from ..contracts import CostEstimate


class BaseRaaSAdapter:
    """Stub for Reactive/Passive/Proactive augmentation overlays."""

    def availability_check(self) -> bool:
        return True

    def cost_estimate(self, work_item) -> CostEstimate:
        raise NotImplementedError

    def compose(self, pipeline, augmentation):
        raise NotImplementedError

    @property
    def audit_grade(self) -> str:
        return "basic"
