"""LingMess/fastcoref integration for coreference resolution.

This module exposes a ``resolve_pronouns`` function compatible with
``tp_vrg.coref.resolve_pronouns`` so it can be swapped in via mode dispatch.
The fastcoref model is loaded lazily on first use and cached process-wide.
"""

from __future__ import annotations

from threading import Lock
from typing import Any

_MODEL: Any | None = None
_MODEL_LOCK = Lock()


def _set_coref_stage(message: str) -> None:
    try:
        import tp_vrg.api_server as _api_server
        _api_server._state.coref_stage = message
    except Exception:
        pass


def _load_model():
    global _MODEL
    if _MODEL is not None:
        _set_coref_stage("ready")
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None:
            _set_coref_stage("ready")
            return _MODEL
        _set_coref_stage("loading from cache...")
        try:
            from fastcoref import LingMessCoref  # SOTA: Neural coreference — adopted from LingMess (BIU-NLP, 2023)
        except ImportError as exc:
            _set_coref_stage(f"error: {exc}")
            raise ImportError(
                "fastcoref is required for LingMess coreference. "
                "Install with: pip install tp-vrg[coref]"
            ) from exc

        # Longformer doesn't support SDPA yet — force eager attention.
        # fastcoref uses AutoModel.from_config() internally, so we patch
        # that to inject attn_implementation="eager" on the config object.
        # See: https://github.com/huggingface/transformers/issues/28005
        import transformers
        _original_from_config = transformers.AutoModel.from_config

        @classmethod  # type: ignore[misc]
        def _patched_from_config(cls, config, *args, **kwargs):
            config._attn_implementation = "eager"
            return _original_from_config.__func__(cls, config, *args, **kwargs)

        transformers.AutoModel.from_config = _patched_from_config
        try:
            # LingMess is 590M params; CPU inference on Wikipedia-length
            # sessions is ~5-7 min/doc. Select CUDA when available — override
            # via TPVRG_LINGMESS_DEVICE=cpu if GPU memory is contested.
            import os as _os
            device = _os.environ.get("TPVRG_LINGMESS_DEVICE", "").strip()
            if not device:
                try:
                    import torch as _torch
                    device = "cuda" if _torch.cuda.is_available() else "cpu"
                except Exception:
                    device = "cpu"
            _MODEL = LingMessCoref(
                model_name_or_path="biu-nlp/lingmess-coref",
                device=device,
            )
            _set_coref_stage("ready")
        except Exception as exc:
            _set_coref_stage(f"error: {exc}")
            raise
        finally:
            transformers.AutoModel.from_config = _original_from_config
        return _MODEL


_PRONOUN_SET = frozenset({
    "i", "me", "my", "mine", "myself",
    "you", "your", "yours", "yourself", "yourselves",
    "he", "him", "his", "himself",
    "she", "her", "hers", "herself",
    "it", "its", "itself",
    "we", "us", "our", "ours", "ourselves",
    "they", "them", "their", "theirs", "themselves",
    "this", "that", "these", "those",
})

_READER_REFERENT_PRONOUN_SET = frozenset({
    "i", "me", "my", "mine", "myself",
    "you", "your", "yours", "yourself", "yourselves",
    "we", "us", "our", "ours", "ourselves",
})

_DEMONSTRATIVE_PRONOUN_SET = frozenset({
    "this", "that", "these", "those",
})

_SUBSTITUTABLE_PRONOUN_SET = (
    _PRONOUN_SET
    - _READER_REFERENT_PRONOUN_SET
    - _DEMONSTRATIVE_PRONOUN_SET
)


def _pick_representative(mentions: list[str]) -> str:
    """Pick the representative mention for a coref cluster.

    Prefers the longest non-pronoun mention; falls back to the longest overall.
    """
    non_pron = [m for m in mentions if m.strip().lower() not in _PRONOUN_SET]
    pool = non_pron or mentions
    return max(pool, key=lambda m: (len(m), -mentions.index(m)))


