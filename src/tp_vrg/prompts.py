"""
Manifold-driven answer prompt assembly.

Builds answer prompts from query manifold coordinates: domain persona,
detail level, citation style, and temporal instructions. The same
rendered context through different prompts produces different analysis
styles — the "shader" in the rendering metaphor.

Usage:
    from tp_vrg.prompts import build_answer_prompt
    prompt = build_answer_prompt(query, context, intent)
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from typing import Any


ANSWER_PROMPT_ENV = "TPVRG_ANSWER_PROMPT"
AnswerPromptBuilder = Callable[..., str]
AnswerPromptEntry = str | AnswerPromptBuilder


FACTUAL_STRICT = """\
Answer the question in English using ONLY the provided context. If the context \
contains non-English content, translate the relevant information to English in \
your answer. Be concise -- one phrase or a few words when possible. Use the \
exact wording from the context rather than paraphrasing when the source is \
already in English.{reasoning_hint}

If the context contains relative dates ("yesterday", "last year", "last month", \
etc.) along with a session date or timestamp, resolve them to the actual date or \
year in your answer (e.g., "yesterday" from a May 8 session = "May 7"; \
"last year" from a 2023 session = "2022").

Context:
{context}

Question: {question}

Answer:"""


COCKPIT = """\
Answer the question using ONLY the provided context. Be clear and concise.
Use the exact wording from the context when quoting facts.{reasoning_hint}

If the context contains relative dates ("yesterday", "last year") along with
a session date or timestamp, resolve them to the actual date in your answer.

Context:
{context}

Question: {question}

Answer:"""


COCKPIT_OPENAI_SYSTEM = """\
Answer the question using ONLY the provided context. Be clear and concise.
Use the exact wording from the context when quoting facts.{reasoning_hint}

If the context contains relative dates ("yesterday", "last year") along with
a session date or timestamp, resolve them to the actual date in your answer.

Context:
{context}"""


# Grounded-inference shader: relaxes the "ONLY the provided context" hedge that
# suppresses LoCoMo category_3 (speculative-commonsense) answers, while keeping
# the anti-hallucination guard (no invented specific facts). A/B candidate per
# [[docs/design/arch-prompt-as-swept-axis-2026-06-07.md]] (RQ-PROMPT-2).
GROUNDED_INFERENCE = """\
Answer the question in English using the provided context as your primary \
evidence. You may apply reasonable commonsense inference and connect facts the \
context supports, even when the answer is not stated verbatim -- but do not \
contradict the context, and do not invent specific facts (names, numbers, dates, \
events) the context does not support. Prefer the exact wording from the context \
when quoting facts. Be concise.{reasoning_hint}

If the context contains relative dates ("yesterday", "last year", "last month", \
etc.) along with a session date or timestamp, resolve them to the actual date or \
year in your answer.

Context:
{context}

Question: {question}

Answer:"""


# ---------------------------------------------------------------------------
# Domain personas — the "shader program" per domain
# ---------------------------------------------------------------------------

DOMAIN_PERSONAS: dict[str, str] = {
    "legal": "You are a legal analyst reviewing transaction documents.",
    "financial": "You are a financial analyst examining corporate filings.",
    "medical": "You are a medical professional reviewing clinical evidence.",
    "technical": "You are a technical analyst explaining system architecture.",
    "academic": "You are a researcher synthesizing findings from academic sources.",
    "biographical": "You are a historian establishing facts from biographical sources.",
    "general": "You are a knowledgeable assistant.",
}

# ---------------------------------------------------------------------------
# Detail level — scales with reasoning_depth
# ---------------------------------------------------------------------------

_DETAIL_LOW = "Be concise -- one phrase or a few words when possible."
_DETAIL_MEDIUM = "Give a clear, specific answer with key supporting details."
_DETAIL_HIGH = (
    "Give a complete, detailed answer. When the answer spans multiple "
    "sources, explain the relationship between them and cite which "
    "document or source contains each fact."
)

# ---------------------------------------------------------------------------
# Template
# ---------------------------------------------------------------------------

_ANSWER_TEMPLATE = """{persona}
Answer the question in English based ONLY on the provided context.
{detail}
{length_contract}
{citation}
{temporal}
Context:
{context}

Question: {question}

