"""Stopword filtering for relation labels produced by extraction.

The production graph has observed Swedish and English function words leaking
into relation labels. Keep the canonical vocabulary here so extraction and
retrieval can share one filter.

Edge-case behaviors codified by the 2026-05-14 Lane-A sweep:

- **2-char labels:** previously the `len < 3` heuristic flagged "AI", "ML",
  "IO", "IP" as noise. These are common acronyms in tech corpora and
  carry real semantic content. The heuristic is now `len < 2`, which
  catches only empty/single-char labels.
- **Boundary punctuation:** previously `"of."` and `"the,"` slipped through
  because `.strip()` only removes whitespace. The filter now strips leading
  + trailing punctuation before stopword-set lookup.
- **Multi-token labels:** previously `"of the"` and `"och the"` (polyglot)
  slipped through because the whole-string lookup didn't decompose. The
  filter now splits on whitespace; if ALL tokens are stopwords, the
  combined label is treated as noise.
"""

from __future__ import annotations

import logging
import string

try:
    from spacy.lang.en.stop_words import STOP_WORDS as EN_STOP_WORDS
    from spacy.lang.sv.stop_words import STOP_WORDS as SV_STOP_WORDS
except ImportError:
    # Minimal installs should still import and run. spaCy's curated lists are
    # used when available; these fallback sets cover the relation-noise cases
    # the filter is expected to catch in the core package.
    EN_STOP_WORDS = frozenset(
        {
            "a",
            "an",
            "the",
            "is",
            "was",
            "are",
            "were",
            "be",
            "been",
            "being",
            "have",
            "has",
            "had",
            "do",
            "does",
            "did",
            "will",
            "would",
            "could",
            "should",
            "may",
            "might",
            "shall",
            "can",
            "to",
            "of",
            "in",
            "on",
            "at",
            "by",
            "for",
            "with",
            "about",
            "from",
            "into",
            "through",
            "before",
            "after",
            "between",
            "and",
            "or",
            "but",
            "not",
            "no",
            "than",
            "that",
            "this",
            "these",
            "those",
            "what",
            "which",
            "who",
            "whom",
            "how",
            "when",
            "where",
            "why",
            "all",
            "any",
            "each",
            "more",
            "most",
            "some",
            "i",
            "you",
            "he",
            "she",
            "it",
            "we",
            "they",
            "me",
            "him",
            "her",
            "us",
            "them",
        }
    )
    SV_STOP_WORDS = frozenset(
        {
            "en",
            "ett",
            "den",
            "det",
            "de",
            "denna",
            "detta",
            "dessa",
            "och",
            "att",
            "som",
            "men",
            "om",
            "när",
            "hur",
            "vad",
            "vem",
            "var",
            "varför",
            "i",
            "på",
            "för",
            "med",
            "av",
            "till",
            "från",
            "vid",
            "under",
            "över",
            "är",
            "var",
            "har",
            "ha",
            "kan",
            "ska",
        }
    )

logger = logging.getLogger(__name__)

# Boundary punctuation stripped before stopword-set lookup. Conservative set:
# only characters that could plausibly be tokenizer/whitespace artifacts on
# either side of a real relation label. Internal punctuation (e.g., hyphens
# in "well-known", underscores in "published_by") is preserved.
_BOUNDARY_PUNCT = string.punctuation + string.whitespace

_OBSERVED_SWEDISH_RELATION_LEAKS: frozenset[str] = frozenset(
    {
        # Articles / pronouns
        "en",
        "ett",
        "den",
        "det",
        "de",
        "denna",
        "detta",
        "dessa",
        "min",
        "din",
        "sin",
        "ditt",
        "sitt",
        "dina",
        "sina",
        "mitt",
        "vi",
        "ni",
        "han",
        "hon",
        "jag",
        "du",
        "mig",
        "dig",
        "sig",
        # Conjunctions / prepositions
        "och",
        "att",
        "som",
        "men",
        "om",
        "när",
        "hur",
        "vad",
        "vem",
        "var",
        "varför",
        "i",
        "på",
        "för",
        "med",
        "av",
        "till",
        "från",
        "vid",
        "under",
        "över",
        # Common verbs with low semantic relation value
        "har",
        "är",
        "var",
        "blev",
        "skapa",
        "göra",
        "vara",
        "ha",
        "bli",
        "kan",
        "kunde",
        "skulle",
        "måste",
        "vilja",
        "ska",
        "bör",
        # Observed as relation labels in the production graph
        "också",
        "samt",
        "mer",
        "mest",
        "me",
    }
)