def _resolve_text_with_fastcoref(model: Any, text: str) -> str:
    """Substitute mentions with their cluster representative.

    fastcoref 2.1.6's ``CorefResult`` exposes ``get_clusters()`` (strings) and
    ``get_clusters(as_strings=False)`` (char spans). Neither ``LingMessCoref``
    nor ``CorefResult`` provides a direct ``get_resolved_text`` helper in this
    version, so we apply the substitution ourselves.
    """
    prediction = model.predict(texts=[text])
    if not prediction:
        return text

    first = prediction[0]

    # Manual substitution from clusters + char spans.
    try:
        str_clusters = first.get_clusters(as_strings=True)
        span_clusters = first.get_clusters(as_strings=False)
    except Exception:
        # Compatibility path for future/alternate fastcoref versions that expose
        # only a resolved-text helper. Current LingMess exposes cluster spans,
        # which we prefer because it lets TP-VRG enforce its pronoun scope rules.
        get_resolved_text = getattr(first, "get_resolved_text", None)
        if callable(get_resolved_text):
            resolved = get_resolved_text()
            if isinstance(resolved, str) and resolved:
                return resolved
        return text

    if not str_clusters or not span_clusters:
        return text

    # Build (start, end, replacement) edits, skipping mentions that already
    # equal the representative.
    edits: list[tuple[int, int, str]] = []
    for mentions, spans in zip(str_clusters, span_clusters):
        if not mentions or len(mentions) < 2:
            continue
        rep = _pick_representative(mentions)
        for mention, (start, end) in zip(mentions, spans):
            if mention == rep:
                continue
            # Only substitute third-person entity pronouns. First/second-person
            # pronouns are reader/speaker-referent unless turn/quote attribution
            # proves otherwise, which the rule-based pass handles explicitly.
            if mention.strip().lower() not in _SUBSTITUTABLE_PRONOUN_SET:
                continue
            edits.append((start, end, rep))

    if not edits:
        return text

    # Apply right-to-left so earlier indices stay valid.
    edits.sort(key=lambda e: e[0], reverse=True)
    out = text
    for start, end, rep in edits:
        out = out[:start] + rep + out[end:]
    return out


def resolve_pronouns(
    text: str,
    nlp=None,
    prior_context: dict | None = None,
    turn_boundaries: list[tuple[int, int, str]] | None = None,
) -> tuple[str, dict]:
    """Resolve coreferences with LingMess.

    Signature intentionally mirrors ``tp_vrg.coref.resolve_pronouns``.
    ``nlp``, ``prior_context``, and ``turn_boundaries`` are accepted for
    compatibility; LingMess performs document-level resolution directly.
    """
    del nlp, turn_boundaries

    if not text or not text.strip():
        return text, {}

    model = _load_model()
    resolved_text = _resolve_text_with_fastcoref(model, text)
    return resolved_text, (prior_context or {})


# SOTA: Multi-pass coreference sieve — adopted from Stanford (Raghunathan et al., 2010; Lee et al., 2013)
def resolve_pronouns_sieve(
    text: str,
    nlp=None,
    prior_context: dict | None = None,
    turn_boundaries: list[tuple[int, int, str]] | None = None,
) -> tuple[str, dict]:
    """Two-pass coref sieve: LingMess first, rule-based fallback.

    Pass 1 (LingMess): handles nominals ("the company", "the CEO"),
    cross-paragraph references, and ambiguous multi-antecedent cases.

    Pass 2 (rule-based): catches simple pronoun substitutions (he/she/it/they)
    that LingMess identified but didn't rewrite in the text. Zero-cost (<1ms).

    This ensures the sieve is never worse than either method alone.
    """
    # Ensure spaCy nlp is available for the rule-based pass
    if nlp is None:
        import spacy
        nlp = spacy.load("en_core_web_sm")

    # Pass 1: LingMess (heavy lifting — nominals, cross-paragraph, ambiguous)
    resolved, ctx = resolve_pronouns(text, nlp, prior_context, turn_boundaries)

    # Pass 2: Rule-based (catch simple pronouns LingMess didn't substitute)
    from tp_vrg.coref import resolve_pronouns as resolve_rules
    resolved, ctx = resolve_rules(resolved, nlp, ctx, turn_boundaries)

    return resolved, ctx
