"""
Ingester — all ingestion concerns extracted from LODGraphMemory.

Handles add_memory(), _chunk_and_ingest(), all stitching layers (sibling,
session, mention-order), temporal extraction, HyPE question generation,
and backbone scheduling.

The JanitorContext namedtuple provides duck-typed coupling to GraphJanitor
so that the Ingester can schedule background maintenance without importing
from engine.py (which would create a circular import).
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from dataclasses import dataclass
from typing import Any

from tp_vrg.compression import extract_entity_sentences
from tp_vrg.progress import progress
from tp_vrg.models import (
    CHUNK_MAX_CHARS,
    CONTEXTUAL_EMBEDDING as _CONTEXTUAL_EMBEDDING_DEFAULT,
    EdgeData,
    ExtractionResult,
    NodeData,
    SourcePassage,
)


@dataclass
class _JanitorContext:
    """Duck-typed context for GraphJanitor.

    Provides the same interface as LODGraphMemory (._storage, ._llm, ._embedder)
    without importing engine.py (which would create a circular import).
    """
    _storage: Any
    _llm: Any
    _embedder: Any


# ---------------------------------------------------------------------------
# Module-level helpers (moved from engine.py)
# ---------------------------------------------------------------------------

_MD_TABLE_SEP_RE = re.compile(r"^\|[\s:]*-+", re.MULTILINE)
_SESSION_DATE_RE = re.compile(
    r"\[Session date:\s*(\d{4}-\d{2}-\d{2})(?:[^\]]*)\]",
    re.IGNORECASE,
)


def _is_table_chunk(text: str) -> bool:
    """Detect markdown table chunks (pipe-delimited rows + separator row)."""
    lines = text.strip().split("\n")
    if len(lines) < 3:
        return False
    pipe_lines = sum(
        1 for line in lines
        if line.strip().startswith("|") and line.strip().endswith("|")
    )
    return pipe_lines >= 3 and bool(_MD_TABLE_SEP_RE.search(text))


def _has_headers(text: str) -> bool:
    """Check if text contains markdown headers (# ## ### etc.)."""
    header_pattern = r"^#{1,6}\s+.+$"
    return bool(re.search(header_pattern, text, re.MULTILINE))


def _should_chunk(text: str) -> bool:
    """Determine if text should be chunked: exceeds size, has headers, or contains tables."""
    return (
        len(text) > CHUNK_MAX_CHARS
        or _has_headers(text)
        or _is_table_chunk(text)
    )


def _session_date_header(text: str) -> str | None:
    m = _SESSION_DATE_RE.search(text)
    if not m:
        return None
    return f"[Session date: {m.group(1)}]"


def _carry_session_date_to_chunks(chunks: list[str], header: str | None) -> list[str]:
    if not header:
        return chunks
    return [
        chunk if _SESSION_DATE_RE.search(chunk) else f"{header}\n\n{chunk}"
        for chunk in chunks
    ]


# ---------------------------------------------------------------------------
# Ingester class
# ---------------------------------------------------------------------------

class Ingester:
    """Owns the ingestion pipeline: chunking, extraction, stitching, backbone."""

    def __init__(
        self,
        storage: Any,
        llm: Any,
        embedder: Any,
        normalizer: Any,
        coref_mode: str,
        water_config: Any,
        water_llm: Any,
        extraction_enricher: Any = None,
        contextual_embedding: bool = _CONTEXTUAL_EMBEDDING_DEFAULT,
        provenance: Any = None,
    ) -> None:
        self._storage = storage
        self._llm = llm
        self._embedder = embedder
        self._normalizer = normalizer
        self._coref_mode = coref_mode
        self._water_config = water_config
        self._water_llm = water_llm
        self._extraction_enricher = extraction_enricher
        self._contextual_embedding: bool = contextual_embedding
        self._provenance = provenance  # ProvenanceBackend | None — F16 audit trail
        from tp_vrg.models import SENTENCE_EMBEDDINGS_ENABLED
        self._sentence_embeddings_enabled: bool = SENTENCE_EMBEDDINGS_ENABLED
        self._janitor_running: bool = False

    # -- Backbone scheduling --------------------------------------------------

    async def _schedule_backbone(self) -> None:
        """Schedule background maintenance caches update after a committed batch.

        No-op for InMemoryBackend (no calculate_backbone support).
        Debounced: if a backbone task is already running, skip silently.
        Never raises — backbone failure must not affect the caller.
        """
        if not hasattr(self._storage, "calculate_backbone"):
            return
        if self._janitor_running:
            return
        self._janitor_running = True
        asyncio.create_task(self._run_backbone_bg())

    async def _run_backbone_bg(self) -> None:
        """Background task: compute backbone, merge, then rebuild neighborhood cache."""
        try:
            from tp_vrg.janitor import GraphJanitor
            ctx = _JanitorContext(
                _storage=self._storage,
                _llm=self._llm,
                _embedder=self._embedder,
            )
            janitor = GraphJanitor(ctx)
            await janitor.run_backbone()
            # After backbone completes, scan for merge candidates
            await self._run_merge_bg(janitor)
            # Rebuild semantic neighborhood cache once final topology stabilizes
            await janitor.run_neighborhood_cache()
        except Exception:
            pass  # Background — never crash the caller
        finally:
            self._janitor_running = False

    async def _run_merge_bg(self, janitor: Any = None) -> None:
        """Background task: merge duplicate entities if any candidates found.

        Runs automatically after backbone completes. If merge modifies the
        graph, re-runs backbone to update centrality for the new topology.
        """
        try:
            if janitor is None:
                from tp_vrg.janitor import GraphJanitor
                ctx = _JanitorContext(
                    _storage=self._storage,
                    _llm=self._llm,
                    _embedder=self._embedder,
                )
                janitor = GraphJanitor(ctx)
            report = await janitor.merge()
            # If merge changed the graph, recompute backbone
            if report.nodes_modified > 0:
                await janitor.run_backbone()
        except Exception:
            pass  # Background — never crash the caller

    # -- Stitching layers -----------------------------------------------------

    def _stitch_sibling_edges(
        self,
        chunks: list[str],
        chunk_entity_ids: list[list[str]],
        event_timestamp: float | None = None,
    ) -> list[EdgeData]:
        """Create structural _follows edges between adjacent chunk entity groups.

        Layer 2 of the Stitching Protocol: restores cross-chunk linear flow topology
        that is destroyed when a document is split into independently-extracted chunks.

        For each pair of adjacent chunks (K, K+1):
        - tail_ids = last 3 entity IDs of chunk K (by extraction order ≈ left-to-right)
        - head_ids = first 3 entity IDs of chunk K+1 (by extraction order)
        - Creates _follows edges from each tail to each head (up to 9 edges per boundary)

        Weight 0.5: lighter than semantic edges (1.0) — infrastructure, not content.
        Dedup is handled by SQLite PRIMARY KEY (source, target, relation): only one
        _follows edge can exist between any entity pair, preventing duplicates.

        Returns the list of structural EdgeData created (empty if only one chunk).
        """
        structural_edges: list[EdgeData] = []

        for k in range(len(chunks) - 1):
            tail_ids = chunk_entity_ids[k][-3:]     # last ≤3 entities of chunk K
            head_ids = chunk_entity_ids[k + 1][:3]  # first ≤3 entities of chunk K+1

            for tail in tail_ids:
                for head in head_ids:
                    if tail == head:
                        continue  # skip self-loops (same entity in adjacent chunks)
                    edge = EdgeData(
                        source=tail,
                        target=head,
                        relation="_follows",
                        weight=0.5,
                    )
                    self._storage.upsert_edge(edge)
                    structural_edges.append(edge)

        return structural_edges

    def _stitch_session_edges(
        self,
        passage_ids: list[str],
    ) -> list[EdgeData]:
        """Create structural _session_follows edges between adjacent session passages.

        Layer 0 of the Stitching Protocol: restores inter-session linear flow topology.
        For each pair of adjacent sessions (N, N+1):
        - tail_ids = last 3 entity IDs from session N's passage (by extraction order)
        - head_ids = first 3 entity IDs from session N+1's passage
        - Creates _session_follows edges from each tail to each head

        Uses entity_ids from SourcePassage — these are in extraction order (chunk 0 first,
        chunk N last), so last 3 = last entities from last chunk, first 3 = first entities
        from first chunk.

        Returns the list of structural EdgeData created.
        """
        structural_edges: list[EdgeData] = []

        # SQL-B1: batch fetch eliminates N+1 queries on stitch path
        _batch = self._storage.get_passages_batch(passage_ids)
        for k in range(len(passage_ids) - 1):
            prev_passage = _batch.get(passage_ids[k])
            next_passage = _batch.get(passage_ids[k + 1])

            if prev_passage is None or next_passage is None:
                continue  # passage not found (shouldn't happen, but be defensive)
            if not prev_passage.entity_ids or not next_passage.entity_ids:
                continue  # no entities to stitch

            tail_ids = prev_passage.entity_ids[-3:]   # last ≤3 entities of session N
            head_ids = next_passage.entity_ids[:3]    # first ≤3 entities of session N+1

            for tail in tail_ids:
                for head in head_ids:
                    if tail == head:
                        continue  # skip self-loops
                    edge = EdgeData(
                        source=tail,
                        target=head,
                        relation="_session_follows",
                        weight=0.5,
                    )
                    self._storage.upsert_edge(edge)
                    structural_edges.append(edge)

        return structural_edges

    def stitch_sequence(self, passage_ids: list[str]) -> list[EdgeData]:
        """Create _session_follows edges between an ordered sequence of session passages.

        Public API for Layer 0 inter-session stitching. Call after ingesting a batch
        of related documents (book chapters, ChatGPT conversations, article series)
        to create structural edges that encode the sequence ordering.

        Args:
            passage_ids: Session passage IDs in chronological/sequence order.
                Obtain from ExtractionResult.session_passage_id after each ingest() call.

        Returns:
            List of structural EdgeData created between adjacent sessions.
        """
        if len(passage_ids) < 2:
            return []
        return self._stitch_session_edges(passage_ids)

    def _stitch_mention_order(self, entity_ids: list[str]) -> list[EdgeData]:
        """Create _mentioned_before edges between consecutive entities (Layer 2b).

        Preserves intra-chunk mention ordering. Entity IDs arrive in extraction
        order (GLiNER sorts by char offset; LLM extraction preserves document
        order). For each adjacent pair: creates a _mentioned_before structural
        edge. Weight 0.5 (infrastructure, same as all structural edges).

        Self-loops skipped (same entity appearing consecutively).
        Returns the list of structural EdgeData created.
        """
        structural_edges: list[EdgeData] = []
        for k in range(len(entity_ids) - 1):
            src, tgt = entity_ids[k], entity_ids[k + 1]
            if src == tgt:
                continue
            edge = EdgeData(
                source=src,
                target=tgt,
                relation="_mentioned_before",
                weight=0.5,
            )
            self._storage.upsert_edge(edge)
            structural_edges.append(edge)
        return structural_edges

    # -- Temporal extraction --------------------------------------------------

    def _apply_temporal_extraction(self, passage: SourcePassage) -> None:
        """Extract temporal info from passage and create TEMPORAL_ANCHOR nodes + edges.

        F14 Temporal Reasoning:
        1. Extract years from passage raw_text (regex)
        2. Set passage.temporal_min / temporal_max
        3. Create TEMPORAL_ANCHOR nodes (category="temporal_anchor", id="t_YYYY")
        4. Create covers_period edges (passage → anchor, structural)
        5. Create occurred_at edges (entity → anchor, semantic — participates in centrality)

        Called from both _chunk_and_ingest() and add_memory().
        """
        from tp_vrg.temporal import extract_temporal, make_temporal_anchor_id

        temporal = extract_temporal(passage.raw_text)
        if temporal.temporal_min is None:
            return  # no dates found

        # Update passage temporal range and re-upsert
        passage.temporal_min = temporal.temporal_min
        passage.temporal_max = temporal.temporal_max
        self._storage.upsert_passage(passage)

        # Create TEMPORAL_ANCHOR nodes + covers_period edges
        for year in temporal.anchor_years:
            anchor_id = make_temporal_anchor_id(year)
            anchor_node = NodeData(
                entity_id=anchor_id,
                name=str(year),
                category="temporal_anchor",
                lod_0=str(year),
                lod_1=str(year),
                lod_2=str(year),
                refined=True,  # No Janitor polish needed — LOD_1 is definitive
                # No embedding — TEMPORAL_ANCHOR nodes are found via edge traversal,
                # not cosine similarity. V2 can add contextual LOD_1 summaries.
            )
            self._storage.upsert_node(anchor_node)

            # covers_period: passage → anchor (structural — in STRUCTURAL_RELATIONS)
            self._storage.upsert_edge(EdgeData(
                source=passage.passage_id,
                target=anchor_id,
                relation="_covers_period",
                weight=0.5,
            ))

        # occurred_at: entity → anchor (semantic — NOT in STRUCTURAL_RELATIONS)
        # V1: link ALL passage entities to ALL dates found in that passage.
        # This is approximate but acceptable for single-chunk passages.
        for year in temporal.anchor_years:
            anchor_id = make_temporal_anchor_id(year)
            for eid in passage.entity_ids:
                self._storage.upsert_edge(EdgeData(
                    source=eid,
                    target=anchor_id,
                    relation="occurred_at",
                    weight=0.6,
                ))

    # -- Embedding helpers ----------------------------------------------------

    async def _embed_batch_safe(self, texts: list[str]) -> list[Any]:
        """Embed a batch with provider fallback to serial embed() if needed."""
        if not texts:
            return []
        embed_batch = getattr(self._embedder, "embed_batch", None)
        if callable(embed_batch):
            try:
                return await embed_batch(texts)
            except NotImplementedError:
                pass
        return [await self._embedder.embed(text) for text in texts]

    # -- HyPE question generation ---------------------------------------------

    @staticmethod
    def _generate_hype_questions(
        nodes: list, edges: list, entity_name_map: dict[str, str]
    ) -> list[str]:
        """
        HyPE-lite: generate anticipatory questions from entities and edges.

        Two tiers of question generation:
        1. Topology-aware templates (I4 MVP): read edge types, entity categories,
           and multi-hop paths to generate questions targeting the retrieval
           scenarios where TP-VRG's topology matters most.
        2. Generic fallback: "What is {name}?" and "Tell me about {name}."
           Added only if topology templates produce fewer than 3 questions.

        These questions are embedded at ingestion time and searched at query time,
        giving question→question similarity (better match than question→passage).
        """
        from tp_vrg.hype_templates import generate_topology_questions

        # I4: Topology-aware templates (reads edge types, categories, multi-hop paths)
        questions = generate_topology_questions(
            nodes, edges, entity_name_map, max_questions=15,
        )

        # Generic fallback: ensure minimum coverage if topology templates are sparse
        if len(questions) < 3:
            for node in nodes:
                name = node.name
                questions.append(f"What is {name}?")
                questions.append(f"Tell me about {name}.")
            for edge in edges:
                src = entity_name_map.get(edge.source, edge.source)
                tgt = entity_name_map.get(edge.target, edge.target)
                questions.append(f"What is the relationship between {src} and {tgt}?")

        return questions

    # -- Core ingestion methods -----------------------------------------------

    async def _chunk_and_ingest(
        self,
        raw_text: str,
        source: str = "",
        event_timestamp: float | None = None,
        suppress_backbone: bool = False,
        normalization_cache: dict[str, str] | None = None,
        concurrent_chunks: int = 1,
    ) -> ExtractionResult:
        """
        Chunk large or header-containing documents into passage-level micro-graphs.

        Graph-per-Node architecture (F5.9):
        - Each chunk is extracted independently — no parent extraction call
        - Each entity gets its OWN LOD_1 from its chunk's extraction (not inherited)
        - Each chunk becomes a SourcePassage with its own embedding (chunk-level precision)
        - A session-level passage is also created with a full-text embedding (macro-graph node)
          linking to all entities for broad macro search
        - No parent/child node hierarchy — passage→entity links replace it

        Cost: N API calls (one per chunk), NOT N+1 (old: parent + N chunks).
        """
        from datetime import datetime, timezone

        from tp_vrg.chunker import DeterministicChunker

        concurrent_chunks = max(1, int(concurrent_chunks))

        # Layer 1: Defined-term expansion (before coref, before chunking).
        # Resolves explicit definition sites ("the Company" → "SkyWater Technology, Inc.")
        # so every chunk contains explicit entity names. Near-100% accurate, <100ms.
        from tp_vrg.defined_terms import preprocess_defined_terms
        raw_text, dt_stats = preprocess_defined_terms(raw_text)
        if dt_stats.get("terms_found", 0) > 0:
            import logging
            logging.getLogger(__name__).info(
                "Defined terms: %d terms, %d replacements",
                dt_stats["terms_found"], dt_stats["replacements"],
            )
        self._last_defined_term_stats = dt_stats

        raw_text, pre_resolved_coref = await asyncio.to_thread(
            self._pre_resolve_coref_before_chunking,
            raw_text,
        )
        session_date_header = _session_date_header(raw_text)
        chunks = _carry_session_date_to_chunks(
            DeterministicChunker.chunk(raw_text),
            session_date_header,
        )
        now_iso = datetime.now(timezone.utc).isoformat()

        # Orphan chunk diagnostic: find chunks with nominal references
        # ("the Company," "he/she") but no proper-noun entity anchor.
        # Stores individual orphan locations for future Layer 2 LLM resolution.
        import re as _re
        _nominal_re = _re.compile(r'\bthe\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b')
        _proper_re = _re.compile(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,}\b')
        _pronoun_re = _re.compile(r'\b(?:he|she|his|her|him|they|their)\b', _re.IGNORECASE)
        orphan_details: list[dict] = []
        for _ci, _chunk in enumerate(chunks):
            nominals_found = _nominal_re.findall(_chunk)
            pronouns_found = _pronoun_re.findall(_chunk)
            has_proper = bool(_proper_re.search(_chunk))
            if (nominals_found or pronouns_found) and not has_proper:
                orphan_details.append({
                    "chunk_index": _ci,
                    "nominals": nominals_found,
                    "pronouns": pronouns_found,
                    "snippet": _chunk[:150].replace("\n", " "),
                })
        self._last_orphan_stats = {
            "total_chunks": len(chunks),
            "orphan_chunks": len(orphan_details),
            "orphan_pct": round(100 * len(orphan_details) / max(len(chunks), 1), 1),
            "orphans": orphan_details,
        }

        all_results = ExtractionResult()
        all_entity_ids: list[str] = []
        per_chunk_entity_ids: list[list[str]] = []  # for Layer 2 sibling stitching
        chunk_passage_payloads: list[tuple[str, str, list[str]]] = []
        existing_categories = (
            normalization_cache if normalization_cache is not None
            else self._storage.get_node_index()
        )
        existing_ids = set(existing_categories.keys())

        baseline_existing_categories = dict(existing_categories)
        baseline_existing_ids = set(existing_ids)

        llm_prior_mode = getattr(self._llm, "_coref_mode", None)
        if pre_resolved_coref and llm_prior_mode is not None and hasattr(self._llm, "set_coref_mode"):
            self._llm.set_coref_mode("none")

        # F16 provenance: precompute source_id + content_hash for this ingest.
        # Deterministic so re-ingesting the same text is idempotent.
        content_hash = hashlib.sha256(raw_text.encode()).hexdigest()
        source_id = f"s_{hashlib.sha256((source + content_hash).encode()).hexdigest()[:16]}"
        source_byte_size = len(raw_text.encode())

        # Begin atomic batch — all storage writes are held in a single SQLite
        # transaction and committed only after the session passage is stored.
        # On any failure the entire ingestion is rolled back so the graph is
        # never left in a half-written state.
        self._storage.begin_batch()
        if self._provenance is not None:
            self._provenance.begin_batch()
        try:
            chunk_results: list[tuple[int, str, ExtractionResult]] = []

            async def process_chunk(chunk_idx: int, chunk_text: str) -> tuple[int, str, ExtractionResult]:
                if _is_table_chunk(chunk_text):
                    header_line = chunk_text.strip().split("\n")[0]
                    header_cells = [c.strip() for c in header_line.split("|") if c.strip()]
                    table_name = "Table: " + " | ".join(header_cells[:4])
                    from tp_vrg.normalizer import normalize_entity_id

                    table_id = normalize_entity_id(table_name)
                    table_node = NodeData(
                        entity_id=table_id,
                        name=table_name,
                        category="table",
                        lod_0=chunk_text,
                        lod_1=f"Data table with columns: {', '.join(header_cells)}",
                        lod_2=table_name,
                    )
                    chunk_result = ExtractionResult(nodes=[table_node], edges=[])
                else:
                    chunk_result = await self._llm.extract_entities_and_edges(chunk_text)
                    if (
                        self._water_config.enabled
                        and self._water_config.extraction_enrichment
                        and self._extraction_enricher is not None
                        and self._water_llm is not None
                    ):
                        chunk_result = await self._extraction_enricher.enrich(
                            chunk_text, chunk_result, self._water_llm
                        )

                if concurrent_chunks == 1:
                    norm_existing_ids = existing_ids
                    norm_existing_categories = existing_categories
                else:
                    norm_existing_ids = baseline_existing_ids
                    norm_existing_categories = baseline_existing_categories

                chunk_norm = self._normalizer.normalize(
                    chunk_result,
                    existing_ids=norm_existing_ids,
                    existing_categories=norm_existing_categories,
                )
                chunk_result = chunk_norm.result

                # B1 ablation (2026-04-22): TPVRG_ENTITY_EMBEDDING=off skips
                # per-entity embedding writes at ingest time. Query-path reads
                # degrade gracefully: retrieval.py entity-bridge + flat fallback
                # skip their vector_search calls; scoring.py keeps its existing
                # `node.embedding is None → sem=0.0` branch, so the S signal
                # drops out of the composite score. The other 5 signals (T/D/R/P/TP)
                # continue to operate on the same candidate pool reached via
                # passage-level retrieval + topology expansion.
                from tp_vrg.models import ENTITY_EMBEDDINGS_ENABLED
                if ENTITY_EMBEDDINGS_ENABLED:
                    needs_embeddings = [n for n in chunk_result.nodes if n.embedding is None]
                    if needs_embeddings:
                        vectors = await self._embed_batch_safe([n.lod_1 for n in needs_embeddings])
                        for node, emb in zip(needs_embeddings, vectors, strict=False):
                            node.embedding = emb.tolist()

                return chunk_idx, chunk_text, chunk_result

            n_chunks = len(chunks)
            progress.emit("ingest", current=0, total=n_chunks,
                          message=f"Extracting entities from {n_chunks} chunks...")

            if concurrent_chunks == 1:
                for chunk_idx, chunk_text in enumerate(chunks):
                    progress.emit("extract", current=chunk_idx + 1, total=n_chunks,
                                  message=f"Chunk {chunk_idx + 1}/{n_chunks}")
                    chunk_results.append(await process_chunk(chunk_idx, chunk_text))
            else:
                sem = asyncio.Semaphore(concurrent_chunks)

                async def process_chunk_bounded(chunk_idx: int, chunk_text: str):
                    async with sem:
                        return await process_chunk(chunk_idx, chunk_text)

                chunk_results = list(
                    await asyncio.gather(
                        *[
                            process_chunk_bounded(chunk_idx, chunk_text)
                            for chunk_idx, chunk_text in enumerate(chunks)
                        ]
                    )
                )

            for chunk_idx, chunk_text, chunk_result in sorted(chunk_results, key=lambda x: x[0]):
                chunk_entity_ids: list[str] = []
                for node in chunk_result.nodes:
                    # F5.1: entity-specific LOD_0 — sentences mentioning this
                    # entity + 1 context-window neighbor, not full chunk text.
                    # Improves admission gate precision and governor budget estimation.
                    node.lod_0 = extract_entity_sentences(chunk_text, node.name)
                    node.refined = True
                    if event_timestamp is not None:
                        node.event_timestamp = event_timestamp
                    self._storage.upsert_node(node)
                    existing_ids.add(node.entity_id)
                    existing_categories[node.entity_id] = node.category
                    chunk_entity_ids.append(node.entity_id)

                self._storage.upsert_edges_bulk(chunk_result.edges)

                chunk_embed_text = f"From: {source}\n\n{chunk_text}" if self._contextual_embedding else chunk_text
                chunk_passage_id = f"p_{hashlib.sha256(chunk_text.encode()).hexdigest()[:16]}"
                chunk_passage_payloads.append((chunk_passage_id, chunk_embed_text, chunk_entity_ids))

                if chunk_result.nodes:
                    entity_name_map = {n.entity_id: n.name for n in chunk_result.nodes}
                    questions = self._generate_hype_questions(chunk_result.nodes, chunk_result.edges, entity_name_map)
                    if questions:
                        q_vecs = await self._embed_batch_safe(questions)
                        self._storage.save_question_embeddings_bulk(chunk_passage_id, q_vecs)

                all_entity_ids.extend(chunk_entity_ids)
                per_chunk_entity_ids.append(chunk_entity_ids)

                if len(chunk_entity_ids) > 1:
                    mention_edges = self._stitch_mention_order(chunk_entity_ids)
                    all_results.edges.extend(mention_edges)

                all_results.nodes.extend(chunk_result.nodes)
                all_results.edges.extend(chunk_result.edges)

            progress.emit("extract", current=n_chunks, total=n_chunks,
                          message=f"Extraction complete — {len(all_entity_ids)} entities found")

            # Batch-embed chunk passages and write them in source order.
            if chunk_passage_payloads:
                progress.emit("embed", current=0, total=len(chunk_passage_payloads),
                              message="Embedding passages...")
                chunk_vectors = await self._embed_batch_safe(
                    [payload[1] for payload in chunk_passage_payloads]
                )
                # F16 provenance: one source row per ingestion, written once
                # before segment writes begin.
                if self._provenance is not None:
                    self._provenance.upsert_source(
                        source_id=source_id,
                        source_label=source,
                        content_hash=content_hash,
                        byte_size=source_byte_size,
                    )
                for idx, (passage_id, _embed_text, entity_ids) in enumerate(chunk_passage_payloads):
                    chunk_passage = SourcePassage(
                        passage_id=passage_id,
                        raw_text=chunks[idx],
                        source_id=source_id,
                        source_label=f"{source}[chunk-{idx}]",
                        entity_ids=entity_ids,
                        ingested_at=now_iso,
                        embedding=chunk_vectors[idx].tolist(),
                    )
                    self._storage.upsert_passage(chunk_passage)
                    # F16 provenance: chunk segment (seq 1..N)
                    if self._provenance is not None:
                        self._provenance.upsert_segment(
                            segment_id=passage_id,
                            source_id=source_id,
                            seq=idx + 1,
                            text=chunks[idx],
                        )

                    # Sentence-level embeddings for fine-grained macro retrieval.
                    # Each sentence gets its own embedding so macro_search can find
                    # passages by matching individual sentences, not just the chunk average.
                    from tp_vrg.compression import split_sentences
                    chunk_sents = split_sentences(chunks[idx])
                    if self._sentence_embeddings_enabled:
                        if len(chunk_sents) > 1:
                            sent_vecs = await self._embed_batch_safe(chunk_sents)
                            self._storage.save_sentence_embeddings_bulk(
                                passage_id, sent_vecs
                            )

                    # Fiber-basis: pre-compute per-sentence NER/POS/lemma profiles.
                    if chunk_sents:
                        from tp_vrg.render_confidence import compute_sentence_profiles
                        profiles = compute_sentence_profiles(chunk_sents)
                        self._storage.save_sentence_profiles_bulk(passage_id, profiles)

            # --- Layer 2 Stitching: connect adjacent chunks with _follows edges ---
            # Creates structural edges between tail entities of chunk K and head
            # entities of chunk K+1, restoring cross-chunk linear flow topology.
            # No-op for single-chunk documents (per_chunk_entity_ids has length 1).
            if len(per_chunk_entity_ids) > 1:
                structural_edges = self._stitch_sibling_edges(
                    chunks, per_chunk_entity_ids, event_timestamp
                )
                all_results.edges.extend(structural_edges)

            # Session-level passage: full-text embedding for macro search breadth.
            # Links to ALL entities extracted across all chunks — the macro-graph node
            # that Stage 1 search finds to identify which session is relevant.
            # "ps_" prefix (passage-session) guarantees no collision with chunk passage IDs
            # ("p_" prefix), even when there is only one chunk whose text == raw_text.
            session_embed_text = (
                f"From: {source}\n\n{raw_text}" if self._contextual_embedding else raw_text
            )
            session_emb = await self._embedder.embed(session_embed_text)
            session_passage_id = f"ps_{hashlib.sha256(raw_text.encode()).hexdigest()[:16]}"
            session_passage = SourcePassage(
                passage_id=session_passage_id,
                raw_text=raw_text,
                source_id=source_id,
                source_label=source,
                entity_ids=list(dict.fromkeys(all_entity_ids)),  # deduplicated, order preserved
                ingested_at=now_iso,
                embedding=session_emb.tolist(),
            )
            self._storage.upsert_passage(session_passage)

            # F16 provenance: session segment (seq=0, the whole document).
            # If chunk_passage_payloads was empty (rare), ensure the source row
            # still exists before writing the session segment.
            if self._provenance is not None:
                if not chunk_passage_payloads:
                    self._provenance.upsert_source(
                        source_id=source_id,
                        source_label=source,
                        content_hash=content_hash,
                        byte_size=source_byte_size,
                    )
                self._provenance.upsert_segment(
                    segment_id=session_passage_id,
                    source_id=source_id,
                    seq=0,
                    text=raw_text,
                )

            # Sentence-level embeddings for session passage
            from tp_vrg.compression import split_sentences
            session_sents = split_sentences(raw_text)
            if self._sentence_embeddings_enabled:
                if len(session_sents) > 1:
                    sent_vecs = await self._embed_batch_safe(session_sents)
                    self._storage.save_sentence_embeddings_bulk(
                        session_passage_id, sent_vecs
                    )

            # Fiber-basis: pre-compute per-sentence NER/POS/lemma profiles.
            if session_sents:
                from tp_vrg.render_confidence import compute_sentence_profiles
                profiles = compute_sentence_profiles(session_sents)
                self._storage.save_sentence_profiles_bulk(session_passage_id, profiles)

            # --- F14: Temporal extraction + TEMPORAL_ANCHOR nodes ---
            self._apply_temporal_extraction(session_passage)

            self._storage.commit_batch()
            progress.emit("ingest", current=n_chunks, total=n_chunks,
                          message=f"Ingestion complete — {len(all_results.nodes)} nodes, {len(all_results.edges)} edges")

            # F16 provenance: graph is now durable; try to commit provenance.
            # If the provenance commit fails (disk full, lock, corruption),
            # log loudly but do NOT roll back graph.db — graph is authoritative.
            # The next ingest can still re-derive provenance from graph.db content.
            if self._provenance is not None:
                try:
                    self._provenance.commit_batch()
                except Exception as exc:
                    import logging
                    logging.getLogger(__name__).warning(
                        "F16: provenance commit failed after graph commit "
                        "(source=%s, source_id=%s): %s",
                        source, source_id, exc,
                    )
                    try:
                        self._provenance.rollback_batch()
                    except Exception:
                        pass
                    all_results.provenance_write_failed = True

            if not suppress_backbone:
                await self._schedule_backbone()
        except Exception:
            self._storage.rollback_batch()
            if self._provenance is not None:
                try:
                    self._provenance.rollback_batch()
                except Exception:
                    pass
            raise
        finally:
            if pre_resolved_coref and llm_prior_mode is not None and hasattr(self._llm, "set_coref_mode"):
                self._llm.set_coref_mode(llm_prior_mode)

        all_results.session_passage_id = session_passage_id
        return all_results

    async def add_memory(
        self,
        raw_text: str,
        source: str = "",
        event_timestamp: float | None = None,
        suppress_backbone: bool = False,
        normalization_cache: dict[str, str] | None = None,
        concurrent_chunks: int = 1,
    ) -> ExtractionResult:
        """
        Ingest raw text: extract entities and edges via the LLM,
        then merge them into the graph.

        If text exceeds CHUNK_MAX_CHARS or contains markdown headers,
        automatically chunks it and creates parent-child node relationships
        (Atomic LOD0 mode).

        Otherwise, treats the full raw_text as a single node's LOD_0 data,
        which is also stored as a SourcePassage for provenance tracking.
        """
        # Strip YAML frontmatter (Obsidian clippings, markdown metadata).
        # Frontmatter wastes token budget in LOD_0 and confuses extraction.
        raw_text = re.sub(r"\A---\n.*?\n---\n*", "", raw_text, count=1, flags=re.DOTALL)

        # Reset per-document coref context so cross-session salience doesn't
        # pollute pronoun resolution. Cross-CHUNK carry-over (within one ingest
        # call via _chunk_and_ingest) is preserved; cross-SESSION carry-over
        # (between separate ingest() calls) is intentionally discarded.
        if self._coref_mode != "none" and hasattr(self._llm, '_coref_context'):
            self._llm._coref_context = None

        # Check if chunking is needed (Atomic LOD0 mode)
        if _should_chunk(raw_text):
            return await self._chunk_and_ingest(
                raw_text,
                source,
                event_timestamp,
                suppress_backbone,
                normalization_cache=normalization_cache,
                concurrent_chunks=concurrent_chunks,
            )

        # Standard path: single extraction for short text (no chunking needed)
        from datetime import datetime, timezone

        result = await self._llm.extract_entities_and_edges(raw_text)

        # Build lightweight normalization index (ID + category only, no embeddings)
        # instead of full get_all_nodes() materialisation inside normalize().
        existing_categories = (
            normalization_cache if normalization_cache is not None
            else self._storage.get_node_index()
        )
        existing_ids = set(existing_categories.keys())

        # Normalize entity IDs before storage
        norm_result = self._normalizer.normalize(
            result,
            existing_ids=existing_ids,
            existing_categories=existing_categories,
        )
        result = norm_result.result

        # F16 provenance: precompute source_id + content_hash.
        content_hash = hashlib.sha256(raw_text.encode()).hexdigest()
        source_id = f"s_{hashlib.sha256((source + content_hash).encode()).hexdigest()[:16]}"
        source_byte_size = len(raw_text.encode())

        # Begin atomic batch — all storage writes held in one transaction.
        # Rolled back automatically on any failure.
        self._storage.begin_batch()
        if self._provenance is not None:
            self._provenance.begin_batch()
        try:
            # Batch-embed all nodes that need embeddings.
            # B1 ablation (2026-04-22): gated on TPVRG_ENTITY_EMBEDDING (default on).
            from tp_vrg.models import ENTITY_EMBEDDINGS_ENABLED
            if ENTITY_EMBEDDINGS_ENABLED:
                needs_embeddings = [n for n in result.nodes if n.embedding is None]
                if needs_embeddings:
                    vectors = await self._embed_batch_safe(
                        [n.lod_1 for n in needs_embeddings]
                    )
                    for node, emb in zip(needs_embeddings, vectors, strict=False):
                        node.embedding = emb.tolist()

            for node in result.nodes:
                # F5.1: entity-specific LOD_0 — sentences mentioning this
                # entity + 1 context-window neighbor, not full raw text.
                node.lod_0 = extract_entity_sentences(raw_text, node.name)
                # lod_1 is the entity's own summary from extraction (correct as-is)
                node.refined = True  # Own LOD_1 from extraction, no Janitor refinement needed
                if event_timestamp is not None:
                    node.event_timestamp = event_timestamp
                self._storage.upsert_node(node)
                existing_categories[node.entity_id] = node.category

            self._storage.upsert_edges_bulk(result.edges)

            # --- Layer 2b: mention-order edges for single-node path ---
            single_entity_ids = [n.entity_id for n in result.nodes]
            if len(single_entity_ids) > 1:
                mention_edges = self._stitch_mention_order(single_entity_ids)
                result.edges.extend(mention_edges)

            # Store passage with embedding — passage is the macro-graph node for Stage 1 search.
            # Embedding computed from raw_text for broad semantic coverage.
            passage_emb = await self._embedder.embed(raw_text)
            passage_id = f"p_{hashlib.sha256(raw_text.encode()).hexdigest()[:16]}"
            passage = SourcePassage(
                passage_id=passage_id,
                raw_text=raw_text,
                source_id=source_id,
                source_label=source,
                entity_ids=[n.entity_id for n in result.nodes],
                ingested_at=datetime.now(timezone.utc).isoformat(),
                embedding=passage_emb.tolist(),
            )
            self._storage.upsert_passage(passage)

            # F16 provenance: single source + single segment (seq=0)
            if self._provenance is not None:
                self._provenance.upsert_source(
                    source_id=source_id,
                    source_label=source,
                    content_hash=content_hash,
                    byte_size=source_byte_size,
                )
                self._provenance.upsert_segment(
                    segment_id=passage_id,
                    source_id=source_id,
                    seq=0,
                    text=raw_text,
                )

            # Sentence-level embeddings for single-text passage
            from tp_vrg.compression import split_sentences
            sents = split_sentences(raw_text)
            if self._sentence_embeddings_enabled:
                if len(sents) > 1:
                    sent_vecs = await self._embed_batch_safe(sents)
                    self._storage.save_sentence_embeddings_bulk(passage_id, sent_vecs)

            # Fiber-basis: pre-compute per-sentence NER/POS/lemma profiles.
            # Eliminates the 2.75M-char spaCy crash at query-time render confidence.
            if sents:
                from tp_vrg.render_confidence import compute_sentence_profiles
                profiles = compute_sentence_profiles(sents)
                self._storage.save_sentence_profiles_bulk(passage_id, profiles)

            # --- F14: Temporal extraction + TEMPORAL_ANCHOR nodes ---
            self._apply_temporal_extraction(passage)

            self._storage.commit_batch()

            # F16 provenance: graph is durable; try to commit provenance.
            if self._provenance is not None:
                try:
                    self._provenance.commit_batch()
                except Exception as exc:
                    import logging
                    logging.getLogger(__name__).warning(
                        "F16: provenance commit failed after graph commit "
                        "(source=%s, source_id=%s): %s",
                        source, source_id, exc,
                    )
                    try:
                        self._provenance.rollback_batch()
                    except Exception:
                        pass
                    result.provenance_write_failed = True

            if not suppress_backbone:
                await self._schedule_backbone()
        except Exception:
            self._storage.rollback_batch()
            if self._provenance is not None:
                try:
                    self._provenance.rollback_batch()
                except Exception:
                    pass
            raise

        result.session_passage_id = passage_id
        return result

    def _pre_resolve_coref_before_chunking(self, raw_text: str) -> tuple[str, bool]:
        """Run pre-chunk coref on full document or sliding windows."""
        if self._coref_mode == "none":
            return raw_text, False

        try:
            from tp_vrg.coref import detect_turn_boundaries
            from tp_vrg.llm_service import get_coref_resolver
        except Exception:
            return raw_text, False

        resolver = get_coref_resolver(self._coref_mode)
        if resolver is None:
            return raw_text, False

        nlp = getattr(self._llm, "_nlp", None)
        token_spans = list(re.finditer(r"\S+\s*", raw_text))
        token_count = len(token_spans)
        if token_count == 0:
            return raw_text, False

        max_tokens = 4096
        window_tokens = 3500
        overlap_tokens = 500

        def _resolve(text: str, prior_context: dict | None):
            turns = detect_turn_boundaries(text) if self._coref_mode in ("rules", "sieve") else None
            return resolver(text, nlp, prior_context=prior_context, turn_boundaries=turns if turns else None)

        try:
            if token_count <= max_tokens:
                resolved_text, _ctx = _resolve(raw_text, None)
                return resolved_text, True

            step = max(1, window_tokens - overlap_tokens)
            windows: list[tuple[int, int]] = []
            start = 0
            while start < token_count:
                end = min(token_count, start + window_tokens)
                windows.append((start, end))
                if end >= token_count:
                    break
                start += step

            prior_context: dict | None = None
            resolved_tokens: list[str] = []
            for idx, (start_idx, end_idx) in enumerate(windows):
                start_char = token_spans[start_idx].start()
                end_char = token_spans[end_idx - 1].end()
                window_text = raw_text[start_char:end_char]
                resolved_window, prior_context = _resolve(window_text, prior_context)
                window_parts = re.findall(r"\S+\s*", resolved_window)
                if idx == 0:
                    resolved_tokens = window_parts
                    continue

                max_overlap = min(overlap_tokens * 2, len(resolved_tokens), len(window_parts))
                overlap_len = 0
                for k in range(max_overlap, 0, -1):
                    if resolved_tokens[-k:] == window_parts[:k]:
                        overlap_len = k
                        break
                resolved_tokens.extend(window_parts[overlap_len:])

            merged_text = "".join(resolved_tokens).strip()
            if merged_text:
                return merged_text, True
            return raw_text, False
        except Exception:
            return raw_text, False
