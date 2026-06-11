"""Deterministic query decomposition for multi-hop retrieval.

Decomposes complex queries into sub-queries that each target a single
constraint or entity. Each sub-query retrieves its own passage pool;
pools are merged with order-preserving deduplication before rendering.

Three-strategy cascade:
  1. Constraint decomposition (spaCy dep-parse) -- SOTA
  2. Entity decomposition (GLiNER-detected entities) -- fallback
  3. Clause decomposition (regex split on contrast/chain markers) -- last resort

Cost: $0.  Latency: <5ms.  Deterministic.  No LLM calls.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from tp_vrg.intent import IntentSignal
    from tp_vrg.models import SourcePassage

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Chain keywords that signal multi-hop structure
_CHAIN_KEYWORDS: re.Pattern = re.compile(
    r"\b(?:"
    r"of the|whose|the same|named after|went to the same|"
    r"parent company|record label of|who played|"
    r"difference between|compared to"
    r")\b",
    re.IGNORECASE,
)

# Contrast markers
_CONTRAST_MARKERS: re.Pattern = re.compile(
    r"\b(?:but|while|whereas)\b",
    re.IGNORECASE,
)

# Interrogative conjunctions: "and what/where/when/who/how"
_INTERROG_CONJ: re.Pattern = re.compile(
    r"\band\s+(?:what|where|when|who|how)\b",
    re.IGNORECASE,
)

# Split pattern for clause decomposition (union of contrast + interrogative)
_CLAUSE_SPLIT: re.Pattern = re.compile(
    r"\b(?:but|while|whereas)\b|\band\s+(?:what|where|when|who|how)\b",
    re.IGNORECASE,
)

# Dependency labels that indicate decomposable clause structure
_CLAUSE_DEPS: frozenset[str] = frozenset({"relcl", "advcl", "acl"})

# Maximum sub-queries (original + N constraints)
_MAX_SUB_QUERIES: int = 4


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class DecompositionResult:
    """Result of query decomposition."""

    sub_queries: list[str] = field(default_factory=list)
    is_decomposed: bool = False
    strategy: str = "direct"


# ---------------------------------------------------------------------------
# Gate: should we decompose?
# ---------------------------------------------------------------------------


def should_decompose(query: str, intent: Any) -> bool:
    """Return True when multi-hop signals are detected.

    Fires when:
      - intent.reasoning_depth > 0.5 (GLiNER found 2+ entities)
      - Chain keywords present ("of the", "whose", "the same", ...)
      - Contrast markers + interrogative conjunctions present

    Suppressed when:
      - Overview query (specificity < 0.3)
      - Exhaustive query (exhaustiveness > 0.7)
    """
    if intent is None:
        return False

    specificity = getattr(intent, "specificity", 0.5)
    exhaustiveness = getattr(intent, "exhaustiveness", 0.5)

    # Suppress for overview or exhaustive queries
    if specificity < 0.3:
        return False
    if exhaustiveness > 0.7:
        return False

    # Check reasoning depth (2+ entities detected by GLiNER)
    reasoning_depth = getattr(intent, "reasoning_depth", 0.0)
    if reasoning_depth > 0.5:
        return True

    # Check chain keywords
    if _CHAIN_KEYWORDS.search(query):
        return True

    # Check contrast markers
    if _CONTRAST_MARKERS.search(query) and _INTERROG_CONJ.search(query):
        return True

    return False


# ---------------------------------------------------------------------------
# Strategy 1: Constraint decomposition (spaCy dep-parse)
# ---------------------------------------------------------------------------


def _decompose_by_constraints(
    query: str, spacy_nlp: Any
) -> DecompositionResult | None:
    """PRIMARY STRATEGY: Extract relcl/advcl/acl clauses with antecedents.

    For Q49 "What was the middle name of the U.S. president who won Alaska,
    graduated from Yale University, and had a son named Michael?":
      - relcl root: "won" -> subtree "who won Alaska" -> antecedent "the U.S. president"
      - conj "graduated" -> "graduated from Yale University"
      - conj "had" -> "had a son named Michael"

    Returns None if no decomposable structure found.
    """
    if spacy_nlp is None:
        return None

    doc = spacy_nlp(query)
    sub_queries: list[str] = []

    for token in doc:
        if token.dep_ not in _CLAUSE_DEPS:
            continue

        # Find antecedent: walk up via .head to the noun phrase
        head = token.head
        # Get the full noun phrase span using left_edge
        antecedent_start = head.left_edge.i
        antecedent_end = head.i + 1
        antecedent = doc[antecedent_start:antecedent_end].text

        # Extract subtree text for this clause
        clause_tokens = sorted(token.subtree, key=lambda t: t.i)
        clause_text = " ".join(t.text for t in clause_tokens)
        # Strip leading relative pronoun for cleaner sub-query
        sub_q = f"{antecedent} {clause_text}".strip()
        if sub_q and sub_q not in sub_queries:
            sub_queries.append(sub_q)

        # Handle conj children: parallel constraints on same antecedent
        for child in token.children:
            if child.dep_ == "conj":
                conj_tokens = sorted(child.subtree, key=lambda t: t.i)
                conj_text = " ".join(t.text for t in conj_tokens)
                conj_q = f"{antecedent} {conj_text}".strip()
                if conj_q and conj_q not in sub_queries:
                    sub_queries.append(conj_q)

    if not sub_queries:
        return None

    # Always include original query first, cap at _MAX_SUB_QUERIES
    result = [query] + sub_queries[: _MAX_SUB_QUERIES - 1]
    return DecompositionResult(
        sub_queries=result,
        is_decomposed=True,
        strategy="constraints",
    )


# ---------------------------------------------------------------------------
# Strategy 2: Entity decomposition (GLiNER-detected entities)
# ---------------------------------------------------------------------------


def _decompose_by_entities(
    query: str, intent: Any
) -> DecompositionResult | None:
    """Fallback: each detected entity becomes a retrieval probe.

    Returns None if fewer than 2 entities detected.
    """
    entities = getattr(intent, "detected_entities", [])
    if len(entities) < 2:
        return None

    sub_queries = [query]
    for entity_text in entities:
        if entity_text and entity_text not in sub_queries:
            sub_queries.append(entity_text)
            if len(sub_queries) >= _MAX_SUB_QUERIES:
                break

    return DecompositionResult(
        sub_queries=sub_queries,
        is_decomposed=True,
        strategy="entities",
    )


# ---------------------------------------------------------------------------
# Strategy 3: Clause decomposition (regex split)
# ---------------------------------------------------------------------------


def _decompose_by_clauses(query: str) -> DecompositionResult | None:
    """Last resort: split on contrast markers and interrogative conjunctions.

    Returns None if no split points found.
    """
    parts = _CLAUSE_SPLIT.split(query)
    parts = [p.strip() for p in parts if p.strip()]

    if len(parts) < 2:
        return None

    # Original first, then clause parts (capped)
    sub_queries = [query] + parts[: _MAX_SUB_QUERIES - 1]
    return DecompositionResult(
        sub_queries=sub_queries,
        is_decomposed=True,
        strategy="clauses",
    )


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def decompose(
    query: str, intent: Any, spacy_nlp: Any = None
) -> DecompositionResult:
    """Decompose a query into sub-queries. Tries strategies in order.

    1. Constraint decomposition (spaCy dep-parse) if spaCy available
    2. Entity decomposition if 2+ detected entities
    3. Clause decomposition if chain/contrast keywords found
    4. Direct (no decomposition)
    """
    # Strategy 1: constraints via dep-parse
    if spacy_nlp is not None:
        result = _decompose_by_constraints(query, spacy_nlp)
        if result is not None:
            return result

    # Strategy 2: entity probes
    result = _decompose_by_entities(query, intent)
    if result is not None:
        return result

    # Strategy 3: clause splitting
    if _CHAIN_KEYWORDS.search(query) or _CONTRAST_MARKERS.search(query):
        result = _decompose_by_clauses(query)
        if result is not None:
            return result

    # No decomposition possible
    return DecompositionResult(
        sub_queries=[query],
        is_decomposed=False,
        strategy="direct",
    )


# ---------------------------------------------------------------------------
# Passage pool merging
# ---------------------------------------------------------------------------


def merge_passage_pools(
    pools: list[list[str]], max_passages: int = 40
) -> list[str]:
    """Merge passage pools with frequency-weighted ranking.

    Passages found by more sub-queries rank higher (cross-query agreement
    is a strong relevance signal). Within the same frequency tier, Pool 0
    (original query) results come first, then order of first appearance.

    Inspired by QMD's "original 2x" RRF weighting — passages confirmed
    by multiple retrieval paths are more likely to be relevant.
    """
    if len(pools) <= 1:
        # Single pool (no decomposition) — return as-is
        return pools[0][:max_passages] if pools else []

    # Count frequency: how many pools each passage appears in
    freq: dict[str, int] = {}
    first_seen_pool: dict[str, int] = {}  # which pool first found it
    first_seen_rank: dict[str, int] = {}  # rank within that pool

    for pool_idx, pool in enumerate(pools):
        for rank, pid in enumerate(pool):
            if pid not in first_seen_pool:
                first_seen_pool[pid] = pool_idx
                first_seen_rank[pid] = rank
            freq[pid] = freq.get(pid, 0) + 1

    # Sort: frequency desc → first-seen pool asc (Pool 0 priority) → rank asc
    all_pids = list(freq.keys())
    all_pids.sort(key=lambda pid: (-freq[pid], first_seen_pool[pid], first_seen_rank[pid]))

    return all_pids[:max_passages]


# ---------------------------------------------------------------------------
# Integration: decompose + retrieve + render
# ---------------------------------------------------------------------------


async def decompose_and_retrieve(
    query: str,
    intent: Any,
    retriever: Any,
    renderer: Any,
    storage: Any,
    token_budget: int = 4000,
    spacy_nlp: Any = None,
    collect_timing: bool = False,
) -> tuple[str, dict[str, int]] | tuple[str, dict[str, int], dict[str, float]] | None:
    """Decompose query, retrieve per sub-query, merge, and render.

    Returns (context_str, dedup_stats) or None if no passages found.
    Rendering uses the ORIGINAL query for coherent context framing.
    """
    t_start = time.perf_counter()
    result = decompose(query, intent, spacy_nlp)
    t_decompose = time.perf_counter()

    # Retrieve passage pools for each sub-query (concurrent — sub-queries are independent)
    import asyncio as _asyncio

    async def _search_subquery(sub_q: str) -> tuple[list[str], dict]:
        t_sq = time.perf_counter()
        passage_ids = await retriever.macro_search(sub_q, intent=intent)
        return passage_ids or [], {
            "sub_query": sub_q[:80],
            "time_s": round(time.perf_counter() - t_sq, 3),
            "passages": len(passage_ids or []),
            "macro_detail": getattr(retriever, "_last_macro_timing", {}),
        }

    search_results = await _asyncio.gather(*[
        _search_subquery(sq) for sq in result.sub_queries
    ])
    pools = [r[0] for r in search_results]
    per_subquery_times = [r[1] for r in search_results]
    t_retrieve = time.perf_counter()

    # Merge with dedup
    merged_ids = merge_passage_pools(pools)
    t_merge = time.perf_counter()
    if not merged_ids:
        return None

    # Resolve passage IDs to SourcePassage objects
    # SQL-B1: batch fetch eliminates N+1 queries
    _batch = storage.get_passages_batch(merged_ids)
    passages = [_batch[pid] for pid in merged_ids if pid in _batch]
    t_get_passages = time.perf_counter()
    if not passages:
        return None

    # Render using ORIGINAL query (not sub-queries)
    ctx, dedup, rendered_pids = renderer.format_passages(passages, query, token_budget, intent)
    t_render = time.perf_counter()

    if not collect_timing:
        return (ctx, dedup, rendered_pids)

    timing = {
        "decompose": round(t_decompose - t_start, 3),
        "macro_search_all_subqueries": round(t_retrieve - t_decompose, 3),
        "n_subqueries": len(result.sub_queries),
        "per_subquery": per_subquery_times,
        "merge_pools": round(t_merge - t_retrieve, 3),
        "get_passages": round(t_get_passages - t_merge, 3),
        "format_passages": round(t_render - t_get_passages, 3),
        "render_confidence": 0.0,
        "total": round(t_render - t_start, 3),
    }
    return (ctx, dedup, rendered_pids, timing)
