"""Adapter contract surface for boundary-spanning engine extensions."""

from .contracts import (
    ComponentAdapter,
    CostEstimate,
    FederationAdapter,
    InboundAdapter,
    OutboundAdapter,
    RaaSAdapter,
)
from .registry import AdapterRegistry, get_registry

__all__ = [
    "AdapterRegistry",
    "ComponentAdapter",
    "CostEstimate",
    "FederationAdapter",
    "InboundAdapter",
    "OutboundAdapter",
    "RaaSAdapter",
    "get_registry",
]
