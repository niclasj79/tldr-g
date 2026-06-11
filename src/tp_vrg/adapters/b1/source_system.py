"""Source-system inbound adapter stubs."""

from __future__ import annotations

from typing import Mapping, Sequence

from ..contracts import CostEstimate


class SourceSystemInboundAdapter:
    """Base for per-source inbound adapters."""

    source_system: str = ""

    def availability_check(self) -> bool:
        return True

    def cost_estimate(self, work_item) -> CostEstimate:
        raise NotImplementedError

    def ingest(self, asset) -> Sequence[object]:
        raise NotImplementedError

    @property
    def capability_flags(self) -> Mapping[str, str]:
        return {"source_system": self.source_system}
