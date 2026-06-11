"""Protocol contracts for the five adapter boundaries."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Protocol, Sequence, runtime_checkable


@dataclass(frozen=True)
class CostEstimate:
    """Per-work-item cost estimate emitted by adapters before invocation."""

    compute_ms: float | None
    tokens_in: int | None
    tokens_out: int | None
    cryptographic_ops: int | None
    confidence: float  # 0.0 = wild guess; 1.0 = exact


@runtime_checkable
class InboundAdapter(Protocol):
    """B1 - inbound asset to passages."""

    def availability_check(self) -> bool: ...
    def cost_estimate(self, work_item) -> CostEstimate: ...
    def ingest(self, asset) -> Sequence[object]: ...

    @property
    def capability_flags(self) -> Mapping[str, str]: ...


@runtime_checkable
class ComponentAdapter(Protocol):
    """B2 - swappable engine components."""

    def availability_check(self) -> bool: ...
    def cost_estimate(self, work_item) -> CostEstimate: ...

    @property
    def component_id(self) -> str: ...

    @property
    def component_family(self) -> str: ...


@runtime_checkable
class RaaSAdapter(Protocol):
    """B3 - Reactive/Passive/Proactive augmentation overlays."""

    def availability_check(self) -> bool: ...
    def cost_estimate(self, work_item) -> CostEstimate: ...
    def compose(self, pipeline, augmentation): ...

    @property
    def audit_grade(self) -> str: ...


@runtime_checkable
class OutboundAdapter(Protocol):
    """B4 - outbound KRO emission to framework targets."""

    def availability_check(self) -> bool: ...
    def cost_estimate(self, work_item) -> CostEstimate: ...
    def emit(self, kro, target): ...

    @property
    def framework_target(self) -> str: ...


@runtime_checkable
class FederationAdapter(Protocol):
    """B5 - cross-Mega KRO attestation placeholder."""

    def availability_check(self) -> bool: ...
    def cost_estimate(self, work_item) -> CostEstimate: ...
    def attest(self, kro, target_mega): ...
