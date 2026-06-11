"""Render confidence L(C|Q) — diagnostic-only (C.1).

Performance-optimized: parses the entire rendered context ONCE with spaCy,
then scores each sentence from the cached parse. Without this, 111 sentences
× 7 axis matchers = 777 spaCy parse calls (~30s). With batch parse: ~0.5s.
"""

from __future__ import annotations

import re
from typing import Any

from tp_vrg.models import (
    RENDER_CONFIDENCE_ALPHA,
    RENDER_CONFIDENCE_BETA,
    RENDER_CONFIDENCE_GAMMA,
    RENDER_CONFIDENCE_SENTENCE_THRESHOLD,
)


def _batch_sentence_scores(
    sentences: list[str],
    intent: Any,
    query_words: frozenset[str],
    storage: Any = None,
) -> list[float]:
    """Score all sentences using cached sentence profiles (fiber-basis).

    When storage is available, looks up pre-computed NER/POS/lemma profiles
    by sentence hash. Cache misses fall back to individual per-sentence
    spaCy parsing — never joins all sentences (prevents 2.75M-char crash).
    """
    import hashlib
    from tp_vrg.intent import _get_intent_spacy_nlp

    content_axes = getattr(intent, "content_axes", {})
    active_weights = {
        axis: weight for axis, weight in content_axes.items() if weight >= 0.05
    }

    # Attempt cache lookup via storage
    n = len(sentences)
    sent_ent_labels: list[set[str]] = [set() for _ in range(n)]
    sent_pos_tags: list[set[str]] = [set() for _ in range(n)]
    sent_lemmas: list[set[str]] = [set() for _ in range(n)]
    uncached_indices: list[int] = []

    hashes = [hashlib.sha256(s.strip().encode()).hexdigest()[:24] for s in sentences]

    if storage is not None:
        try:
            cached = storage.get_sentence_profiles_batch(hashes)
        except Exception:
            cached = {}
    else:
        cached = {}

    for i, h in enumerate(hashes):
        if h in cached:
            ents, pos, lem = cached[h]
            sent_ent_labels[i] = set(ents)
            sent_pos_tags[i] = set(pos)
            sent_lemmas[i] = set(lem)
        else:
            uncached_indices.append(i)

    # Fallback: parse uncached sentences individually (never joins all)
    if uncached_indices:
        nlp = _get_intent_spacy_nlp()
        if nlp is not None:
            for i in uncached_indices:
                doc = nlp(sentences[i])
                sent_ent_labels[i] = {ent.label_ for ent in doc.ents}
                sent_pos_tags[i] = {tok.pos_ for tok in doc}
                sent_lemmas[i] = {tok.lemma_.lower() for tok in doc}
        else:
            # No spaCy at all — pure keyword scoring
            from tp_vrg.intent import intent_sentence_score
            return [intent_sentence_score(s, intent, query_words) for s in sentences]

    # Score each sentence using profiles (cached or freshly parsed)
    scores: list[float] = []
    for i, sent in enumerate(sentences):
        if query_words:
            sentence_words = frozenset(re.findall(r"\b\w+\b", sent.lower()))
            keyword_score = len(query_words & sentence_words) / len(query_words)
        else:
            keyword_score = 0.0

        ent_labels = sent_ent_labels[i]
        pos_tags = sent_pos_tags[i]
        lemmas = sent_lemmas[i]

        axis_score = 0.0
        active_weight_sum = 0.0
        for axis, weight in active_weights.items():
            match_val = _fast_axis_match(axis, ent_labels, pos_tags, lemmas, sent)
            axis_score += weight * match_val
            active_weight_sum += weight

        if active_weight_sum > 0:
            axis_score /= active_weight_sum

        base = 0.6 * keyword_score + 0.4 * axis_score
        scores.append(base)

    return scores


