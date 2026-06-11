"""
LOD Graph Memory - Core Engine

The main class that maintains a knowledge graph with Level-of-Detail
context assembly, backed by a pluggable storage backend.
"""

from __future__ import annotations

import inspect
import logging
import os
import re
import time
from dataclasses import asdict, dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

from tp_vrg.compression import query_words as _extract_query_words
from tp_vrg.embedding_cache import EmbeddingCache
from tp_vrg.embeddings import CachedEmbeddingProvider, EmbeddingProvider, MockEmbeddingProvider
from tp_vrg.ingestion import Ingester, _should_chunk, _is_table_chunk, _MD_TABLE_SEP_RE
from tp_vrg.llm_service import LLMProvider, MockLLMProvider
from tp_vrg.models import (
    C3_ENABLED,
    C3_THRESHOLD,
    CONTEXTUAL_EMBEDDING,
    CROSS_ENCODER_TOP_K,
    DEFAULT_KOLMOGOROV_DECAY_EXPONENT,
    MACRO_TOP_K,
    FUZZY_THRESHOLD,
    MACRO_TOPOLOGY,
    PROFILES,
    SP7_ENABLED,
    STRUCTURAL_RELATIONS,
    EdgeData,
    ExtractionResult,
    LODLevel,
    NodeData,
    ScoredNode,
    SourcePassage,
    SpiralConfig,
    TokenProfile,
    WaterConfig,
)
from tp_vrg.normalizer import EntityNormalizer
from tp_vrg.renderer import ContextRenderer
from tp_vrg.retrieval import Retriever
from tp_vrg.scoring import RelevanceScorer, _intent_to_mad_t
from tp_vrg.storage import InMemoryBackend, StorageBackend

DEFAULT_PASSAGE_EXPANSION_FACTOR: float = float(
    os.environ.get("TPVRG_EXPANSION_FACTOR", "0.7")
)


class PipelineContractViolation(RuntimeError):
    """Raised when a pipeline contract is violated at engine init.

    Pipeline contracts (C1, C7) catch silent-truncation and embedding-coverage
    bugs *before* they corrupt ingestion. The 2026-04-06 incident (MAX_TOKENS=1000
    > max_seq_length=512) ran for ~2 months under the prior `warnings.warn` approach
    because the warning was easily missed in init logs; converting to a raise
    enforces the the pipeline invariant policy INV-2 ("fail loud") discipline.

    See the public pipeline contract docs for the full contract table.

    Emergency override: set ``TPVRG_PIPELINE_CONTRACT_LAX=1`` to downgrade the
    raise to a warning. This is for short-term legacy-graph migrations only;
    do not ship lax mode to production.
    """
    pass


@dataclass
class RenderDecision:
    """Record of which rendering strategy was selected and why.

    Strategies:
      1   = Tier 1 topology (passage scope)
      2a  = Tier 1 topology_relaxed (2x search pool, 1.5x budget)
      2b  = cosine_fill (pure embedding similarity)
      3   = Tier 2 entity topology (full graph scoring pipeline)
      3a  = Tier 2 entity topology_relaxed (full graph, 1.5x budget)
    """

    triggered: bool
    threshold: float
    strategy_1_L: float
    strategy_2a_L: float | None
    strategy_2b_L: float | None
    strategy_3_L: float | None
    strategy_3a_L: float | None
    selected_strategy: str
    selected_tier: str  # "tier1" or "tier2" — which depth won
    selection_margin: float
    pass_1_time_s: float
    pass_2a_time_s: float | None
    pass_2b_time_s: float | None
    pass_3_time_s: float | None
    pass_3a_time_s: float | None


_QUERY_TIMING_RECONCILIATION_KEYS = (
    "extract_s",
    "route_s",
    "topology_render_s",
    "topology_relaxed_render_s",
    "cosine_fill_render_s",
    "entity_topology_render_s",
    "selector_decision_s",
)


def _resolve_kolmogorov_decay_exponent() -> float:
    raw = os.environ.get("TPVRG_KOLMOGOROV_DECAY_EXPONENT")
    if raw is None:
        return DEFAULT_KOLMOGOROV_DECAY_EXPONENT
    try:
        return float(raw.strip())
    except ValueError as exc:
        raise ValueError(
            "TPVRG_KOLMOGOROV_DECAY_EXPONENT must be a float "
            f"(got {raw!r})."
        ) from exc


