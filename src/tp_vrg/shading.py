"""
Topological Shading — Liquid LOD Phase A.

Applies bold/italic formatting to query-relevant sentences within LOD_0 text.
Guides LLM attention deterministically without any LLM or embedder call at
query time.

Three scoring signals combined:
1. Keyword overlap (query words ∩ sentence words, lemmatized + derivational bridge)
2. Sentence position (lead bias: first/last sentences of paragraphs)
3. Discourse connectives ("however", "therefore", "specifically" — transition signals)

Deterministic SOTA check (2026-04-04):
  Problem: deterministic attention guidance for LLM context
  SOTA: sentence position scoring (lead bias), discourse connective detection,
        information density. All derivable from spaCy doc or simple regex.
  Available in: spaCy (loaded), regex patterns
  Replaces: regex-only keyword overlap shading (shipped 2026-03-16)

Sentence-level primitives (split_sentences, _keyword_score, query_words) live
in compression.py — the canonical home for sentence operations shared across
Phase A (shading) and Phase B (extractive compression / LOD_Z).
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

# Re-export sentence primitives from compression.py so existing imports work:
#   from tp_vrg.shading import split_sentences, _keyword_score, query_words
from tp_vrg.compression import (  # noqa: F401
    _keyword_score,
    query_words,
    split_sentences,
)

# Backward compat alias
_query_words = query_words

# ---------------------------------------------------------------------------
# Signal 2: Discourse connectives — sentences containing these phrases signal
# key transitions, conclusions, or specifics that deserve LLM attention.
# ---------------------------------------------------------------------------

_DISCOURSE_CONNECTIVES = re.compile(
    r"\b(?:"
    r"however|therefore|consequently|furthermore|moreover|"
    r"nevertheless|nonetheless|specifically|in\s+particular|"
    r"in\s+contrast|on\s+the\s+other\s+hand|as\s+a\s+result|"
    r"for\s+example|for\s+instance|in\s+fact|notably|"
    r"importantly|significantly|crucially"
    r")\b",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Signal 3: Information density — content word ratio (nouns, verbs, adjectives
# vs total words). Higher ratio = more informational, less filler.
# Computed via simple POS heuristic (capitalized words + verb-like suffixes)
# when spaCy is not available, or via spaCy POS tags when loaded.
# ---------------------------------------------------------------------------

_CONTENT_POS = {"NOUN", "PROPN", "VERB", "ADJ", "NUM"}

# Lazy spaCy cache (shared with compression.py's _get_spacy_nlp)
_shading_spacy_nlp = None
_shading_spacy_attempted = False


def _get_shading_spacy():
    """Lazy-load spaCy for POS tagging. Returns None on failure."""
    global _shading_spacy_nlp, _shading_spacy_attempted
    if _shading_spacy_attempted:
        return _shading_spacy_nlp
    _shading_spacy_attempted = True
    try:
        import spacy
        _shading_spacy_nlp = spacy.load("en_core_web_sm", disable=["ner"])
        return _shading_spacy_nlp
    except Exception:
        return None


def _information_density(sentence: str) -> float:
    """Ratio of content words to total words. Range [0.0, 1.0]."""
    nlp = _get_shading_spacy()
    words = sentence.split()
    if not words:
        return 0.0

    if nlp is not None:
        doc = nlp(sentence)
        content_count = sum(1 for token in doc if token.pos_ in _CONTENT_POS)
        total = len(doc)
        return content_count / total if total > 0 else 0.0

    # Fallback heuristic: capitalized words + common verb suffixes as proxy
    content = sum(
        1 for w in words
        if w[0].isupper() or w.endswith(("ed", "ing", "tion", "ment", "ness"))
    )
    return content / len(words)


def _composite_score(
    sentence: str,
    q_words: frozenset[str],
    position_idx: int,
    total_sentences: int,
    paragraph_start: bool,
    paragraph_end: bool,
) -> float:
    """Combine three signals into a composite shading score.

    Weights:
    - Keyword overlap: 0.60 (primary signal — query relevance)
    - Position bias:   0.20 (lead/trail sentences carry more information)
    - Discourse:       0.10 (connectives signal key transitions)
    - Info density:    0.10 (content-heavy sentences over filler)
    """
    # Signal 1: Keyword overlap (0.0 - 1.0)
    kw_score = _keyword_score(sentence, q_words)

    # Signal 2: Position bias (0.0 - 1.0)
    pos_score = 0.0
    if paragraph_start:
        pos_score = 1.0  # First sentence of paragraph (topic sentence)
    elif paragraph_end:
        pos_score = 0.6  # Last sentence (conclusion/summary)
    elif total_sentences > 2:
        # Middle sentences: slight decay from start
        pos_score = max(0.0, 0.4 - (position_idx / total_sentences) * 0.3)

    # Signal 3: Discourse connective (0.0 or 1.0)
    discourse_score = 1.0 if _DISCOURSE_CONNECTIVES.search(sentence) else 0.0

    # Signal 4: Information density (0.0 - 1.0)
    density_score = _information_density(sentence)

    return (
        0.60 * kw_score
        + 0.20 * pos_score
        + 0.10 * discourse_score
        + 0.10 * density_score
    )


def apply_topological_shading(
    text: str,
    query: str,
    top_fraction: float = 0.30,
) -> str:
    """
    Apply bold formatting to the most informative sentences in LOD_0 text.

    Scores each sentence by a 4-signal composite:
    1. Keyword overlap with query (lemmatized, 60% weight)
    2. Sentence position — lead bias (20% weight)
    3. Discourse connectives — transition signals (10% weight)
    4. Information density — content word ratio (10% weight)

    Then bolds the top ``top_fraction`` of sentences (minimum 1).

    Args:
        text: The LOD_0 verbatim text to shade.
        query: The user's query string.
        top_fraction: Fraction of sentences to bold (default 0.30 = top 30%).

    Returns:
        Text with **bold** applied to the most informative sentences.
        Returns original text unchanged if no sentences can be scored.
    """
    if not text or not text.strip() or not query or not query.strip():
        return text

    sentences = split_sentences(text)
    if len(sentences) <= 1:
        q_words = _query_words(query)
        score = _keyword_score(text.strip(), q_words)
        if score > 0:
            return f"**{text.strip()}**"
        return text

    q_words = _query_words(query)

    # Detect paragraph boundaries for position scoring.
    # Paragraph = block of text separated by double newline.
    # Mark first and last sentence of each paragraph.
    para_starts: set[int] = {0}  # First sentence is always a paragraph start
    para_ends: set[int] = {len(sentences) - 1}  # Last sentence is always a paragraph end

    # Scan for paragraph breaks: if a sentence ends with \n\n or the next
    # sentence follows a double newline in the original text
    running_pos = 0
    for i, sent in enumerate(sentences):
        pos = text.find(sent, running_pos)
        if pos >= 0:
            # Check if there's a double newline before this sentence
            gap = text[running_pos:pos]
            if "\n\n" in gap and i > 0:
                para_starts.add(i)
                para_ends.add(i - 1)
            running_pos = pos + len(sent)

    scored: list[tuple[str, float]] = []
    for i, sentence in enumerate(sentences):
        score = _composite_score(
            sentence,
            q_words,
            position_idx=i,
            total_sentences=len(sentences),
            paragraph_start=(i in para_starts),
            paragraph_end=(i in para_ends),
        )
        scored.append((sentence, score))

    # Determine how many to bold
    n_bold = max(1, int(len(sentences) * top_fraction))

    # Sort by score descending to find threshold
    sorted_scores = sorted((sc for _, sc in scored), reverse=True)
    threshold = sorted_scores[n_bold - 1]

    # Only bold if there's at least one sentence with keyword overlap.
    # Position/density signals alone shouldn't trigger bolding — bolding
    # means "this is relevant to YOUR query", not "this is generally important."
    any_keyword_overlap = any(_keyword_score(s, q_words) > 0 for s, _ in scored)

    shaded: list[str] = []
    bold_count = 0
    for sentence, score in scored:
        should_bold = (
            any_keyword_overlap
            and score >= threshold
            and score > 0
            and bold_count < n_bold
        )
        if should_bold:
            shaded.append(f"**{sentence}**")
            bold_count += 1
        else:
            shaded.append(sentence)

    return " ".join(shaded)
