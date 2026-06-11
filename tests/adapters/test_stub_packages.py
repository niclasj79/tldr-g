from __future__ import annotations

from tp_vrg.adapters.b2 import BaseComponentAdapter
from tp_vrg.adapters.b3 import BaseRaaSAdapter
from tp_vrg.adapters.b4 import LangChainOutboundAdapter
from tp_vrg.adapters.b5 import BaseFederationAdapter
from tp_vrg.adapters.contracts import (
    ComponentAdapter,
    FederationAdapter,
    OutboundAdapter,
    RaaSAdapter,
)


def test_b2_package_importable_and_stub_satisfies_protocol() -> None:
    assert isinstance(BaseComponentAdapter(), ComponentAdapter)


def test_b3_package_importable_and_stub_satisfies_protocol() -> None:
    assert isinstance(BaseRaaSAdapter(), RaaSAdapter)


def test_b4_package_importable_and_langchain_stub_satisfies_protocol() -> None:
    adapter = LangChainOutboundAdapter()

    assert isinstance(adapter, OutboundAdapter)
    assert adapter.framework_target == "langchain"


def test_b5_package_importable_and_stub_satisfies_protocol() -> None:
    assert isinstance(BaseFederationAdapter(), FederationAdapter)
