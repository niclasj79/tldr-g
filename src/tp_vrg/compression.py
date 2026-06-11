"""
Deterministic LOD_Z compression — Liquid LOD Phase B.

Extractive sentence selection: given a passage and a token budget, returns
the most query-relevant sentences that fit within the budget.  No LLM calls.
No external API calls.  Pure text transformation.

This module is the canonical home for sentence-level text operations.
``shading.py`` (Phase A) imports from here so the scoring logic is shared.

Core contract::

    compress(text, query, budget) -> str

Where ``budget`` is the number of tokens the caller can afford for this node.
The function selects the most query-relevant sentences greedily until the budget
is exhausted, then re-orders them by original position to preserve narrative flow.

Edge cases:
- budget >= full text tokens → return full text unchanged
- single sentence (or empty) → return full text unchanged
- budget too small for any sentence → truncation fallback (first N words)
"""

from __future__ import annotations

import re

from tp_vrg.tokens import estimate_tokens


# ---------------------------------------------------------------------------
# Table detection and compression
# ---------------------------------------------------------------------------
# Markdown tables are structured data — splitting them into "sentences" destroys
# the header-row relationship and produces nonsense fragments. Detect table
# structure early in compress() and handle it with a separate path.
#
# Note: _MD_TABLE_SEP_RE is intentionally duplicated here from ingestion.py.
# compression.py is a leaf module (no dependencies on ingestion). Importing
# ingestion.py here would create a layering regression.

_MD_TABLE_SEP_RE = re.compile(r"^\|[\s:]*-+[\s:|-]*\|", re.MULTILINE)


def _is_table_text(text: str) -> bool:
    """Return True if text looks like a Markdown table (header + separator + rows).

    Requires at least 3 pipe-delimited lines (header, separator, ≥1 data row)
    and a separator line matching the ``| --- |`` pattern.
    """
    if not text or "|" not in text:
        return False
    lines = text.strip().split("\n")
    if len(lines) < 3:
        return False
    pipe_lines = sum(
        1 for line in lines
        if line.strip().startswith("|") and line.strip().endswith("|")
    )
    return pipe_lines >= 3 and bool(_MD_TABLE_SEP_RE.search(text))


def _compress_table(text: str, budget: int) -> str:
    """Budget-aware table compression: keep header + separator, then greedily add rows.

    The header row and separator are always included (they are the schema).
    Data rows are added in order until the budget is exhausted. Partial rows
    are not included — a row either fits in full or is skipped entirely.
    Falls back to returning the full text if the input has fewer than 3 lines.
    """
    lines = text.strip().split("\n")
    if len(lines) < 3:
        return text

    header = lines[0]
    separator = lines[1]
    data_rows = lines[2:]

    header_cost = estimate_tokens(header) + estimate_tokens(separator)
    if header_cost >= budget:
        # Budget too small even for header — return just the header (schema only)
        return "\n".join([header, separator])

    selected = [header, separator]
    remaining = budget - header_cost

    for row in data_rows:
        cost = estimate_tokens(row)
        if cost <= remaining:
            selected.append(row)
            remaining -= cost
        else:
            break  # stop at first row that doesn't fit

    return "\n".join(selected)


# ---------------------------------------------------------------------------
# Sentence-level primitives (canonical — shading.py re-exports these)
# ---------------------------------------------------------------------------


# Shared spaCy sentencizer instance (blank pipeline, rule-based boundary detection)
# Deterministic SOTA check (2026-04-04):
#   Problem: regex + 17-abbreviation list misses edge cases (quotes, ellipses,
#            U.S.A., non-ASCII punctuation), produces false splits on "Dr. Smith".
#   SOTA: spaCy blank("en") + sentencizer — rule-based, handles abbreviations
#         and punctuation edge cases without loading the full en_core_web_sm model.
#   Available in: spaCy (already loaded). ~10x faster than full parser.
#   Replaces: regex-based split_sentences() with 17-item abbreviation list.
_spacy_sent_nlp = None
_spacy_sent_attempted = False