class LODGraphMemory:
    """
    Knowledge graph with Level-of-Detail context assembly.

    The graph skeleton (edges) is always fully retained. Node content is
    stored at three resolutions; at query time the system selects which
    resolution to serve based on a five-signal composite relevance score:
    semantic proximity, topological weight, graph distance, parent signal,
    and temporal recency.

    When no scorer is configured, falls back to simple hop-distance
    thresholds for backward compatibility.
    """

    LOD_THRESHOLDS: list[tuple[range, LODLevel]] = [
        (range(0, 2), LODLevel.LOD_0),
        (range(2, 3), LODLevel.LOD_1),
        (range(3, 100), LODLevel.LOD_2),
    ]

    def __init__(
        self,
        llm_provider: LLMProvider | None = None,
        embedding_provider: EmbeddingProvider | None = None,
        storage: StorageBackend | None = None,
        scorer: RelevanceScorer | None = None,
        use_semantic_scoring: bool = True,
        water_config: WaterConfig | None = None,
        water_llm: LLMProvider | None = None,
        coref_mode: str | None = None,
        cross_encoder_reranker=None,
        provenance: Any = None,
    ) -> None:
        # Per-step diagnostic markers added 2026-05-17 night (overnight batch
        # Block 5) to narrow the 11-min post-backbone-load wedge documented in
        # [[GOTCHAS.md]] "/health wedge after backbone-load (2026-05-17)" +
        # [[docs/diagnostics/2026-05-17-doctrine-a-derived-state-inventory.md]] §2.
        # When the wedge reproduces, api.log will show the last `[engine-init]`
        # marker before silence, pinpointing which init step is the blocker.
        # Markers can be removed once the root cause is found + fixed.
        _init_start = time.monotonic()
        logger.info("[engine-init] LODGraphMemory.__init__ started")

        self._storage: StorageBackend = storage or InMemoryBackend()
        self._llm: LLMProvider = llm_provider or MockLLMProvider()
        self._embedder: EmbeddingProvider = embedding_provider or MockEmbeddingProvider()
        logger.info("[engine-init] step 1 OK (storage + llm + embedder bound)  +%.3fs", time.monotonic() - _init_start)
        self._scorer: RelevanceScorer = scorer or RelevanceScorer(
            decay_exponent=_resolve_kolmogorov_decay_exponent()
        )
        self._normalizer: EntityNormalizer = EntityNormalizer(
            fuzzy_threshold=FUZZY_THRESHOLD
        )
        logger.info("[engine-init] step 2 OK (scorer + normalizer)  +%.3fs", time.monotonic() - _init_start)
        self._use_semantic_scoring = use_semantic_scoring
        self._coref_mode = (coref_mode or os.environ.get("TPVRG_COREF_MODE", "sieve")).strip().lower()
        if self._coref_mode not in {"rules", "lingmess", "sieve", "none"}:
            raise ValueError(
                f"Unknown coref_mode '{self._coref_mode}'. Use 'rules', 'lingmess', 'sieve', or 'none'."
            )
        self._active_lods: dict[str, LODLevel] = {}
        self._last_scored_nodes: list[ScoredNode] = []
        self._last_intent: Any = None  # IntentSignal from most recent query
        # Rendering health diagnostics (product-level, every query)
        self._last_query_term_coverage: float = 0.0
        self._last_render_confidence: dict | None = None
        self._last_dedup_stats: dict[str, int] = {"rendered": 0, "skipped": 0}
        self._last_budget_scale: float = 1.0  # F20 reverted: full chosen ceiling used
        self._last_query_timing: dict[str, float | dict[str, float]] = {}
        self._last_render_decision: dict | None = None
        self._last_pass_1_survivors: dict[str, int | None] = {}
        self._last_pass_2_realized: dict[str, int | None] = {}
        self._last_entity_render_stage_timing: dict[str, float] = {}
        # F16: passage IDs that appear in the rendered context of the most
        # recent query. Source of truth for citation capture in the query
        # handlers (mcp_server, api_server). Updated by Tier 1/Tier 2 paths
        # and the C.3 selector's winning strategy.
        self._last_rendered_passage_ids: list[str] = []
        self._cross_encoder_reranker = cross_encoder_reranker

        # Water mode — LLM augmentation pipeline (Fire/Water Doctrine, strategy.md §4)
        self._water_config: WaterConfig = water_config or WaterConfig()
        self._water_llm: LLMProvider | None = water_llm  # separate from extraction LLM

        # Lazy-init Water components only when mode is enabled
        self._query_expander = None
        self._passage_reranker = None
        self._extraction_enricher = None
        if self._water_config.enabled and self._water_llm is not None:
            from tp_vrg.water import QueryExpander, PassageReranker, ExtractionEnricher
            self._query_expander = QueryExpander()
            self._passage_reranker = PassageReranker(self._storage)
            self._extraction_enricher = ExtractionEnricher()

        if hasattr(self._llm, "set_coref_mode"):
            self._llm.set_coref_mode(self._coref_mode)
        logger.info("[engine-init] step 3 OK (coref mode set)  +%.3fs", time.monotonic() - _init_start)

        # Rendering delegation (provenance handle enables reading-order fiber)
        self._renderer: ContextRenderer = ContextRenderer(
            self._storage, provenance=provenance
        )
        logger.info("[engine-init] step 4 OK (ContextRenderer)  +%.3fs", time.monotonic() - _init_start)

        # Retrieval delegation (provenance handle enables SP-8 reading-order fiber)
        self._retriever: Retriever = Retriever(
            storage=self._storage,
            embedder=self._embedder,
            use_semantic_scoring=self._use_semantic_scoring,
            water_config=self._water_config,
            water_llm=self._water_llm,
            query_expander=self._query_expander,
            passage_reranker=self._passage_reranker,
            cross_encoder_reranker=self._cross_encoder_reranker,
            provenance=provenance,
        )
        logger.info("[engine-init] step 5 OK (Retriever)  +%.3fs", time.monotonic() - _init_start)

        # Ingestion delegation
        # CONTEXTUAL_EMBEDDING is read from engine module namespace so that
        # monkeypatch("tp_vrg.engine.CONTEXTUAL_EMBEDDING", ...) in tests works.
        import tp_vrg.engine as _engine_mod
        self._provenance = provenance  # F16 ProvenanceBackend | None
        self._ingester: Ingester = Ingester(
            storage=self._storage,
            llm=self._llm,
            embedder=self._embedder,
            normalizer=self._normalizer,
            coref_mode=self._coref_mode,
            water_config=self._water_config,
            water_llm=self._water_llm,
            extraction_enricher=self._extraction_enricher,
            contextual_embedding=_engine_mod.CONTEXTUAL_EMBEDDING,
            provenance=provenance,
        )
        logger.info("[engine-init] step 6 OK (Ingester)  +%.3fs", time.monotonic() - _init_start)

        # Pipeline contracts C1 + C7 enforcement at engine init.
        # Per the public pipeline contract docs + the pipeline invariant policy INV-2
        # ("fail loud — must raise, not silently continue"). The 2026-04-06 silent-truncation
        # incident ran for ~2 months because the prior `warnings.warn` was easily missed in
        # init logs. Now raises by default; emergency override via TPVRG_PIPELINE_CONTRACT_LAX=1.
        self._validate_pipeline_contracts()
        logger.info("[engine-init] step 7 OK (_validate_pipeline_contracts)  +%.3fs", time.monotonic() - _init_start)
        logger.info("[engine-init] LODGraphMemory.__init__ complete  total=%.3fs", time.monotonic() - _init_start)

    def _validate_pipeline_contracts(self) -> None:
        """Validate pipeline contracts C1 + C7 at engine init.

        Raises:
            PipelineContractViolation: if any contract fails AND
                TPVRG_PIPELINE_CONTRACT_LAX is not set.

        See the public pipeline contract docs § "Contract Table"
        for the full invariant list. C2 is enforced separately at storage
        attach time (hard error on dim mismatch). C8 (async-handler event-loop
        safety) is a static check, not a runtime invariant.
        """
        _embedder_model = inspect.getattr_static(self._embedder, "_model", None)
        _embed_max_seq = inspect.getattr_static(
            _embedder_model, "max_seq_length", None
        )
        # inspect.getattr_static returns descriptors uninvoked. Real
        # sentence-transformers SentenceTransformer defines max_seq_length as a
        # @property that reads a cached attribute on the loaded model (no model
        # load triggered). When we have both the materialized model and the
        # property descriptor, resolve via fget on the instance — this is what
        # restores C1/C7 protection for production embedders without violating
        # the "don't trigger lazy _model load" intent of commit a16f4c5.
        if isinstance(_embed_max_seq, property) and _embedder_model is not None:
            try:
                _embed_max_seq = _embed_max_seq.fget(_embedder_model)
            except Exception:
                return
        if not isinstance(_embed_max_seq, int):
            # Embedder doesn't expose max_seq_length as a usable int (e.g.,
            # MockEmbeddingProvider in tests, lazy-loaded model where _model
            # itself is still a property descriptor, or unusual shape). Skip
            # check; will re-check on first real embed call if violation occurs.
            return

        from tp_vrg.chunker import DeterministicChunker

        violations: list[str] = []

        # C1: chunk MAX_TOKENS < max_seq_length - 32-token margin
        # (margin covers contextual prefix + tokenizer variance + [CLS]/[SEP])
        c1_margin = 32
        if DeterministicChunker.MAX_TOKENS > _embed_max_seq - c1_margin:
            violations.append(
                f"C1 VIOLATED: DeterministicChunker.MAX_TOKENS="
                f"{DeterministicChunker.MAX_TOKENS} >= embedding "
                f"max_seq_length={_embed_max_seq} minus {c1_margin}-token margin. "
                f"Passage embeddings WILL be silently truncated. "
                f"Fix: set MAX_TOKENS < {_embed_max_seq - c1_margin}."
            )

        # C7: contextual prefix budget — `"From: {source}" + chunk` must fit.
        # Conservative source-label estimate: 100 chars ≈ 25 tokens (English-ish).
        # This catches edge cases where source labels are long (e.g., full file
        # paths) and would push the combined input past max_seq_length even
        # though C1's 32-token margin would otherwise pass.
        c7_source_token_budget = 25
        c7_combined = c7_source_token_budget + DeterministicChunker.MAX_TOKENS
        if c7_combined > _embed_max_seq:
            violations.append(
                f"C7 VIOLATED: 'From: {{source}}' prefix budget "
                f"(~{c7_source_token_budget} tokens for a ~100-char label) "
                f"+ MAX_TOKENS ({DeterministicChunker.MAX_TOKENS}) = {c7_combined} > "
                f"max_seq_length={_embed_max_seq}. Contextual embeddings WILL be "
                f"silently truncated when source labels approach the budget. "
                f"Fix: reduce MAX_TOKENS or constrain source-label length."
            )

        if not violations:
            return

        msg = (
            "Pipeline contract violations at engine init:\n  - "
            + "\n  - ".join(violations)
            + "\n\nSee the public pipeline contract docs for the full contract table."
        )
        if os.environ.get("TPVRG_PIPELINE_CONTRACT_LAX") == "1":
            import warnings
            warnings.warn(
                msg
                + "\n[TPVRG_PIPELINE_CONTRACT_LAX=1 — running in lax mode; "
                + "violations not raised. NOT RECOMMENDED for production.]",
                stacklevel=3,
            )
            return

        msg += (
            "\n\nTo override temporarily (e.g., for legacy graphs you're "
            "actively re-ingesting), set TPVRG_PIPELINE_CONTRACT_LAX=1. "
            "Do not ship lax mode to production."
        )
        raise PipelineContractViolation(msg)

    # -- Properties -----------------------------------------------------------

    @property
    def graph(self):
        """Expose the raw graph for advanced queries (backend-dependent)."""
        return getattr(self._storage, "graph", None)

    @property
    def node_count(self) -> int:
        return self._storage.node_count()

    @property
    def edge_count(self) -> int:
        return self._storage.edge_count()

    @property
    def last_scored_nodes(self) -> list[ScoredNode]:
        """Scored nodes from the most recent get_context call."""
        return self._last_scored_nodes

    @property
    def last_query_term_coverage(self) -> float:
        """Fraction of query keywords found in rendered context (0.0–1.0)."""
        return self._last_query_term_coverage

    @property
    def last_dedup_stats(self) -> dict[str, int]:
        """Content dedup stats from last render: {rendered, skipped}."""
        return self._last_dedup_stats

    @property
    def last_query_timing(self) -> dict[str, float | dict[str, float]]:
        """Timing breakdown from the most recent query path."""
        return self._last_query_timing

    @property
    def last_asset_overlay_trace(self) -> dict:
        """Asset overlay trace from the most recent macro retrieval."""
        return dict(getattr(self._retriever, "_last_asset_overlay_trace", {}) or {})

    @property
    def last_render_trace_counts(self) -> dict[str, dict[str, int | None]]:
        """Survivor/realization counts for the most recent render."""
        return {
            "pass_1_survivors": dict(self._last_pass_1_survivors),
            "pass_2_realized": dict(self._last_pass_2_realized),
        }

    def _reset_render_trace_counters(self) -> None:
        self._last_pass_1_survivors = {
            "admitted_entity_atoms": 0,
            "total_candidates": 0,
            "candidate_passages": 0,
            "admitted_passages": 0,
        }
        self._last_pass_2_realized = {"entity_atoms": 0, "passages": 0}
        self._last_entity_render_stage_timing = {}
        self._last_render_decision = None

    @staticmethod
    def _seconds(value: object) -> float:
        if value is None:
            return 0.0
        try:
            return round(float(value), 3)
        except (TypeError, ValueError):
            return 0.0

    def _annotate_timing_reconciliation(
        self,
        timing: dict[str, float | dict[str, float] | str],
    ) -> dict[str, float | dict[str, float] | str]:
        total_s = self._seconds(timing.get("total_s", timing.get("total", 0.0)))
        timed_stage_sum_s = round(
            sum(
                self._seconds(timing.get(key))
                for key in _QUERY_TIMING_RECONCILIATION_KEYS
            ),
            3,
        )
        unaccounted_s = round(max(total_s - timed_stage_sum_s, 0.0), 3)
        unaccounted_pct = (
            round(unaccounted_s / total_s * 100, 1) if total_s > 0 else 0.0
        )
        timing["timed_stage_sum_s"] = timed_stage_sum_s
        timing["unaccounted_s"] = unaccounted_s
        timing["unaccounted_pct"] = unaccounted_pct
        return timing

    def _finalize_selector_timing(self, selector_elapsed_s: float) -> None:
        timing = dict(self._last_query_timing or {})
        decision = self._last_render_decision or {}

        topology_relaxed_s = self._seconds(decision.get("pass_2a_time_s"))
        cosine_fill_s = self._seconds(decision.get("pass_2b_time_s"))
        entity_topology_s = self._seconds(decision.get("pass_3_time_s"))
        strategy_time_s = topology_relaxed_s + cosine_fill_s + entity_topology_s

        timing["topology_relaxed_render_s"] = topology_relaxed_s
        timing["cosine_fill_render_s"] = cosine_fill_s
        timing["entity_topology_render_s"] = entity_topology_s
        timing["selector_decision_s"] = round(max(selector_elapsed_s - strategy_time_s, 0.0), 3)

        entity_stage = self._last_entity_render_stage_timing
        if entity_stage:
            timing["pass_1_admission_s"] = round(
                self._seconds(timing.get("pass_1_admission_s"))
                + self._seconds(entity_stage.get("pass_1_admission_s")),
                3,
            )
            timing["pass_2_score_s"] = self._seconds(entity_stage.get("pass_2_score_s"))
            timing["governor_s"] = self._seconds(entity_stage.get("governor_s"))
        else:
            timing.setdefault("pass_2_score_s", 0.0)
            timing.setdefault("governor_s", 0.0)

        base_total_s = self._seconds(timing.get("total_s", timing.get("total", 0.0)))
        timing["total_s"] = round(base_total_s + selector_elapsed_s, 3)
        timing["total"] = timing["total_s"]
        self._last_query_timing = self._annotate_timing_reconciliation(timing)

    @property
    def last_defined_term_stats(self) -> dict:
        """Defined-term expansion stats from last ingestion."""
        return getattr(self._ingester, "_last_defined_term_stats", {})

    async def _schedule_backbone(self) -> None:
        """Shim: delegate to Ingester._schedule_backbone()."""
        await self._ingester._schedule_backbone()

    # -- Ingestion shims (delegate to Ingester) ------------------------------------

    @staticmethod
    def _has_headers(text: str) -> bool:
        """Shim: delegate to ingestion._has_headers()."""
        from tp_vrg.ingestion import _has_headers
        return _has_headers(text)

    @staticmethod
    def _should_chunk(text: str) -> bool:
        """Shim: delegate to ingestion._should_chunk()."""
        from tp_vrg.ingestion import _should_chunk
        return _should_chunk(text)

    def _stitch_sibling_edges(self, chunks, chunk_entity_ids, event_timestamp=None):
        """Shim: delegate to Ingester._stitch_sibling_edges()."""
        return self._ingester._stitch_sibling_edges(chunks, chunk_entity_ids, event_timestamp)

    def _stitch_session_edges(self, passage_ids):
        """Shim: delegate to Ingester._stitch_session_edges()."""
        return self._ingester._stitch_session_edges(passage_ids)

    def stitch_sequence(self, passage_ids: list[str]) -> list[EdgeData]:
        """Create _session_follows edges between an ordered sequence of session passages.

        Public API — delegates to Ingester.stitch_sequence().
        """
        return self._ingester.stitch_sequence(passage_ids)

    def _stitch_mention_order(self, entity_ids):
        """Shim: delegate to Ingester._stitch_mention_order()."""
        return self._ingester._stitch_mention_order(entity_ids)

    def _apply_temporal_extraction(self, passage):
        """Shim: delegate to Ingester._apply_temporal_extraction()."""
        return self._ingester._apply_temporal_extraction(passage)

    async def _chunk_and_ingest(
        self,
        raw_text,
        source="",
        event_timestamp=None,
        suppress_backbone=False,
        normalization_cache: dict[str, str] | None = None,
        concurrent_chunks: int = 1,
    ):
        """Shim: delegate to Ingester._chunk_and_ingest()."""
        return await self._ingester._chunk_and_ingest(
            raw_text,
            source,
            event_timestamp,
            suppress_backbone,
            normalization_cache=normalization_cache,
            concurrent_chunks=concurrent_chunks,
        )

    async def _embed_batch_safe(self, texts):
        """Shim: delegate to Ingester._embed_batch_safe()."""
        return await self._ingester._embed_batch_safe(texts)

    @staticmethod
    def _generate_hype_questions(nodes, edges, entity_name_map):
        """Shim: delegate to Ingester._generate_hype_questions()."""
        from tp_vrg.ingestion import Ingester as _Ingester
        return _Ingester._generate_hype_questions(nodes, edges, entity_name_map)

    # -- Core API -------------------------------------------------------------

    async def add_memory(
        self,
        raw_text: str,
        source: str = "",
        event_timestamp: float | None = None,
        suppress_backbone: bool = False,
        normalization_cache: dict[str, str] | None = None,
        concurrent_chunks: int = 1,
    ) -> ExtractionResult:
        """Ingest raw text — delegates to Ingester.add_memory().

        Syncs mutable engine attributes (normalizer, llm) to the ingester so
        that test-time replacements (e.g. memory._normalizer = ...) propagate.
        """
        self._ingester._normalizer = self._normalizer
        self._ingester._llm = self._llm
        return await self._ingester.add_memory(
            raw_text,
            source,
            event_timestamp,
            suppress_backbone,
            normalization_cache=normalization_cache,
            concurrent_chunks=concurrent_chunks,
        )

    async def get_context(
        self, query: str, profile: TokenProfile | None = None, debug: bool = False
    ) -> str:
        """
        Build an LLM-ready context string, using progressive rendering.

        Tier 1 (passage scope): Fast path. Multi-hop queries are decomposed
        into sub-queries (F19) for broader passage retrieval; simple queries
        use direct macro_search. Returns if passages found.

        Tier 2 (entity pipeline): Full graph scoring + rendering fallback
        when Tier 1 produces no passages.

        When ``TPVRG_WORLD_MAP_ORIENTATION`` is on (default OFF —
        byte-identical render when unset), the result is prefixed with the
        query-conditioned world-map orientation frame (a territory TOC for
        broad queries, a route spine for multi-hop, nothing for local
        lookups) per docs/design/arch-world-map-render-surface-2026-06-09.md §9.

        Args:
            debug: If True, use developer-facing format. If False, use clean
                   LLM-optimized format (F18 Pre-Reasoning Harness).
        """
        ctx = await self._get_context_inner(query, profile=profile, debug=debug)
        from tp_vrg.world_map import maybe_prepend_orientation

        return maybe_prepend_orientation(
            ctx,
            self._last_intent,
            self._storage,
            getattr(self, "_last_rendered_passage_ids", None),
        )

    async def _get_context_inner(
        self, query: str, profile: TokenProfile | None = None, debug: bool = False
    ) -> str:
        """The render-pipeline body behind :meth:`get_context` (which adds
        the flag-gated world-map orientation frame on top)."""
        from tp_vrg.intent import classify_intent
        t_start = time.perf_counter()
        self._reset_render_trace_counters()

        spacy_nlp = getattr(self._llm, '_spacy_nlp', None)
        gliner = getattr(self._llm, '_gliner', None)
        intent = classify_intent(query, spacy_nlp=spacy_nlp, gliner_model=gliner)
        t1 = time.perf_counter()
        self._last_intent = intent
        # Visible-intelligence exposure: these already-computed signals are
        # surfaced through _compute_query_stats (the engine adapts + reasons
        # whether or not anyone is watching; now the Cockpit can watch).
        self._last_sub_queries: list[str] = []
        self._last_decomposition_strategy: str = "direct"
        self._last_speculative_hit: dict | None = None

        # Query budget: derived from intent signals when no explicit profile is set.
        # 10K floor. Complex queries scale up to 12.6K. Fallbacks get 1.5x.
        # The Governor is a meter, not a bouncer — generous headroom, measure usage.
        if profile is not None:
            budget = profile.max_tokens
        else:
            from tp_vrg.models import query_budget
            budget = query_budget(intent)
        self._last_budget_scale = 1.0

        from tp_vrg.multi_res.entry_seed import query_family_cell_lookup
        cache_cell = query_family_cell_lookup(query, intent, "asset", self._storage)
        self._last_speculative_hit = {
            "hit": bool(cache_cell.hit),
            "cluster_id": getattr(cache_cell, "cache_cluster_id", None),
            "reason": getattr(cache_cell, "cache_reason", None),
        }
        if cache_cell.hit and cache_cell.version_is_fresh and cache_cell.rendered_bundle:
            import asyncio
            from tp_vrg.janitor.bake_speculative_prerender import (
                bake_speculative_prerender_cache_async,
                default_low_lod_renderer,
            )
            conn = getattr(self._storage, "_conn", None)
            if conn is not None:
                async def _refresh_speculative_cache() -> None:
                    try:
                        await bake_speculative_prerender_cache_async(
                            conn,
                            history_events=[query],
                            render_low_lod=default_low_lod_renderer,
                        )
                    except Exception as exc:
                        logger.debug("Speculative cache refinement failed: %s", exc)
                asyncio.create_task(_refresh_speculative_cache())
            self._last_rendered_passage_ids = []
            self._last_query_timing = {
                "path": "speculative_prerender_cache_hit",
                "extract_s": round(t1 - t_start, 3),
                "total_s": round(time.perf_counter() - t_start, 3),
                "cache_cluster_id": cache_cell.cache_cluster_id,
                "cache_similarity": round(cache_cell.cache_similarity, 4),
            }
            return cache_cell.rendered_bundle.decode("utf-8", errors="replace")

        # ── Tier 1: Passage scope (with decomposition for multi-hop) ────
        from tp_vrg.decomposition import should_decompose, decompose_and_retrieve

        if should_decompose(query, intent):
            # Record the deterministic decomposition for the stats surface
            # (re-running the splitter is <5ms and pure; decompose_and_retrieve
            # recomputes it internally — zero behavior change).
            from tp_vrg.decomposition import decompose as _decompose_for_stats

            _dr = _decompose_for_stats(query, intent, spacy_nlp=spacy_nlp)
            self._last_sub_queries = list(_dr.sub_queries)
            self._last_decomposition_strategy = _dr.strategy
            result = await decompose_and_retrieve(
                query, intent, self._retriever, self._renderer,
                self._storage, budget, spacy_nlp=spacy_nlp, collect_timing=True,
            )
            t2 = time.perf_counter()
            if result is not None:
                ctx, dedup = result[:2]
                # result[2] is rendered_passage_ids (added 2026-04-10 for F16).
                # result[3] is timing (only present when collect_timing=True).
                rendered_pids = result[2] if len(result) > 2 else []
                self._last_rendered_passage_ids = rendered_pids
                decomp_timing = result[3] if len(result) > 3 else None
                from tp_vrg.render_confidence import compute_render_confidence
                self._last_query_term_coverage = self._compute_query_term_coverage(query, ctx)
                self._last_dedup_stats = dedup
                self._last_scored_nodes = []
                self._active_lods = {}
                self._last_render_confidence = compute_render_confidence(ctx, query, intent, storage=self._storage)
                self._last_pass_1_survivors = {
                    "admitted_entity_atoms": 0,
                    "total_candidates": 0,
                    "candidate_passages": len(rendered_pids),
                    "admitted_passages": len(rendered_pids),
                }
                self._last_pass_2_realized = {
                    "entity_atoms": 0,
                    "passages": len(rendered_pids),
                }
                self._last_query_timing = {
                    "path": "tier1_decomposition",
                    "extract_s": round(t1 - t_start, 3),
                    "route_s": round(t2 - t1, 3),
                    "pass_1_admission_s": 0.0,
                    "pass_2_score_s": 0.0,
                    "selector_decision_s": 0.0,
                    "topology_render_s": round(t2 - t1, 3),
                    "topology_relaxed_render_s": 0.0,
                    "cosine_fill_render_s": 0.0,
                    "entity_topology_render_s": 0.0,
                    "governor_s": 0.0,
                    "total_s": round(t2 - t_start, 3),
                    "intent": round(t1 - t_start, 3),
                    "decomposition_pipeline": round(t2 - t1, 3),
                    "decomposition_detail": decomp_timing,
                    "total": round(time.perf_counter() - t_start, 3),
                }
                return await self._maybe_c3_select(
                    ctx, query, intent, budget, profile, debug
                )
        else:
            # Simple query — direct passage scope
            from tp_vrg.multi_res.integration import scoped_macro_search
            passage_ids = await scoped_macro_search(
                query,
                intent=intent,
                storage=self._storage,
                embedder=self._embedder,
                retriever=self._retriever,
            )
            t2 = time.perf_counter()
            if passage_ids:
                # Tier-1 expansion pipeline:
                # SP-6 (sequential neighbors) → cross-encoder (rerank top-K from
                # similarity pool) → SP-7 (entity bridge, appended AFTER reranking
                # because bridge passages are structural, not similarity-ranked —
                # the cross-encoder's judgment is less relevant for them and
                # reranking the full SP-7 pool was a 10-20s bottleneck).
                if MACRO_TOPOLOGY != "none":
                    topo_rels: set[str] = set()
                    if MACRO_TOPOLOGY in ("session", "both"):
                        topo_rels.add("_session_follows")
                    if MACRO_TOPOLOGY in ("follows", "both"):
                        topo_rels.add("_follows")
                    if topo_rels:
                        passage_ids = self._retriever._expand_macro_by_topology(
                            passage_ids, topo_rels
                        )
                t3 = time.perf_counter()

                # Cross-encoder BEFORE SP-7 (bridge passages are structural,
                # not similarity candidates — reranking them was a bottleneck)
                if self._cross_encoder_reranker is not None:
                    passage_ids = await self._cross_encoder_reranker.rerank(
                        query, passage_ids, self._storage, top_k=CROSS_ENCODER_TOP_K
                    )
                t4 = time.perf_counter()

                if SP7_ENABLED:
                    passage_ids = self._retriever._expand_macro_by_entity_bridge(
                        passage_ids, query=query
                    )

                # Temporal-lookup retrieval mode (audit Finding 4b; founder
                # Decision B). For "when did X happen?" queries (reasoning_intent
                # == temporal_lookup), cosine retrieval over the question text
                # often misses the passage whose salient content is the *date* —
                # no scoring nudge recovers a passage that was never retrieved.
                # Overcast date-bearing passages where the query's named entities
                # co-occur with a date. Appended AFTER reranking (like the entity
                # bridge) because date-bearing passages are structural, not
                # similarity-ranked.
                passage_ids = self._expand_macro_by_temporal_lookup(
                    passage_ids, query, intent
                )
                t5 = time.perf_counter()

                # SQL-B1: batch fetch eliminates N+1 queries
                _batch = self._storage.get_passages_batch(passage_ids)
                passages = [_batch[pid] for pid in passage_ids if pid in _batch]
                t6 = time.perf_counter()
                if passages:
                    ctx, dedup, rendered_pids = self._renderer.format_passages(passages, query, budget, intent)
                    self._last_rendered_passage_ids = rendered_pids
                    t7 = time.perf_counter()
                    from tp_vrg.render_confidence import compute_render_confidence
                    self._last_render_confidence = compute_render_confidence(ctx, query, intent, storage=self._storage)
                    t8 = time.perf_counter()
                    self._last_query_term_coverage = self._compute_query_term_coverage(query, ctx)
                    self._last_dedup_stats = dedup
                    self._last_scored_nodes = []
                    self._active_lods = {}
                    self._last_pass_1_survivors = {
                        "admitted_entity_atoms": 0,
                        "total_candidates": 0,
                        "candidate_passages": len(passage_ids),
                        "admitted_passages": len(passages),
                    }
                    self._last_pass_2_realized = {
                        "entity_atoms": 0,
                        "passages": len(rendered_pids),
                    }
                    self._last_query_timing = {
                        "path": "tier1_simple",
                        "extract_s": round(t1 - t_start, 3),
                        "route_s": round((t2 - t1) + (t3 - t2) + (t4 - t3) + (t5 - t4), 3),
                        "pass_1_admission_s": round(t6 - t5, 3),
                        "pass_2_score_s": 0.0,
                        "selector_decision_s": 0.0,
                        "topology_render_s": round((t7 - t6) + (t8 - t7), 3),
                        "topology_relaxed_render_s": 0.0,
                        "cosine_fill_render_s": 0.0,
                        "entity_topology_render_s": 0.0,
                        "governor_s": 0.0,
                        "total_s": round(t8 - t_start, 3),
                        "intent": round(t1 - t_start, 3),
                        "macro_search": round(t2 - t1, 3),
                        "sp6_expand": round(t3 - t2, 3),
                        "cross_encoder": round(t4 - t3, 3),
                        "sp7_bridge": round(t5 - t4, 3),
                        "get_passages": round(t6 - t5, 3),
                        "format_passages": round(t7 - t6, 3),
                        "render_confidence": round(t8 - t7, 3),
                        "total": round(t8 - t_start, 3),
                        "macro_search_detail": getattr(self._retriever, "_last_macro_timing", {}),
                    }
                    return await self._maybe_c3_select(
                        ctx, query, intent, budget, profile, debug
                    )

        # ── Tier 1 found nothing — Tier 2 standalone (rare edge case) ────────
        # Normally Tier 2 competes as a C.3 strategy inside _c3_select.
        # This fallback only fires when macro_search returns zero passages
        # AND decomposition also fails — extremely rare with current indexing.
        ctx_t2, L_t2 = await self._tier2_entity_render(query, intent, budget, debug)
        t2 = time.perf_counter()
        self._last_query_timing = self._annotate_timing_reconciliation({
            "path": "tier2_standalone",
            "extract_s": round(t1 - t_start, 3),
            "route_s": 0.0,
            "pass_1_admission_s": self._seconds(
                self._last_entity_render_stage_timing.get("pass_1_admission_s")
            ),
            "pass_2_score_s": self._seconds(
                self._last_entity_render_stage_timing.get("pass_2_score_s")
            ),
            "selector_decision_s": 0.0,
            "topology_render_s": 0.0,
            "topology_relaxed_render_s": 0.0,
            "cosine_fill_render_s": 0.0,
            "entity_topology_render_s": round(t2 - t1, 3),
            "governor_s": self._seconds(
                self._last_entity_render_stage_timing.get("governor_s")
            ),
            "total_s": round(t2 - t_start, 3),
            "intent": round(t1 - t_start, 3),
            "tier2_entity_render": round(t2 - t1, 3),
            "total": round(t2 - t_start, 3),
        })
        if ctx_t2:
            from tp_vrg.render_confidence import compute_render_confidence
            self._last_render_confidence = compute_render_confidence(ctx_t2, query, intent, storage=self._storage)
            return ctx_t2
        return "[No relevant entities found in the knowledge graph.]"

    async def _tier2_entity_render(
        self,
        query: str,
        intent,
        budget: int,
        debug: bool = False,
    ) -> tuple[str, float]:
        """Run Tier 2 entity pipeline and return (context, confidence_L).

        This method calls _get_context_scored which mutates self state
        (scored_nodes, active_lods, dedup_stats). Callers running this
        as a C.3 strategy MUST save/restore self state around the call.
        """
        active_ids = await self._retriever.identify_active_nodes(query, intent=intent)
        if not active_ids:
            self._last_rendered_passage_ids = []
            self._last_pass_1_survivors = {
                "admitted_entity_atoms": 0,
                "total_candidates": 0,
                "candidate_passages": 0,
                "admitted_passages": 0,
            }
            self._last_pass_2_realized = {"entity_atoms": 0, "passages": 0}
            self._last_entity_render_stage_timing = {
                "pass_1_admission_s": 0.0,
                "pass_2_score_s": 0.0,
                "governor_s": 0.0,
            }
            return "", 0.0

        depth = max(0.0, min(1.0, getattr(intent, "reasoning_depth", 0.0) or 0.0))
        max_hops = max(2, min(6, int(2 + 4 * depth)))
        distances = self._compute_distances(active_ids, max_hops=max_hops)

        if self._use_semantic_scoring:
            ctx = await self._get_context_scored(
                query, distances, debug=debug, intent=intent
            )
            # _get_context_scored already updated _last_rendered_passage_ids
        else:
            lods = self._assign_lods(distances)
            ctx, _ = self._renderer.format_context(
                lods, distances, query, scored_nodes=[], debug=debug
            )
            # Distance-only path — no scored nodes, no citations derivable
            self._last_rendered_passage_ids = []

        from tp_vrg.render_confidence import compute_render_confidence
        rc = compute_render_confidence(ctx, query, intent, storage=self._storage)
        return ctx, float(rc.get("L", 0.0))

    async def _maybe_c3_select(
        self,
        ctx: str,
        query: str,
        intent,
        budget: int,
        profile: TokenProfile | None,
        debug: bool,
    ) -> str:
        """Apply C.3 selector when render confidence falls below threshold.

        Also honors the TPVRG_USR_STRATEGIES ablation flag (sprint
        2026-04-23-usr-audit Step 3) for restricted-mode measurement runs.
        When the flag is set to anything other than "all", the restricted
        mode takes priority over C3_ENABLED — the audit explicitly wants
        to measure single-strategy behavior regardless of the global
        selector toggle.
        """
        # Lazy import — test monkeypatching on tp_vrg.models.USR_STRATEGIES
        # picks up the new value on each call without requiring a reload.
        from tp_vrg.models import USR_STRATEGIES

        L1 = float((self._last_render_confidence or {}).get("L", 1.0))
        selector_start = time.perf_counter()

        # ── USR audit: topology-only — always return the upstream topology render.
        if USR_STRATEGIES == "topology-only":
            self._last_render_decision = asdict(
                RenderDecision(
                    triggered=False,
                    threshold=C3_THRESHOLD,
                    strategy_1_L=round(L1, 4),
                    strategy_2a_L=None,
                    strategy_2b_L=None,
                    strategy_3_L=None,
                    strategy_3a_L=None,
                    selected_strategy="topology",
                    selected_tier="tier1",
                    selection_margin=0.0,
                    pass_1_time_s=0.0,
                    pass_2a_time_s=None,
                    pass_2b_time_s=None,
                    pass_3_time_s=None,
                    pass_3a_time_s=None,
                )
            )
            self._finalize_selector_timing(time.perf_counter() - selector_start)
            return ctx

        # ── USR audit: passage-only — run cosine_fill exclusively, discard ctx.
        # The topology render upstream already ran (its work is wasted under
        # this mode); the audit's Step 5 measurement reads per-strategy
        # wall-clock from the pass_X_time_s fields, not end-to-end query time,
        # so this waste does not distort the measurement.
        if USR_STRATEGIES == "passage-only":
            from tp_vrg.render_confidence import compute_render_confidence
            from tp_vrg.simple_renderer import cosine_fill_render

            t0 = time.perf_counter()
            ctx_cf, rendered_pids = await cosine_fill_render(
                query, self._storage, self._embedder, budget
            )
            t_cf = time.perf_counter() - t0

            if ctx_cf:
                rc = compute_render_confidence(
                    ctx_cf, query, intent, storage=self._storage
                )
                L_cf = float(rc.get("L", 0.0))
                self._last_render_confidence = rc
                self._last_rendered_passage_ids = rendered_pids
                self._last_pass_2_realized = {
                    "entity_atoms": 0,
                    "passages": len(rendered_pids),
                }
            else:
                L_cf = 0.0

            self._last_render_decision = asdict(
                RenderDecision(
                    triggered=True,
                    threshold=C3_THRESHOLD,
                    strategy_1_L=None,
                    strategy_2a_L=None,
                    strategy_2b_L=round(L_cf, 4),
                    strategy_3_L=None,
                    strategy_3a_L=None,
                    selected_strategy="cosine_fill",
                    selected_tier="tier1",
                    selection_margin=0.0,
                    pass_1_time_s=None,
                    pass_2a_time_s=None,
                    pass_2b_time_s=round(t_cf, 3),
                    pass_3_time_s=None,
                    pass_3a_time_s=None,
                )
            )
            self._finalize_selector_timing(time.perf_counter() - selector_start)
            return ctx_cf

        # ── Normal paths (USR_STRATEGIES in {"all", "2-primary"})
        if not C3_ENABLED:
            self._last_render_decision = None
            self._finalize_selector_timing(time.perf_counter() - selector_start)
            return ctx
        if L1 >= C3_THRESHOLD:
            self._last_render_decision = asdict(
                RenderDecision(
                    triggered=False,
                    threshold=C3_THRESHOLD,
                    strategy_1_L=round(L1, 4),
                    strategy_2a_L=None,
                    strategy_2b_L=None,
                    strategy_3_L=None,
                    strategy_3a_L=None,
                    selected_strategy="topology",
                    selected_tier="tier1",
                    selection_margin=0.0,
                    pass_1_time_s=0.0,
                    pass_2a_time_s=None,
                    pass_2b_time_s=None,
                    pass_3_time_s=None,
                    pass_3a_time_s=None,
                )
            )
            self._finalize_selector_timing(time.perf_counter() - selector_start)
            return ctx
        best_ctx, decision = await self._c3_select(
            query=query,
            ctx_1=ctx,
            L1=L1,
            intent=intent,
            budget=budget,
            profile=profile,
            debug=debug,
            usr_mode=USR_STRATEGIES,
        )
        self._last_render_decision = asdict(decision)
        self._finalize_selector_timing(time.perf_counter() - selector_start)
        return best_ctx

    async def _c3_select(
        self,
        query: str,
        ctx_1: str,
        L1: float,
        intent,
        budget: int,
        profile: TokenProfile | None,
        debug: bool,
        usr_mode: str = "all",
    ) -> tuple[str, RenderDecision]:
        """C.3 unified selector: multi-strategy competition on render confidence.

        Strategies 1, 2a, 2b are passage-scope (Tier 1).
        Strategy 3 is entity-scope (Tier 2) — full graph scoring pipeline.
        Fallback strategies get 1.5x budget. When the primary topology render
        isn't confident, the alternatives need MORE room to compensate, not the
        same. In 3D rendering: when primary LOD fails, you render at higher
        quality (more polygons), not the same.

        Args:
            usr_mode: TPVRG_USR_STRATEGIES ablation mode. "all" (default) runs
                all 4 strategies. "2-primary" runs only topology + cosine_fill
                — skips render_2a (topology_relaxed) AND _tier2_entity_render.
                Other modes short-circuit before reaching this function.
        """
        import asyncio

        from tp_vrg.render_confidence import compute_render_confidence
        from tp_vrg.simple_renderer import cosine_fill_render

        # Generous fallback: 1.5x budget for alternative strategies
        fallback_budget = int(budget * 1.5)

        async def render_2a() -> tuple[str, float, float, list[str]]:
            t0 = time.perf_counter()
            passage_ids = await self._retriever.macro_search(
                query, top_k=MACRO_TOP_K * 2, intent=intent
            )
            if not passage_ids:
                return "", 0.0, time.perf_counter() - t0, []
            # SQL-B1: batch fetch eliminates N+1 queries
            _batch = self._storage.get_passages_batch(passage_ids)
            passages = [_batch[pid] for pid in passage_ids if pid in _batch]
            if not passages:
                return "", 0.0, time.perf_counter() - t0, []
            ctx_2a, _, rendered_pids_2a = self._renderer.format_passages(passages, query, fallback_budget, intent)
            rc = compute_render_confidence(ctx_2a, query, intent, storage=self._storage)
            return ctx_2a, float(rc.get("L", 0.0)), time.perf_counter() - t0, rendered_pids_2a

        async def render_2b() -> tuple[str, float, float, list[str]]:
            t0 = time.perf_counter()
            ctx_2b, rendered_pids_2b = await cosine_fill_render(
                query, self._storage, self._embedder, fallback_budget
            )
            if not ctx_2b:
                return "", 0.0, time.perf_counter() - t0, []
            rc = compute_render_confidence(ctx_2b, query, intent, storage=self._storage)
            return ctx_2b, float(rc.get("L", 0.0)), time.perf_counter() - t0, rendered_pids_2b

        # ── USR audit 2-primary: skip render_2a + _tier2_entity_render ──
        # Under 2-primary mode, only cosine_fill competes with topology.
        # The Tier 2 state save/restore dance below is unneeded because
        # _tier2_entity_render is not called.
        if usr_mode == "2-primary":
            ctx_2b, L2b, t2b, pids_2b = await render_2b()
            ctx_2a, L2a, t2a, pids_2a = "", 0.0, 0.0, []
            ctx_3, L3, t3, pids_3 = "", 0.0, 0.0, []
            t2_scored, t2_lods, t2_dedup = None, None, None

            candidates = [
                ("topology", ctx_1, L1),
                ("cosine_fill", ctx_2b, L2b),
            ]
            best_name, best_ctx, _best_L = max(candidates, key=lambda x: x[2])
            margin = abs(L1 - L2b)

            if best_name == "cosine_fill":
                self._last_rendered_passage_ids = pids_2b
                self._last_pass_2_realized = {
                    "entity_atoms": 0,
                    "passages": len(pids_2b),
                }
            # else: "topology" — self._last_rendered_passage_ids already
            # reflects the upstream topology render, no action needed.

            self._last_render_confidence = compute_render_confidence(
                best_ctx, query, intent, storage=self._storage
            )
            return best_ctx, RenderDecision(
                triggered=True,
                threshold=C3_THRESHOLD,
                strategy_1_L=round(L1, 4),
                strategy_2a_L=None,
                strategy_2b_L=round(L2b, 4),
                strategy_3_L=None,
                strategy_3a_L=None,
                selected_strategy=best_name,
                selected_tier="tier1",
                selection_margin=round(margin, 4),
                pass_1_time_s=0.0,
                pass_2a_time_s=None,
                pass_2b_time_s=round(t2b, 3),
                pass_3_time_s=None,
                pass_3a_time_s=None,
            )

        # ── USR audit tier1-all-no-entity: run topology + 2a + 2b, skip Tier 2 ──
        # Safe operational mitigation when Tier 2's compute cost is unacceptable
        # but the relaxed-topology and cosine-fill alternatives should still
        # compete. Replaces "2-primary" as the recommended fast-mode for Mode 7
        # because 2-primary wrongly skips topology_relaxed (which wins on many
        # slow queries per the 2026-04-28 failure-trace synthesis).
        if usr_mode == "tier1-all-no-entity":
            (ctx_2a, L2a, t2a, pids_2a), (ctx_2b, L2b, t2b, pids_2b) = await asyncio.gather(
                render_2a(), render_2b()
            )
            candidates = [
                ("topology", ctx_1, L1),
                ("topology_relaxed", ctx_2a, L2a),
                ("cosine_fill", ctx_2b, L2b),
            ]
            best_name, best_ctx, _best_L = max(candidates, key=lambda x: x[2])
            sorted_ls = sorted([L1, L2a, L2b], reverse=True)
            margin = sorted_ls[0] - sorted_ls[1] if len(sorted_ls) > 1 else 0.0

            if best_name == "topology_relaxed":
                self._last_rendered_passage_ids = pids_2a
                self._last_pass_2_realized = {
                    "entity_atoms": 0,
                    "passages": len(pids_2a),
                }
            elif best_name == "cosine_fill":
                self._last_rendered_passage_ids = pids_2b
                self._last_pass_2_realized = {
                    "entity_atoms": 0,
                    "passages": len(pids_2b),
                }
            # else: "topology" — self._last_rendered_passage_ids unchanged

            self._last_render_confidence = compute_render_confidence(
                best_ctx, query, intent, storage=self._storage
            )
            return best_ctx, RenderDecision(
                triggered=True,
                threshold=C3_THRESHOLD,
                strategy_1_L=round(L1, 4),
                strategy_2a_L=round(L2a, 4),
                strategy_2b_L=round(L2b, 4),
                strategy_3_L=None,
                strategy_3a_L=None,
                selected_strategy=best_name,
                selected_tier="tier1",
                selection_margin=round(margin, 4),
                pass_1_time_s=0.0,
                pass_2a_time_s=round(t2a, 3),
                pass_2b_time_s=round(t2b, 3),
                pass_3_time_s=None,
                pass_3a_time_s=None,
            )

        # ── usr_mode == "all" (default): all 4 strategies compete ──

        # ── Run Tier 1 alternatives in parallel (no self-state mutation) ──
        (ctx_2a, L2a, t2a, pids_2a), (ctx_2b, L2b, t2b, pids_2b) = await asyncio.gather(
            render_2a(), render_2b()
        )

        # ── Early-winner skip ─────────────────────────────────────────────
        # If any Tier 1 alternative already meets the C3_THRESHOLD, skip
        # _tier2_entity_render. Per the topology-first policy, Tier 2 is
        # a fallback competitor when Tier 1 is weak; if Tier 1 already wins,
        # the entity render's compute is wasted (it never wins on Mode 7's
        # slow queries per the 2026-04-28 failure-trace synthesis, which
        # measured ~13 min of discarded compute per slow query).
        #
        # The skip path doesn't mutate Tier 2 state, so the save/restore dance
        # below is also skipped — there's nothing to save or restore.
        if max(L1, L2a, L2b) >= C3_THRESHOLD:
            ctx_3, L3, t3, pids_3 = "", 0.0, 0.0, []
            t2_scored, t2_lods, t2_dedup = None, None, None
            saved_rendered_pids = list(self._last_rendered_passage_ids)

            candidates = [
                ("topology", ctx_1, L1),
                ("topology_relaxed", ctx_2a, L2a),
                ("cosine_fill", ctx_2b, L2b),
            ]
            best_name, best_ctx, _best_L = max(candidates, key=lambda x: x[2])
            sorted_ls = sorted([L1, L2a, L2b], reverse=True)
            margin = sorted_ls[0] - sorted_ls[1] if len(sorted_ls) > 1 else 0.0

            if best_name == "topology_relaxed":
                self._last_rendered_passage_ids = pids_2a
                self._last_pass_2_realized = {
                    "entity_atoms": 0,
                    "passages": len(pids_2a),
                }
            elif best_name == "cosine_fill":
                self._last_rendered_passage_ids = pids_2b
                self._last_pass_2_realized = {
                    "entity_atoms": 0,
                    "passages": len(pids_2b),
                }
            # else: "topology" — self._last_rendered_passage_ids unchanged

            self._last_render_confidence = compute_render_confidence(
                best_ctx, query, intent, storage=self._storage
            )
            return best_ctx, RenderDecision(
                triggered=True,
                threshold=C3_THRESHOLD,
                strategy_1_L=round(L1, 4),
                strategy_2a_L=round(L2a, 4),
                strategy_2b_L=round(L2b, 4),
                strategy_3_L=None,  # Tier 2 skipped — no L3 to report
                strategy_3a_L=None,
                selected_strategy=best_name,
                selected_tier="tier1",
                selection_margin=round(margin, 4),
                pass_1_time_s=0.0,
                pass_2a_time_s=round(t2a, 3),
                pass_2b_time_s=round(t2b, 3),
                pass_3_time_s=None,
                pass_3a_time_s=None,
            )

        # ── Run Tier 2 entity pipeline sequentially ──────────────────────
        # Sequential because _tier2_entity_render calls _get_context_scored
        # which mutates self state (scored_nodes, active_lods, dedup,
        # _last_rendered_passage_ids). Save/restore Tier 1 state around the
        # call. See plan G3 — all SIX save/restore points must be kept in sync.
        saved_scored = self._last_scored_nodes
        saved_lods = self._active_lods
        saved_dedup = self._last_dedup_stats
        saved_coverage = self._last_query_term_coverage
        saved_rendered_pids = list(self._last_rendered_passage_ids)

        t3_start = time.perf_counter()
        ctx_3, L3 = await self._tier2_entity_render(query, intent, budget, debug)
        t3 = time.perf_counter() - t3_start

        # Capture Tier 2 diagnostic state before restoring Tier 1
        t2_scored = self._last_scored_nodes
        t2_lods = self._active_lods
        t2_dedup = self._last_dedup_stats
        pids_3 = list(self._last_rendered_passage_ids)  # Tier 2 rendered IDs

        # Restore Tier 1 state as default (topology is the default winner)
        self._last_scored_nodes = saved_scored
        self._active_lods = saved_lods
        self._last_dedup_stats = saved_dedup
        self._last_query_term_coverage = saved_coverage
        self._last_rendered_passage_ids = saved_rendered_pids

        # ── Select best strategy ─────────────────────────────────────────
        candidates = [
            ("topology", ctx_1, L1),
            ("topology_relaxed", ctx_2a, L2a),
            ("cosine_fill", ctx_2b, L2b),
            ("entity_topology", ctx_3, L3),
        ]
        best_name, best_ctx, _best_L = max(candidates, key=lambda x: x[2])
        sorted_ls = sorted([L1, L2a, L2b, L3], reverse=True)
        margin = sorted_ls[0] - sorted_ls[1] if len(sorted_ls) > 1 else 0.0

        # Assign the winning strategy's rendered passage IDs to the
        # canonical field used by the query handler for citation capture.
        if best_name == "entity_topology":
            self._last_scored_nodes = t2_scored
            self._active_lods = t2_lods
            self._last_dedup_stats = t2_dedup
            self._last_rendered_passage_ids = pids_3
            self._last_pass_2_realized = {
                "entity_atoms": len(t2_scored or []),
                "passages": len(pids_3),
            }
        elif best_name == "topology_relaxed":
            self._last_rendered_passage_ids = pids_2a
            self._last_pass_2_realized = {
                "entity_atoms": 0,
                "passages": len(pids_2a),
            }
        elif best_name == "cosine_fill":
            self._last_rendered_passage_ids = pids_2b
            self._last_pass_2_realized = {
                "entity_atoms": 0,
                "passages": len(pids_2b),
            }
        # else: "topology" — saved_rendered_pids already restored above

        selected_tier = "tier2" if best_name.startswith("entity") else "tier1"
        self._last_render_confidence = compute_render_confidence(best_ctx, query, intent, storage=self._storage)
        return best_ctx, RenderDecision(
            triggered=True,
            threshold=C3_THRESHOLD,
            strategy_1_L=round(L1, 4),
            strategy_2a_L=round(L2a, 4),
            strategy_2b_L=round(L2b, 4),
            strategy_3_L=round(L3, 4),
            strategy_3a_L=None,  # TODO: add entity_relaxed after first data collection
            selected_strategy=best_name,
            selected_tier=selected_tier,
            selection_margin=round(margin, 4),
            pass_1_time_s=0.0,
            pass_2a_time_s=round(t2a, 3),
            pass_2b_time_s=round(t2b, 3),
            pass_3_time_s=round(t3, 3),
            pass_3a_time_s=None,
        )

    async def _llm_rerank(
        self,
        query: str,
        scored_nodes: list[ScoredNode],
        nodes: dict[str, NodeData],
        config: SpiralConfig,
    ) -> list[ScoredNode]:
        """R1/AIP-4 — LLM Retrieval Re-ranking (premium tier only).

        Sends the top-K scored nodes (with LOD_1 summaries) to the LLM and asks
        it to re-order them by relevance to the query. The re-ordered list is
        returned; original scores are preserved so the Governor still allocates
        budget proportionally to relevance.

        Enabled only when config.rerank_enabled=True AND an LLM provider is
        configured (not MockLLMProvider). Gracefully falls back to original order
        on any error (LLM unavailable, parse failure, unexpected output).

        Cost: ~$0.002/complex query (Haiku). Latency: +400-600ms.
        """
        if not config.rerank_enabled:
            return scored_nodes

        # Only proceed if the LLM provider supports free-form completion.
        # R1 is a premium-tier feature; providers that only implement
        # extract_entities_and_edges + summarize skip this gracefully.
        if not hasattr(self._llm, "complete"):
            return scored_nodes

        top_k = min(config.rerank_top_k, len(scored_nodes))
        if top_k <= 1:
            return scored_nodes

        top_nodes = scored_nodes[:top_k]
        rest = scored_nodes[top_k:]

        # Build re-ranking prompt
        lines = [
            f"Query: {query}\n",
            "Re-rank these knowledge fragments by relevance (most relevant first).",
            "Return ONLY a comma-separated list of IDs, e.g.: id1,id2,id3\n",
        ]
        for sn in top_nodes:
            node = nodes.get(sn.entity_id)
            summary = node.lod_1 if node else sn.entity_id
            lines.append(f"[{sn.entity_id}] {summary[:200]}")
        prompt = "\n".join(lines)

        try:
            response = await self._llm.complete(prompt, max_tokens=300)
            # Parse: extract IDs from a comma/newline-separated list
            import re as _re
            raw_ids = [
                tok.strip().strip("[]")
                for tok in _re.split(r"[,\n]+", response)
                if tok.strip()
            ]
            # Build reordered list: only include IDs that exist in top_nodes
            id_to_node = {sn.entity_id: sn for sn in top_nodes}
            reordered = [id_to_node[eid] for eid in raw_ids if eid in id_to_node]
            # Append any top_nodes not mentioned by LLM (preserve original order)
            mentioned = set(raw_ids)
            leftover = [sn for sn in top_nodes if sn.entity_id not in mentioned]
            import logging
            logging.getLogger(__name__).debug(
                "R1: LLM re-ranked %d candidates, %d positions changed",
                len(reordered),
                sum(1 for i, sn in enumerate(reordered) if i < len(top_nodes) and sn.entity_id != top_nodes[i].entity_id),
            )
            return reordered + leftover + rest
        except Exception:
            # Any failure → silent fallback to original order
            return scored_nodes

    def _expand_macro_by_temporal_lookup(
        self,
        passage_ids: list[str],
        query: str,
        intent,
        max_add: int = 20,
    ) -> list[str]:
        """Temporal-lookup retrieval mode — overcast date-bearing passages.

        For "when did X happen?" queries (reasoning_intent == "temporal_lookup"),
        cosine retrieval over the question text frequently fails to surface the
        passage whose salient content is the *answer date* (audit Finding 4b:
        intent is scoring-only, never a retrieval signal — and no scoring nudge
        recovers a passage that was never retrieved).

        This pass resolves the query's named entities to entity nodes (FTS name
        match), then appends passages where those entities co-occur with a date
        (passage.temporal_min is set). Appended after the existing pool — like the
        entity bridge (SP-7) — because date-bearing passages are structural, not
        similarity-ranked, so a similarity reranker would wrongly demote them.

        No-ops (returns the input unchanged) unless reasoning_intent is
        temporal_lookup AND the query has named entities AND those entities
        resolve to date-bearing passages. Bounded by ``max_add``.
        """
        if getattr(intent, "reasoning_intent", "factual_lookup") != "temporal_lookup":
            return passage_ids

        entity_texts = list(getattr(intent, "detected_entities", []) or [])
        if not entity_texts:
            return passage_ids

        # Resolve query entities → entity node IDs via the FTS name index.
        # Defensive: the canonical SQLite backend implements FTS; lighter
        # backends (InMemoryBackend) don't — no-op there rather than crash
        # (same getattr-guard pattern as get_edges_for_nodes).
        search_fts = getattr(self._storage, "search_nodes_fts", None)
        if not callable(search_fts):
            return passage_ids
        entity_node_ids: set[str] = set()
        for text in entity_texts:
            entity_node_ids.update(search_fts(text))
        if not entity_node_ids:
            return passage_ids

        # Date-bearing passages whose entities intersect the query entities.
        pem = self._storage.get_passage_entity_map()
        candidate_pids = [
            pid for pid, eids in pem.items()
            if entity_node_ids.intersection(eids)
        ]
        if not candidate_pids:
            return passage_ids

        batch = self._storage.get_passages_batch(candidate_pids)
        dated_pids = [
            pid for pid in candidate_pids
            if (p := batch.get(pid)) is not None and p.temporal_min is not None
        ]
        if not dated_pids:
            return passage_ids

        merged = list(passage_ids)
        seen = set(merged)
        added = 0
        for pid in dated_pids:
            if pid not in seen:
                merged.append(pid)
                seen.add(pid)
                added += 1
                if added >= max_add:
                    break

        if added:
            logger.info(
                "[temporal-lookup] query=%r resolved %d query entit(ies) → %d "
                "date-bearing passage(s) overcast via entity×date co-occurrence",
                query, len(entity_node_ids), added,
            )
        return merged

    def _expand_by_passage(
        self,
        scored_nodes: list,
        expansion_factor: float = DEFAULT_PASSAGE_EXPANSION_FACTOR,
    ) -> list:
        """
        Boost entities that share a source passage with a high-scoring entity.

        When entity A scores 0.85 and entity B (extracted from the same passage)
        scores 0.30, B's score is boosted to max(0.30, 0.85 * 0.7) = 0.595.
        This ensures ALL entities from a relevant passage survive Governor
        filtering, preserving the full passage context for the LLM.

        Why this matters: LOD_0 deduplication renders each source passage once,
        so surfacing even one entity from a passage causes the entire passage text
        to appear in context. But without expansion, co-entities from that same
        passage are dropped by the Governor — even though their LOD_0 content is
        already free (dedup). Expansion ensures the Governor accounts for passage
        coherence when allocating budget.

        The boost is MONOTONIC — it only raises scores, never lowers them.
        """
        passage_entity_map = self._storage.get_passage_entity_map()
        if not passage_entity_map:
            return scored_nodes  # no passages stored — skip expansion

        # entity_id → current composite score
        score_map: dict[str, float] = {sn.entity_id: sn.score for sn in scored_nodes}

        # entity_id → list of passage_ids it belongs to
        entity_to_pids: dict[str, list[str]] = {}
        for pid, eids in passage_entity_map.items():
            for eid in eids:
                entity_to_pids.setdefault(eid, []).append(pid)

        # For each entity, compute its boost from the max-scoring co-entity
        boosted: dict[str, float] = {}
        for sn in scored_nodes:
            for pid in entity_to_pids.get(sn.entity_id, []):
                passage_eids = passage_entity_map[pid]
                passage_max = max(
                    (score_map.get(eid, 0.0) for eid in passage_eids),
                    default=0.0,
                )
                boost = passage_max * expansion_factor
                boosted[sn.entity_id] = max(boosted.get(sn.entity_id, 0.0), boost)

        # Apply boosts (only increase — never decrease a score)
        for sn in scored_nodes:
            candidate = boosted.get(sn.entity_id, 0.0)
            if candidate > sn.score:
                sn.score = candidate

        # Re-sort descending: Governor's apply_budget() processes in score order
        scored_nodes.sort(key=lambda sn: sn.score, reverse=True)
        return scored_nodes

    async def _get_context_scored(
        self,
        query: str,
        distances: dict[str, int],
        profile: TokenProfile | None = None,
        debug: bool = False,
        intent=None,
    ) -> str:
        """Build context using the composite relevance scorer.

        Scoped scoring (Graph-per-Node, F5.9): only candidates from the tessellated
        passage set are scored. `distances` already contains only reachable nodes;
        nodes with distance 999 (unreachable, from _compute_distances default) are
        excluded so scoring stays bounded to the macro-search candidate pool.
        """
        query_emb = await self._embedder.embed(query)

        if intent is None:
            from tp_vrg.intent import classify_intent
            spacy_nlp = getattr(self._llm, '_spacy_nlp', None)
            gliner = getattr(self._llm, '_gliner', None)
            intent = classify_intent(query, spacy_nlp=spacy_nlp, gliner_model=gliner)

        # Scope nodes to the candidate set from macro search + BFS expansion.
        # Nodes with distance 999 are unreachable from the tessellated anchors —
        # exclude them so we score only entities from relevant passages plus their
        # immediate topological neighbours (which get low hop distances via BFS).
        candidate_ids = {eid for eid, d in distances.items() if d < 999}
        nodes = self._storage.get_nodes(list(candidate_ids)) if candidate_ids else self._storage.get_all_nodes()

        # Never compute betweenness in query path; cold backbone -> uniform fallback.
        centralities = self._storage.get_backbone()
        timestamps = self._storage.get_node_timestamps()

        # C.2 Traversal Modulation: derive scorer + governor overrides from intent
        modulation = intent.modulation_profile()
        weight_overrides = {
            k: v for k, v in modulation.items()
            if k.startswith("weight_")
        } or None
        max_nodes_override = int(modulation["max_nodes"]) if "max_nodes" in modulation else None
        mad_t_override = _intent_to_mad_t(intent)

        # F14: Gather passage temporal data for temporal_proximity scoring
        passage_temporals: dict[str, tuple[int, int]] = {}
        passage_entity_map_for_scorer: dict[str, list[str]] = {}
        if intent.temporal_reference_date is not None:
            pem = self._storage.get_passage_entity_map()
            # SQL-B1: batch fetch eliminates N+1 queries on temporal metadata
            _pids = list(pem.keys())
            _batch = self._storage.get_passages_batch(_pids)
            for pid, eids in pem.items():
                p = _batch.get(pid)
                if p and p.temporal_min is not None:
                    passage_temporals[pid] = (p.temporal_min, p.temporal_max)
                    passage_entity_map_for_scorer[pid] = eids

        t_score_start = time.perf_counter()
        scored_nodes = await self._scorer.score_nodes(
            query_emb, nodes, distances, centralities, self._embedder,
            timestamps=timestamps,
            weight_overrides=weight_overrides,
            temporal_ref_year=intent.temporal_reference_date,
            passage_temporals=passage_temporals,
            passage_entity_map=passage_entity_map_for_scorer,
            intent=intent,
        )
        t_score_end = time.perf_counter()

        # Passage expansion: boost co-entities from the same source passage
        # as high-scoring entities. Ensures full passage context survives
        # Governor filtering even when some entities score low individually.
        t_expand_start = time.perf_counter()
        scored_nodes = self._expand_by_passage(scored_nodes)
        t_expand_end = time.perf_counter()

        # R1/AIP-4 — optional LLM re-ranking (premium tier).
        # No-op by default (rerank_enabled=False in SpiralConfig).
        t_rerank_start = time.perf_counter()
        scored_nodes = await self._llm_rerank(query, scored_nodes, nodes, SpiralConfig())
        t_rerank_end = time.perf_counter()

        # ── C.4 Dress-Code Governor: admission gate ──────────────────
        # Filters scored_nodes by LOD_0 content relevance + topological
        # bridge role BEFORE Governor allocates budget.  Only admitted
        # nodes consume tokens.  Design: design/dress-code-governor.md
        from tp_vrg.admission import admission_gate
        from tp_vrg.compression import query_words as get_query_words

        qwords = get_query_words(query)
        pre_admission_candidates = len(scored_nodes)
        t_admission_start = time.perf_counter()

        # High-centrality entity NAMES for bridge detection (top 20%)
        high_cent_names: set[str] = set()
        if centralities:
            sorted_cent = sorted(centralities.values(), reverse=True)
            threshold_idx = max(0, min(len(sorted_cent) // 5, len(sorted_cent) - 1))
            cent_threshold = sorted_cent[threshold_idx]
            for eid, c in centralities.items():
                if c >= cent_threshold:
                    n = nodes.get(eid)
                    if n:
                        high_cent_names.add(n.name)

        # Build structural adjacency map for scored candidates only.
        # Uses bounded edge fetch when available (O(|candidates|) vs O(E)).
        scored_ids = {sn.entity_id for sn in scored_nodes}
        get_edges_bounded = getattr(self._storage, "get_edges_for_nodes", None)
        if callable(get_edges_bounded):
            candidate_edges = get_edges_bounded(scored_ids)
        else:
            candidate_edges = self._storage.get_all_edges()
        structural_adj: dict[str, set[str]] = {}
        for src, tgt, meta in candidate_edges:
            if meta.get("relation", "") in STRUCTURAL_RELATIONS:
                structural_adj.setdefault(src, set()).add(tgt)
                structural_adj.setdefault(tgt, set()).add(src)

        scored_nodes = admission_gate(
            scored_nodes, nodes, intent, qwords,
            high_cent_names, structural_adj,
        )
        t_admission_end = time.perf_counter()
        self._last_pass_1_survivors = {
            "admitted_entity_atoms": len(scored_nodes),
            "total_candidates": pre_admission_candidates,
            "candidate_passages": 0,
            "admitted_passages": 0,
        }
        # ── End C.4 ───────────────────────────────────────────────────

        edge_budget: int = 0
        boundary_budget: int = 0

        # Apply token governor if profile provided
        t_governor_start = time.perf_counter()
        if profile is not None:
            from tp_vrg.governor import TokenGovernor

            # Partition budget into pools: node (70%), edge (25%), boundary (5%)
            # by default. Bare TokenProfile(name=..., max_tokens=N) uses
            # (1.0/0.0/0.0) which sends full budget to nodes and leaves edge/
            # boundary rendering to fall back to Phase A count-based caps.
            node_budget, edge_budget, boundary_budget = TokenGovernor.compute_pools(profile)

            # Governor governs nodes only — create a node-scoped profile that
            # preserves LOD bias settings but applies only the node pool budget.
            node_profile = TokenProfile(
                name=profile.name,
                max_tokens=node_budget,
                description=profile.description,
                lod_0_bias=profile.lod_0_bias,
                lod_1_bias=profile.lod_1_bias,
                lod_2_bias=profile.lod_2_bias,
                max_nodes=profile.max_nodes,
            )

            governor = TokenGovernor()
            scored_nodes = governor.apply_budget(
                scored_nodes, node_profile, nodes,
                max_nodes_override=max_nodes_override,
                mad_t_override=mad_t_override,
            )
        t_governor_end = time.perf_counter()

        self._last_scored_nodes = scored_nodes
        self._last_intent = intent
        self._active_lods = {sn.entity_id: sn.assigned_lod for sn in scored_nodes}

        t_format_start = time.perf_counter()
        result, dedup = self._renderer.format_context(
            self._active_lods, distances, query, edge_budget, boundary_budget,
            scored_nodes=self._last_scored_nodes, intent=intent, debug=debug,
        )
        t_format_end = time.perf_counter()
        self._last_dedup_stats = dedup

        # F16: derive rendered passage IDs from the scored entities.
        # Known limitation (plan D7/G6): over-reports — cites all passages
        # containing any admitted entity, not just the passages that actually
        # contributed to the rendered context. Refinement deferred.
        if scored_nodes and hasattr(self._storage, "get_passages_for_entities"):
            try:
                entity_to_passages = self._storage.get_passages_for_entities(
                    [sn.entity_id for sn in scored_nodes]
                )
                seen: set[str] = set()
                ordered_pids: list[str] = []
                for sn in scored_nodes:
                    for p in entity_to_passages.get(sn.entity_id, []):
                        if p.passage_id not in seen:
                            ordered_pids.append(p.passage_id)
                            seen.add(p.passage_id)
                self._last_rendered_passage_ids = ordered_pids
            except Exception:
                # Non-fatal: the rendering itself succeeded, only the
                # citation capture failed. Leave the previous value intact.
                pass
        else:
            self._last_rendered_passage_ids = []

        self._last_pass_2_realized = {
            "entity_atoms": len(scored_nodes),
            "passages": len(self._last_rendered_passage_ids),
        }
        self._last_entity_render_stage_timing = {
            "pass_1_admission_s": round(t_admission_end - t_admission_start, 3),
            "pass_2_score_s": round(
                (t_score_end - t_score_start)
                + (t_expand_end - t_expand_start)
                + (t_rerank_end - t_rerank_start),
                3,
            ),
            "governor_s": round(t_governor_end - t_governor_start, 3),
            "format_context_s": round(t_format_end - t_format_start, 3),
        }

        # Rendering health: query term coverage (product metric, every query)
        self._last_query_term_coverage = self._compute_query_term_coverage(
            query, result
        )
        from tp_vrg.render_confidence import compute_render_confidence
        self._last_render_confidence = compute_render_confidence(result, query, intent, storage=self._storage)

        return result

    def _compute_query_term_coverage(self, query: str, rendered: str) -> float:
        """Fraction of query keywords (lemmatized + derivational bridge) in rendered context."""
        if not query or not rendered:
            return 0.0
        q_words = _extract_query_words(query)
        if not q_words:
            return 1.0
        from tp_vrg.compression import _lemmatize_words
        q_normalized = _lemmatize_words(q_words)
        ctx_words = frozenset(re.findall(r"\b\w+\b", rendered.lower()))
        ctx_normalized = _lemmatize_words(ctx_words)
        return len(q_normalized & ctx_normalized) / len(q_normalized)

    # -- Public API (PRD surface) --------------------------------------------

    async def ingest(
        self,
        text: str,
        source: str = "",
        event_timestamp: float | None = None,
        suppress_backbone: bool = False,
        normalization_cache: dict[str, str] | None = None,
    ) -> ExtractionResult:
        """Process and store new content. PRD-specified public API.

        Args:
            text: Raw text to ingest.
            source: Label describing the text source.
            event_timestamp: Unix timestamp of the described event (e.g.
                conversation create_time from a ChatGPT export).  Propagated
                to every extracted ``NodeData.event_timestamp``.
            suppress_backbone: If True, skip the post-ingest backbone
                recomputation.  Use during bulk imports to avoid O(V*E)
                recomputation after every item; call ``_schedule_backbone()``
                once after the batch completes instead.
        """
        return await self.add_memory(
            text, source=source, event_timestamp=event_timestamp,
            suppress_backbone=suppress_backbone,
            normalization_cache=normalization_cache,
        )

    async def render_context(
        self,
        query: str,
        profile: str | TokenProfile = "research",
        debug: bool = False,
    ) -> str:
        """
        Assemble LOD-aware context for an LLM prompt.

        Args:
            query: The user's question or instruction.
            profile: A profile name ("chat", "research", "code_simple",
                     "code_complex") or a TokenProfile instance.
            debug: If True, use the original developer-facing format with LOD
                   labels, node aliases, arrow notation, and ASCII separators.
                   If False (default), use the clean LLM-optimized format.
        """
        if isinstance(profile, str):
            profile = PROFILES[profile]
        return await self.get_context(query, profile=profile, debug=debug)

    # -- Persistence ----------------------------------------------------------

    def save(self, path: str | Path) -> None:
        """Save the graph via the storage backend."""
        self._storage.save(path)

    def load(self, path: str | Path) -> None:
        """Load a graph via the storage backend."""
        self._storage.load(path)

    def close(self) -> None:
        """Close owned storage resources when the engine lifecycle ends."""
        storage_close = getattr(self._storage, "close", None)
        if callable(storage_close):
            storage_close()
        provenance_close = getattr(self._provenance, "close", None)
        if callable(provenance_close):
            provenance_close()

    def _compute_distances(self, active_ids: set[str], max_hops: int = 5) -> dict[str, int]:
        """
        BFS from all active nodes simultaneously -> shortest hop distance
        to every reachable node.
        """
        distances: dict[str, int] = self._storage.bounded_neighborhood(
            list(active_ids), max_hops=max_hops
        )
        for nid in self._storage.get_node_index():
            distances.setdefault(nid, 999)

        return distances

    def _assign_lods(self, distances: dict[str, int]) -> dict[str, LODLevel]:
        """Map each node to its appropriate LOD based on hop distance (legacy)."""
        lods: dict[str, LODLevel] = {}
        for nid, dist in distances.items():
            for dist_range, lod in self.LOD_THRESHOLDS:
                if dist in dist_range:
                    lods[nid] = lod
                    break
        return lods

    # -- Rendering shims (delegate to ContextRenderer) -------------------------
    # These preserve the internal API for tests and legacy callers.

    def _format_context(
        self,
        lods: dict[str, LODLevel],
        distances: dict[str, int],
        query: str,
        edge_budget: int = 0,
        boundary_budget: int = 0,
        intent=None,
        debug: bool = False,
    ) -> str:
        """Shim: delegate to ContextRenderer.format_context()."""
        result, dedup = self._renderer.format_context(
            lods, distances, query, edge_budget, boundary_budget,
            scored_nodes=self._last_scored_nodes, intent=intent, debug=debug,
        )
        self._last_dedup_stats = dedup
        return result

    def _get_entity_full_text(
        self, entity_id: str, entity_name: str | None = None,
    ) -> str | None:
        """Shim: delegate to ContextRenderer.get_entity_full_text()."""
        return self._renderer.get_entity_full_text(entity_id, entity_name=entity_name)

    @staticmethod
    def _clean_entity_name(name: str) -> str:
        """Shim: delegate to ContextRenderer.clean_entity_name()."""
        return ContextRenderer.clean_entity_name(name)

    @staticmethod
    def _relation_to_phrase(relation: str) -> str:
        """Shim: delegate to ContextRenderer.relation_to_phrase()."""
        return ContextRenderer.relation_to_phrase(relation)

    # -- Retrieval shims (delegate to Retriever) --------------------------------
    # These preserve the internal API for tests and legacy callers.

    async def _macro_search(
        self, query: str, top_k: int = 5, intent: "Any" = None
    ) -> list[str]:
        """Shim: delegate to Retriever.macro_search()."""
        return await self._retriever.macro_search(query, top_k=top_k, intent=intent)

    def _micro_tessellate(self, passage_ids: list[str]) -> set[str]:
        """Shim: delegate to Retriever._micro_tessellate()."""
        return self._retriever._micro_tessellate(passage_ids)

    def _backbone_orbit(self, candidate_ids: set[str], config: SpiralConfig) -> set[str]:
        """Shim: delegate to Retriever._backbone_orbit()."""
        return self._retriever._backbone_orbit(candidate_ids, config)

    def _neighborhood_expand(
        self, candidate_ids: set[str], passage_ids_seen: set[str], config: SpiralConfig
    ) -> set[str]:
        """Shim: delegate to Retriever._neighborhood_expand()."""
        return self._retriever._neighborhood_expand(candidate_ids, passage_ids_seen, config)

    def _expand_macro_by_topology(
        self, passage_ids: list[str], relations: set[str], max_neighbors: int = 10
    ) -> list[str]:
        """Shim: delegate to Retriever._expand_macro_by_topology()."""
        return self._retriever._expand_macro_by_topology(passage_ids, relations, max_neighbors)

    def _expand_macro_by_entity_bridge(
        self,
        passage_ids: list[str],
        query: str = "",
        max_bridge_entities: int = 5,
        max_per_entity: int = 2,
        max_total: int = 10,
    ) -> list[str]:
        """Shim: delegate to Retriever._expand_macro_by_entity_bridge()."""
        return self._retriever._expand_macro_by_entity_bridge(
            passage_ids,
            query=query,
            max_bridge_entities=max_bridge_entities,
            max_per_entity=max_per_entity,
            max_total=max_total,
        )

    async def _ghost_node_candidates(
        self, query: str, intent: "Any" = None, max_hops: int = 2
    ) -> dict[str, float]:
        """Shim: delegate to Retriever._ghost_node_candidates()."""
        return await self._retriever._ghost_node_candidates(query, intent=intent, max_hops=max_hops)

    async def _identify_active_nodes(
        self, query: str, top_k: int = 5, spiral: SpiralConfig | None = None
    ) -> set[str]:
        """Shim: delegate to Retriever.identify_active_nodes()."""
        return await self._retriever.identify_active_nodes(
            query, top_k=top_k, spiral=spiral, intent=self._last_intent
        )

    def _identify_active_nodes_substring(self, query: str) -> set[str]:
        """Shim: delegate to Retriever.identify_active_nodes_substring()."""
        return self._retriever.identify_active_nodes_substring(query)

    # -- Visualisation --------------------------------------------------------

    def render_map(self, query: str | None = None) -> str:
        """
        Print an ASCII map of the graph showing LOD assignments.
        If a query is provided, it recomputes LODs first.
        """
        nodes = self._storage.get_all_nodes()
        edges = self._storage.get_all_edges()

        if query:
            active_ids = self._retriever.identify_active_nodes_substring(query)
            distances = self._compute_distances(active_ids) if active_ids else {}
            self._active_lods = self._assign_lods(distances) if distances else {}
        else:
            distances = {}

        lod_icons = {
            LODLevel.LOD_0: "[=]",
            LODLevel.LOD_1: "[~]",
            LODLevel.LOD_2: "[.]",
        }
        lod_labels = {
            LODLevel.LOD_0: "FULL DETAIL",
            LODLevel.LOD_1: "SUMMARY",
            LODLevel.LOD_2: "LABEL ONLY",
        }

        w = 70
        lines = [
            "",
            "+" + "=" * (w - 2) + "+",
            "|" + "LOD GRAPH MEMORY  -  TOPOLOGY MAP".center(w - 2) + "|",
        ]
        if query:
            q = query[:52] + "..." if len(query) > 52 else query
            lines.append("|" + f"  Query: {q}".ljust(w - 2) + "|")
        lines += [
            "+" + "=" * (w - 2) + "+",
            "|"
            + "  Legend:  [=] LOD_0 (full)  [~] LOD_1 (summary)  [.] LOD_2 (label)".ljust(
                w - 2
            )
            + "|",
            "+" + "-" * (w - 2) + "+",
        ]

        for lod in LODLevel:
            nodes_at = sorted(
                nid for nid, assigned in self._active_lods.items() if assigned == lod
            )
            if not nodes_at:
                continue

            icon = lod_icons[lod]
            dist_label = (
                "0-1" if lod == LODLevel.LOD_0 else "2" if lod == LODLevel.LOD_1 else "3+"
            )

            lines.append("|" + "".ljust(w - 2) + "|")
            lines.append(
                "|"
                + f"  {icon}  LOD_{lod.value} -- {lod_labels[lod]}  (distance {dist_label})".ljust(
                    w - 2
                )
                + "|"
            )
            lines.append("|" + ("  " + "-" * (w - 6)).ljust(w - 2) + "|")

            for nid in nodes_at:
                node = nodes.get(nid)
                if not node:
                    continue
                dist = distances.get(nid, "?")
                preview = node.get_at_lod(lod)[:40]
                col = f"    {node.name} (d={dist})"
                lines.append("|" + f"{col:<28}| {preview:<37}" + "|")

        lines += [
            "|" + "".ljust(w - 2) + "|",
            "+" + "-" * (w - 2) + "+",
            "|" + "  EDGES (always in memory -- the thin skeleton)".ljust(w - 2) + "|",
            "|" + ("  " + "-" * (w - 6)).ljust(w - 2) + "|",
        ]
        for u, v, data in edges:
            u_node = nodes.get(u)
            v_node = nodes.get(v)
            if u_node and v_node:
                e = f"    {u_node.name} --[{data['relation']}]--> {v_node.name}"
                lines.append("|" + e.ljust(w - 2) + "|")
        lines += ["+" + "=" * (w - 2) + "+", ""]

        output = "\n".join(lines)
        print(output)
        return output

    def stats(self) -> str:
        """Return a compact summary of graph size."""
        return (
            f"LODGraphMemory: {self.node_count} nodes, "
            f"{self.edge_count} edges, "
            f"{len(self._active_lods)} active LODs"
        )


def maybe_wrap_embedding_cache(
    embedding_provider: EmbeddingProvider,
    storage: StorageBackend,
) -> EmbeddingProvider:
    """Wrap provider with CachedEmbeddingProvider when TPVRG_EMBEDDING_CACHE=on."""
    mode = os.environ.get("TPVRG_EMBEDDING_CACHE", "on").strip().lower()
    if mode not in {"on", "off"}:
        mode = "on"
    if mode == "off":
        return embedding_provider
    conn = getattr(storage, "conn", None)
    if conn is None:
        return embedding_provider
    return CachedEmbeddingProvider(embedding_provider, EmbeddingCache(conn))
