"""
Retriever — all retrieval concerns extracted from LODGraphMemory.

Handles macro search (passage vector + HyPE + FTS5), topology expansion (SP-6),
micro tessellation, backbone orbit (SP-2), neighborhood expansion (SP-1),
ghost node candidates, and the identify_active_nodes orchestration.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from typing import Any

from tp_vrg.extraction.stopword_filter import filter_neighbor_relations_for_retrieval
from tp_vrg.models import (
    CROSS_ENCODER_TOP_K,
    MACRO_TOP_K,
    MACRO_TOPOLOGY,
    MACRO_TOPO_MAX_NEIGHBORS,
    RRF_FUSION,
    RRF_K,
    RRF_SPECIFICITY_EMB_SUPPRESS,
    RRF_SPECIFICITY_FTS5_BOOST,
    SP7_ASSET_CASCADE,
    SP7_CASCADE_SIBLINGS_PER_ASSET,
    SP7_ENABLED,
    SP7_MAX_BRIDGE_ENTITIES,
    SP7_MAX_PASSAGES_PER_ENTITY,
    SP7_MAX_TOTAL_ADDITIONS,
    SIMILARITY_EDGE_MAX_PER_SOURCE,
    SIMILARITY_EDGE_MAX_TOTAL_ADDITIONS,
    SIMILARITY_EDGE_TRAVERSAL_WEIGHT,
    SpiralConfig,
    WaterConfig,
)
from tp_vrg.storage import StorageBackend
from tp_vrg.storage.similarity_edges import similarity_edges_enabled

logger = logging.getLogger(__name__)

# NER-weighted entity mention boost (SOTA steal from SmartSearch/Midbrain).
# Proper nouns (PERSON, ORG, GPE, etc.) get 3x weight, common nouns 1.5x,
# numbers/dates 2x. Flat regex fallback when spaCy unavailable.
ENTITY_MENTION_BOOST_BASE: float = float(os.environ.get("TPVRG_ENTITY_BOOST_BASE", "0.05"))
ENTITY_MENTION_BOOST_NER: float = float(
    os.environ.get("TPVRG_ENTITY_BOOST_NER", "0.15")
)  # named entities (3x base)
ENTITY_MENTION_BOOST_NUM: float = float(
    os.environ.get("TPVRG_ENTITY_BOOST_NUM", "0.10")
)  # numbers, dates (2x base)
ENTITY_MENTION_BOOST_NOUN: float = float(
    os.environ.get("TPVRG_ENTITY_BOOST_NOUN", "0.075")
)  # common nouns (1.5x base)

# spaCy NER labels considered "named entities" for boost purposes
_NER_LABELS = frozenset({"PERSON", "ORG", "GPE", "LOC", "FAC", "EVENT", "PRODUCT",
                          "WORK_OF_ART", "LAW", "NORP", "LANGUAGE"})
_NUM_LABELS = frozenset({"DATE", "TIME", "MONEY", "QUANTITY", "CARDINAL", "ORDINAL", "PERCENT"})

# SP-8 reading-order fiber: cheap markdown-table heuristic. Mirrors the shape
# of compression._is_table_text but kept local so retrieval has no dependency
# on compression's module-level private helpers. A table chunk is three or
# more pipe-delimited lines with a separator row (``| --- |``). When SP-8
# sees a table chunk it expands window to 2 to recover legend + data rows
# that straddled the chunk boundary.
_TABLE_SEP_RE = re.compile(r"^\|[\s:]*-+[\s:|-]*\|", re.MULTILINE)


def _is_table_chunk(text: str) -> bool:
    if not text or "|" not in text:
        return False
    lines = text.strip().split("\n")
    if len(lines) < 3:
        return False
    pipe_lines = sum(
        1 for line in lines
        if line.strip().startswith("|") and line.strip().endswith("|")
    )
    return pipe_lines >= 3 and bool(_TABLE_SEP_RE.search(text))


class Retriever:
    """Retrieves candidate entity IDs relevant to a query via two-stage search."""

    def __init__(
        self,
        storage: StorageBackend,
        embedder: Any,
        use_semantic_scoring: bool = True,
        water_config: WaterConfig | None = None,
        water_llm: Any = None,
        query_expander: Any = None,
        passage_reranker: Any = None,
        cross_encoder_reranker: Any = None,
        provenance: Any = None,
    ) -> None:
        self._storage = storage
        self._embedder = embedder
        self._use_semantic_scoring = use_semantic_scoring
        self._water_config: WaterConfig = water_config or WaterConfig()
        self._water_llm = water_llm
        self._query_expander = query_expander
        self._passage_reranker = passage_reranker
        self._cross_encoder_reranker = cross_encoder_reranker
        self._provenance = provenance  # F16 ProvenanceBackend | None — enables SP-8
        self._last_macro_timing: dict[str, float] = {}
        self._last_asset_overlay_trace: dict[str, Any] = {}
        self._asset_backfill_lock = threading.Lock()  # single-flight lazy Asset backfill
        self._last_sentence_peer_entry_points: list[dict[str, Any]] = []
        self._spacy_nlp: Any = None  # cached spaCy model for NER-weighted boost

    @staticmethod
    def _asset_overlay_mode() -> str:
        raw = (
            os.environ.get("TPVRG_ASSET_OVERLAY_MODE")
            or os.environ.get("TPVRG_ASSET_OVERLAY")
            or "passive"
        )
        mode = raw.strip().lower().replace("_", "-")
        if mode in {"active", "overlay-active"}:
            return "active"
        if mode in {"baseline", "baseline-no-overlay", "off", "false", "0", "none"}:
            return "baseline-no-overlay"
        return "overlay-passive"

    def _ensure_asset_backfill(self) -> None:
        """Lazy on-query Asset backfill (`[ASSET-OVERLAY-BACKFILL-WIRING]`).

        Populate ``passages.asset_id`` on the first query after an ingest so the
        active overlay has Assets to aggregate. Idempotent + single-flight; the
        ``pending()`` fast-path means steady-state queries (nothing to backfill)
        never touch the lock. Doctrine A: reads warm derived state. This is the
        production caller the dormancy probe flagged missing for
        ``backfill_assets_by_source_document``.
        """
        backfill = getattr(self._storage, "backfill_assets_by_source_document", None)
        pending = getattr(self._storage, "asset_backfill_pending", None)
        if not callable(backfill) or not callable(pending):
            return
        try:
            if not pending():
                return
            with self._asset_backfill_lock:
                if pending():  # re-check under lock — single-flight
                    backfill()
        except Exception:
            logger.warning(
                "Lazy Asset backfill failed; overlay continues passage-only.",
                exc_info=True,
            )

    def _apply_asset_overlay(
        self,
        score_map: dict[str, float],
        *,
        top_k: int,
    ) -> dict[str, float]:
        """Apply opt-in Asset-aware candidate aggregation to macro passage scores."""
        mode = self._asset_overlay_mode()
        trace: dict[str, Any] = {
            "mode": mode,
            "active": mode == "active",
            "candidate_count": len(score_map),
            "asset_scores": {},
            "added_passages": [],
            "asset_misses": [],
            "sentence_peer_entry_points": list(self._last_sentence_peer_entry_points),
        }
        if mode != "active" or not score_map:
            self._last_asset_overlay_trace = trace
            return score_map

        self._ensure_asset_backfill()

        get_assets = getattr(self._storage, "get_asset_ids_for_passages", None)
        get_siblings = getattr(self._storage, "get_passage_ids_for_assets", None)
        if get_assets is None or get_siblings is None:
            trace["asset_misses"].append(
                {"reason": "asset_lookup_unavailable", "passage_count": len(score_map)}
            )
            logger.warning(
                "Asset overlay miss: storage does not expose Asset lookup methods; "
                "continuing with passage-only candidates."
            )
            self._last_asset_overlay_trace = trace
            return score_map

        candidate_ids = list(score_map.keys())
        asset_by_pid = get_assets(candidate_ids)
        missing = [pid for pid in candidate_ids if not asset_by_pid.get(pid)]
        if missing:
            trace["asset_misses"].append(
                {
                    "reason": "missing_asset_id",
                    "passage_count": len(missing),
                    "examples": missing[:5],
                }
            )
            logger.warning(
                "Asset overlay miss: %d candidate passages lacked asset_id; "
                "continuing with explicit passage-only fallback for those passages; examples=%s",
                len(missing),
                missing[:5],
            )

        grouped_scores: dict[str, list[float]] = {}
        for passage_id, score in score_map.items():
            asset_id = asset_by_pid.get(passage_id)
            if asset_id:
                grouped_scores.setdefault(asset_id, []).append(score)

        asset_scores: dict[str, float] = {}
        for asset_id, scores in grouped_scores.items():
            ranked_scores = sorted(scores, reverse=True)
            asset_scores[asset_id] = 0.7 * ranked_scores[0] + 0.3 * sum(ranked_scores[:3])
        trace["asset_scores"] = {
            asset_id: round(score, 6)
            for asset_id, score in sorted(
                asset_scores.items(), key=lambda item: (-item[1], item[0])
            )
        }

        ranked_assets = [
            asset_id
            for asset_id, _score in sorted(
                asset_scores.items(), key=lambda item: (-item[1], item[0])
            )
        ][:top_k]
        sibling_map = get_siblings(ranked_assets, limit_per_asset=3)
        updated_scores = dict(score_map)
        for asset_id in ranked_assets:
            sibling_score = asset_scores[asset_id] * 0.85
            for passage_id in sibling_map.get(asset_id, []):
                current = updated_scores.get(passage_id, -999.0)
                if sibling_score > current:
                    updated_scores[passage_id] = sibling_score
                    trace["added_passages"].append(
                        {
                            "passage_id": passage_id,
                            "asset_id": asset_id,
                            "score": round(sibling_score, 6),
                        }
                    )

        self._last_asset_overlay_trace = trace
        return updated_scores

    def _ensure_spacy(self) -> bool:
        """Ensure spaCy model is loaded. Returns True if available."""
        if self._spacy_nlp is not None:
            return True
        try:
            import spacy
            try:
                self._spacy_nlp = spacy.load("en_core_web_sm", disable=["parser"])
            except OSError:
                self._spacy_nlp = spacy.blank("en")
            self._spacy_nlp.max_length = 5_000_000
            return True
        except ImportError:
            return False

    def _expand_query_for_fts(self, query: str, doc: Any = None) -> str:
        """Expand query with lemmas and NER terms for FTS5 lexical search.

        Returns an OR-joined FTS5 query that includes:
        - Original content words (nouns, verbs, adjectives, proper nouns)
        - Their lemmatized forms (catches morphological variants)
        - Named entity phrases (multi-word names as quoted phrases)

        Args:
            doc: Pre-parsed spaCy Doc. If None, falls back to raw query.
        """
        if doc is None:
            return query

        terms: set[str] = set()

        # Content words: lemmas of nouns, verbs, adjectives, proper nouns
        for token in doc:
            if token.is_stop or token.is_punct or len(token.text) < 2:
                continue
            if token.pos_ in ("NOUN", "VERB", "ADJ", "PROPN"):
                terms.add(token.text.lower())
                if token.lemma_.lower() != token.text.lower():
                    terms.add(token.lemma_.lower())

        # Named entities as quoted phrases (multi-word NER matches)
        # SOTA: strip FTS5 special chars to prevent syntax errors (UX-14)
        import re
        _fts5_special = re.compile(r'[()":*^{}]')
        _fts5_keywords = {"AND", "OR", "NOT", "NEAR"}
        for ent in doc.ents:
            text = ent.text.strip()
            if len(text) >= 2:
                safe = _fts5_special.sub("", text.lower()).strip()
                # Remove FTS5 keyword tokens to prevent operator injection
                safe_words = [w for w in safe.split() if w.upper() not in _fts5_keywords and len(w) >= 2]
                safe = " ".join(safe_words)
                if not safe:
                    continue
                if " " in safe:
                    terms.add(f'"{safe}"')  # FTS5 phrase match
                else:
                    terms.add(safe)

        if not terms:
            return query

        # Join with OR for FTS5 (broader recall than the raw query)
        return " OR ".join(sorted(terms))

    async def macro_search(
        self,
        query: str,
        top_k: int = MACRO_TOP_K,
        intent: Any = None,
    ) -> list[str]:
        """
        Stage 1 — Macro search: find the most relevant passages by cosine similarity.

        Combines two signals:
        1. Passage embeddings (raw_text → query similarity)
        2. HyPE-lite question embeddings (pre-generated questions → query similarity)

        Results from both channels are merged into a single ranked score map
        (max similarity per passage). Question-embedding matches compensate for
        vocabulary mismatch between passage text and query phrasing.

        F14: When intent has temporal_reference_date, over-fetches and post-filters
        by temporal overlap. Passages without temporal metadata pass through (don't
        lose coverage for non-temporal passages).
        """
        t_start = time.perf_counter()
        self._last_sentence_peer_entry_points = []
        self._last_asset_overlay_trace = {
            "mode": self._asset_overlay_mode(),
            "active": False,
            "candidate_count": 0,
            "asset_scores": {},
            "added_passages": [],
            "asset_misses": [],
            "sentence_peer_entry_points": [],
        }

        # Parse query with spaCy ONCE — reused by FTS expansion and NER boost.
        query_doc = None
        if self._ensure_spacy():
            query_doc = self._spacy_nlp(query)

        # F14: over-fetch when temporal filtering will shrink the result set
        temporal_ref = intent.temporal_reference_date if intent else None
        effective_top_k = top_k * 2 if temporal_ref is not None else top_k

        # SOTA: BM25-first gate — adopted from QMD (Lütke/Shopify, 2026)
        # Probe FTS5 BEFORE embedding. If BM25 returns enough strong matches,
        # skip the expensive embed + vector search entirely.
        # QMD + SmartSearch showed 98.9% of entity-heavy queries resolve via
        # substring match alone. Gate saves ~25-100ms per skipped query.
        fts_query = query
        fts_pids: list[str] = []
        if hasattr(self._storage, "search_passages_fts"):
            # SOTA: Channel-specific lex expansion for FTS5 — adopted from QMD (Lütke/Shopify, 2026)
            fts_query = self._expand_query_for_fts(query, doc=query_doc)
            fts_pids = self._storage.search_passages_fts(fts_query, top_k=effective_top_k)
        t_fts = time.perf_counter()

        # Gate: if FTS5 returned enough results AND query has high specificity
        # (entity-heavy lookup, not a broad conceptual question), skip vector search.
        specificity = getattr(intent, "specificity", 0.0) if intent else 0.0
        bm25_gate_hit = (
            len(fts_pids) >= top_k
            and specificity >= 0.6
        )

        if bm25_gate_hit:
            # Fast path: FTS5 only, no embedding needed
            query_emb = None
            t_embed = t_fts
            passage_results = []
            t_passage_vec = t_fts
            question_results = []
            t_question_vec = t_fts
            sentence_results = []
            t_sentence_vec = t_fts
        else:
            # Full path: embed + all channels
            query_emb = await self._embedder.embed(query)
            t_embed = time.perf_counter()

            passage_results = self._storage.passage_vector_search(query_emb, top_k=effective_top_k)
            t_passage_vec = time.perf_counter()
            question_results = self._storage.question_vector_search(query_emb, top_k=effective_top_k)
            t_question_vec = time.perf_counter()
            # Channel 3 (sentence-level): fine-grained topic matching
            from tp_vrg.models import SENTENCE_EMBEDDINGS_ENABLED
            if SENTENCE_EMBEDDINGS_ENABLED:
                detailed_sentence_search = getattr(
                    self._storage, "sentence_vector_search_detailed", None
                )
                if detailed_sentence_search is not None:
                    detailed_sentence_results = detailed_sentence_search(
                        query_emb, top_k=effective_top_k
                    )
                    best_sentence_by_passage: dict[str, tuple[int, float]] = {}
                    for passage_id, sentence_idx, sim in detailed_sentence_results:
                        previous = best_sentence_by_passage.get(passage_id)
                        if previous is None or sim > previous[1]:
                            best_sentence_by_passage[passage_id] = (sentence_idx, sim)
                    sentence_results = sorted(
                        [
                            (passage_id, sim)
                            for passage_id, (_sentence_idx, sim) in best_sentence_by_passage.items()
                        ],
                        key=lambda item: item[1],
                        reverse=True,
                    )[:effective_top_k]
                    self._last_sentence_peer_entry_points = [
                        {
                            "passage_id": passage_id,
                            "sentence_idx": sentence_idx,
                            "line_range": [sentence_idx + 1, sentence_idx + 1],
                            "score": round(sim, 6),
                        }
                        for passage_id, sentence_idx, sim in detailed_sentence_results
                        if sim >= 0.1
                    ][:effective_top_k]
                else:
                    sentence_results = self._storage.sentence_vector_search(
                        query_emb, top_k=effective_top_k
                    )
            else:
                sentence_results = []
            t_sentence_vec = time.perf_counter()

        threshold = 0.1

        if RRF_FUSION:
            # SOTA: Reciprocal Rank Fusion — adopted from Cormack, Clarke & Buettcher, 2009
            rrf_k = RRF_K
            ranks: dict[str, dict[str, int]] = {}

            # Channel 1: passage embeddings (sorted by similarity desc)
            passage_ranked = [(pid, sim) for pid, sim in passage_results if sim >= threshold]
            passage_ranked.sort(key=lambda x: -x[1])
            ranks["passage_emb"] = {pid: rank for rank, (pid, _) in enumerate(passage_ranked)}

            # Channel 2: HyPE question embeddings
            question_ranked = [(pid, sim) for pid, sim in question_results if sim >= threshold]
            question_ranked.sort(key=lambda x: -x[1])
            ranks["question_emb"] = {pid: rank for rank, (pid, _) in enumerate(question_ranked)}

            # Channel 3: Sentence-level embeddings (fine-grained topic matching)
            if sentence_results:
                sentence_ranked = [(pid, sim) for pid, sim in sentence_results if sim >= threshold]
                sentence_ranked.sort(key=lambda x: -x[1])
                ranks["sentence_emb"] = {pid: rank for rank, (pid, _) in enumerate(sentence_ranked)}

            # Channel 4: FTS5 lexical
            if fts_pids:
                ranks["fts5"] = {pid: rank for rank, pid in enumerate(fts_pids)}

            # Manifold-driven RRF: channel weights modulated by query specificity.
            # High specificity → FTS5 dominates (exact keyword match for lookups).
            # Low specificity → equal weights (semantic similarity for broad queries).
            specificity = getattr(intent, "specificity", 0.0) if intent else 0.0
            w_emb = max(0.1, 1.0 - RRF_SPECIFICITY_EMB_SUPPRESS * specificity)
            w_sent = max(0.1, 1.0 - 0.5 * specificity)  # sentence: slightly less suppressed than passage
            w_hype = 1.0  # HyPE compensates vocab mismatch in both cases
            w_fts = 1.0 + RRF_SPECIFICITY_FTS5_BOOST * specificity
            channel_weights = {
                "passage_emb": w_emb,
                "sentence_emb": w_sent,
                "question_emb": w_hype,
                "fts5": w_fts,
            }

            # Fuse: weighted sum of reciprocal ranks across channels
            all_pids: set[str] = set()
            for channel_ranks in ranks.values():
                all_pids.update(channel_ranks.keys())

            score_map: dict[str, float] = {}
            for pid in all_pids:
                rrf = 0.0
                for channel_name, channel_ranks in ranks.items():
                    if pid in channel_ranks:
                        w = channel_weights.get(channel_name, 1.0)
                        rrf += w / (rrf_k + channel_ranks[pid])
                score_map[pid] = rrf
        else:
            # --- Legacy max-merge (pre-RRF) ---
            score_map: dict[str, float] = {}
            for pid, sim in passage_results:
                if sim >= threshold:
                    score_map[pid] = max(score_map.get(pid, -999.0), sim)
            for pid, sim in question_results:
                if sim >= threshold:
                    score_map[pid] = max(score_map.get(pid, -999.0), sim)
            for pid, sim in sentence_results:
                if sim >= threshold:
                    score_map[pid] = max(score_map.get(pid, -999.0), sim)
            for pid in fts_pids:
                if pid not in score_map:
                    score_map[pid] = threshold

        t_fusion = time.perf_counter()
        score_map = self._apply_asset_overlay(score_map, top_k=effective_top_k)
        t_asset_overlay = time.perf_counter()

        if not score_map:
            self._last_macro_timing = {
                "embed_query": round(t_embed - t_start, 3),
                "passage_vector_search": round(t_passage_vec - t_embed, 3),
                "question_vector_search": round(t_question_vec - t_passage_vec, 3),
                "sentence_vector_search": round(t_sentence_vec - t_question_vec, 3),
                "fts_search": round(t_fts - t_sentence_vec, 3),
                "fusion": round(t_fusion - t_fts, 3),
                "asset_overlay": round(t_asset_overlay - t_fusion, 3),
                "sentence_peer_entry_points": len(self._last_sentence_peer_entry_points),
                "asset_overlay_trace": self._last_asset_overlay_trace,
                "entity_mention_boost": 0.0,
                "sort_rank": 0.0,
                "temporal_filter": 0.0,
                "total": round(t_asset_overlay - t_start, 3),
            }
            return []

        # 3) NER-weighted entity-mention boost (SOTA steal: SmartSearch/Midbrain).
        # Extract query terms with spaCy NER labels. Named entities get 3x boost,
        # numbers/dates 2x, common nouns 1.5x. Falls back to regex if spaCy unavailable.
        # OPTIMIZED: batch-fetch raw_text for all candidate passages in one query.
        query_weighted_terms: list[tuple[str, float]] = []  # (term, boost_value)
        if query_doc is not None:
            doc = query_doc
            seen_terms: set[str] = set()
            # Named entities first (highest boost)
            for ent in doc.ents:
                term = ent.text.strip().lower()
                if term and len(term) >= 2 and term not in seen_terms:
                    seen_terms.add(term)
                    if ent.label_ in _NER_LABELS:
                        query_weighted_terms.append((term, ENTITY_MENTION_BOOST_NER))
                    elif ent.label_ in _NUM_LABELS:
                        query_weighted_terms.append((term, ENTITY_MENTION_BOOST_NUM))
            # Proper nouns not caught by NER
            for token in doc:
                term = token.text.strip().lower()
                if token.pos_ == "PROPN" and term not in seen_terms and len(term) >= 2:
                    seen_terms.add(term)
                    query_weighted_terms.append((term, ENTITY_MENTION_BOOST_NER))
                elif token.pos_ == "NOUN" and term not in seen_terms and len(term) >= 3:
                    seen_terms.add(term)
                    query_weighted_terms.append((term, ENTITY_MENTION_BOOST_NOUN))

        # Fallback: regex-based capitalized term extraction (pre-steal behavior)
        if not query_weighted_terms:
            for m in re.findall(
                r"\b(?:[A-Z][a-z]+|[A-Z]{2,})(?:\s+(?:[A-Z][a-z]+|[A-Z]{2,}))*\b",
                query,
            ):
                term = m.strip().lower()
                if term and len(term) >= 2:
                    query_weighted_terms.append((term, ENTITY_MENTION_BOOST_NER))

        # Batch-load raw_text for entity mention check
        _passage_text_cache: dict[str, str] = {}
        if query_weighted_terms and score_map:
            pids_to_check = list(score_map.keys())
            _batch_fn = getattr(self._storage, "get_passages_raw_text_batch", None)
            if _batch_fn is not None:
                _passage_text_cache = _batch_fn(pids_to_check)
            else:
                for pid in pids_to_check:
                    p = self._storage.get_passage(pid)
                    if p:
                        _passage_text_cache[pid] = p.raw_text or ""

        ranked: list[tuple[str, float, float]] = []
        for pid, base_score in score_map.items():
            boost = 0.0
            if query_weighted_terms:
                raw = _passage_text_cache.get(pid, "").lower()
                for term, term_boost in query_weighted_terms:
                    if term in raw:
                        boost = max(boost, term_boost)  # take highest matching boost
            composite = base_score + boost
            ranked.append((pid, composite, base_score))
        t_entity_boost = time.perf_counter()

        # Stable deterministic order: composite desc, then base desc, then passage_id asc.
        ranked.sort(key=lambda x: (-x[1], -x[2], x[0]))
        t_sort = time.perf_counter()

        # F14: temporal post-filter — keep ranked order while filtering by overlap.
        if temporal_ref is not None:
            window = 10  # ±10 years
            # SQL-B1: batch fetch eliminates N+1 queries
            _ranked_pids = [pid for pid, _, _ in ranked]
            _batch = self._storage.get_passages_batch(_ranked_pids)
            temporal_ranked: list[str] = []
            for pid, _, _ in ranked:
                p = _batch.get(pid)
                if p and p.temporal_min is not None:
                    if p.temporal_min <= temporal_ref + window and p.temporal_max >= temporal_ref - window:
                        temporal_ranked.append(pid)
                else:
                    # No temporal metadata — include anyway (don't lose coverage)
                    temporal_ranked.append(pid)
            t_temporal = time.perf_counter()
            self._last_macro_timing = {
                "embed_query": round(t_embed - t_start, 3),
                "passage_vector_search": round(t_passage_vec - t_embed, 3),
                "question_vector_search": round(t_question_vec - t_passage_vec, 3),
                "sentence_vector_search": round(t_sentence_vec - t_question_vec, 3),
                "fts_search": round(t_fts - t_sentence_vec, 3),
                "fusion": round(t_fusion - t_fts, 3),
                "asset_overlay": round(t_asset_overlay - t_fusion, 3),
                "sentence_peer_entry_points": len(self._last_sentence_peer_entry_points),
                "asset_overlay_trace": self._last_asset_overlay_trace,
                "entity_mention_boost": round(t_entity_boost - t_asset_overlay, 3),
                "sort_rank": round(t_sort - t_entity_boost, 3),
                "temporal_filter": round(t_temporal - t_sort, 3),
                "total": round(t_temporal - t_start, 3),
            }
            return temporal_ranked[:top_k]
        self._last_macro_timing = {
            "embed_query": round(t_embed - t_start, 3),
            "passage_vector_search": round(t_passage_vec - t_embed, 3),
            "question_vector_search": round(t_question_vec - t_passage_vec, 3),
            "sentence_vector_search": round(t_sentence_vec - t_question_vec, 3),
            "fts_search": round(t_fts - t_sentence_vec, 3),
            "fusion": round(t_fusion - t_fts, 3),
            "asset_overlay": round(t_asset_overlay - t_fusion, 3),
            "sentence_peer_entry_points": len(self._last_sentence_peer_entry_points),
            "asset_overlay_trace": self._last_asset_overlay_trace,
            "entity_mention_boost": round(t_entity_boost - t_asset_overlay, 3),
            "sort_rank": round(t_sort - t_entity_boost, 3),
            "temporal_filter": 0.0,
            "total": round(t_sort - t_start, 3),
        }
        return [pid for pid, _, _ in ranked[:top_k]]

    def _expand_macro_by_topology(
        self,
        passage_ids: list[str],
        relations: set[str],
        max_neighbors: int = MACRO_TOPO_MAX_NEIGHBORS,
    ) -> list[str]:
        """SP-6: Expand macro search results via passage-level topology.

        Follows structural edges (_follows, _session_follows) from entities
        in selected passages to entities in adjacent passages. Adds adjacent
        passages to the candidate pool for micro tessellation.

        Args:
            passage_ids: Ordered passage IDs from macro search.
            relations: Set of edge relation types to follow (e.g., {"_session_follows"}).
            max_neighbors: Maximum number of new passages to add.

        Returns:
            Original passage_ids + up to max_neighbors topologically adjacent passages.
        """
        if not passage_ids or not relations:
            return passage_ids

        selected = set(passage_ids)
        neighbors: list[str] = []
        seen_neighbors: set[str] = set()

        get_nbr = getattr(self._storage, "get_neighbors_with_relations", None)
        if get_nbr is None:
            return passage_ids

        # SQL-B1: batch fetch eliminates N+1 queries
        _batch_sp6 = self._storage.get_passages_batch(passage_ids)
        for pid in passage_ids:
            passage = _batch_sp6.get(pid)
            if not passage:
                continue
            eids = passage.entity_ids if isinstance(passage.entity_ids, list) else []
            for eid in eids:
                for nbr_id, rel in filter_neighbor_relations_for_retrieval(get_nbr(eid)):
                    if rel not in relations:
                        continue
                    # Find passages containing the neighbor entity
                    nbr_passages = self._storage.get_passages_for_entity(nbr_id)
                    for np in nbr_passages:
                        npid = np.passage_id
                        if npid not in selected and npid not in seen_neighbors:
                            if len(neighbors) >= max_neighbors:
                                return passage_ids + neighbors
                            neighbors.append(npid)
                            seen_neighbors.add(npid)

        return passage_ids + neighbors

    def _expand_macro_by_similarity_edges(
        self,
        passage_ids: list[str],
        *,
        max_per_source: int = SIMILARITY_EDGE_MAX_PER_SOURCE,
        max_total: int = SIMILARITY_EDGE_MAX_TOTAL_ADDITIONS,
        weight: float = SIMILARITY_EDGE_TRAVERSAL_WEIGHT,
    ) -> list[str]:
        """Expand macro passages through baked similarity edges only.

        The persisted cosine is a conservative ordering signal for a bounded
        topology expansion, not a query-time vector search. Existing symbolic or
        earlier passage hits keep priority because similarity additions append
        after the seed set and are capped per source and in total.
        """
        if not passage_ids or max_per_source <= 0 or max_total <= 0:
            return passage_ids
        if not similarity_edges_enabled():
            return passage_ids
        reader = getattr(self._storage, "get_similarity_passage_neighbors", None)
        if not callable(reader):
            return passage_ids

        neighbor_map = reader(
            passage_ids,
            limit_per_source=max_per_source,
            weight=weight,
        )
        selected = set(passage_ids)
        additions: list[str] = []
        seen = set(selected)
        for source_id in passage_ids:
            ranked_neighbors = sorted(
                neighbor_map.get(source_id, []),
                key=lambda item: (-float(item[1]), int(item[2]), str(item[0])),
            )
            for target_id, _score, _rank in ranked_neighbors:
                target = str(target_id)
                if target in seen:
                    continue
                additions.append(target)
                seen.add(target)
                if len(additions) >= max_total:
                    return passage_ids + additions
        return passage_ids + additions

    def _expand_macro_by_entity_bridge(
        self,
        passage_ids: list[str],
        query: str = "",
        max_bridge_entities: int = SP7_MAX_BRIDGE_ENTITIES,
        max_per_entity: int = SP7_MAX_PASSAGES_PER_ENTITY,
        max_total: int = SP7_MAX_TOTAL_ADDITIONS,
    ) -> list[str]:
        """SP-7: Expand macro passage set via shared entity bridges.

        Ranks entities mentioned in the selected passages, boosts entities whose
        names appear in the query, excludes globally common entities via an
        IDF-style ceiling, then adds new passages linked by the highest-ranked
        bridge entities.
        """
        if not passage_ids:
            return passage_ids

        entity_counts: dict[str, int] = {}
        selected = set(passage_ids)
        # SQL-B1: batch fetch eliminates N+1 queries
        _batch_sp7 = self._storage.get_passages_batch(passage_ids)
        for pid in passage_ids:
            passage = _batch_sp7.get(pid)
            if not passage:
                continue
            for eid in (passage.entity_ids if isinstance(passage.entity_ids, list) else []):
                entity_counts[eid] = entity_counts.get(eid, 0) + 1

        if not entity_counts:
            return passage_ids

        query_lower = query.lower()
        if query_lower:
            for eid in list(entity_counts):
                node = self._storage.get_node(eid)
                if node and node.name and node.name.lower() in query_lower:
                    entity_counts[eid] += 2

        total_passages = self._storage.passage_count()
        idf_ceiling = max(total_passages * 0.2, 5)

        ranked_entities = sorted(entity_counts.items(), key=lambda x: -x[1])

        # Use lightweight count for IDF ceiling check (no data load),
        # then passage_ids-only for additions (no raw_text load).
        count_fn = getattr(self._storage, "count_passages_for_entity", None)
        pids_fn = getattr(self._storage, "get_passage_ids_for_entity", None)

        bridge_entity_ids: list[str] = []
        for eid, _count in ranked_entities:
            if len(bridge_entity_ids) >= max_bridge_entities:
                break
            # IDF check: lightweight count if available, else full load
            if count_fn is not None:
                n_passages = count_fn(eid)
            else:
                n_passages = len(self._storage.get_passages_for_entity(eid))
            if n_passages > idf_ceiling:
                continue
            bridge_entity_ids.append(eid)

        def _passage_ids_for_entity(eid: str) -> list[str]:
            if pids_fn is not None:
                return pids_fn(eid)
            return [p.passage_id for p in self._storage.get_passages_for_entity(eid)]

        def _legacy_expand() -> list[str]:
            additions: list[str] = []
            seen: set[str] = set(selected)
            for eid in bridge_entity_ids:
                entity_pids = _passage_ids_for_entity(eid)
                added_for_entity = 0
                for pid in entity_pids:
                    if pid not in seen:
                        additions.append(pid)
                        seen.add(pid)
                        added_for_entity += 1
                        if len(additions) >= max_total:
                            return passage_ids + additions
                        if added_for_entity >= max_per_entity:
                            break

            return passage_ids + additions

        get_assets = getattr(self._storage, "get_asset_ids_for_passages", None)
        get_asset_siblings = getattr(self._storage, "get_passage_ids_for_assets", None)
        if not SP7_ASSET_CASCADE or not callable(get_assets) or not callable(get_asset_siblings):
            return _legacy_expand()
        if max_total <= 0 or max_per_entity <= 0:
            return passage_ids

        additions: list[str] = []
        seen: set[str] = set(selected)
        seed_assets = {
            asset_id
            for asset_id in get_assets(passage_ids).values()
            if asset_id
        }
        cascaded_assets: set[str] = set()

        for eid in bridge_entity_ids:
            entity_pids = _passage_ids_for_entity(eid)
            asset_by_pid = get_assets(entity_pids)
            candidates: list[tuple[int, str, str | None]] = []
            for pid in entity_pids:
                if pid in seen:
                    continue
                asset_id = asset_by_pid.get(pid)
                cross_asset_rank = 0 if asset_id and asset_id not in seed_assets else 1
                candidates.append((cross_asset_rank, pid, asset_id))

            added_for_entity = 0
            for cross_asset_rank, pid, asset_id in sorted(
                candidates, key=lambda item: (item[0], item[1])
            ):
                if added_for_entity >= max_per_entity:
                    break
                additions.append(pid)
                seen.add(pid)
                added_for_entity += 1
                if len(additions) >= max_total:
                    return passage_ids + additions

                if (
                    cross_asset_rank != 0
                    or not asset_id
                    or asset_id in cascaded_assets
                    or SP7_CASCADE_SIBLINGS_PER_ASSET <= 0
                ):
                    continue

                cascaded_assets.add(asset_id)
                sibling_map = get_asset_siblings(
                    [asset_id],
                    limit_per_asset=SP7_CASCADE_SIBLINGS_PER_ASSET,
                )
                for sibling_pid in sorted(sibling_map.get(asset_id, [])):
                    if sibling_pid in seen:
                        continue
                    additions.append(sibling_pid)
                    seen.add(sibling_pid)
                    if len(additions) >= max_total:
                        return passage_ids + additions

        return passage_ids + additions

    def _expand_by_reading_order(
        self,
        passage_ids: list[str],
        query: str,
        intent: Any = None,
    ) -> list[str]:
        """SP-8: Reading-order fiber expansion — general seq-neighbor retrieval.

        For every retrieved passage, fetch its seq-neighbors from provenance and
        use LOD_Z compression as the relevance gate: if `compress(neighbor, query,
        budget_per_neighbor)` yields non-empty output, the neighbor contains
        query-relevant sentences and is added to the candidate pool. No
        heuristics, no pattern matching — the compression itself decides.

        Window is intent-modulated:
          * default: window=1 (immediate predecessor + successor)
          * reasoning_depth > 0.5 OR temporal axis > 0.5: window=2
          * table chunks: window=2 regardless (legends often precede tables)

        Generalizes the per-passage adjacent-chunk fiber (which enriches RENDER
        text) by bringing seq-neighbors into the RETRIEVAL candidate pool so
        their entities are tessellated and their content can be C.3-selected.

        Returns passage_ids + unique non-empty neighbor segment IDs (preserving
        original ordering). Neighbors already in the pool are skipped.
        """
        if self._provenance is None or not passage_ids:
            return passage_ids

        # Lazy imports: these are hot-path only when SP-8 actually fires.
        from tp_vrg.compression import compress

        # Per-neighbor relevance budget. Just enough to recover 3-5 relevant
        # sentences if they exist. The Governor handles total context size
        # downstream; this is only a gate, not final rendering.
        BUDGET_PER_NEIGHBOR = 200

        # Intent-modulated default window
        default_window = 1
        if intent is not None:
            reasoning = float(getattr(intent, "reasoning_depth", 0.0) or 0.0)
            axes = getattr(intent, "content_axes", None) or {}
            temporal = float(axes.get("temporal", 0.0) or 0.0)
            if reasoning > 0.5 or temporal > 0.5:
                default_window = 2

        # Batch-load passage raw_text for table detection
        _batch_fn = getattr(self._storage, "get_passages_batch", None)
        _batch: dict[str, Any] = _batch_fn(passage_ids) if _batch_fn else {}

        selected_set: set[str] = set(passage_ids)
        additions: list[str] = []

        for pid in passage_ids:
            # Table chunks need window=2 regardless of intent (legend + data row
            # pattern frequently straddles the chunk boundary)
            window = default_window
            if window < 2:
                p = _batch.get(pid)
                if p is not None and _is_table_chunk(p.raw_text or ""):
                    window = 2

            try:
                ctx_segs = self._provenance.get_segment_context(pid, window=window)
            except Exception:
                # Provenance backends may raise on unknown segments; skip
                continue
            if len(ctx_segs) <= 1:
                continue  # only self returned — no neighbors

            for seg in ctx_segs:
                neighbor_id = seg.get("segment_id")
                if not neighbor_id or neighbor_id == pid:
                    continue
                if neighbor_id in selected_set:
                    continue

                neighbor_text = (seg.get("text") or "").strip()
                if not neighbor_text:
                    continue

                # LOD_Z relevance gate: compress → include only if non-empty.
                # compress() returns "" (or near-empty) when no sentences are
                # query-relevant within the budget. That's the filter.
                try:
                    compressed = compress(
                        neighbor_text, query, BUDGET_PER_NEIGHBOR, intent=intent
                    )
                except Exception:
                    continue
                if not compressed or not compressed.strip():
                    continue

                # Neighbor is relevant. Add to pool only if it exists as a
                # stored passage (tessellation requires passage entities).
                if self._storage.get_passage(neighbor_id) is None:
                    continue

                additions.append(neighbor_id)
                selected_set.add(neighbor_id)

        if additions:
            import logging
            logging.getLogger(__name__).debug(
                "SP-8: added %d reading-order neighbor(s) to passage pool "
                "(from %d seed passages, window=%d)",
                len(additions), len(passage_ids), default_window,
            )

        return passage_ids + additions

    def _micro_tessellate(self, passage_ids: list[str]) -> set[str]:
        """
        Stage 2a — Micro tessellation: collect entity_ids from selected passages.

        Only entities inside the relevant passages are candidates for scoring.
        This scopes the entity pool from ~1700 (flat graph) to ~30-100
        (entities within the top-K passages), dramatically improving precision.
        """
        entity_ids: set[str] = set()
        # SQL-B1: batch fetch eliminates N+1 queries
        _batch = self._storage.get_passages_batch(passage_ids)
        for pid in passage_ids:
            passage = _batch.get(pid)
            if passage:
                entity_ids.update(passage.entity_ids)
        return entity_ids

    def _backbone_orbit(
        self, candidate_ids: set[str], config: SpiralConfig
    ) -> set[str]:
        """SP-2 — Backbone Orbit: inject top-B high-centrality nodes into candidate pool.

        Structural bridge nodes connect topic clusters. They're often missed by cosine
        similarity because their LOD_0 text doesn't directly match the query, but they
        are essential for multi-hop reasoning chains. Cost: $0, +1-5ms.

        Gracefully handles empty backbone (backbone not yet computed → no injection).
        """
        if config.backbone_orbit_k <= 0:
            return candidate_ids
        backbone_ids = self._storage.get_top_backbone_nodes(config.backbone_orbit_k)
        if not backbone_ids:
            return candidate_ids
        new_ids = set(backbone_ids) - candidate_ids
        if new_ids:
            import logging
            logging.getLogger(__name__).debug(
                "SP-2: injected %d backbone node(s) into candidate pool", len(new_ids)
            )
        return candidate_ids | new_ids

    def _neighborhood_expand(
        self,
        candidate_ids: set[str],
        passage_ids_seen: set[str],
        config: SpiralConfig,
    ) -> set[str]:
        """SP-1 — Neighborhood Expansion: entity→passage reverse lookup.

        For each entity in the current candidate set, find other passages that
        also mention that entity. Tessellate those passages to discover additional
        entities that are topologically adjacent but missed by cosine similarity.
        This is one hop through the macro-graph: entity → passage → entity.

        passage_ids_seen: passages already tessellated in Stage 1 (skip to avoid
        re-processing and re-counting against neighborhood_max_new).

        Cap: neighborhood_max_new prevents candidate pool explosion when entities
        appear in many passages. Selection priority: entities are processed in
        candidate_ids iteration order (no sorting — pool is small enough).

        Cost: $0, +10-50ms.
        """
        if config.neighborhood_max_new <= 0:
            return candidate_ids

        new_entity_ids: set[str] = set()
        for eid in candidate_ids:
            if len(new_entity_ids) >= config.neighborhood_max_new:
                break
            passages = self._storage.get_passages_for_entity(eid)
            for passage in passages:
                if passage.passage_id in passage_ids_seen:
                    continue
                passage_ids_seen.add(passage.passage_id)
                for new_eid in passage.entity_ids:
                    if new_eid not in candidate_ids:
                        new_entity_ids.add(new_eid)
                        if len(new_entity_ids) >= config.neighborhood_max_new:
                            break
                if len(new_entity_ids) >= config.neighborhood_max_new:
                    break

        if new_entity_ids:
            import logging
            logging.getLogger(__name__).debug(
                "SP-1: expanded %d new entity(ies) from adjacent passages",
                len(new_entity_ids),
            )
        return candidate_ids | new_entity_ids

    async def _ghost_node_candidates(
        self, query: str, intent: Any = None, max_hops: int = 2,
    ) -> dict[str, float]:
        """Ghost Node: query-anchored topological retrieval.

        Extracts entities from the query, resolves them to existing graph nodes
        via triple-union (exact match + FTS5 + embedding similarity), then expands
        their 1-2 hop neighborhood. Returns {entity_id: score} for ghost candidates.
        """
        # 1) Get query entities from intent (GLiNER-detected) or empty
        raw_entities: list[str] = []
        if intent is not None and hasattr(intent, "detected_entities"):
            raw_entities = list(set(intent.detected_entities))
        if not raw_entities:
            return {}

        # 2) Resolve to graph node IDs — triple-union
        seed_ids: set[str] = set()
        for ent_text in raw_entities:
            # Exact name match
            seed_ids |= self._storage.exact_name_match(ent_text)
            # FTS5 lexical match
            fts_fn = getattr(self._storage, "search_nodes_fts", None)
            if callable(fts_fn):
                fts_results = fts_fn(ent_text)
                seed_ids.update(fts_results[:8])
            # Embedding similarity.
            # B1 ablation (2026-04-22): gated on TPVRG_ENTITY_EMBEDDING (default on).
            # When disabled, the triple-union degrades to a double-union of exact
            # name match + FTS5 lexical. Fuzzy-match recall is lost for entities
            # whose query vocabulary doesn't exactly/lexically overlap with the
            # entity name — that's exactly what the audit measures.
            from tp_vrg.models import ENTITY_EMBEDDINGS_ENABLED
            if ENTITY_EMBEDDINGS_ENABLED:
                try:
                    ent_emb = await self._embedder.embed(ent_text)
                    for eid, sim in self._storage.vector_search(ent_emb, top_k=8):
                        if sim >= 0.2:
                            seed_ids.add(eid)
                except Exception:
                    pass  # embedding unavailable — skip this resolution path

        if not seed_ids:
            return {}

        # 3) Expand 1-2 hops with relation filtering
        _blocked = {"_follows", "_session_follows", "_mentioned_before"}
        ghost_scores: dict[str, float] = {}
        frontier = set(seed_ids)
        visited = set(seed_ids)

        for hop in range(1, max_hops + 1):
            next_frontier: set[str] = set()
            for nid in frontier:
                get_nbr = getattr(self._storage, "get_neighbors_with_relations", None)
                if callable(get_nbr):
                    neighbors = filter_neighbor_relations_for_retrieval(get_nbr(nid))
                else:
                    # Fallback: no relation info — include all
                    neighbors = [(n, "") for n in self._storage.get_neighbors(nid)]
                for nbr, rel in neighbors:
                    if nbr in visited or rel in _blocked:
                        continue
                    visited.add(nbr)
                    next_frontier.add(nbr)
                    base = 1.0 if hop == 1 else 0.6
                    if rel == "_covers_period":
                        base *= 0.7
                    ghost_scores[nbr] = max(ghost_scores.get(nbr, 0.0), base)
            frontier = next_frontier
            if not frontier:
                break

        # Seed nodes themselves get score 1.0
        for sid in seed_ids:
            ghost_scores[sid] = max(ghost_scores.get(sid, 0.0), 1.0)

        return ghost_scores

    async def identify_active_nodes(
        self,
        query: str,
        top_k: int = 5,
        spiral: SpiralConfig | None = None,
        intent: Any = None,
    ) -> set[str]:
        """
        Find candidate entity nodes relevant to the query.

        Graph-per-Node two-stage search (F5.9):
        Stage 1: Macro search — find relevant passages via passage embeddings.
        Stage 2a: Micro tessellation — collect entities within those passages.
        Stage 2b (SP-2): Backbone Orbit — inject high-centrality structural nodes.
        Stage 2c (SP-1): Neighborhood Expansion — entity→passage reverse lookup.

        Falls back to flat entity vector_search if no passage embeddings exist
        (legacy graphs without F5.9 ingestion), then to substring matching.
        """
        _spiral = spiral or SpiralConfig()

        if self._use_semantic_scoring:
            # Water: Query expansion — broaden macro search recall with LLM-generated variants
            if (
                self._water_config.enabled
                and self._water_config.query_expansion
                and self._query_expander is not None
                and self._water_llm is not None
            ):
                variants = await self._query_expander.expand(
                    query, self._water_llm, self._water_config.expansion_variants
                )
                # Run macro search for each variant, merge candidate pools
                all_passage_ids: list[str] = []
                seen_pids: set[str] = set()
                for variant in variants:
                    variant_pids = await self.macro_search(variant, intent=intent)
                    for pid in variant_pids:
                        if pid not in seen_pids:
                            seen_pids.add(pid)
                            all_passage_ids.append(pid)
                passage_ids = all_passage_ids
            else:
                # Stage 1a: Macro search over passages (spatial partitioning)
                passage_ids = await self.macro_search(query, intent=intent)

            # Water: Passage reranking — LLM reorders macro search results
            if (
                self._water_config.enabled
                and self._water_config.macro_reranking
                and self._passage_reranker is not None
                and self._water_llm is not None
                and passage_ids
            ):
                passage_ids = await self._passage_reranker.rerank(
                    query, passage_ids, self._water_llm, self._water_config.reranking_top_k
                )

            # SP-6: Passage-level topology expansion (fractal stitching)
            if MACRO_TOPOLOGY != "none" and passage_ids:
                topo_relations: set[str] = set()
                if MACRO_TOPOLOGY in ("session", "both"):
                    topo_relations.add("_session_follows")
                if MACRO_TOPOLOGY in ("follows", "both"):
                    topo_relations.add("_follows")
                if topo_relations:
                    passage_ids = self._expand_macro_by_topology(
                        passage_ids, topo_relations
                    )

            passage_ids = self._expand_macro_by_similarity_edges(passage_ids)

            # SP-7: Entity-bridged passage expansion
            if SP7_ENABLED and passage_ids:
                passage_ids = self._expand_macro_by_entity_bridge(
                    passage_ids, query=query
                )

            # SP-8: Reading-order fiber — LOD_Z-scored seq-neighbor expansion.
            # Runs after SP-7 so the fourth structural axis (authorial/seq)
            # sees the full post-topology pool, and before cross-encoder so
            # reranking applies uniformly to the expanded candidates.
            if self._provenance is not None and passage_ids:
                passage_ids = self._expand_by_reading_order(
                    passage_ids, query=query, intent=intent
                )

            # Optional cross-encoder reranking (after SP-6 + SP-7 + SP-8 expansion)
            if self._cross_encoder_reranker is not None and passage_ids:
                passage_ids = await self._cross_encoder_reranker.rerank(
                    query, passage_ids, self._storage, top_k=CROSS_ENCODER_TOP_K
                )

            # Stage 1b: Ghost Node — query-anchored topological retrieval
            ghost_scores = await self._ghost_node_candidates(query, intent=intent)
            ghost_ids = set(ghost_scores.keys())

            if passage_ids or ghost_ids:
                # Stage 2a: Tessellate — candidate entities from selected passages
                entity_ids = self._micro_tessellate(passage_ids) if passage_ids else set()
                # Union ghost candidates into the pool
                entity_ids |= ghost_ids
                if entity_ids:
                    # Stage 2b: SP-2 — inject backbone bridge nodes
                    entity_ids = self._backbone_orbit(entity_ids, _spiral)
                    # Stage 2c: SP-1 — expand via entity→passage reverse lookup
                    entity_ids = self._neighborhood_expand(
                        entity_ids, set(passage_ids) if passage_ids else set(), _spiral
                    )
                    return entity_ids

            # Fallback: flat entity vector search (backward compat for legacy graphs).
            # B1 ablation (2026-04-22): gated on TPVRG_ENTITY_EMBEDDING (default on).
            # When disabled, this path is skipped entirely — we fall through one
            # step earlier to the substring-matching final fallback below.
            from tp_vrg.models import ENTITY_EMBEDDINGS_ENABLED
            if ENTITY_EMBEDDINGS_ENABLED:
                query_emb = await self._embedder.embed(query)
                results = self._storage.vector_search(query_emb, top_k=top_k)
                if results:
                    threshold = 0.1
                    active = {eid for eid, sim in results if sim >= threshold}
                    if active:
                        return active

        # Final fallback: substring matching
        return self.identify_active_nodes_substring(query)

    def identify_active_nodes_substring(self, query: str) -> set[str]:
        """Fallback: find nodes whose name or content matches the query.

        Uses FTS5 full-text search on SQLiteBackend (O(log N) via inverted
        index) instead of loading all nodes and scanning in Python (O(N)).
        Falls back to the legacy full-scan approach for non-SQLite backends.
        """
        # Fast path: FTS5 on SQLiteBackend
        search_fts = getattr(self._storage, "search_nodes_fts", None)
        if callable(search_fts):
            return set(search_fts(query))

        # Legacy fallback for InMemoryBackend / other backends
        query_lower = query.lower()
        nodes = self._storage.get_all_nodes()
        return {
            eid
            for eid, node in nodes.items()
            if eid in query_lower or node.name.lower() in query_lower
        }