def _get_spacy_sentencizer():
    """Lazy-load a lightweight spaCy pipeline with only the sentencizer enabled.

    Uses blank("en") + sentencizer — rule-based sentence boundary detection
    without the overhead of the full en_core_web_sm model. Returns None on failure.
    """
    global _spacy_sent_nlp, _spacy_sent_attempted
    if _spacy_sent_attempted:
        return _spacy_sent_nlp
    _spacy_sent_attempted = True
    try:
        import spacy
        nlp = spacy.blank("en")
        nlp.add_pipe("sentencizer")
        _spacy_sent_nlp = nlp
        return _spacy_sent_nlp
    except Exception:
        return None


def split_sentences(text: str, max_chars: int | None = None) -> list[str]:
    """Split text into sentences using spaCy's sentencizer.

    Uses spaCy blank("en") + sentencizer for rule-based boundary detection.
    Handles abbreviations, quoted speech, and edge cases more robustly than
    the previous regex-based approach. Falls back to the regex split if spaCy
    is unavailable.

    Returns a list of non-empty sentence strings. If no sentence boundaries
    are found, returns the full text as a single-element list.
    """
    if not text or not text.strip():
        return []
    if max_chars is not None and len(text) > max_chars:
        text = text[:max_chars]

    nlp = _get_spacy_sentencizer()
    if nlp is not None:
        doc = nlp(text)
        sentences = [sent.text.strip() for sent in doc.sents if sent.text.strip()]
        return sentences if sentences else [text.strip()]

    # Fallback: regex-based split with abbreviation protection
    ABBREVS = [
        "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "Sr.", "Jr.",
        "e.g.", "i.e.", "vs.", "etc.", "al.", "fig.", "eq.",
        "no.", "vol.", "pp.", "ed.", "est.",
    ]
    placeholder_map: dict[str, str] = {}
    working = text
    for i, abbrev in enumerate(ABBREVS):
        placeholder = f"\x00ABBREV{i}\x00"
        placeholder_map[placeholder] = abbrev
        working = working.replace(abbrev, placeholder)
    parts = re.split(r"(?<=[.!?])\s+", working)
    sentences: list[str] = []
    for part in parts:
        restored = part
        for placeholder, abbrev in placeholder_map.items():
            restored = restored.replace(placeholder, abbrev)
        stripped = restored.strip()
        if stripped:
            sentences.append(stripped)
    return sentences if sentences else [text.strip()]


def extract_entity_sentences(
    text: str,
    entity_name: str,
    context_window: int = 1,
) -> str:
    """Extract sentences mentioning *entity_name* plus a context window.

    For each sentence that contains ``entity_name`` (case-insensitive
    substring match), the sentence itself and up to *context_window*
    neighbours on each side are selected.  Overlapping windows are merged
    and sentences are returned in their original order.

    **Fallback:** if no sentence matches (e.g. entity only mentioned via
    pronoun and coref didn't resolve), the full *text* is returned
    unchanged — no information is ever silently dropped.

    This is the core primitive for F5.1 (entity-specific LOD_0 spans).
    It replaces the current behaviour where every entity in a chunk shares
    the full chunk text as ``node.lod_0``.
    """
    if not text or not text.strip() or not entity_name:
        return text or ""

    sentences = split_sentences(text)
    if len(sentences) <= 1:
        return text  # single sentence — nothing to filter

    name_lower = entity_name.lower()

    # Find indices of sentences that mention the entity
    match_indices: list[int] = [
        i for i, s in enumerate(sentences) if name_lower in s.lower()
    ]

    if not match_indices:
        return text  # fallback: entity not found by name — return full text

    # Expand each match by context_window and collect unique indices
    selected: set[int] = set()
    for idx in match_indices:
        lo = max(0, idx - context_window)
        hi = min(len(sentences) - 1, idx + context_window)
        for j in range(lo, hi + 1):
            selected.add(j)

    # Reconstruct in original order
    filtered = [sentences[i] for i in sorted(selected)]
    return " ".join(filtered)


