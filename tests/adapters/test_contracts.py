from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from tp_vrg.adapters.contracts import (
    ComponentAdapter,
    CostEstimate,
    FederationAdapter,
    InboundAdapter,
    OutboundAdapter,
    RaaSAdapter,
)


class MockInboundAdapter:
    def availability_check(self) -> bool:
        return True

    def cost_estimate(self, work_item) -> CostEstimate:
        return CostEstimate(1.0, 2, 3, 0, 1.0)

    def ingest(self, asset) -> list[object]:
        return [asset]

    @property
    def capability_flags(self) -> dict[str, str]:
        return {"language": "en", "asset_type": "text"}


class MockComponentAdapter:
    def availability_check(self) -> bool:
        return True

    def cost_estimate(self, work_item) -> CostEstimate:
        return CostEstimate(None, None, None, None, 0.0)

    @property
    def component_id(self) -> str:
        return "mock-component"

    @property
    def component_family(self) -> str:
        return "embedding"


class MockRaaSAdapter:
    def availability_check(self) -> bool:
        return True

    def cost_estimate(self, work_item) -> CostEstimate:
        return CostEstimate(5.0, 10, 20, 0, 0.5)

    def compose(self, pipeline, augmentation):
        return (pipeline, augmentation)

    @property
    def audit_grade(self) -> str:
        return "basic"


class MockOutboundAdapter:
    def availability_check(self) -> bool:
        return True

    def cost_estimate(self, work_item) -> CostEstimate:
        return CostEstimate(2.0, 4, 8, 0, 0.8)

    def emit(self, kro, target):
        return {"kro": kro, "target": target}

    @property
    def framework_target(self) -> str:
        return "langchain"


class MockFederationAdapter:
    def availability_check(self) -> bool:
        return True

    def cost_estimate(self, work_item) -> CostEstimate:
        return CostEstimate(20.0, None, None, 3, 0.2)

    def attest(self, kro, target_mega):
        return {"kro": kro, "target_mega": target_mega}


@pytest.mark.parametrize(
    ("protocol", "implementation"),
    [
        (InboundAdapter, MockInboundAdapter()),
        (ComponentAdapter, MockComponentAdapter()),
        (RaaSAdapter, MockRaaSAdapter()),
        (OutboundAdapter, MockOutboundAdapter()),
        (FederationAdapter, MockFederationAdapter()),
    ],
)
def test_protocols_are_runtime_checkable(protocol, implementation) -> None:
    assert isinstance(implementation, protocol)


def test_cost_estimate_is_frozen_and_hashable() -> None:
    estimate = CostEstimate(
        compute_ms=10.5,
        tokens_in=100,
        tokens_out=25,
        cryptographic_ops=0,
        confidence=0.75,
    )

    assert isinstance(hash(estimate), int)
    with pytest.raises(FrozenInstanceError):
        estimate.confidence = 1.0