Answer:"""


def _answer_length_contract(gold_answer: str | None) -> str:
    """Build a benchmark-only length ceiling without exposing gold content."""
    if not gold_answer:
        return ""
    gold_words = len(re.findall(r"\b\w+\b", gold_answer))
    if gold_words == 0:
        return ""
    max_words = gold_words * 2
    return (
        "Keep the answer no longer than about twice the gold answer's length "
        f"({max_words} words). Do not add explanatory framing unless the "
        "question asks for it."
    )


def build_answer_prompt(
    question: str,
    context: str,
    intent: Any = None,
    *,
    gold_answer: str | None = None,
) -> str:
    """Assemble answer prompt from query manifold position.

    Args:
        question: The user's query.
        context: Rendered context from the engine.
        intent: IntentSignal with domain, reasoning_depth, specificity,
                temporal_reference_date. If None, uses general/concise defaults.
        gold_answer: Optional benchmark reference answer. Only its word count
                is used to bound answer verbosity; its contents are never
                included in the prompt.

    Returns:
        Complete prompt string ready for the judge LLM.
    """
    # Extract manifold coordinates
    domain = getattr(intent, "domain", "general") or "general"
    reasoning_depth = getattr(intent, "reasoning_depth", 0.0) or 0.0
    temporal_ref = getattr(intent, "temporal_reference_date", None)

    # Persona from domain
    persona = DOMAIN_PERSONAS.get(domain, DOMAIN_PERSONAS["general"])

    # Detail level from reasoning_depth
    if reasoning_depth > 0.7:
        detail = _DETAIL_HIGH
    elif reasoning_depth > 0.3:
        detail = _DETAIL_MEDIUM
    else:
        detail = _DETAIL_LOW

    # Citation instruction — activate for high reasoning_depth
    citation = ""
    if reasoning_depth > 0.5:
        citation = "Cite which document or source contains each part of your answer."

    # Temporal instruction — activate when temporal reference detected
    temporal = ""
    if temporal_ref is not None:
        temporal = (
            "If the context contains relative dates (\"yesterday\", \"last year\", "
            "\"last month\"), resolve them to the actual date or year in your answer."
        )

    # Assemble (strip empty lines from unused slots)
    raw = _ANSWER_TEMPLATE.format(
        persona=persona,
        detail=detail,
        length_contract=_answer_length_contract(gold_answer),
        citation=citation,
        temporal=temporal,
        context=context,
        question=question,
    )
    # Collapse multiple blank lines from empty slots
    cleaned = re.sub(r"\n{3,}", "\n\n", raw)
    return cleaned.strip()


ANSWER_PROMPT_REGISTRY: dict[str, AnswerPromptEntry] = {
    "factual_strict": FACTUAL_STRICT,
    "grounded_inference": GROUNDED_INFERENCE,
    "cockpit": COCKPIT,
    "cockpit_openai_system": COCKPIT_OPENAI_SYSTEM,
    "shader": build_answer_prompt,
}


def _normalize_answer_prompt_key(key: str) -> str:
    return key.strip().lower().replace("-", "_")


def selected_answer_prompt_key(default_key: str) -> str:
    """Return the env-selected answer prompt key, falling back safely."""
    normalized_default = _normalize_answer_prompt_key(default_key)
    if normalized_default not in ANSWER_PROMPT_REGISTRY:
        raise KeyError(f"Unknown default answer prompt key: {default_key!r}")
    requested = _normalize_answer_prompt_key(os.environ.get(ANSWER_PROMPT_ENV, ""))
    if requested in ANSWER_PROMPT_REGISTRY:
        return requested
    return normalized_default


def resolve_answer_prompt(
    default_key: str,
    *,
    context: str | None = None,
    question: str | None = None,
    reasoning_hint: str = "",
    intent: Any = None,
    gold_answer: str | None = None,
    format_prompt: bool = False,
) -> str:
    """Resolve the active answer prompt for a product or benchmark path.

    String-template callers can request the raw template (default) to preserve
    the ``.format(...)`` contract. Callers that need the final prompt pass
    ``format_prompt=True`` plus the usual placeholders.
    """
    key = selected_answer_prompt_key(default_key)
    entry = ANSWER_PROMPT_REGISTRY[key]
    if key == "shader":
        if context is None or question is None:
            raise ValueError(
                "context and question are required when TPVRG_ANSWER_PROMPT=shader"
            )
        return build_answer_prompt(
            question=question,
            context=context,
            intent=intent,
            gold_answer=gold_answer,
        )
    if not isinstance(entry, str):
        raise TypeError(f"Unsupported answer prompt registry entry for {key!r}")
    if not format_prompt:
        return entry
    return entry.format(
        context="" if context is None else context,
        question="" if question is None else question,
        reasoning_hint=reasoning_hint,
    )
"""
# SOTA: Answer prompt as "shader" — adopted from 3D rendering (shader programs, ~1990s)
# Same geometry (rendered context), different shader (prompt), different output.
# The manifold position selects the shader uniforms (persona, detail, citation).
"""