# Module-level cache for spaCy stopwords (lazy-loaded from spacy.lang.en.stop_words)
# Deterministic SOTA check (2026-04-04):
#   Problem: hand-coded 47-item frozenset misses ~132 valid English stopwords
#   SOTA: spaCy's curated English stopword list (179 terms, linguist-maintained)
#   Available in: spacy.lang.en.stop_words — zero-cost import, no model instance needed
#   Replaces: hard-coded frozenset in query_words()
_SPACY_STOPWORDS_CACHE: frozenset[str] | None = None


def _get_spacy_stopwords() -> frozenset[str]:
    """Lazy-load spaCy's curated English stopwords (~179 terms).

    Uses spacy.lang.en.stop_words.STOP_WORDS — a plain Python set from spaCy's
    language data. No model instance required; zero overhead compared to loading
    en_core_web_sm. Falls back to a minimal hand-coded list if spaCy unavailable.
    """
    global _SPACY_STOPWORDS_CACHE
    if _SPACY_STOPWORDS_CACHE is not None:
        return _SPACY_STOPWORDS_CACHE
    try:
        from spacy.lang.en.stop_words import STOP_WORDS as _SPACY_STOP
        _SPACY_STOPWORDS_CACHE = frozenset(_SPACY_STOP)
    except Exception:
        # Fallback to minimal hand-coded list if spaCy unavailable
        _SPACY_STOPWORDS_CACHE = frozenset({
            "a", "an", "the", "is", "was", "are", "were", "be", "been", "being",
            "have", "has", "had", "do", "does", "did", "will", "would", "could",
            "should", "may", "might", "shall", "can", "need", "dare", "ought",
            "used", "to", "of", "in", "on", "at", "by", "for", "with", "about",
            "from", "into", "through", "during", "before", "after", "above",
            "below", "between", "and", "or", "but", "not", "no", "nor", "so",
            "yet", "both", "either", "neither", "each", "few", "more", "most",
            "other", "some", "such", "than", "then", "that", "this", "these",
            "those", "what", "which", "who", "whom", "how", "when", "where",
            "why", "all", "any", "every", "i", "you", "he", "she", "it", "we",
            "they", "me", "him", "her", "us", "them", "my", "your", "his",
            "its", "our", "their",
        })
    return _SPACY_STOPWORDS_CACHE


def query_words(query: str) -> frozenset[str]:
    """Extract meaningful words from a query (lowercase, strip stopwords).

    Uses spaCy's curated English stopword list (~179 terms, lazy-loaded from
    spacy.lang.en.stop_words). Falls back to a minimal hand-coded list if
    spaCy is unavailable.
    """
    stopwords = _get_spacy_stopwords()
    words = frozenset(re.findall(r"\b\w+\b", query.lower()))
    meaningful = words - stopwords
    return meaningful if meaningful else words


# ---------------------------------------------------------------------------
# Word form normalization — maps inflected forms to a canonical stem so
# "birth" matches "born", "won" matches "win", etc.  Zero dependencies.
# ---------------------------------------------------------------------------
# Word normalization: spaCy lemmatizer + derivational bridge
#
# Deterministic SOTA check (2026-04-04):
#   Problem: morphological normalization for keyword matching
#   SOTA: spaCy lemmatizer (en_core_web_sm, already loaded) — handles inflection
#         (won→win, graduated→graduate, cities→city) plus derivational bridge for
#         cross-POS pairs that no lemmatizer covers (birth↔born, death↔died).
#   Available in: spaCy (already loaded in intent.py, engine.py)
#   Effort: 2 hours. Replaces hand-coded _WORD_FORM_MAP (~20 groups).
# ---------------------------------------------------------------------------

