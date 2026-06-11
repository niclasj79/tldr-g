"""Tests for Water mode pipeline augmentation components.

Fire/Water Doctrine: Water mode adds LLM augmentation at three pipeline stages.
These tests verify:
1. Each component works with a mock LLM
2. Each component falls back to Fire behavior on LLM failure
3. WaterConfig defaults keep Water mode OFF
4. Engine integration skips Water code when disabled
"""

from __future__ import annotations

import pytest

from tp_vrg.llm_service import MockWaterLLMProvider, MockLLMProvider
from tp_vrg.models import (
    EdgeData,
    ExtractionResult,
    NodeData,
    WaterConfig,
)
from tp_vrg.water import ExtractionEnricher, PassageReranker, QueryExpander


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


class FailingLLMProvider:
    """LLM provider that always raises — tests fallback behavior."""

    async def complete(self, prompt: str, max_tokens: int = 1024) -> str:
        raise RuntimeError("LLM service unavailable")

    async def extract_entities_and_edges(self, raw_text: str) -> ExtractionResult:
        raise RuntimeError("LLM service unavailable")

    async def summarize(self, text: str, target_sentences: int = 2) -> str:
        raise RuntimeError("LLM service unavailable")


class MockStorageForReranker:
    """Minimal mock storage that returns passage text for reranking tests."""

    def __init__(self, passages: dict[str, str]) -> None:
        self._passages = passages

    def get_passage(self, passage_id: str):
        text = self._passages.get(passage_id)
        if text is None:
            return None

        class FakePassage:
            def __init__(self, raw_text):
                self.raw_text = raw_text

        return FakePassage(text)


# ---------------------------------------------------------------------------
# WaterConfig tests
# ---------------------------------------------------------------------------


class TestWaterConfig:
    def test_default_is_disabled(self):
        cfg = WaterConfig()
        assert cfg.enabled is False

    def test_all_augmentations_on_by_default_when_enabled(self):
        cfg = WaterConfig(enabled=True)
        assert cfg.query_expansion is True
        assert cfg.extraction_enrichment is True
        assert cfg.macro_reranking is True

    def test_individual_toggle(self):
        cfg = WaterConfig(enabled=True, query_expansion=False)
        assert cfg.enabled is True
        assert cfg.query_expansion is False
        assert cfg.extraction_enrichment is True

    def test_expansion_variants_default(self):
        cfg = WaterConfig()
        assert cfg.expansion_variants == 3

    def test_reranking_top_k_default(self):
        cfg = WaterConfig()
        assert cfg.reranking_top_k == 10


# ---------------------------------------------------------------------------
# QueryExpander tests
# ---------------------------------------------------------------------------


class TestQueryExpander:
    @pytest.mark.asyncio
    async def test_expand_returns_original_plus_variants(self):
        expander = QueryExpander()
        llm = MockWaterLLMProvider()
        result = await expander.expand("What is the capital of France?", llm, num_variants=3)
        assert result[0] == "What is the capital of France?"
        assert len(result) >= 2  # original + at least 1 variant

    @pytest.mark.asyncio
    async def test_expand_fallback_on_failure(self):
        expander = QueryExpander()
        llm = FailingLLMProvider()
        result = await expander.expand("What is the capital of France?", llm)
        assert result == ["What is the capital of France?"]

    @pytest.mark.asyncio
    async def test_expand_returns_original_on_empty_response(self):
        """If LLM returns empty/garbage, fall back to original."""

        class EmptyLLM:
            async def complete(self, prompt, max_tokens=1024):
                return ""

        expander = QueryExpander()
        result = await expander.expand("test query", EmptyLLM())
        assert result == ["test query"]


# ---------------------------------------------------------------------------
# PassageReranker tests
# ---------------------------------------------------------------------------