def compute_sentence_profiles(
    sentences: list[str],
) -> list[tuple[str, int, list[str], list[str], list[str]]]:
    """Pre-compute NER/POS/lemma profiles for sentences (fiber-basis).

    Returns list of (sentence_hash, sentence_idx, ent_labels, pos_tags, lemmas).
    Designed to run at ingest time so query-time render confidence is a cache lookup.
    Parses each sentence individually — never joins into a single huge doc.
    """
    import hashlib
    from tp_vrg.intent import _get_intent_spacy_nlp

    nlp = _get_intent_spacy_nlp()
    profiles: list[tuple[str, int, list[str], list[str], list[str]]] = []

    for idx, sent in enumerate(sentences):
        sent_hash = hashlib.sha256(sent.strip().encode()).hexdigest()[:24]
        if nlp is not None:
            doc = nlp(sent)
            ent_labels = sorted({ent.label_ for ent in doc.ents})
            pos_tags = sorted({tok.pos_ for tok in doc})
            lemmas = sorted({tok.lemma_.lower() for tok in doc})
        else:
            ent_labels = []
            pos_tags = []
            lemmas = []
        profiles.append((sent_hash, idx, ent_labels, pos_tags, lemmas))

    return profiles


def _fast_axis_match(
    axis: str,
    ent_labels: set[str],
    pos_tags: set[str],
    lemmas: set[str],
    sentence: str,
) -> float:
    """Fast axis matching using pre-computed NER/POS/lemma from batch parse."""
    if axis == "temporal":
        return 1.0 if ({"DATE", "TIME"} & ent_labels) else 0.0
    elif axis == "social":
        if "PERSON" in ent_labels:
            return 1.0
        _personal = {"he", "she", "him", "her", "his", "himself", "herself"}
        return 1.0 if ("PRON" in pos_tags and (lemmas & _personal)) else 0.0
    elif axis == "factual":
        if ent_labels & {"CARDINAL", "MONEY", "PERCENT", "QUANTITY", "ORDINAL"}:
            return 1.0
        return 1.0 if ("be" in lemmas and ({"a", "an"} & lemmas)) else 0.0
    elif axis == "location":
        return 1.0 if (ent_labels & {"GPE", "LOC", "FAC"}) else 0.0
    elif axis == "professional":
        return 1.0 if (ent_labels & {"ORG", "NORP"}) else 0.0
    elif axis == "activity":
        return 1.0 if (ent_labels & {"EVENT"}) else 0.0
    elif axis == "method":
        _method_lemmas = {"use", "apply", "implement", "build", "create", "develop", "design"}
        return 1.0 if (lemmas & _method_lemmas) else 0.0
    return 0.0