# Cross-POS derivational bridge: maps semantically related word forms that
# lemmatizers don't connect (noun↔verb, noun↔adjective across POS boundaries).
# spaCy lemmatizes "born" → "bear" and "died" → "die" but won't connect
# "birth" to "bear" or "death" to "die". The bridge maps both sides to a
# shared canonical form.
_DERIVATIONAL_BRIDGE: dict[str, str] = {}
_DERIVATIONAL_GROUPS: list[tuple[str, list[str]]] = [
    # Life events (noun↔verb/participle)
    ("birth", ["birth", "born", "bear"]),  # spaCy: born→bear; bridge: birth→birth, bear→birth
    ("death", ["death", "dead", "die"]),   # spaCy: died→die; bridge: death→death, die→death
    ("marry", ["marriage", "marry"]),       # spaCy: married→marry; bridge: marriage→marry
    # Achievements (noun↔verb)
    ("elect", ["election", "electoral", "elect"]),
    ("graduate", ["graduation", "graduate"]),
    ("serve", ["service", "serve"]),
    # Creation (noun↔verb↔agent)
    ("found", ["founder", "founding", "founded"]),  # NOT bare "found" (ambiguous: find vs establish)
    ("create", ["creator", "creation", "create"]),
    ("write", ["writer", "wrote", "written", "write"]),
    ("discover", ["discovery", "discover"]),
    ("invent", ["inventor", "invention", "invent"]),
    ("publish", ["publication", "publish"]),
    # Titles (noun↔adjective)
    ("president", ["presidential", "presidency", "president"]),
    ("direct", ["director", "direct"]),
    ("govern", ["governor", "government", "govern"]),
    # Additional cross-POS pairs
    ("divorce", ["divorce", "divorced"]),
    ("appoint", ["appointment", "appoint"]),
    ("nominate", ["nomination", "nominee", "nominate"]),
    ("resign", ["resignation", "resign"]),
    ("retire", ["retirement", "retire"]),
    ("assassinate", ["assassination", "assassin", "assassinate"]),
    ("succeed", ["succession", "successor", "succeed"]),
    ("lose", ["loss", "lose", "defeat"]),
    ("win", ["victory", "winner", "win"]),
]
for _canonical, _forms in _DERIVATIONAL_GROUPS:
    for _form in _forms:
        _DERIVATIONAL_BRIDGE[_form] = _canonical

# Module-level spaCy cache for lemmatization (lazy init, shared across calls)
_spacy_nlp = None
_spacy_init_attempted = False


def _get_spacy_nlp():
    """Lazy-load spaCy en_core_web_sm for lemmatization. Returns None on failure."""
    global _spacy_nlp, _spacy_init_attempted
    if _spacy_init_attempted:
        return _spacy_nlp
    _spacy_init_attempted = True
    try:
        import spacy
        _spacy_nlp = spacy.load("en_core_web_sm", disable=["ner", "parser"])
        _spacy_nlp.max_length = 5_000_000  # large passages can exceed 1M default
        return _spacy_nlp
    except Exception:
        return None


def _lemmatize_words(words: frozenset[str]) -> frozenset[str]:
    """Normalize words via spaCy lemmatization + derivational bridge.

    Two-stage normalization:
    1. spaCy lemmatizer: inflectional morphology (won→win, graduated→graduate,
       cities→city, died→die). Uses en_core_web_sm with NER+parser disabled for speed.
    2. Derivational bridge: cross-POS semantic mapping (birth→birth, bear→birth,
       death→death, die→death). Catches relationships that lemmatizers don't connect.

    Falls back to derivational bridge only if spaCy is unavailable.
    """
    nlp = _get_spacy_nlp()

    if nlp is not None:
        # Batch lemmatize: join words into space-separated string, parse once
        text = " ".join(words)
        doc = nlp(text)
        lemmas = frozenset(token.lemma_.lower() for token in doc)
    else:
        # Fallback: no lemmatization, just lowercase
        lemmas = words

    # Apply derivational bridge on top of lemmas
    return frozenset(_DERIVATIONAL_BRIDGE.get(w, w) for w in lemmas)


# Legacy alias for backward compatibility (used by engine._compute_query_term_coverage)
_WORD_FORM_MAP = _DERIVATIONAL_BRIDGE


