"""Code inbound adapter stubs."""

from __future__ import annotations

from typing import Mapping, Sequence

from ..contracts import CostEstimate


class CodeInboundAdapter:
    """Base for code-specific inbound adapters."""

    code_language: str = ""

    def availability_check(self) -> bool:
        return True

    def cost_estimate(self, work_item) -> CostEstimate:
        raise NotImplementedError

    def ingest(self, asset) -> Sequence[object]:
        raise NotImplementedError

    @property
    def capability_flags(self) -> Mapping[str, str]:
        return {"asset_type": "code", "code_language": self.code_language}


class PythonCodeInboundAdapter(CodeInboundAdapter):
    """Stub for Python code ingestion."""

    code_language = "python"


class TypeScriptCodeInboundAdapter(CodeInboundAdapter):
    """Stub for TypeScript code ingestion."""

    code_language = "typescript"


class RustCodeInboundAdapter(CodeInboundAdapter):
    """Stub for Rust code ingestion."""

    code_language = "rust"


class GoCodeInboundAdapter(CodeInboundAdapter):
    """Stub for Go code ingestion."""

    code_language = "go"