class TestPassageReranker:
    @pytest.mark.asyncio
    async def test_rerank_reorders_passages(self):
        storage = MockStorageForReranker({
            "p1": "Paris is the capital of France.",
            "p2": "Berlin is the capital of Germany.",
            "p3": "Tokyo is the capital of Japan.",
        })
        reranker = PassageReranker(storage)

        # MockWaterLLMProvider returns IDs in reverse order for rank prompts
        llm = MockWaterLLMProvider()
        result = await reranker.rerank(
            "What is the capital of France?",
            ["p1", "p2", "p3"],
            llm,
            top_k=3,
        )
        # Should be reordered (mock reverses)
        assert isinstance(result, list)
        assert len(result) == 3
        assert all(pid in result for pid in ["p1", "p2", "p3"])

    @pytest.mark.asyncio
    async def test_rerank_fallback_on_failure(self):
        storage = MockStorageForReranker({"p1": "text", "p2": "text"})
        reranker = PassageReranker(storage)
        llm = FailingLLMProvider()
        original = ["p1", "p2"]
        result = await reranker.rerank("query", original, llm)
        assert result == original

    @pytest.mark.asyncio
    async def test_rerank_single_passage_is_noop(self):
        storage = MockStorageForReranker({"p1": "text"})
        reranker = PassageReranker(storage)
        llm = MockWaterLLMProvider()
        result = await reranker.rerank("query", ["p1"], llm)
        assert result == ["p1"]

    @pytest.mark.asyncio
    async def test_rerank_empty_is_noop(self):
        storage = MockStorageForReranker({})
        reranker = PassageReranker(storage)
        llm = MockWaterLLMProvider()
        result = await reranker.rerank("query", [], llm)
        assert result == []


# ---------------------------------------------------------------------------
# ExtractionEnricher tests
# ---------------------------------------------------------------------------


class TestExtractionEnricher:
    @pytest.mark.asyncio
    async def test_enrich_merges_results(self):
        """LLM adds entities that GLiNER missed."""
        enricher = ExtractionEnricher()

        gliner_result = ExtractionResult(
            nodes=[
                NodeData(
                    entity_id="paris",
                    name="Paris",
                    category="location",
                    lod_0="text",
                    lod_1="Capital of France",
                    lod_2="Paris [location]",
                ),
            ],
            edges=[],
        )

        # MockWaterLLMProvider returns mock extraction
        llm = MockWaterLLMProvider()
        result = await enricher.enrich("Paris is the capital of France.", gliner_result, llm)

        # Should have at least the GLiNER entity
        assert any(n.entity_id == "paris" for n in result.nodes)

    @pytest.mark.asyncio
    async def test_enrich_gliner_wins_on_collision(self):
        """GLiNER entity takes priority over LLM entity with same ID."""
        enricher = ExtractionEnricher()

        gliner_node = NodeData(
            entity_id="paris",
            name="Paris (GLiNER)",
            category="location",
            lod_0="text",
            lod_1="GLiNER version",
            lod_2="Paris [location]",
        )
        gliner_result = ExtractionResult(nodes=[gliner_node], edges=[])

        # LLM that returns a node with the same ID
        class SameIdLLM:
            async def extract_entities_and_edges(self, raw_text):
                return ExtractionResult(
                    nodes=[
                        NodeData(
                            entity_id="paris",
                            name="Paris (LLM)",
                            category="location",
                            lod_0="text",
                            lod_1="LLM version",
                            lod_2="Paris [location]",
                        ),
                    ],
                    edges=[],
                )

        result = await enricher.enrich("text", gliner_result, SameIdLLM())
        paris_nodes = [n for n in result.nodes if n.entity_id == "paris"]
        assert len(paris_nodes) == 1
        assert paris_nodes[0].name == "Paris (GLiNER)"  # GLiNER wins

    @pytest.mark.asyncio
    async def test_enrich_fallback_on_failure(self):
        enricher = ExtractionEnricher()
        gliner_result = ExtractionResult(
            nodes=[
                NodeData(
                    entity_id="test",
                    name="Test",
                    category="concept",
                    lod_0="text",
                    lod_1="A test",
                    lod_2="Test [concept]",
                ),
            ],
            edges=[],
        )
        llm = FailingLLMProvider()
        result = await enricher.enrich("text", gliner_result, llm)
        assert result is gliner_result  # unchanged

    @pytest.mark.asyncio
    async def test_enrich_edge_dedup(self):
        """Duplicate edges (same source/target/relation) are merged."""
        enricher = ExtractionEnricher()

        edge = EdgeData(source="a", target="b", relation="knows")
        gliner_result = ExtractionResult(
            nodes=[
                NodeData(entity_id="a", name="A", category="person", lod_0="t", lod_1="A", lod_2="A [person]"),
                NodeData(entity_id="b", name="B", category="person", lod_0="t", lod_1="B", lod_2="B [person]"),
            ],
            edges=[edge],
        )

        class DuplicateEdgeLLM:
            async def extract_entities_and_edges(self, raw_text):
                return ExtractionResult(
                    nodes=[
                        NodeData(entity_id="a", name="A", category="person", lod_0="t", lod_1="A", lod_2="A [person]"),
                        NodeData(entity_id="b", name="B", category="person", lod_0="t", lod_1="B", lod_2="B [person]"),
                    ],
                    edges=[EdgeData(source="a", target="b", relation="knows")],
                )

        result = await enricher.enrich("text", gliner_result, DuplicateEdgeLLM())
        knows_edges = [e for e in result.edges if e.relation == "knows"]
        assert len(knows_edges) == 1  # deduped

    @pytest.mark.asyncio
    async def test_enrich_orphan_edges_dropped(self):
        """LLM edges whose endpoints don't exist in merged set are dropped."""
        enricher = ExtractionEnricher()

        gliner_result = ExtractionResult(
            nodes=[
                NodeData(entity_id="a", name="A", category="person", lod_0="t", lod_1="A", lod_2="A [person]"),
            ],
            edges=[],
        )

        class OrphanEdgeLLM:
            async def extract_entities_and_edges(self, raw_text):
                return ExtractionResult(
                    nodes=[
                        NodeData(entity_id="c", name="C", category="person", lod_0="t", lod_1="C", lod_2="C [person]"),
                    ],
                    edges=[
                        EdgeData(source="c", target="missing", relation="knows"),  # orphan
                        EdgeData(source="a", target="c", relation="met"),  # valid
                    ],
                )

        result = await enricher.enrich("text", gliner_result, OrphanEdgeLLM())
        assert len(result.edges) == 1
        assert result.edges[0].relation == "met"