_OBSERVED_ENGLISH_VERB_RELATION_LEAKS: frozenset[str] = frozenset(
    {
        "have",
        "me",
        "use",
        "provide",
        "become",
        "create",
        "include",
        "require",
        "need",
        "offer",
        "show",
        "run",
        "do",
        "say",
        "make",
        "take",
        "know",
        "think",
        "get",
        "give",
        "see",
        "find",
        "try",
    }
)


def _normalize_terms(terms: set[str] | frozenset[str]) -> frozenset[str]:
    return frozenset(term.lower().strip() for term in terms if term and term.strip())


SWEDISH_STOPWORDS: frozenset[str] = frozenset(
    _normalize_terms(SV_STOP_WORDS) | _OBSERVED_SWEDISH_RELATION_LEAKS
)
ENGLISH_STOPWORDS: frozenset[str] = _normalize_terms(EN_STOP_WORDS)
ALL_STOPWORDS: frozenset[str] = frozenset(
    SWEDISH_STOPWORDS | ENGLISH_STOPWORDS | _OBSERVED_ENGLISH_VERB_RELATION_LEAKS
)

EXTRACTION_FILTER_STOPWORDS = True
RETRIEVAL_FILTER_STOPWORDS = True


def is_stopword_relation(relation_label: str) -> bool:
    """Return True when a relation label is stopword/noise rather than semantic.

    Normalization sequence:
      1. ``None`` → empty string
      2. lowercase
      3. strip whitespace + boundary punctuation
      4. length check (< 2 → noise; preserves 2-char acronyms like AI/ML)
      5. whole-string lookup in ALL_STOPWORDS (the fast path; catches most cases)
      6. multi-token decomposition: if the normalized label contains whitespace
         AND every whitespace-split token is itself a stopword → flag as noise
         (catches "of the", "och the" polyglot, "is a", "has been")

    Examples (post-2026-05-14 Lane-A edge-case sweep):
      - ``"AI"`` → kept (2-char acronym; previously incorrectly filtered)
      - ``"of."`` → filtered (trailing punct now stripped; previously kept)
      - ``"of the"`` → filtered (multi-token all-stopword check)
      - ``"och the"`` → filtered (polyglot multi-token; both stopwords)
      - ``"is acquired by"`` → kept (compound with "acquired" non-stopword)
      - ``"published_by"`` → kept (snake_case preserved; underscore not boundary)
    """
    if not relation_label:
        return True
    normalized = relation_label.lower().strip().strip(_BOUNDARY_PUNCT)
    if len(normalized) < 2:
        return True
    if normalized in ALL_STOPWORDS:
        return True
    # Multi-token decomposition (only triggered if whitespace present)
    if " " in normalized or "\t" in normalized:
        tokens = normalized.split()
        if tokens and all(token in ALL_STOPWORDS for token in tokens):
            return True
    return False


def should_skip_extracted_relation(
    relation_label: str,
    extraction_stats: dict[str, int] | None = None,
) -> bool:
    """Apply extraction-time stopword filtering and increment skip telemetry."""
    if not EXTRACTION_FILTER_STOPWORDS or not is_stopword_relation(relation_label):
        return False
    if extraction_stats is not None:
        extraction_stats["stopword_relations_skipped"] = (
            extraction_stats.get("stopword_relations_skipped", 0) + 1
        )
    return True


def _log_retrieval_skips(kind: str, skipped: int) -> None:
    if skipped:
        logger.info(
            "[retrieval] stopword_relations_skipped=%d (%s)",
            skipped,
            kind,
        )


def filter_neighbor_relations_for_retrieval(
    neighbors: list[tuple[str, str]],
) -> list[tuple[str, str]]:
    """Drop relation-aware neighbor rows whose relation label is stopword noise."""
    if not RETRIEVAL_FILTER_STOPWORDS:
        return neighbors
    filtered = [(node_id, rel) for node_id, rel in neighbors if not is_stopword_relation(rel)]
    _log_retrieval_skips("neighbor_edges", len(neighbors) - len(filtered))
    return filtered


def filter_edge_rows_for_retrieval(
    edges: list[tuple[str, str, dict]],
) -> list[tuple[str, str, dict]]:
    """Drop edge rows whose relation label is stopword noise before rendering/scoring."""
    if not RETRIEVAL_FILTER_STOPWORDS:
        return edges
    filtered = [
        (source, target, meta)
        for source, target, meta in edges
        if not is_stopword_relation(str(meta.get("relation", "")))
    ]
    _log_retrieval_skips("edge_rows", len(edges) - len(filtered))
    return filtered
