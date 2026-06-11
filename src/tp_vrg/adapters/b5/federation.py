"""Base B5 federation adapter stub."""

from __future__ import annotations

from ..contracts import CostEstimate


class BaseFederationAdapter:
    """Placeholder for future cross-Mega KRO attestation support."""

    def availability_check(self) -> bool:
        return True

    def cost_estimate(self, work_item) -> CostEstimate:
        raise NotImplementedError

    def attest(self, kro, target_mega):
        raise NotImplementedError
