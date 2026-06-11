"""PDF inbound adapter placeholder."""

from __future__ import annotations

from typing import Mapping, Sequence

from ..contracts import CostEstimate


class PDFInboundAdapter:
    """Placeholder for future diagram-rich PDF ingestion."""

    def availability_check(self) -> bool:
        return True

    def cost_estimate(self, work_item) -> CostEstimate:
        raise NotImplementedError

    def ingest(self, asset) -> Sequence[object]:
        raise NotImplementedError

    @property
    def capability_flags(self) -> Mapping[str, str]:
        return {"asset_type": "pdf", "pdf_mode": "diagram-rich"}
