"""Explicit adapter registration for the five boundary families."""

from __future__ import annotations

from typing import Literal

from .contracts import (
    ComponentAdapter,
    FederationAdapter,
    InboundAdapter,
    OutboundAdapter,
    RaaSAdapter,
)

BoundaryName = Literal["B1", "B2", "B3", "B4", "B5"]
Adapter = (
    InboundAdapter
    | ComponentAdapter
    | RaaSAdapter
    | OutboundAdapter
    | FederationAdapter
)


class AdapterRegistry:
    """Explicit registration; NOT dynamic discovery in Phase 1."""

    def __init__(self) -> None:
        self._adapters: dict[BoundaryName, dict[str, Adapter]] = {
            "B1": {},
            "B2": {},
            "B3": {},
            "B4": {},
            "B5": {},
        }

    def register(self, boundary: BoundaryName, adapter_id: str, adapter: Adapter) -> None:
        if adapter_id in self._adapters[boundary]:
            raise ValueError(f"Adapter {boundary}/{adapter_id} already registered")
        self._adapters[boundary][adapter_id] = adapter

    def get(self, boundary: BoundaryName, adapter_id: str) -> Adapter | None:
        return self._adapters[boundary].get(adapter_id)

    def list_available(self, boundary: BoundaryName) -> list[str]:
        """Return adapter_ids whose availability_check() returns True."""
        return [
            adapter_id
            for adapter_id, adapter in self._adapters[boundary].items()
            if adapter.availability_check()
        ]


_REGISTRY: AdapterRegistry | None = None


def get_registry() -> AdapterRegistry:
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = AdapterRegistry()
    return _REGISTRY