def _keyword_score(sentence: str, q_words: frozenset[str]) -> float:
    """
    Score a sentence by keyword overlap with query words.

    Both query words and sentence words are normalized via spaCy lemmatization
    + derivational bridge so that morphological variants match:
    - Inflectional: won↔win, graduated↔graduate, cities↔city (spaCy)
    - Derivational: birth↔born, death↔died, victory↔win (bridge)

    Score = |normalized_query ∩ normalized_sentence| / |normalized_query|
    Returns 0.0 if query_words is empty.
    """
    if not q_words:
        return 0.0
    sentence_words = frozenset(re.findall(r"\b\w+\b", sentence.lower()))
    q_normalized = _lemmatize_words(q_words)
    s_normalized = _lemmatize_words(sentence_words)
    overlap = q_normalized & s_normalized
    return len(overlap) / len(q_normalized)


# ---------------------------------------------------------------------------
# Core compression function
# ---------------------------------------------------------------------------


def compress(text: str, query: str, budget: int, intent=None) -> str:
    """
    Extractive sentence compression: select the most query-relevant sentences
    from ``text`` that fit within ``budget`` tokens.

    Args:
        text:   The LOD_0 verbatim passage to compress.
        query:  The user's query (used to score sentence relevance).
        budget: Maximum token count for the returned text.
        intent: Optional IntentSignal for intent-axis-aware sentence scoring.
                When provided, sentence scoring uses 60% keyword overlap +
                40% intent-axis alignment. When None, pure keyword overlap
                (backward compatible).

    Returns:
        A subset of sentences from ``text``, selected by relevance and ordered
        by original position to preserve narrative flow.

    Behaviour:
        - budget >= full text tokens → return full text unchanged
        - ≤1 sentence → return full text unchanged
        - budget too small for any sentence → truncation fallback (first N words)
    """
    if not text or not text.strip():
        return text

    full_cost = estimate_tokens(text)
    if full_cost <= budget:
        return text  # nothing to compress

    # Table bypass: Markdown tables must not be split into "sentences" — doing so
    # shreds the header-row relationship and produces fragments like "| --- | --- |".
    # Detect table structure before sentence splitting and use a dedicated path.
    if _is_table_text(text):
        return _compress_table(text, budget)

    sentences = split_sentences(text)
    if len(sentences) <= 1:
        return text  # atomic — can't compress below a single sentence

    q_words = query_words(query) if query and query.strip() else frozenset()

    # F14: add temporal reference year as pseudo-keyword so sentences containing
    # the year get a keyword score boost even for non-intent-aware scoring path
    if intent is not None and hasattr(intent, 'temporal_reference_date') and intent.temporal_reference_date is not None:
        q_words = q_words | frozenset([str(intent.temporal_reference_date)])

    # Score each sentence, preserving original index for position re-ordering
    if intent is not None:
        from tp_vrg.intent import intent_sentence_score
        scored: list[tuple[int, float, str]] = [
            (idx, intent_sentence_score(s, intent, q_words), s)
            for idx, s in enumerate(sentences)
        ]
    else:
        scored: list[tuple[int, float, str]] = [
            (idx, _keyword_score(s, q_words), s)
            for idx, s in enumerate(sentences)
        ]

    # Sort by score descending; ties broken by original position (earlier = preferred)
    scored.sort(key=lambda t: (-t[1], t[0]))

    # Greedy selection: pick highest-scored sentences until budget is exhausted
    selected: list[tuple[int, str]] = []
    remaining = budget
    for idx, _score, sentence in scored:
        cost = estimate_tokens(sentence)
        if cost <= remaining:
            selected.append((idx, sentence))
            remaining -= cost
        if remaining <= 0:
            break

    if not selected:
        # Budget too small for even the shortest sentence — truncation fallback
        words = text.split()
        truncated: list[str] = []
        tok_count = 0
        for word in words:
            tok_count += estimate_tokens(word)
            if tok_count > budget:
                break
            truncated.append(word)
        return " ".join(truncated) if truncated else text[:max(1, budget * 4)]

    # Re-order selected sentences by original position (narrative flow)
    selected.sort(key=lambda t: t[0])
    return " ".join(s for _, s in selected)


def estimate_compressed_tokens(text: str, query: str, budget: int, intent=None) -> int:
    """
    Return the token count that ``compress(text, query, budget)`` would produce.

    Useful for the governor to pre-estimate allocation without calling compress.
    """
    result = compress(text, query, budget, intent=intent)
    return estimate_tokens(result)
