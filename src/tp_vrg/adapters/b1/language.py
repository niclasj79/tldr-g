"""Language-specific inbound adapter stubs."""

from __future__ import annotations

from typing import Mapping, Sequence

from ..contracts import CostEstimate


class LanguageInboundAdapter:
    """Base for language-specific inbound adapters."""

    language_code: str = ""

    def availability_check(self) -> bool:
        return True

    def cost_estimate(self, work_item) -> CostEstimate:
        raise NotImplementedError

    def ingest(self, asset) -> Sequence[object]:
        raise NotImplementedError

    @property
    def capability_flags(self) -> Mapping[str, str]:
        return {"language": self.language_code}


class SwedishLanguageInboundAdapter(LanguageInboundAdapter):
    """Stub for future Swedish language support."""

    language_code = "sv"


class EnglishLanguageInboundAdapter(LanguageInboundAdapter):
    """Stub for current English-oriented inbound behavior."""

    language_code = "en"
