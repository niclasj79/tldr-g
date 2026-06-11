"""Deterministic intent classification from query text.

Four-layer pipeline:
  1. WH-word detection (spaCy doc[0] token analysis)
  2. GLiNER entity detection on query string
  3. Root verb lookup (spaCy dep-parse)
  4. Traversal signals (structural patterns)

Cost: $0.  Latency: <10ms.  Deterministic.  No LLM calls.

The output IntentSignal has two geometric components (see
design/intent-vector-architecture.md):
  - content_axes: tangent vector in fiber space (which aspects to illuminate)
  - traversal scalars: connection on the fiber bundle (how to navigate the graph)

See design/intent-vector-architecture.md for the full design rationale.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

INTENT_AXES: list[str] = [
    "temporal", "social", "factual", "location",
    "method", "activity", "professional",
]

WH_AXIS_MAP: dict[str, tuple[str, float]] = {
    "when": ("temporal", 1.0),
    "who": ("social", 1.0),
    "whom": ("social", 1.0),
    "what": ("factual", 0.8),
    "which": ("factual", 0.8),
    "where": ("location", 1.0),
    "how": ("method", 0.8),
}

# "what date/year/time" overrides to temporal
_TEMPORAL_WHAT_PATTERNS: re.Pattern = re.compile(
    r"\bwhat\s+(?:[\w-]+\s+){0,5}(?:date|year|time|day|month|hour)\b", re.IGNORECASE
)

# SOTA: unified entity→axis mapping covering both GLiNER labels and spaCy NER tags
ENTITY_TYPE_TO_AXIS: dict[str, str] = {
    # GLiNER entity types (lowercase, match GLiNERSpacyProvider.ENTITY_TYPES)
    "person": "social",
    "organization": "professional",
    "location": "location",
    "activity": "activity",
    "hobby": "activity",
    "event": "temporal",
    "technology": "factual",
    "concept": "factual",
    # spaCy NER labels (UPPERCASE, from en_core_web_sm / en_core_web_trf)
    "PERSON": "social",
    "ORG": "professional",
    "GPE": "location",        # geo-political entity (country, city, state)
    "LOC": "location",        # non-GPE location (mountain, river)
    "FAC": "location",        # facility (airport, bridge)
    "EVENT": "temporal",
    "DATE": "temporal",
    "TIME": "temporal",
    "PRODUCT": "factual",
    "WORK_OF_ART": "factual",
    "LAW": "factual",
    "NORP": "social",         # nationality, religion, political group
    "LANGUAGE": "factual",
    "MONEY": "factual",
    "QUANTITY": "factual",
    "ORDINAL": "factual",
    "CARDINAL": "factual",
    "PERCENT": "factual",
}

# GLiNER entity types — must match GLiNERSpacyProvider.ENTITY_TYPES
_GLINER_ENTITY_TYPES: list[str] = [
    "person", "organization", "technology", "concept", "event", "location",
    "activity", "hobby",
]

VERB_AXIS_MAP: dict[str, str] = {
    # Temporal
    "happen": "temporal", "start": "temporal", "end": "temporal",
    "begin": "temporal", "occur": "temporal", "change": "temporal",
    "finish": "temporal",
    # Social
    "meet": "social", "share": "social", "know": "social", "like": "social",
    "love": "social", "marry": "social", "date": "social",
    # Professional
    "work": "professional", "hire": "professional", "fire": "professional",
    "lose": "professional", "quit": "professional", "join": "professional",
    "manage": "professional",
    # Activity
    "play": "activity", "practice": "activity", "do": "activity",
    "train": "activity", "enjoy": "activity", "watch": "activity",
    # Factual / possession
    "collect": "factual", "own": "factual", "buy": "factual",
    "have": "factual", "get": "factual",
    # Location
    "live": "location", "move": "location", "visit": "location",
    "travel": "location", "go": "location",
}

# Exhaustiveness signal words
_EXHAUSTIVE_PATTERN: re.Pattern = re.compile(
    r"\b(?:all|every|each|list|everything|everyone|everybody)\b", re.IGNORECASE
)

# Specificity signal words
_EXACT_PATTERN: re.Pattern = re.compile(
    r"\b(?:exact|exactly|specific|specifically|precisely|precise)\b", re.IGNORECASE
)
_OVERVIEW_PATTERN: re.Pattern = re.compile(
    r"\b(?:tell me about|what do you know about|describe|overview|summarize)\b",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Reasoning-intent dimension (query-manifold input field, distinct from
# content_axes). Answers "what reasoning shape is this query?" — orthogonal to
# content_axes' "what content domain?". Introduced 2026-05-27 per the
# query-manifold decomposed-field consumption audit (Finding 2 + Finding 3,
# founder Decision B): the content-axis vocabulary models content-DOMAIN, not
# reasoning-INTENT, so reasoning-shape queries (why/compare/what-would/…)
# collapsed to factual. reasoning_intent is derived from the already-computed
# wh_type + root_verb + syntactic shape (previously discarded as debug-only).
#
# Vocabulary uses `_lookup`-suffixed names for the two retrieval-bearing classes
# to disambiguate from the same-named content_axes ("temporal", "factual") per
# the canonical-vocabulary compound-label discipline.
#
# This sprint wires ONE retrieval mode live: temporal_lookup (the category_3
# slice with a failing benchmark) routes through date-seeking retrieval +
# scoring; everything else routes through the factual_lookup default. The other
# classes are classified + surfaced on the Cockpit badge but their dedicated
# retrieval strategies (comparative / analytical / procedural / exploratory)
# are use-case-justified follow-ons (no dead affordances).
# ---------------------------------------------------------------------------

REASONING_INTENTS: list[str] = [
    "temporal_lookup",   # "when did X happen?", "what happened on D?" — date is the answer
    "factual_lookup",    # default — direct fact retrieval
    "analytical",        # "why …?", "what caused …?"
    "comparative",       # "compare …", "X versus Y", "difference between …"
    "hypothetical",      # "what would …?", "could … without …?", "if … then …?"
    "exploratory",       # "tell me about …", "overview", "how is X organized?"
    "procedural",        # "walk me through …", "step by step", "how does X flow?"
]

# Surface patterns for reasoning-intent classification. Evaluation order in
# _classify_reasoning_intent is significant (most-distinctive shapes first).
_RI_HYPOTHETICAL: re.Pattern = re.compile(
    r"\b(?:what\s+would|what\s+if|could\s+.*\bwithout\b|would\s+.*\bwithout\b|"
    r"if\s+.+\b(?:then|would|happen)\b|hypothetical(?:ly)?|imagine\s+if|suppose\s+)\b",
    re.IGNORECASE,
)
_RI_COMPARATIVE: re.Pattern = re.compile(
    r"\b(?:compare[ds]?|comparison|versus|vs\.?|difference\s+between|compared\s+to|"
    r"better\s+than|worse\s+than|trade[\s-]?offs?\s+between)\b",
    re.IGNORECASE,
)
_RI_PROCEDURAL: re.Pattern = re.compile(
    r"(?:\bwalk\s+me\s+through\b|\bstep[\s-]by[\s-]step\b|\bsteps\s+to\b|"
    r"\bhow\s+to\b|\bhow\s+do(?:es)?\s+.+\b(?:flow|work|run|execute|happen)\b|"
    r"\bguide\s+me\b|\bprocedure\s+for\b)",
    re.IGNORECASE,
)
_RI_ANALYTICAL: re.Pattern = re.compile(
    r"\b(?:why|what\s+caused|what\s+led\s+to|reasons?\s+(?:for|why)|"
    r"rationale|explain\s+why)\b",
    re.IGNORECASE,
)
_RI_TEMPORAL: re.Pattern = re.compile(
    r"(?:\bwhen\b|\bwhat\s+happened\b|\bwhat\s+date\b|\bon\s+what\s+(?:day|date)\b|"
    r"\bhow\s+long\s+ago\b|\bat\s+what\s+(?:time|point)\b)",
    re.IGNORECASE,
)
_RI_EXPLORATORY: re.Pattern = re.compile(
    r"(?:\btell\s+me\s+about\b|\bwhat\s+do\s+you\s+know\s+about\b|\boverview\b|"
    r"\bdescribe\b|\bsummari[sz]e\b|\bhow\s+is\s+.+\b(?:organi[sz]ed|structured)\b|"
    r"\bgive\s+me\s+a\s+sense\b)",
    re.IGNORECASE,
)


def _classify_reasoning_intent(
    query: str, wh_type: str = "what", root_verb: str = ""
) -> str:
    """Classify the reasoning shape of a query (the reasoning_intent dimension).

    Deterministic, $0, <1ms. Derived from the query surface + the already-computed
    wh_type. Order is significant: the most-distinctive shapes (hypothetical,
    comparative, procedural) are tested before the broader ones so a query like
    "How does X compare to Y?" classifies comparative, not procedural/exploratory.

    Returns one of REASONING_INTENTS. Defaults to "factual_lookup".
    """
    q = (query or "").strip()
    if not q:
        return "factual_lookup"
    if _RI_HYPOTHETICAL.search(q):
        return "hypothetical"
    if _RI_COMPARATIVE.search(q):
        return "comparative"
    if _RI_PROCEDURAL.search(q):
        return "procedural"
    if _RI_ANALYTICAL.search(q):
        return "analytical"
    if _RI_TEMPORAL.search(q) or wh_type == "when":
        return "temporal_lookup"
    if _RI_EXPLORATORY.search(q):
        return "exploratory"
    return "factual_lookup"


# ---------------------------------------------------------------------------
# Axis sentence matchers — spaCy NER + POS for render-time scoring
#
# Deterministic SOTA check (2026-04-04):
#   Problem: 7 regex patterns miss contextual entity boundaries (e.g. regex
#            flags "Tuesday meetings" as temporal; spaCy NER does not).
#   SOTA: spaCy NER entity labels (DATE, TIME, PERSON, GPE, LOC, ORG, etc.)
#         + POS tags — both available in en_core_web_sm (already loaded).
#   Available in: spaCy (already loaded for classify_intent()).
#   Replaces: 7 regex-based _has_*_markers() functions.
# ---------------------------------------------------------------------------

# Fallback regex constants (used only when spaCy is unavailable)
_RE_TEMPORAL_FALLBACK = re.compile(
    r"(?:"
    r"\b\d{4}\b"
    r"|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)"
    r"(?:\s+\d{1,2})?"
    r"|\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2}"
    r"|\b\d{1,2}(?:st|nd|rd|th)\b"
    r"|\b(?:yesterday|today|tomorrow|last\s+(?:week|month|year)|next\s+(?:week|month|year))\b"
    r"|\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b"
    r"|\b\d{1,2}:\d{2}\b"
    r"|\b\d{1,2}/\d{1,2}/\d{2,4}\b"
    r")",
    re.IGNORECASE,
)
_RE_PERSON_NAMES_FALLBACK = re.compile(
    r"(?:"
    r"\b(?:Mr|Mrs|Ms|Dr|Prof|Sir|Lady)\.\s+[A-Z][a-z]+"
    r"|(?<![.!?]\s)\b[A-Z][a-z]+\s+[A-Z][a-z]+"
    r")",
    0,
)
_RE_PERSON_PRONOUNS_FALLBACK = re.compile(
    r"\b(?:he|she|his|her|him|himself|herself)\b",
    re.IGNORECASE,
)
_RE_FACTUAL_FALLBACK = re.compile(
    r"(?:"
    r"\bis\s+(?:a|an|the)\b"
    r"|\brefers?\s+to\b"
    r"|\bmeans?\b"
    r"|\bdefin(?:e|ed|ition)\b"
    r"|\b\d+(?:\.\d+)?(?:\s*%|\s*percent)\b"
    r"|\b\d{2,}\b"
    r")",
    re.IGNORECASE,
)
_RE_LOCATION_FALLBACK = re.compile(
    r"(?:"
    r"\b(?:in|at|from|near|outside|inside)\s+[A-Z][a-z]+"
    r"|\b(?:city|town|country|state|village|district|region|street|avenue|road)\b"
    r")",
    0,
)
_RE_ACTIVITY_FALLBACK = re.compile(
    r"(?:"
    r"\b(?:play(?:s|ed|ing)?|practic(?:e[sd]?|ing)|train(?:s|ed|ing)?|enjoy(?:s|ed|ing)?)\b"
    r"|\b(?:hiking|swimming|running|dancing|painting|cooking|reading|writing|yoga|martial\s+arts"
    r"|kickboxing|taekwondo|boxing|football|basketball|soccer|tennis|golf|chess|fishing)\b"
    r")",
    re.IGNORECASE,
)
_RE_PROFESSIONAL_FALLBACK = re.compile(
    r"(?:"
    r"\b(?:works?\s+(?:at|for)|hired|fired|employed|unemployed|quit|resigned|promoted|demoted)\b"
    r"|\b(?:job|career|position|role|salary|company|employer|employee|manager|director|CEO|CTO)\b"
    r")",
    re.IGNORECASE,
)
_RE_METHOD_FALLBACK = re.compile(
    r"(?:"
    r"\b(?:by|using|via|through|step|steps|procedure|process|method|approach)\b"
    r"|\b(?:first|second|third|then|next|finally|afterward)\b"
    r"|\b\d+\)\s"
    r")",
    re.IGNORECASE,
)

# Full spaCy pipeline (NER + POS) for axis matchers — separate from the query
# classifier's spaCy instance (which uses the caller-provided spacy_nlp parameter).
_intent_spacy_nlp = None
_intent_spacy_attempted = False


def _get_intent_spacy_nlp():
    """Lazy-load full en_core_web_sm for NER + POS tagging in axis matchers."""
    global _intent_spacy_nlp, _intent_spacy_attempted
    if _intent_spacy_attempted:
        return _intent_spacy_nlp
    _intent_spacy_attempted = True
    try:
        import spacy
        _intent_spacy_nlp = spacy.load("en_core_web_sm")
        # Default max_length (1M) is sufficient — fiber-basis ensures
        # render_confidence parses individual sentences, not full context.
        return _intent_spacy_nlp
    except Exception:
        return None


def _analyze_sentence(sentence: str):
    """Parse sentence and return (ent_labels, pos_tags, lemmas).

    Returns (None, None, None) if spaCy is unavailable, which triggers
    regex fallback in each matcher.
    """
    nlp = _get_intent_spacy_nlp()
    if nlp is None:
        return None, None, None
    doc = nlp(sentence)
    ent_labels = {ent.label_ for ent in doc.ents}
    pos_tags = {token.pos_ for token in doc}
    lemmas = {token.lemma_.lower() for token in doc}
    return ent_labels, pos_tags, lemmas


def _has_temporal_markers(sentence: str) -> float:
    """1.0 if sentence contains DATE or TIME NER entities (spaCy), else regex fallback."""
    ent_labels, _, _ = _analyze_sentence(sentence)
    if ent_labels is None:
        return 1.0 if _RE_TEMPORAL_FALLBACK.search(sentence) else 0.0
    return 1.0 if ({"DATE", "TIME"} & ent_labels) else 0.0


def _has_person_markers(sentence: str) -> float:
    """1.0 if sentence contains PERSON entities or personal pronouns (spaCy)."""
    ent_labels, pos_tags, lemmas = _analyze_sentence(sentence)
    if ent_labels is None:
        if _RE_PERSON_NAMES_FALLBACK.search(sentence):
            return 1.0
        return 1.0 if _RE_PERSON_PRONOUNS_FALLBACK.search(sentence) else 0.0
    if "PERSON" in ent_labels:
        return 1.0
    _personal_pronouns = {"he", "she", "him", "her", "his", "himself", "herself"}
    if "PRON" in pos_tags and (lemmas & _personal_pronouns):
        return 1.0
    return 0.0


def _has_factual_markers(sentence: str) -> float:
    """1.0 if sentence contains numeric NER entities or copular is-a patterns (spaCy)."""
    ent_labels, _, lemmas = _analyze_sentence(sentence)
    if ent_labels is None:
        return 1.0 if _RE_FACTUAL_FALLBACK.search(sentence) else 0.0
    if ent_labels & {"CARDINAL", "MONEY", "PERCENT", "QUANTITY", "ORDINAL"}:
        return 1.0
    if "be" in lemmas and ({"a", "an"} & lemmas):
        return 1.0
    return 0.0


def _has_location_markers(sentence: str) -> float:
    """1.0 if sentence contains GPE, LOC, or FAC NER entities (spaCy)."""
    ent_labels, _, _ = _analyze_sentence(sentence)
    if ent_labels is None:
        return 1.0 if _RE_LOCATION_FALLBACK.search(sentence) else 0.0
    return 1.0 if (ent_labels & {"GPE", "LOC", "FAC"}) else 0.0


def _has_activity_markers(sentence: str) -> float:
    """1.0 if sentence contains EVENT entity or activity verb lemmas (spaCy)."""
    ent_labels, _, lemmas = _analyze_sentence(sentence)
    if ent_labels is None:
        return 1.0 if _RE_ACTIVITY_FALLBACK.search(sentence) else 0.0
    if "EVENT" in ent_labels:
        return 1.0
    _activity_lemmas = {
        "play", "practice", "train", "enjoy", "hike", "swim", "run", "dance",
        "paint", "cook", "read", "write", "fish",
    }
    return 1.0 if (lemmas & _activity_lemmas) else 0.0


def _has_professional_markers(sentence: str) -> float:
    """1.0 if sentence contains ORG entity or professional verb/noun lemmas (spaCy)."""
    ent_labels, _, lemmas = _analyze_sentence(sentence)
    if ent_labels is None:
        return 1.0 if _RE_PROFESSIONAL_FALLBACK.search(sentence) else 0.0
    if "ORG" in ent_labels:
        return 1.0
    _prof_lemmas = {
        "work", "hire", "fire", "employ", "quit", "resign", "promote", "demote",
        "job", "career", "position", "role", "salary", "company", "employer",
        "employee", "manager", "director",
    }
    return 1.0 if (lemmas & _prof_lemmas) else 0.0


def _has_method_markers(sentence: str) -> float:
    """1.0 if sentence contains ORDINAL entity or method/procedure lemmas (spaCy)."""
    ent_labels, _, lemmas = _analyze_sentence(sentence)
    if ent_labels is None:
        return 1.0 if _RE_METHOD_FALLBACK.search(sentence) else 0.0
    if "ORDINAL" in ent_labels:
        return 1.0
    _method_lemmas = {
        "use", "via", "through", "step", "procedure", "process",
        "method", "approach", "first", "second", "third", "then", "next", "finally",
    }
    return 1.0 if (lemmas & _method_lemmas) else 0.0


AXIS_SENTENCE_MATCHERS: dict[str, Callable[[str], float]] = {
    "temporal": _has_temporal_markers,
    "social": _has_person_markers,
    "factual": _has_factual_markers,
    "location": _has_location_markers,
    "activity": _has_activity_markers,
    "professional": _has_professional_markers,
    "method": _has_method_markers,
}


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class IntentSignal:
    """Complete intent decomposition of a query.

    Two geometric components (fiber bundle formalization):
    - content_axes: tangent vector — selects which aspects of knowledge to show
    - traversal scalars: connection — modulates graph navigation strategy
    """

    # Content direction: which aspects of knowledge to illuminate
    content_axes: dict[str, float] = field(default_factory=dict)

    # Traversal mode: how to navigate the graph
    exhaustiveness: float = 0.5   # 0.0=mention-some, 1.0=mention-all
    reasoning_depth: float = 0.0  # 0.0=direct retrieval, 1.0=multi-step
    specificity: float = 0.5      # 0.0=overview, 1.0=exact recall

    # Raw signals (for debugging and Cockpit display)
    wh_type: str = "what"
    detected_entities: list[str] = field(default_factory=list)
    root_verb: str = ""

    # F14 Temporal Reasoning: reference year extracted from query (e.g. 2015)
    temporal_reference_date: int | None = None

    # Domain detection: content domain inferred from query vocabulary + NER.
    # Steers answer prompt persona and citation style.
    domain: str = "general"

    # Reasoning-intent dimension (query-manifold input field; orthogonal to
    # content_axes). One of REASONING_INTENTS. Derived from wh_type + root_verb
    # + syntactic shape. Consumed by: Cockpit badge (display) + temporal-lookup
    # retrieval/scoring routing (reasoning_intent == "temporal_lookup").
    reasoning_intent: str = "factual_lookup"

    def modulation_profile(self) -> dict[str, float]:
        """C.2 — Traversal Modulation: return scorer/governor overrides based on intent.

        Returns a flat dict of parameter overrides. Empty dict = no modulation
        (generic query — use defaults). Callers must handle each key explicitly
        since this dict may grow as new axes are added.

        Recognised keys:
            weight_semantic, weight_topological, weight_distance, weight_recency
            → passed to RelevanceScorer.score_nodes() as weight_overrides
            max_nodes
            → passed to TokenGovernor.apply_budget() as max_nodes_override

        All values are conservative nudges rather than dramatic swings. The
        ablation sweep (EXP-007) will calibrate these empirically.
        """
        overrides: dict[str, float] = {}

        temporal = self.content_axes.get("temporal", 0.0)
        social = self.content_axes.get("social", 0.0)
        professional = self.content_axes.get("professional", 0.0)

        # Temporal queries: boost recency, reduce semantic dominance
        # F14: if we have an explicit temporal_reference_date, inject temporal_proximity weight
        if self.temporal_reference_date is not None:
            overrides["weight_temporal_proximity"] = 0.15
            overrides["weight_semantic"] = 0.55
            overrides["weight_recency"] = 0.05  # keep recency low — temporal_proximity handles time
        elif getattr(self, "reasoning_intent", "factual_lookup") == "temporal_lookup":
            # Date-seeking mode (audit Finding 4a): a "when did X happen?" query
            # carries no explicit reference year (the year is the *answer*), so
            # the year-gated branch above never fires. Critically, this is NOT a
            # recency question — the answer is a specific historical date, not the
            # latest. Keep semantic dominant so the date-bearing passage is found;
            # the date-seeking boost lives in intent_sentence_score + the
            # temporal-lookup retrieval pass, never in a misleading recency nudge.
            overrides["weight_semantic"] = 0.60
        elif temporal > 0.3:
            overrides["weight_recency"] = 0.20
            overrides["weight_semantic"] = 0.55

        # Social / relationship queries: boost graph distance traversal
        if social > 0.3:
            overrides["weight_distance"] = 0.20
            if "weight_semantic" not in overrides:
                overrides["weight_semantic"] = 0.55

        # Multi-hop / professional / relational: boost topology
        if self.reasoning_depth > 0.5 or professional > 0.3:
            overrides["weight_topological"] = 0.25
            if "weight_semantic" not in overrides:
                overrides["weight_semantic"] = 0.55

        # Exhaustive queries ("list all", "every", …): widen candidate pool
        if self.exhaustiveness > 0.7:
            overrides["max_nodes"] = 80.0

        # Specific / exact recall: narrow candidate pool, concentrate budget
        if self.specificity > 0.7:
            if "max_nodes" not in overrides:
                overrides["max_nodes"] = 25.0

        return overrides

    def reasoning_guidance(self, query: str = "") -> str:
        """Return intent-driven reasoning hints for the answering LLM.

        Produces concise, one-sentence instructions that guide the LLM's
        reasoning strategy based on the detected query intent. Multiple
        hints can fire and are joined with spaces. Returns empty string
        for generic queries (no special guidance needed).

        Args:
            query: Original query text for lightweight keyword detection
                   that supplements the structured intent signals.
        """
        hints: list[str] = []
        query_lower = query.lower()

        temporal = self.content_axes.get("temporal", 0.0)

        # Temporal: explicit date, temporal axis, or temporal keywords in query
        _temporal_kw = any(
            w in query_lower
            for w in ("year", "born", "died", "founded", "oldest",
                      "earliest", "latest", "before", "after", "during",
                      "when", "age", "old", "as of")
        )
        if temporal > 0.3 or self.temporal_reference_date is not None or _temporal_kw:
            hints.append(
                "Identify the specific time period or date constraint in the "
                "question, then find the entity that matches that exact time."
            )

        # Multi-hop: detected entities > 1, or chain-like query patterns
        _chain_kw = any(
            w in query_lower
            for w in ("of the", "who played", "whose", "the same",
                      "named after", "went to the same")
        )
        if self.reasoning_depth > 0.5 or _chain_kw:
            hints.append(
                "This question connects facts across multiple passages — "
                "trace each step of the chain before answering."
            )

        # Who-question with multiple entities: disambiguate person
        if self.wh_type in ("who", "whom") and len(self.detected_entities) > 1:
            hints.append(
                "Multiple people appear in the context — match the specific "
                "constraint to exactly one person."
            )

        # High specificity + likely numerical answer
        _numerical_kw = any(
            w in query_lower
            for w in ("how many", "how old", "how much", "what number",
                      "population", "subtract", "add", "total")
        )
        if _numerical_kw or (self.specificity > 0.7 and self.wh_type in ("how", "what")):
            hints.append(
                "If the answer is a number, show your calculation step by "
                "step before giving the final answer."
            )

        # Exhaustive queries
        if self.exhaustiveness > 0.7:
            hints.append(
                "List ALL items that match the criteria, not just the first."
            )

        return " ".join(hints)


# ---------------------------------------------------------------------------
# Intent classification
# ---------------------------------------------------------------------------


def _normalize_axes(axes: dict[str, float]) -> dict[str, float]:
    """L2-normalize content axes to unit vector."""
    norm = math.sqrt(sum(v * v for v in axes.values()))
    if norm > 0:
        return {k: v / norm for k, v in axes.items()}
    return axes


def _layer1_wh_word(query: str, doc: Any | None) -> tuple[str, str, float]:
    """Layer 1: WH-word detection.

    Returns (wh_type, primary_axis, weight).
    Uses spaCy doc if available, else regex fallback.
    """
    query_lower = query.lower().strip()

    # Check for "what date/year/time" temporal override first
    if _TEMPORAL_WHAT_PATTERNS.search(query_lower):
        return "what", "temporal", 1.0

    if doc is not None and len(doc) > 0:
        first_token = doc[0].lower_
        # Check WH-word
        if first_token in WH_AXIS_MAP:
            axis, weight = WH_AXIS_MAP[first_token]
            return first_token, axis, weight
        # Auxiliary inversion (yes/no question): "Is...", "Did...", "Has..."
        if doc[0].tag_ in ("VBZ", "VBD", "VBP", "MD"):
            return first_token, "factual", 0.6
    else:
        # Regex fallback (no spaCy)
        first_word = query_lower.split()[0] if query_lower else ""
        if first_word in WH_AXIS_MAP:
            axis, weight = WH_AXIS_MAP[first_word]
            return first_word, axis, weight

    return "what", "factual", 0.5


def _layer2_gliner_entities(
    query: str, gliner_model: Any | None
) -> tuple[dict[str, float], list[str]]:
    """Layer 2: GLiNER entity detection on query string.

    Returns (axis_boosts, detected_entity_texts).
    """
    if gliner_model is None:
        return {}, []

    try:
        entities = gliner_model.predict_entities(
            query, _GLINER_ENTITY_TYPES, threshold=0.4
        )
    except Exception:
        return {}, []

    boosts: dict[str, float] = {}
    texts: list[str] = []
    for ent in entities:
        label = ent.get("label", "")
        score = ent.get("score", 0.5)
        text = ent.get("text", "")
        axis = ENTITY_TYPE_TO_AXIS.get(label)
        if axis:
            boosts[axis] = max(boosts.get(axis, 0.0), score)
        if text:
            texts.append(text)

    return boosts, texts


def _layer3_root_verb(doc: Any | None) -> tuple[str, str | None]:
    """Layer 3: Root verb extraction via spaCy dep-parse.

    Returns (verb_lemma, axis_or_none).
    """
    if doc is None:
        return "", None

    # Find ROOT token
    root = None
    for token in doc:
        if token.dep_ == "ROOT":
            root = token
            break

    if root is None:
        return "", None

    # If ROOT is an auxiliary, look for its complement (xcomp, ccomp)
    verb = root
    if root.pos_ == "AUX":
        for child in root.children:
            if child.dep_ in ("xcomp", "ccomp", "acomp", "attr"):
                verb = child
                break

    lemma = verb.lemma_.lower()
    axis = VERB_AXIS_MAP.get(lemma)
    return lemma, axis


def _layer4_traversal(query: str, detected_entities: list[str]) -> tuple[float, float, float]:
    """Layer 4: Traversal signals from structural patterns.

    Returns (exhaustiveness, reasoning_depth, specificity).
    """
    query_lower = query.lower()

    # Exhaustiveness
    exhaustiveness = 0.5
    if _EXHAUSTIVE_PATTERN.search(query_lower):
        exhaustiveness = 0.9

    # Specificity
    specificity = 0.5
    if _EXACT_PATTERN.search(query_lower):
        specificity = 0.9
    elif _TEMPORAL_WHAT_PATTERNS.search(query_lower):
        specificity = 0.9  # "what date" implies exact recall
    elif re.search(r"\bwhat\s+(?:[\w-]+\s+){0,5}(?:name|amount|number|price|value|cost|percentage|rate|consideration)\b", query_lower):
        specificity = 0.8  # asking for a specific fact
    elif re.search(r"\bwhich\s+\w+", query_lower):
        specificity = 0.8  # "which X" questions ask for specific identification
    elif re.search(r"\bwho\s+(?:is|are|was|were)\b", query_lower):
        specificity = 0.8  # asking for specific identity
    elif _OVERVIEW_PATTERN.search(query_lower):
        specificity = 0.1

    # Reasoning depth: multi-hop signals from query structure.
    # Entity count is one signal, but structural patterns in the query text
    # are more reliable (GLiNER often detects 0 entities on short queries).
    reasoning_depth = 0.0

    # Signal 1: entity count (existing)
    if len(detected_entities) > 1:
        reasoning_depth = max(reasoning_depth, 0.7)
    elif len(detected_entities) == 1:
        reasoning_depth = max(reasoning_depth, 0.3)

    # Signal 2: multi-hop chain keywords ("of the", "named after", "whose", etc.)
    _chain_kw = re.search(
        r"\b(?:of the|whose|the same|named after|went to the same|"
        r"parent company|record label of|who played|"
        r"difference between|compared to)\b",
        query_lower,
    )
    if _chain_kw:
        reasoning_depth = max(reasoning_depth, 0.7)

    # Signal 3: cross-document / interaction / synthesis language
    _interaction_kw = re.search(
        r"\b(?:interact|relationship between|how do .+ and .+|"
        r"complement|contradict|conflict|compared|differ|"
        r"across .+ (?:documents?|the)|between .+ and|"
        r"recur across|span .+ and|across the)\b",
        query_lower,
    )
    if _interaction_kw:
        reasoning_depth = max(reasoning_depth, 0.8)

    # Signal 4: contrast/conditional markers
    _contrast_kw = re.search(
        r"\b(?:but|while|whereas|even though|however|despite|"
        r"if .+ (?:then|what|how)|what happens (?:when|if)|"
        r"what .+ still|what relationship .+ (?:if|when))\b",
        query_lower,
    )
    if _contrast_kw:
        reasoning_depth = max(reasoning_depth, 0.5)

    # Signal 5: explicit reasoning words
    _reasoning_kw = re.search(
        r"\b(?:reconstruct|timeline|trace|explain why|"
        r"what (?:led to|caused|resulted in)|how did .+ change|"
        r"sequence of events|step by step)\b",
        query_lower,
    )
    if _reasoning_kw:
        reasoning_depth = max(reasoning_depth, 0.8)

    # Signal 6: interrogative conjunctions ("and what", "and how")
    _interrog_conj = re.search(r"\band\s+(?:what|where|when|who|how)\b", query_lower)
    if _interrog_conj:
        reasoning_depth = max(reasoning_depth, 0.6)

    # Signal 7: long queries (>15 words) with question marks tend to be complex
    word_count = len(query_lower.split())
    if word_count > 20:
        reasoning_depth = max(reasoning_depth, 0.5)
    elif word_count > 15:
        reasoning_depth = max(reasoning_depth, 0.3)

    return exhaustiveness, reasoning_depth, specificity


# ---------------------------------------------------------------------------
# Layer 6: Domain detection (new manifold dimension)
# ---------------------------------------------------------------------------

DOMAIN_VOCABULARY: dict[str, frozenset[str]] = {
    "legal": frozenset({
        "merger", "agreement", "clause", "provision", "plaintiff", "defendant",
        "statute", "liability", "indemnification", "termination", "covenant",
        "fiduciary", "antitrust", "stockholder", "waiver", "amendment",
        "arbitration", "jurisdiction", "counsel", "remedy", "breach",
    }),
    "financial": frozenset({
        "revenue", "ebitda", "margin", "valuation", "fiscal", "quarterly",
        "dividend", "earnings", "portfolio", "equity", "debt", "capital",
        "ipo", "acquisition", "ticker", "share", "stock", "fund",
    }),
    "medical": frozenset({
        "patient", "diagnosis", "treatment", "clinical", "dosage", "symptom",
        "prognosis", "contraindication", "therapy", "surgical", "pathology",
    }),
    "technical": frozenset({
        "algorithm", "implementation", "architecture", "protocol", "latency",
        "throughput", "schema", "api", "database", "compiler", "runtime",
    }),
    "academic": frozenset({
        "hypothesis", "methodology", "findings", "citation", "abstract",
        "theorem", "proof", "peer-reviewed", "experiment", "variable",
    }),
    "biographical": frozenset({
        "born", "died", "founded", "married", "career", "education",
        "nationality", "birthplace", "autobiography", "award",
    }),
}


def _detect_domain(query: str, doc: object | None = None) -> str:
    """Detect query domain from vocabulary overlap + NER labels.

    Returns the top-scoring domain or 'general' if no strong signal.
    Uses spaCy doc if available for NER-assisted classification.
    """
    query_lower = query.lower()
    query_words = set(query_lower.split())

    scores: dict[str, float] = {}
    for domain, vocab in DOMAIN_VOCABULARY.items():
        overlap = query_words & vocab
        scores[domain] = len(overlap)

    # NER boost: ORG-heavy queries lean legal/financial, PERSON-heavy lean biographical
    if doc is not None:
        ner_labels = [ent.label_ for ent in doc.ents]  # type: ignore[attr-defined]
        org_count = ner_labels.count("ORG")
        person_count = ner_labels.count("PERSON")
        money_count = ner_labels.count("MONEY")
        if org_count >= 2:
            scores["legal"] = scores.get("legal", 0) + 0.5
            scores["financial"] = scores.get("financial", 0) + 0.5
        if person_count >= 2:
            scores["biographical"] = scores.get("biographical", 0) + 1.0
        if money_count >= 1:
            scores["financial"] = scores.get("financial", 0) + 1.0

    if not scores:
        return "general"

    best_domain = max(scores, key=scores.get)  # type: ignore[arg-type]
    best_score = scores[best_domain]

    # Require at least 1.0 signal to classify (1 vocab match or NER boost)
    return best_domain if best_score >= 1.0 else "general"


def classify_intent(
    query: str,
    spacy_nlp: Any | None = None,
    gliner_model: Any | None = None,
) -> IntentSignal:
    """Classify a query into an IntentSignal with content axes and traversal mode.

    Four-layer deterministic pipeline:
      1. WH-word detection (spaCy or regex fallback)
      2. GLiNER entity detection on query string (optional)
      3. Root verb lookup (spaCy dep-parse)
      4. Traversal signals (structural patterns)

    Args:
        query: The user's query string.
        spacy_nlp: Loaded spaCy Language model (en_core_web_sm). If None,
            falls back to regex-only WH-word detection.
        gliner_model: Loaded GLiNER model for entity detection on query.
            If None, Layer 2 is skipped.

    Returns:
        IntentSignal with normalized content_axes and traversal scalars.
    """
    if not query or not query.strip():
        return IntentSignal(
            content_axes={ax: (1.0 if ax == "factual" else 0.0) for ax in INTENT_AXES},
            wh_type="what",
        )

    # Parse with spaCy if available
    doc = spacy_nlp(query) if spacy_nlp is not None else None

    # Initialize axes
    axes: dict[str, float] = {ax: 0.0 for ax in INTENT_AXES}

    # Layer 1: WH-word → primary axis
    wh_type, primary_axis, wh_weight = _layer1_wh_word(query, doc)
    axes[primary_axis] = max(axes[primary_axis], wh_weight)

    # Layer 2: GLiNER entities → secondary axis boosts
    entity_boosts, detected_entities = _layer2_gliner_entities(query, gliner_model)
    for axis, boost in entity_boosts.items():
        if axis in axes:
            axes[axis] = max(axes[axis], boost)

    # Layer 3: Root verb → axis refinement
    root_verb, verb_axis = _layer3_root_verb(doc)
    if verb_axis and verb_axis in axes:
        axes[verb_axis] = max(axes[verb_axis], 0.7)

    # Layer 4: Traversal signals
    exhaustiveness, reasoning_depth, specificity = _layer4_traversal(
        query, detected_entities
    )

    # Layer 5: Temporal reference extraction (F14)
    from .temporal import extract_years
    query_years = extract_years(query)
    temporal_reference_date: int | None = None
    if query_years:
        # Use last mentioned year — typically the reference date in FRAMES-style questions
        temporal_reference_date = query_years[-1]

    # Normalize content axes to unit vector
    axes = _normalize_axes(axes)

    # Layer 6: Domain detection
    domain = _detect_domain(query, doc)

    # Layer 7: Reasoning-intent dimension (orthogonal to content_axes).
    # Derived from the query surface + wh_type; promotes the previously
    # debug-only wh_type/root_verb signals to a consumed, first-class field.
    reasoning_intent = _classify_reasoning_intent(query, wh_type, root_verb)

    return IntentSignal(
        content_axes=axes,
        exhaustiveness=exhaustiveness,
        reasoning_depth=reasoning_depth,
        specificity=specificity,
        wh_type=wh_type,
        detected_entities=detected_entities,
        root_verb=root_verb,
        temporal_reference_date=temporal_reference_date,
        domain=domain,
        reasoning_intent=reasoning_intent,
    )


# ---------------------------------------------------------------------------
# Intent-aware sentence scoring
# ---------------------------------------------------------------------------


def intent_sentence_score(
    sentence: str,
    intent: IntentSignal,
    query_words: frozenset[str],
) -> float:
    """Score a sentence by keyword overlap + intent-axis alignment.

    Returns 0.6 * keyword_score + 0.4 * axis_alignment_score.
    Falls back to pure keyword score if no intent axes are active.

    The keyword component uses the same logic as compression._keyword_score(),
    re-implemented here to avoid circular imports.
    """
    # Keyword score (same algorithm as compression._keyword_score)
    if query_words:
        sentence_words = frozenset(re.findall(r"\b\w+\b", sentence.lower()))
        overlap = query_words & sentence_words
        keyword_score = len(overlap) / len(query_words)
    else:
        keyword_score = 0.0

    # Intent-axis alignment score
    axis_score = 0.0
    active_weight_sum = 0.0
    for axis, weight in intent.content_axes.items():
        if weight < 0.05:  # Skip near-zero axes
            continue
        matcher = AXIS_SENTENCE_MATCHERS.get(axis)
        if matcher:
            axis_score += weight * matcher(sentence)
            active_weight_sum += weight

    # Normalize axis score by active weight sum
    if active_weight_sum > 0:
        axis_score /= active_weight_sum

    # Blend: 60% keyword + 40% intent
    base = 0.6 * keyword_score + 0.4 * axis_score

    # F14: Temporal boost — sentences containing years near the reference date
    # get a score boost (up to +0.3 for exact year match, decaying with distance)
    if intent.temporal_reference_date is not None:
        from .temporal import extract_years
        sent_years = extract_years(sentence)
        if sent_years:
            min_distance = min(abs(y - intent.temporal_reference_date) for y in sent_years)
            temporal_boost = 0.3 / (1.0 + min_distance / 5.0)
            base += temporal_boost
    elif getattr(intent, "reasoning_intent", "factual_lookup") == "temporal_lookup":
        # Date-seeking mode (audit Finding 4a): "when did X happen?" queries carry
        # no explicit reference year, so the year-gated branch above silently
        # no-ops. Boost any sentence that states a concrete date so the
        # answer-bearing sentence surfaces in the rendered set.
        from .temporal import extract_years
        if extract_years(sentence):
            base += 0.3

    return min(base, 1.0)
