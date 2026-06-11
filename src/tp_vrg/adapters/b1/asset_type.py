"""Asset-type inbound adapter stubs."""

from __future__ import annotations

from typing import Mapping, Sequence

from ..contracts import CostEstimate


class AssetTypeInboundAdapter:
    """Base for asset-type-specific inbound adapters."""

    asset_type: str = ""

    def availability_check(self) -> bool:
        return True

    def cost_estimate(self, work_item) -> CostEstimate:
        raise NotImplementedError

    def ingest(self, asset) -> Sequence[object]:
        raise NotImplementedError

    @property
    def capability_flags(self) -> Mapping[str, str]:
        return {"asset_type": self.asset_type}


class PDFAssetTypeInboundAdapter(AssetTypeInboundAdapter):
    """Stub for PDF inbound support."""

    asset_type = "pdf"


class ImageAssetTypeInboundAdapter(AssetTypeInboundAdapter):
    """Stub for image inbound support."""

    asset_type = "image"


class TableAssetTypeInboundAdapter(AssetTypeInboundAdapter):
    """Stub for table inbound support."""

    asset_type = "table"


class CodeAssetTypeInboundAdapter(AssetTypeInboundAdapter):
    """Stub for code inbound support."""

    asset_type = "code"