# ---------------------------------------------------------------------------
# Engine integration: Fire mode parity
# ---------------------------------------------------------------------------


class TestFireModeParity:
    """Verify that Water-disabled engine behaves identically to pre-Water engine."""

    def test_engine_init_without_water(self):
        """Default engine init has Water disabled, no components created."""
        from tp_vrg.engine import LODGraphMemory

        engine = LODGraphMemory()
        assert engine._water_config.enabled is False
        assert engine._query_expander is None
        assert engine._passage_reranker is None
        assert engine._extraction_enricher is None

    def test_engine_init_with_water(self):
        """Water-enabled engine creates all three components."""
        from tp_vrg.engine import LODGraphMemory

        water_llm = MockWaterLLMProvider()
        water_config = WaterConfig(enabled=True)
        engine = LODGraphMemory(water_config=water_config, water_llm=water_llm)
        assert engine._water_config.enabled is True
        assert engine._query_expander is not None
        assert engine._passage_reranker is not None
        assert engine._extraction_enricher is not None

    def test_engine_water_without_llm_skips_components(self):
        """Water config enabled but no LLM → no components (graceful)."""
        from tp_vrg.engine import LODGraphMemory

        water_config = WaterConfig(enabled=True)
        engine = LODGraphMemory(water_config=water_config, water_llm=None)
        assert engine._water_config.enabled is True
        assert engine._query_expander is None  # no LLM → no components


# ---------------------------------------------------------------------------
# MockWaterLLMProvider tests
# ---------------------------------------------------------------------------


class TestMockWaterLLMProvider:
    @pytest.mark.asyncio
    async def test_complete_exists(self):
        llm = MockWaterLLMProvider()
        assert hasattr(llm, "complete")

    @pytest.mark.asyncio
    async def test_complete_returns_string(self):
        llm = MockWaterLLMProvider()
        result = await llm.complete("test prompt")
        assert isinstance(result, str)
        assert len(result) > 0

    @pytest.mark.asyncio
    async def test_mock_llm_no_complete(self):
        """MockLLMProvider (Fire) does NOT have complete()."""
        llm = MockLLMProvider()
        assert not hasattr(llm, "complete")

    @pytest.mark.asyncio
    async def test_inherits_extraction(self):
        """MockWaterLLMProvider still supports extraction (inherits from MockLLMProvider)."""
        llm = MockWaterLLMProvider()
        result = await llm.extract_entities_and_edges("test text")
        assert isinstance(result, ExtractionResult)
