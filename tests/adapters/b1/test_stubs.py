from __future__ import annotations

import pytest

from tp_vrg.adapters.b1.asset_type import (
    AssetTypeInboundAdapter,
    CodeAssetTypeInboundAdapter,
    ImageAssetTypeInboundAdapter,
    PDFAssetTypeInboundAdapter,
    TableAssetTypeInboundAdapter,
)
from tp_vrg.adapters.b1.code import (
    CodeInboundAdapter,
    GoCodeInboundAdapter,
    PythonCodeInboundAdapter,
    RustCodeInboundAdapter,
    TypeScriptCodeInboundAdapter,
)
from tp_vrg.adapters.b1.language import (
    EnglishLanguageInboundAdapter,
    LanguageInboundAdapter,
    SwedishLanguageInboundAdapter,
)
from tp_vrg.adapters.b1.pdf import PDFInboundAdapter
from tp_vrg.adapters.b1.source_system import SourceSystemInboundAdapter
from tp_vrg.adapters.contracts import InboundAdapter


@pytest.mark.parametrize(
    "adapter",
    [
        LanguageInboundAdapter(),
        SwedishLanguageInboundAdapter(),
        EnglishLanguageInboundAdapter(),
        AssetTypeInboundAdapter(),
        PDFAssetTypeInboundAdapter(),
        ImageAssetTypeInboundAdapter(),
        TableAssetTypeInboundAdapter(),
        CodeAssetTypeInboundAdapter(),
        CodeInboundAdapter(),
        PythonCodeInboundAdapter(),
        TypeScriptCodeInboundAdapter(),
        RustCodeInboundAdapter(),
        GoCodeInboundAdapter(),
        PDFInboundAdapter(),
        SourceSystemInboundAdapter(),
    ],
)
def test_b1_stubs_satisfy_inbound_adapter_protocol(adapter) -> None:
    assert isinstance(adapter, InboundAdapter)


def test_b1_package_exports_decision_sub_axes() -> None:
    import tp_vrg.adapters.b1 as b1

    assert b1.__all__ == [
        "LanguageInboundAdapter",
        "AssetTypeInboundAdapter",
        "CodeInboundAdapter",
        "PDFInboundAdapter",
        "SourceSystemInboundAdapter",
    ]


def test_b1_capability_flags_identify_sub_axis() -> None:
    assert SwedishLanguageInboundAdapter().capability_flags == {"language": "sv"}
    assert PDFAssetTypeInboundAdapter().capability_flags == {"asset_type": "pdf"}
    assert PythonCodeInboundAdapter().capability_flags == {
        "asset_type": "code",
        "code_language": "python",
    }
    assert PDFInboundAdapter().capability_flags == {
        "asset_type": "pdf",
        "pdf_mode": "diagram-rich",
    }
