"""
Water mode augmentation components for the TP-VRG pipeline.

Fire/Water Doctrine (strategy.md S4): Principles 4-5 are the floor, not the
ceiling. Water mode adds LLM augmentation at three high-ROI pipeline stages:

1. QueryExpander   -- expand query into variants before macro search
2. PassageReranker -- LLM rerank passage candidates after macro search
3. ExtractionEnricher -- GLiNER + LLM fusion at ingestion time

Each component:
- Accepts an LLMProvider with a complete() method
- Has a deterministic fallback if the LLM call fails
- Is independently toggleable via WaterConfig flags
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tp_vrg.llm_service import LLMProvider
    from tp_vrg.models import ExtractionResult
    from tp_vrg.storage import StorageBackend

logger = logging.getLogger(__name__)


class QueryExpander:
    """Expand a query into multiple variants for broader macro search recall.

    Generates N rephrased variants of the original query, then macro search
    runs on all variants and merges the candidate pools. This compensates for
    vocabulary mismatch between query phrasing and passage embeddings.

    Deterministic fallback: returns [original_query] if LLM fails.
    Cost: 1 LLM call per query (~50 input, ~200 output tokens).
    """

    async def expand(
        self,
        query: str,
        llm: LLMProvider,
        num_variants: int = 3,
    ) -> list[str]:
        """Return the original query plus N rephrasings.

        Args:
            query: Original user query.
            llm: LLM provider with complete() method.
            num_variants: Number of variants to generate.

        Returns:
            List starting with the original query, followed by variants.
            On LLM failure, returns [query] (Fire behavior).
        """
        prompt = (
            f"Rephrase this question {num_variants} different ways, "
            "preserving the original meaning but using different words and structure. "
            "Return ONLY the rephrased questions, one per line. No numbering, no explanations.\n\n"
            f"Original: {query}"
        )

        try:
            response = await llm.complete(prompt, max_tokens=512)
            variants = [
                line.strip()
                for line in response.strip().split("\n")
                if line.strip() and len(line.strip()) > 5
            ]
            # Cap at requested number
            variants = variants[:num_variants]
            if variants:
                logger.info(
                    "[Water] QueryExpander: %d variants generated for query",
                    len(variants),
                )
                return [query] + variants
        except Exception as e:
            logger.warning("[Water] QueryExpander failed, falling back to Fire: %s", e)

        return [query]


class PassageReranker:
    """Rerank macro search passage candidates using LLM judgment.

    After macro search returns top-K passages by cosine similarity, the reranker
    sends the top candidates (with their text) to an LLM for relevance reranking.
    This catches passages that are semantically related but have low embedding
    similarity, and demotes false positives.

    Deterministic fallback: returns original order if LLM fails.
    Cost: 1 LLM call per query (~1000 input, ~100 output tokens).
    """

    def __init__(self, storage: StorageBackend) -> None:
        self._storage = storage

    async def rerank(
        self,
        query: str,
        passage_ids: list[str],
        llm: LLMProvider,
        top_k: int = 10,
    ) -> list[str]:
        """Rerank passage candidates by LLM-judged relevance.

        Args:
            query: The original query.
            passage_ids: Ordered list of passage IDs from macro search.
            llm: LLM provider with complete() method.
            top_k: Number of top candidates to send to the LLM.

        Returns:
            Reordered list of passage IDs.
            On LLM failure, returns original list unchanged.
        """
        if len(passage_ids) <= 1:
            return passage_ids

        # Only send top_k candidates to the LLM (cost control)
        to_rerank = passage_ids[:top_k]
        rest = passage_ids[top_k:]

        # Fetch passage text for each candidate
        passage_texts: list[tuple[str, str]] = []  # (pid, text_preview)
        for pid in to_rerank:
            passage = self._storage.get_passage(pid)
            if passage and passage.raw_text:
                # Truncate to ~300 chars per passage for cost control
                preview = passage.raw_text[:300].replace("\n", " ")
                passage_texts.append((pid, preview))
            else:
                passage_texts.append((pid, "(no text available)"))

        # Build reranking prompt
        lines = [
            f"Query: {query}\n",
            "Below are passages retrieved from a knowledge base. "
            "Rank them by relevance to the query (most relevant first). "
            "Return ONLY the passage numbers in order, comma-separated. "
            "Example: 3,1,5,2,4\n",
        ]
        for i, (pid, preview) in enumerate(passage_texts, 1):
            lines.append(f"[{i}] {preview}")
        prompt = "\n".join(lines)

        try:
            response = await llm.complete(prompt, max_tokens=256)
            # Parse: extract numbers from response
            raw_nums = re.findall(r"\d+", response)
            reordered_indices = []
            seen: set[int] = set()
            for num_str in raw_nums:
                idx = int(num_str) - 1  # 1-indexed to 0-indexed
                if 0 <= idx < len(passage_texts) and idx not in seen:
                    reordered_indices.append(idx)
                    seen.add(idx)

            if reordered_indices:
                reranked = [passage_texts[idx][0] for idx in reordered_indices]
                # Add any un-mentioned passages at the end
                for idx in range(len(passage_texts)):
                    if idx not in seen:
                        reranked.append(passage_texts[idx][0])

                logger.info(
                    "[Water] PassageReranker: reranked %d passages",
                    len(reranked),
                )
                return reranked + rest

        except Exception as e:
            logger.warning("[Water] PassageReranker failed, falling back to Fire: %s", e)

        return passage_ids


class ExtractionEnricher:
    """Enrich GLiNER extraction with LLM-discovered entities and relationships.

    Runs an LLM extraction pass on the same chunk text, then merges LLM-found
    entities/edges with the GLiNER result. GLiNER entities are always kept
    (ground truth); LLM adds entities that GLiNER missed (implicit relationships,
    abstract concepts, nuanced categorization).

    Deterministic fallback: returns GLiNER result unchanged if LLM fails.
    Cost: 1 LLM call per chunk (~500 input, ~600 output tokens).
    """

    async def enrich(
        self,
        chunk_text: str,
        gliner_result: ExtractionResult,
        llm: LLMProvider,
    ) -> ExtractionResult:
        """Merge GLiNER and LLM extraction results.

        Args:
            chunk_text: The raw chunk text that was extracted.
            gliner_result: ExtractionResult from GLiNER/spaCy.
            llm: LLM provider with extract_entities_and_edges() method.

        Returns:
            Merged ExtractionResult with entities from both sources.
            On LLM failure, returns gliner_result unchanged.
        """
        try:
            llm_result = await llm.extract_entities_and_edges(chunk_text)
            merged = self._merge(gliner_result, llm_result)
            logger.info(
                "[Water] ExtractionEnricher: GLiNER=%d nodes, LLM=%d nodes, merged=%d nodes",
                len(gliner_result.nodes),
                len(llm_result.nodes),
                len(merged.nodes),
            )
            return merged
        except Exception as e:
            logger.warning(
                "[Water] ExtractionEnricher failed, falling back to Fire: %s", e
            )
            return gliner_result

    def _merge(
        self,
        base: ExtractionResult,
        supplement: ExtractionResult,
    ) -> ExtractionResult:
        """Merge two ExtractionResults, deduplicating by entity_id.

        Base (GLiNER) entities always win on conflict. Supplement (LLM) entities
        are added only if they don't collide with an existing entity_id.
        Edges are unioned, deduplicated by (source, target, relation).
        """
        from tp_vrg.models import ExtractionResult as ER

        def _as_payload(item):
            return item.model_dump() if hasattr(item, "model_dump") else item

        # Entity dedup: base wins on collision
        entity_map = {node.entity_id: node for node in base.nodes}
        for node in supplement.nodes:
            normalized_id = node.entity_id.lower().strip().replace(" ", "_")
            # Check both raw and normalized ID
            if node.entity_id not in entity_map and normalized_id not in entity_map:
                entity_map[node.entity_id] = node

        # Edge dedup: union by (source, target, relation) tuple
        edge_set: set[tuple[str, str, str]] = set()
        merged_edges = []
        for edge in base.edges:
            key = (edge.source, edge.target, edge.relation)
            if key not in edge_set:
                edge_set.add(key)
                merged_edges.append(edge)
        for edge in supplement.edges:
            key = (edge.source, edge.target, edge.relation)
            if key not in edge_set:
                # Only add edge if both endpoints exist in merged entity set
                if edge.source in entity_map and edge.target in entity_map:
                    edge_set.add(key)
                    merged_edges.append(edge)

        return ER(
            nodes=[_as_payload(node) for node in entity_map.values()],
            edges=[_as_payload(edge) for edge in merged_edges],
        )
