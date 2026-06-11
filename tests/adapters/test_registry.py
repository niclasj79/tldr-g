from __future__ import annotations

import pytest

import tp_vrg.adapters.registry as registry_module
from tp_vrg.adapters.contracts import CostEstimate
from tp_vrg.adapters.registry import AdapterRegistry, get_registry


class RegistryComponentAdapter:
    def __init__(self, available: bool = True, component_id: str = "mock") -> None:
        self._available = available
        self._component_id = component_id

    def availability_check(self) -> bool:
        return self._available

    def cost_estimate(self, work_item) -> CostEstimate:
        return CostEstimate(None, None, None, 0, 0.0)

    @property
    def component_id(self) -> str:
        return self._component_id

    @property
    def component_family(self) -> str:
        return "embedding"


@pytest.fixture(autouse=True)
def reset_registry_singleton() -> None:
    registry_module._REGISTRY = None


def test_register_and_get_adapter() -> None:
    registry = AdapterRegistry()
    adapter = RegistryComponentAdapter(component_id="available")

    registry.register("B2", "available", adapter)

    assert registry.get("B2", "available") is adapter
    assert registry.get("B2", "missing") is None


def test_duplicate_registration_is_rejected() -> None:
    registry = AdapterRegistry()
    adapter = RegistryComponentAdapter()
    registry.register("B2", "mock", adapter)

    with pytest.raises(ValueError, match="Adapter B2/mock already registered"):
        registry.register("B2", "mock", adapter)


def test_list_available_filters_unavailable_adapters() -> None:
    registry = AdapterRegistry()
    registry.register("B2", "available", RegistryComponentAdapter(available=True))
    registry.register("B2", "unavailable", RegistryComponentAdapter(available=False))

    assert registry.list_available("B2") == ["available"]


def test_registry_state_is_isolated_between_instances() -> None:
    first = AdapterRegistry()
    second = AdapterRegistry()

    first.register("B2", "only-first", RegistryComponentAdapter())

    assert second.get("B2", "only-first") is None
    assert second.list_available("B2") == []


def test_get_registry_lazy_singleton_can_be_reset_between_tests() -> None:
    first = get_registry()
    first.register("B2", "singleton", RegistryComponentAdapter())

    registry_module._REGISTRY = None
    second = get_registry()

    assert second is not first
    assert second.get("B2", "singleton") is None