def _compute_entity_coverage(query: str, rendered_context: str) -> tuple[float, list[str], list[str]]:
    """Check what fraction of query's distinctive terms appear in the context.

    Extracts proper nouns, numbers, and quoted phrases from the query.
    Returns (coverage_fraction, terms_found, terms_missing).

    This addresses the Goodhart pattern: axis activation measures "right topic"
    but entity coverage measures "right answer present."
    """
    context_lower = rendered_context.lower()

    # Extract distinctive query terms (not stopwords, not common words)
    _SKIP_WORDS = frozenset({
        "what", "where", "when", "who", "how", "why", "which", "does", "did",
        "is", "are", "was", "were", "the", "a", "an", "if", "and", "or", "but",
        "for", "in", "on", "at", "to", "of", "by", "from", "with", "that",
        "this", "not", "no", "do", "has", "have", "had", "be", "been",
    })
    # 1. Proper nouns (capitalized multi-word or single capitalized)
    proper_nouns = [
        pn for pn in re.findall(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b', query)
        if pn.lower() not in _SKIP_WORDS
    ]
    # 2. Numbers and dollar amounts
    numbers = re.findall(r'\$[\d,.]+|\b\d[\d,.]+\b', query)
    # 3. Quoted phrases
    quoted = re.findall(r'"([^"]+)"', query)

    # 4. Distinctive content words (not stopwords, length >= 6 to skip noise)
    # Catches domain terms like "antitrust", "terminated", "stockholders"
    # that aren't proper nouns but are query-specific
    _EXTRA_SKIP = frozenset({
        "would", "could", "should", "about", "after", "before", "between",
        "still", "there", "their", "these", "those", "other", "every",
        "under", "above", "below", "where", "while", "since", "until",
        "being", "might", "shall", "which", "whose", "again", "along",
        "among", "doing", "during", "either", "enough", "rather",
        "reasons", "single", "fixed", "playing", "continue",
    })
    query_content_words = [
        w for w in re.findall(r'\b[a-z]{6,}\b', query.lower())
        if w not in _SKIP_WORDS and w not in _EXTRA_SKIP
    ]
    # Deduplicate against proper nouns (avoid double-counting "Merger" and "merger")
    existing_lower = {t.lower() for t in proper_nouns + numbers + quoted}
    content_words_unique = [w for w in set(query_content_words) if w not in existing_lower]

    all_terms = list(set(proper_nouns + numbers + quoted + content_words_unique))
    if not all_terms:
        return 1.0, [], []  # no distinctive terms → assume covered

    found = [t for t in all_terms if t.lower() in context_lower]
    missing = [t for t in all_terms if t.lower() not in context_lower]

    coverage = len(found) / len(all_terms) if all_terms else 1.0
    return coverage, found, missing


def compute_render_confidence(
    rendered_context: str,
    query: str,
    intent: Any,
    alpha: float = RENDER_CONFIDENCE_ALPHA,
    beta: float = RENDER_CONFIDENCE_BETA,
    gamma: float = RENDER_CONFIDENCE_GAMMA,
    storage: Any = None,
) -> dict[str, Any]:
    """Compute L(C|Q) from coverage × cleanliness × entity_coverage.

    Three factors:
    - coverage: do the query's intent axes have matching sentences? (topic match)
    - cleanliness: what fraction of sentences are relevant? (noise level)
    - entity_coverage: do the query's specific entities/terms appear? (answer presence)

    The entity_coverage factor addresses the Goodhart pattern where axis activation
    is high (right topic) but the specific answer is missing.

    When storage is provided, uses fiber-basis cached sentence profiles
    (pre-computed at ingest time). Falls back to per-sentence parsing on
    cache miss — never joins all sentences into one huge spaCy doc.
    """
    sentences = [
        s.strip() for s in re.split(r"(?<=[.!?])\s+", rendered_context or "") if s.strip()
    ]
    if not sentences:
        return {
            "L": 0.0,
            "coverage": 0.0,
            "cleanliness": 0.0,
            "entity_coverage": 0.0,
            "entity_terms_found": [],
            "entity_terms_missing": [],
            "axis_profile": {},
            "n_sentences": 0,
            "n_clean": 0,
            "active_axes": [],
        }

    query_words = frozenset(re.findall(r"\b\w+\b", (query or "").lower()))
    content_axes = getattr(intent, "content_axes", {})
    active_axes = [axis for axis, weight in content_axes.items() if weight > 0.3]

    # Fiber-basis: use cached profiles when available, per-sentence fallback
    sentence_scores = _batch_sentence_scores(sentences, intent, query_words, storage=storage)

    # Per-axis accumulation
    axis_sums = {ax: 0.0 for ax in active_axes}
    for score in sentence_scores:
        for axis in active_axes:
            axis_sums[axis] += score

    if active_axes:
        covered = sum(1 for ax in active_axes if axis_sums.get(ax, 0.0) > 0.0)
        coverage = covered / len(active_axes)
    else:
        coverage = 1.0

    clean_count = sum(1 for s in sentence_scores if s > RENDER_CONFIDENCE_SENTENCE_THRESHOLD)
    cleanliness = clean_count / len(sentences)

    # Entity coverage: specific query terms present in rendered context
    entity_cov, terms_found, terms_missing = _compute_entity_coverage(
        query, rendered_context
    )

    L = (coverage ** alpha) * (cleanliness ** beta) * (entity_cov ** gamma)

    return {
        "L": round(L, 4),
        "coverage": round(coverage, 4),
        "cleanliness": round(cleanliness, 4),
        "entity_coverage": round(entity_cov, 4),
        "entity_terms_found": terms_found,
        "entity_terms_missing": terms_missing,
        "n_sentences": len(sentences),
        "n_clean": clean_count,
        "active_axes": active_axes,
        "axis_profile": {k: round(v, 4) for k, v in axis_sums.items()},
    }
