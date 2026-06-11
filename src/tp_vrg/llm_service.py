"""
LLM service abstraction layer.

Defines the LLMProvider protocol with concrete implementations:
- MockLLMProvider: deterministic mock for prototyping and testing
- AnthropicLLMProvider: real Claude Haiku integration for production
- OllamaLLMProvider: local extraction via Ollama (zero API cost)
- GLiNERSpacyProvider: zero-LLM extraction via GLiNER NER + spaCy dep-parse (~10ms/chunk)

All providers implement the LLMProvider protocol (extract_entities_and_edges + summarize).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import time
from typing import Protocol, runtime_checkable

logger = logging.getLogger(__name__)

from tp_vrg.extraction.stopword_filter import should_skip_extracted_relation
from tp_vrg.models import EdgeData, ExtractionResult, NodeData
from tp_vrg.progress import progress


def get_coref_resolver(coref_mode: str):
    mode = (coref_mode or "rules").strip().lower()
    if mode == "rules":
        from tp_vrg.coref import resolve_pronouns as _resolve_pronouns
        return _resolve_pronouns
    if mode == "lingmess":
        from tp_vrg.coref_lingmess import resolve_pronouns as _resolve_pronouns
        return _resolve_pronouns
    if mode == "sieve":
        from tp_vrg.coref_lingmess import resolve_pronouns_sieve as _resolve_pronouns
        return _resolve_pronouns
    if mode == "none":
        return None
    raise ValueError(
        f"Unknown coref_mode '{coref_mode}'. Use 'rules', 'lingmess', 'sieve', or 'none'."
    )


@runtime_checkable
class LLMProvider(Protocol):
    """Interface for LLM text generation providers."""

    async def extract_entities_and_edges(self, raw_text: str) -> ExtractionResult: ...

    async def summarize(self, text: str, target_sentences: int = 2) -> str: ...


# -- Shared extraction prompt -------------------------------------------------

_EXTRACTION_PROMPT_TEMPLATE = (
    "Extract entities and relationships from this text. "
    "Return ONLY valid JSON matching this schema:\n"
    '{{"nodes": [...], "edges": [...]}}\n\n'
    "For each node:\n"
    "- entity_id: lowercase_underscored unique ID\n"
    "- name: Display name\n"
    "- category: one of [person, organization, technology, concept, event, location]\n"
    "- lod_1: A 1-2 sentence summary preserving entity names and the 'why'\n"
    '- lod_2: Just "EntityName [category]"\n\n'
    "Do NOT include lod_0 — it will be set automatically from the source text.\n\n"
    "For each edge:\n"
    "- source: entity_id of the source\n"
    "- target: entity_id of the target\n"
    "- relation: a short verb phrase (e.g., 'founded', 'works_at', 'developed')\n\n"
    "Text:\n{raw_text}"
)


class MockLLMProvider:
    """
    Deterministic mock LLM provider for testing and prototyping.

    Returns hard-coded demo data regardless of input text.
    """

    async def extract_entities_and_edges(self, raw_text: str) -> ExtractionResult:
        return _mock_extract(raw_text)

    async def summarize(self, text: str, target_sentences: int = 2) -> str:
        sentences = [s.strip() for s in text.replace("\n", " ").split(".") if s.strip()]
        return ". ".join(sentences[:target_sentences]) + "."


class MockWaterLLMProvider(MockLLMProvider):
    """Mock LLM provider WITH complete() support — for Water mode tests.

    Inherits extraction/summarize from MockLLMProvider, adds a deterministic
    complete() that returns a canned response based on the prompt content.
    """

    async def complete(self, prompt: str, max_tokens: int = 1024) -> str:
        """Deterministic mock completion for testing Water mode components."""
        prompt_lower = prompt.lower()
        if "rephrase" in prompt_lower or "rewrite" in prompt_lower:
            # Query expansion mock
            return "variant 1\nvariant 2\nvariant 3"
        if "rank" in prompt_lower or "relevance" in prompt_lower:
            # Reranking mock — return IDs in reverse order
            import re as _re
            ids = _re.findall(r"\[([a-z_0-9]+)\]", prompt)
            return ",".join(reversed(ids)) if ids else "id_0,id_1"
        return "mock completion response"


class AnthropicLLMProvider:
    """
    Production LLM provider using Anthropic's Claude API.

    Supports any Claude model for entity extraction. Defaults to Haiku
    for cost-efficiency, but can be configured to use Sonnet or Opus
    for higher extraction quality.

    Requires the ``anthropic`` package: ``pip install tp-vrg[llm]``

    Configure the model via the ``TPVRG_MODEL`` environment variable
    or the ``model`` constructor argument.
    """

    # Friendly aliases → official model strings
    MODEL_ALIASES: dict[str, str] = {
        "haiku": "claude-haiku-4-5-20251001",
        "sonnet": "claude-sonnet-4-5-20250929",
        "opus": "claude-opus-4-5-20251101",
    }

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "haiku",
    ) -> None:
        try:
            import anthropic
        except ImportError:
            raise ImportError(
                "anthropic is required for AnthropicLLMProvider. "
                "Install with: pip install tp-vrg[llm]"
            )
        self._client = anthropic.AsyncAnthropic(api_key=api_key)
        self._model = self.MODEL_ALIASES.get(model, model)  # alias or raw string

    async def extract_entities_and_edges(self, raw_text: str) -> ExtractionResult:
        prompt = _EXTRACTION_PROMPT_TEMPLATE.format(raw_text=raw_text)

        response = await self._client.messages.create(
            model=self._model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )

        return _parse_response(response.content[0].text)

    async def summarize(self, text: str, target_sentences: int = 2) -> str:
        response = await self._client.messages.create(
            model=self._model,
            max_tokens=256,
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"Summarize the following in exactly {target_sentences} sentences. "
                        f"Preserve all entity names.\n\n{text}"
                    ),
                }
            ],
        )
        return response.content[0].text.strip()

    async def complete(self, prompt: str, max_tokens: int = 1024) -> str:
        """Free-form completion for Water mode augmentation (reranking, query expansion)."""
        response = await self._client.messages.create(
            model=self._model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text.strip()


class OllamaLLMProvider:
    """
    Local LLM provider using Ollama.

    Runs extraction entirely on-device — zero external API calls.
    Default model: qwen2.5-coder:7b (strong JSON extraction, 7B params).

    See docs/local-setup.md for installation instructions.

    Configure via env vars:
      TPVRG_OLLAMA_MODEL  (default: qwen2.5-coder:7b)
      TPVRG_OLLAMA_HOST   (default: http://localhost:11434)

    Requires: pip install tp-vrg[local]
    """

    DEFAULT_MODEL = "qwen2.5-coder:7b"
    DEFAULT_HOST = "http://localhost:11434"

    def __init__(
        self,
        model: str | None = None,
        host: str | None = None,
    ) -> None:
        try:
            import ollama as _ollama
            self._ollama = _ollama
        except ImportError:
            raise ImportError(
                "The 'ollama' package is required for OllamaLLMProvider.\n"
                "Install it with: pip install tp-vrg[local]\n"
                "Then ensure Ollama is running: https://ollama.ai"
            )
        self._model = model or self.DEFAULT_MODEL
        self._host = host or self.DEFAULT_HOST

    async def extract_entities_and_edges(self, raw_text: str) -> ExtractionResult:
        prompt = _EXTRACTION_PROMPT_TEMPLATE.format(raw_text=raw_text)
        try:
            client = self._ollama.AsyncClient(host=self._host)
            response = await client.chat(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                format="json",
                options={"temperature": 0},
            )
            return _parse_response(response["message"]["content"])
        except Exception as e:
            raise _ollama_error(e, self._host, self._model) from e

    async def summarize(self, text: str, target_sentences: int = 2) -> str:
        prompt = (
            f"Summarize the following in exactly {target_sentences} sentences. "
            f"Preserve all entity names.\n\n{text}"
        )
        try:
            client = self._ollama.AsyncClient(host=self._host)
            response = await client.chat(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                options={"temperature": 0},
            )
            return response["message"]["content"].strip()
        except Exception as e:
            raise _ollama_error(e, self._host, self._model) from e

    async def complete(self, prompt: str, max_tokens: int = 1024) -> str:
        """Free-form completion for Water mode augmentation (reranking, query expansion).

        Uses the configured Ollama model. Falls back to raising a clear error
        if Ollama is unreachable.
        """
        try:
            client = self._ollama.AsyncClient(host=self._host)
            response = await client.chat(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                options={"temperature": 0, "num_predict": max_tokens},
            )
            return response["message"]["content"].strip()
        except Exception as e:
            raise _ollama_error(e, self._host, self._model) from e


# -- Shared helpers -----------------------------------------------------------

def _parse_response(text: str) -> ExtractionResult:
    """Parse LLM response text into an ExtractionResult.

    Handles JSON wrapped in markdown code fences. Returns an empty
    ExtractionResult on any parse failure rather than raising.
    """
    json_match = re.search(r"\{[\s\S]*\}", text)
    if not json_match:
        return ExtractionResult()

    try:
        data = json.loads(json_match.group())
    except json.JSONDecodeError:
        return ExtractionResult()

    nodes = []
    for n in data.get("nodes", []):
        try:
            if "lod_0" not in n:
                n["lod_0"] = n.get("lod_1", n.get("name", ""))
            nodes.append(NodeData(**n))
        except Exception:
            continue

    edges = []
    for e in data.get("edges", []):
        try:
            edges.append(EdgeData(**e))
        except Exception:
            continue

    return ExtractionResult(nodes=nodes, edges=edges)


def _ollama_error(exc: Exception, host: str, model: str) -> Exception:
    """Convert Ollama exceptions into actionable RuntimeErrors."""
    msg = str(exc).lower()
    if "not found" in msg or "404" in msg:
        return RuntimeError(
            f"[tp-vrg] Ollama model '{model}' not found.\n"
            f"Pull it with: ollama pull {model}\n"
            "Then restart tp-vrg-mcp."
        )
    if "connect" in msg or "connection" in msg:
        return RuntimeError(
            f"[tp-vrg] Cannot connect to Ollama at {host}.\n"
            "Is Ollama running?\n"
            "  Linux/macOS: ollama serve\n"
            "  Windows: open Ollama from the system tray\n"
            f"First time? Install from https://ollama.ai, then: ollama pull {model}"
        )
    return exc


# -- Backward compatibility alias --

class LLMService(MockLLMProvider):
    """Legacy alias. Use MockLLMProvider or AnthropicLLMProvider directly."""
    pass


# ---------------------------------------------------------------------------
# GLiNER + spaCy provider (zero-LLM extraction)
# ---------------------------------------------------------------------------

# GLiNER's internal tokenizer truncates any sentence exceeding 384 subword
# tokens (~1 200 characters). We pre-split on spaCy sentence boundaries so
# no chunk ever hits that limit, then restore absolute offsets before merging.
#
# GLiNER 2 upgrade path (evaluated 2026-03-20, blocked):
# gliner2==1.2.4 exists on PyPI but uses an incompatible API:
#   - New: from gliner2 import GLiNER2; schema = model.create_schema(); schema.entities(...)
#   - Old: from gliner import GLiNER; model.predict_entities(text, labels, threshold=...)
# An adapter would need to wrap GLiNER2's Schema builder to mimic predict_entities().
# GLiNER 2 offers 2048-token context (vs 384) which would eliminate chunking overhead.
# Upgrade task: add backlog item once GLiNER 2 API stabilizes or adapter is written.
_GLINER_MAX_CHARS = 1_200


def _split_for_gliner(text: str, doc) -> list[tuple[str, int]]:
    """
    Split *text* into sub-chunks ≤ _GLINER_MAX_CHARS chars using the spaCy
    sentence boundaries already in *doc* (so we don't re-parse).

    Returns a list of (chunk_text, char_offset_in_original) pairs.
    Sentences that individually exceed the limit are clause-split (Layer 2c).
    """
    chunks: list[tuple[str, int]] = []

    def _flush(buf: str, buf_start: int) -> None:
        if buf.strip():
            chunks.append((buf.strip(), buf_start))

    def _clause_split(text_frag: str, frag_start: int) -> None:
        """Clause-aware split for an over-long sentence (Layer 2c).

        Looks for clause boundaries (comma+conjunction, semicolons,
        em-dashes, colons) before falling back to word-boundary split.
        This prevents GLiNER's 384-token truncation from silently
        discarding entities in the latter half of long sentences.
        """
        import re as _re
        _CLAUSE_PAT = _re.compile(
            r'(?:,\s+(?:and|but|or|which|that|who|where|when|while|however|although)\b'
            r'|;\s+'
            r'|\s+[—–]\s+'
            r'|:\s+)'
        )
        pos = 0
        while pos < len(text_frag):
            remaining = text_frag[pos:]
            if len(remaining) <= _GLINER_MAX_CHARS:
                if remaining.strip():
                    chunks.append((remaining.strip(), frag_start + pos))
                break
            window = remaining[:_GLINER_MAX_CHARS]
            # Find the LAST clause boundary within the window
            best_cut = -1
            for m in _CLAUSE_PAT.finditer(window):
                best_cut = m.start()
            if best_cut > _GLINER_MAX_CHARS // 4:
                # Cut at clause boundary (not too early in the window)
                cut_point = best_cut
            else:
                # Fallback: word boundary
                cut_point = window.rfind(" ")
                if cut_point <= 0:
                    cut_point = _GLINER_MAX_CHARS
                import logging
                logging.getLogger(__name__).debug(
                    "[GLiNER] clause-split fallback to word boundary for %d-char fragment",
                    len(text_frag),
                )
            chunk_text = window[:cut_point].strip()
            if chunk_text:
                chunks.append((chunk_text, frag_start + pos))
            pos += cut_point
            # Skip leading whitespace in next window
            while pos < len(text_frag) and text_frag[pos] in " \t":
                pos += 1

    sents = list(doc.sents)
    if not sents:
        # No sentence segmentation — hard-split the whole text
        _clause_split(text, 0)
        return chunks

    buf = ""
    buf_start = 0

    for sent in sents:
        sent_text = sent.text
        sent_start = sent.start_char

        if len(sent_text) > _GLINER_MAX_CHARS:
            # Sentence is itself too long — flush current buffer first
            _flush(buf, buf_start)
            buf, buf_start = "", sent_start + len(sent_text)
            _clause_split(sent_text, sent_start)
            continue

        if buf and len(buf) + 1 + len(sent_text) > _GLINER_MAX_CHARS:
            _flush(buf, buf_start)
            buf, buf_start = sent_text, sent_start
        else:
            if not buf:
                buf_start = sent_start
                buf = sent_text
            else:
                buf = buf + " " + sent_text

    _flush(buf, buf_start)
    return chunks


def _deduplicate_spans(spans: list[dict]) -> list[dict]:
    """
    Remove overlapping GLiNER spans, keeping the higher-confidence one.

    Sort by score descending, then discard any span whose character range
    is fully contained within an already-accepted span.
    """
    sorted_spans = sorted(spans, key=lambda s: s.get("score", 0.0), reverse=True)
    accepted: list[dict] = []
    for candidate in sorted_spans:
        c_start, c_end = candidate["start"], candidate["end"]
        dominated = any(
            a["start"] <= c_start and a["end"] >= c_end
            for a in accepted
        )
        if not dominated:
            accepted.append(candidate)
    # Restore source order for consistent output
    return sorted(accepted, key=lambda s: s["start"])


def _name_to_entity_id(name: str) -> str:
    """Convert a display name to a snake_case entity_id (mirrors normalizer pattern)."""
    import re
    import unicodedata
    # Normalize unicode, lowercase, replace non-alphanumeric with underscore
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_str = nfkd.encode("ascii", "ignore").decode("ascii")
    lower = ascii_str.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "_", lower)
    slug = slug.strip("_")
    return slug or "unknown"


def _lod1_for_entity(entity_name: str, doc) -> str:
    """
    Extract the 1-2 most informative sentences mentioning this entity.

    Prefers sentences that mention the entity by name. Falls back to
    the entity name + category label if no sentence found.
    """
    name_lower = entity_name.lower()
    entity_sents = [
        s.text.strip()
        for s in doc.sents
        if name_lower in s.text.lower()
    ]
    if not entity_sents:
        return entity_name
    # Return first sentence; if it's short (<8 words), append the second
    first = entity_sents[0]
    if len(first.split()) < 8 and len(entity_sents) > 1:
        return f"{first} {entity_sents[1]}"
    return first


def _extract_relationships(
    doc,
    entity_spans_info: list[dict],
    extraction_stats: dict[str, int] | None = None,
) -> list[EdgeData]:
    """
    Extract verb-mediated relational triples using spaCy dep parse.

    Algorithm:
    - Build a token → entity_id lookup from GLiNER character spans
    - For each VERB in the sentence:
        - Find subject tokens (nsubj, nsubjpass) → subject entity
        - Find object tokens (dobj, attr, acomp, prep→pobj) → object entity
        - If both found and distinct: emit EdgeData(source, verb.lemma_, target)

    Only verb-mediated edges — no co-occurrence noise.
    """
    # Map each token index to the entity_id of the span it belongs to
    token_to_eid: dict[int, str] = {}
    mapped = 0
    missed = 0
    for ent in entity_spans_info:
        span = doc.char_span(ent["start"], ent["end"], alignment_mode="expand")
        if span is None:
            # FALLBACK: find tokens overlapping the character range
            span_tokens = [
                t for t in doc
                if t.idx < ent["end"] and t.idx + len(t.text) > ent["start"]
            ]
            if not span_tokens:
                logger.debug(
                    "[extraction] char_span miss (no fallback tokens): '%s' [%d:%d]",
                    ent.get("text", "?"), ent["start"], ent["end"],
                )
                missed += 1
                continue
            for token in span_tokens:
                token_to_eid[token.i] = ent["entity_id"]
            mapped += 1
        else:
            for token in span:
                token_to_eid[token.i] = ent["entity_id"]
            mapped += 1

    def _subtree_entity(token) -> str | None:
        """Return entity_id for the first entity token in this token's subtree."""
        for t in token.subtree:
            if t.i in token_to_eid:
                return token_to_eid[t.i]
        return None

    edges: set[tuple[str, str, str]] = set()
    stats = extraction_stats if extraction_stats is not None else {
        "stopword_relations_skipped": 0,
    }
    skipped_before = stats.get("stopword_relations_skipped", 0)

    for sent in doc.sents:
        for token in sent:
            if token.pos_ != "VERB":
                continue

            # Find subject entity.
            # With pronoun resolution applied before extraction, subjects in the
            # resolved text are named entities — no pronoun fallback needed here.
            subj_eid: str | None = None
            for child in token.children:
                if child.dep_ in ("nsubj", "nsubjpass"):
                    subj_eid = _subtree_entity(child)
                    if subj_eid:
                        break
            if not subj_eid:
                continue

            # Find object entities (direct, attribute, prepositional)
            obj_eids: list[str] = []
            for child in token.children:
                if child.dep_ in ("dobj", "attr", "acomp"):
                    eid = _subtree_entity(child)
                    if eid:
                        obj_eids.append(eid)
                elif child.dep_ == "prep":
                    for pobj in child.children:
                        if pobj.dep_ == "pobj":
                            eid = _subtree_entity(pobj)
                            if eid:
                                obj_eids.append(eid)

            for obj_eid in obj_eids:
                if obj_eid != subj_eid:
                    relation_label = token.lemma_
                    if should_skip_extracted_relation(relation_label, stats):
                        continue
                    edges.add((subj_eid, relation_label, obj_eid))

    result = [EdgeData(source=s, relation=r, target=t) for s, r, t in edges]
    stopword_relations_skipped = (
        stats.get("stopword_relations_skipped", 0) - skipped_before
    )
    logger.debug(
        "[extraction] %d entities → %d mapped, %d missed → %d edges "
        "(stopword_relations_skipped=%d)",
        len(entity_spans_info), mapped, missed, len(result),
        stopword_relations_skipped,
    )
    return result


# SOTA: Zero-shot NER — adopted from GLiNER (Zaratiana et al., NAACL 2024)
class GLiNERSpacyProvider:
    """
    Zero-LLM extraction provider: GLiNER (entities) + spaCy (relationships).

    GLiNER detects entity spans using zero-shot NER; spaCy dep-parse finds
    verb-mediated relational triples between those entities. No LLM calls
    at ingestion — ~10ms/chunk vs 5–15s for AnthropicLLMProvider.

    Requires: pip install tp-vrg[gliner]
    Then:     python -m spacy download en_core_web_sm
    NOTE:     Requires Python 3.12. Not compatible with Python 3.14 due to
              pydantic v1 dependency in GLiNER's transitive deps.

    Configure via env vars:
      TPVRG_GLINER_MODEL  (default: urchade/gliner_mediumv2.1)
      TPVRG_SPACY_MODEL   (default: en_core_web_sm)
    """

    ENTITY_TYPES = [
        "person", "organization", "technology", "concept", "event", "location",
        "activity", "hobby",
    ]
    # GLiNER2 label set — broader coverage for relation extraction
    ENTITY_TYPES_V2 = [
        "person", "organization", "location", "event", "product",
        "date", "law", "concept",
    ]
    DEFAULT_GLINER_MODEL = "urchade/gliner_mediumv2.1"
    DEFAULT_GLINER2_MODEL = "fastino/gliner2-base-v1"
    DEFAULT_SPACY_MODEL = "en_core_web_sm"
    GLINER_THRESHOLD = 0.5

    def __init__(
        self,
        gliner_model: str | None = None,
        spacy_model: str | None = None,
        coref_mode: str | None = None,
    ) -> None:
        from tp_vrg.models import NER_BACKEND
        self._ner_backend = NER_BACKEND
        logger.debug(
            "GLiNERSpacyProvider.__init__: NER_BACKEND=%r, self._ner_backend=%r",
            NER_BACKEND, self._ner_backend,
        )

        try:
            import spacy as _spacy
        except ImportError:
            raise ImportError(
                "spacy is required for GLiNERSpacyProvider.\n"
                "Install: pip install tp-vrg[gliner]\n"
                "Then:    python -m spacy download en_core_web_sm"
            )

        spacy_id = spacy_model or self.DEFAULT_SPACY_MODEL

        import torch
        _device = "cuda" if torch.cuda.is_available() else "cpu"

        if self._ner_backend == "gliner2":
            logger.debug("Entering GLiNER2 branch")
            try:
                from gliner2 import GLiNER2
            except ImportError:
                raise ImportError(
                    "gliner2 is required for NER_BACKEND=gliner2.\n"
                    "Install: pip install tp-vrg[gliner]"
                )
            gliner2_id = gliner_model or self.DEFAULT_GLINER2_MODEL
            # INV-2 (fail loud): a v2.1 model name fed into the gliner2 branch
            # silently 404'd on HuggingFace and the failure was only visible
            # in ~/.tp_vrg/mcp.log after the 2026-04-16 observability ship.
            # Refuse explicitly at the edge so the user sees WHY it failed.
            if gliner2_id.startswith("urchade/"):
                raise ValueError(
                    f"NER_BACKEND=gliner2 but gliner_model={gliner2_id!r} looks "
                    f"like a GLiNER v2.1 model (urchade/*). The gliner2 library "
                    f"expects fastino/* models. Either (a) leave TPVRG_GLINER_MODEL "
                    f"unset to use the default {self.DEFAULT_GLINER2_MODEL!r}, "
                    f"or (b) set TPVRG_NER_BACKEND=gliner to use the v2.1 backend."
                )
            # GLiNER2 prints emoji (U+1F9E0) during model load that Windows
            # cp1252 cannot encode. Set PYTHONIOENCODING=utf-8 before running,
            # or use: python -X utf8
            #
            # DO NOT pass map_location here: when another model in the same
            # process (e.g. LingMess coref via fastcoref) has activated
            # torch.compile/dynamo, dynamo's tracing state can leak into
            # transformers' load path and leave some DeBERTa weights on the
            # meta device. GLiNER2's .to(device) then fails with
            # "Cannot copy out of meta tensor; no data!". The dynamo.disable
            # below handles the runtime-inference equivalent.
            self._gliner2 = GLiNER2.from_pretrained(gliner2_id)
            self._gliner = None  # not used in gliner2 mode

            # CRITICAL: isolate GLiNER2's forward path from any outer
            # torch.compile/dynamo frame. Root cause diagnosed 2026-04-16
            # from ~/.tp_vrg/cockpit.log: the traceback of the first Cockpit
            # ingest crash passes through torch/_compile.py,
            # torch/_dynamo/eval_frame.py, torch/_refs/__init__.py and
            # torch/_library/fake_impl.py (the "fake" / meta kernel path) —
            # which is only taken when dynamo tracing is active. fastcoref
            # runs LingMess (a torch.compile'd model) immediately before the
            # GLiNER2 call during ingestion, leaving dynamo's global state
            # primed. GLiNER2's DeBERTa.disentangled_attention_bias then
            # executes under fake-tensor tracing and raises
            #   "Tensor on device cpu is not on the expected device meta!".
            # _dynamo.disable on the model and its encoder marks them opaque
            # so any outer compile frame treats them as black boxes.
            try:
                import torch._dynamo as _dynamo
                _dynamo.disable(self._gliner2)
                encoder = getattr(self._gliner2, "encoder", None)
                if encoder is not None:
                    _dynamo.disable(encoder)
            except Exception:  # best-effort; dynamo APIs shift across versions
                logger.exception(
                    "GLiNER2 dynamo.disable failed — inference may crash with"
                    " a meta-tensor error if another model has triggered compile"
                )

            logger.info("[NER] GLiNER2 backend: %s", gliner2_id)
        else:
            logger.debug("Entering GLiNER v2.1 branch")
            try:
                from gliner import GLiNER
            except ImportError:
                raise ImportError(
                    "gliner is required for GLiNERSpacyProvider.\n"
                    "Install: pip install tp-vrg[gliner]\n"
                    "IMPORTANT: Requires Python 3.12.\n"
                    "Use: .venv-gliner\\Scripts\\python.exe (not py -3.14)"
                )
            gliner_id = gliner_model or self.DEFAULT_GLINER_MODEL
            # INV-2 (fail loud): symmetric guard against fastino/* being passed
            # to the v2.1 branch.
            if gliner_id.startswith("fastino/"):
                raise ValueError(
                    f"NER_BACKEND=gliner (v2.1) but gliner_model={gliner_id!r} "
                    f"looks like a GLiNER2 model (fastino/*). The v2.1 library "
                    f"expects urchade/* models. Either (a) leave TPVRG_GLINER_MODEL "
                    f"unset to use the default {self.DEFAULT_GLINER_MODEL!r}, "
                    f"or (b) set TPVRG_NER_BACKEND=gliner2."
                )
            self._gliner = GLiNER.from_pretrained(gliner_id).to(_device)
            self._gliner2 = None  # not used in v2.1 mode
            logger.info("[NER] GLiNER v2.1 backend: %s", gliner_id)

        try:
            self._nlp = _spacy.load(spacy_id)
            self._nlp.max_length = 5_000_000
        except OSError:
            raise OSError(
                f"spaCy model '{spacy_id}' not found.\n"
                f"Download: python -m spacy download {spacy_id}"
            )

        # Cross-session coref context: salience table carried from the previous
        # ingest call. Threaded automatically through extract_entities_and_edges().
        # Reset to None by calling reset_coref_context() when starting a fresh document.
        self._coref_context: dict | None = None

        self._resolve_pronouns = None
        self._coref_mode = "sieve"
        self.set_coref_mode(coref_mode or os.environ.get("TPVRG_COREF_MODE", "sieve"))

    def set_coref_mode(self, coref_mode: str) -> None:
        self._coref_mode = (coref_mode or "rules").strip().lower()
        self._resolve_pronouns = get_coref_resolver(self._coref_mode)

    def reset_coref_context(self) -> None:
        self._coref_context = None

    async def _resolve_coref_async(
        self,
        raw_text: str,
        turn_boundaries: list[tuple[int, int, str]] | None,
    ) -> tuple[str, dict]:
        if self._resolve_pronouns is None:
            return raw_text, self._coref_context or {}

        kwargs = {
            "prior_context": self._coref_context,
            "turn_boundaries": turn_boundaries if turn_boundaries else None,
        }
        if self._coref_mode in {"lingmess", "sieve"}:
            return await asyncio.to_thread(
                self._resolve_pronouns,
                raw_text,
                self._nlp,
                **kwargs,
            )
        return self._resolve_pronouns(raw_text, self._nlp, **kwargs)

    async def extract_entities_and_edges(self, raw_text: str) -> ExtractionResult:
        """
        Extract entities (GLiNER) and relationships (spaCy dep-parse).

        lod_0 is intentionally NOT set — the engine sets it from raw_text.
        lod_1 is the best 1-2 sentences mentioning the entity (extractive).
        lod_2 is "Name [category]".
        """
        if not raw_text or not raw_text.strip():
            return ExtractionResult()

        # -- Pronoun resolution: replace pronouns with named antecedents before extraction.
        # This lets GLiNER detect entities that appear only as pronouns in the original text
        # and ensures dep-parse subjects are named entities (not pronouns).
        # prior_context threads salience state from the previous ingest call so entities
        # introduced in a prior session remain available for cross-session resolution.
        # Turn boundaries detect "Name: content" dialogue format (e.g. LoCoMo sessions)
        # so first-person "I/me/my" resolves to the speaker — critical for edge extraction.
        resolved_text = raw_text
        if self._coref_mode != "none" and self._resolve_pronouns is not None:
            from tp_vrg.coref import detect_turn_boundaries
            turns = detect_turn_boundaries(raw_text) if self._coref_mode in ("rules", "sieve") else None
            resolved_text, self._coref_context = await self._resolve_coref_async(raw_text, turns)

        # -- spaCy parse on resolved text (used for LOD_1, relationships, AND splitting)
        doc = self._nlp(resolved_text)

        # -- Entity extraction ---------------------------------------------------
        if self._ner_backend == "gliner2" and self._gliner2 is not None:
            # GLiNER2: single-pass extraction with native spans, no sub-chunking
            raw_result = self._gliner2.extract_entities(
                resolved_text, self.ENTITY_TYPES_V2,
                threshold=self.GLINER_THRESHOLD,
                include_spans=True, include_confidence=True,
            )
            # Normalize GLiNER2 output → v2.1 span format [{text, label, start, end}]
            raw_spans: list[dict] = []
            for label, entries in raw_result.get("entities", {}).items():
                if isinstance(entries, list):
                    for entry in entries:
                        if isinstance(entry, dict):
                            raw_spans.append({
                                "text": entry["text"],
                                "label": label,
                                "start": entry["start"],
                                "end": entry["end"],
                            })
                        elif isinstance(entry, str):
                            # Fallback: name only, no span — find in text
                            idx = resolved_text.lower().find(entry.lower())
                            if idx >= 0:
                                raw_spans.append({
                                    "text": entry,
                                    "label": label,
                                    "start": idx,
                                    "end": idx + len(entry),
                                })
            spans = _deduplicate_spans(raw_spans)
            per_subchunk_spans = [raw_spans]  # single "chunk" for Layer 2c compat
        else:
            # GLiNER v2.1: chunked extraction to avoid 384-token truncation
            raw_spans: list[dict] = []
            gliner_chunks = _split_for_gliner(resolved_text, doc)
            per_subchunk_spans: list[list[dict]] = []  # Layer 2c: track per-sub-chunk
            for chunk_text, chunk_offset in gliner_chunks:
                chunk_spans = self._gliner.predict_entities(
                    chunk_text, self.ENTITY_TYPES, threshold=self.GLINER_THRESHOLD
                )
                # Restore absolute character offsets so doc.char_span() works correctly
                for s in chunk_spans:
                    s["start"] += chunk_offset
                    s["end"] += chunk_offset
                raw_spans.extend(chunk_spans)
                per_subchunk_spans.append(chunk_spans)
            spans = _deduplicate_spans(raw_spans)

        # -- Build NodeData list -----------------------------------------------
        seen_ids: set[str] = set()
        nodes: list[NodeData] = []
        span_infos: list[dict] = []   # ALL span occurrences — used for token→entity mapping

        for span in spans:
            name = span["text"]
            category = span["label"]
            entity_id = _name_to_entity_id(name)

            # Add EVERY span occurrence to span_infos so all token positions map to
            # the entity in token_to_eid. An entity can appear many times (e.g. turn
            # label "Caroline:" AND as nsubj "Caroline went to..."). If only the first
            # occurrence is indexed, subjects at other positions won't produce edges.
            span_infos.append({
                "text": name,
                "label": category,
                "start": span["start"],
                "end": span["end"],
                "entity_id": entity_id,
            })

            # Deduplicate NodeData by entity_id — one node per entity in the graph
            if entity_id in seen_ids:
                continue
            seen_ids.add(entity_id)

            lod_1 = _lod1_for_entity(name, doc)
            lod_2 = f"{name} [{category}]"

            nodes.append(NodeData(
                entity_id=entity_id,
                name=name,
                category=category,
                # lod_0 set to lod_1 as placeholder — engine overwrites from raw_text
                # (NodeData.lod_0 is required by the Pydantic model; the engine always
                # replaces it with the verbatim chunk text in _chunk_and_ingest())
                lod_0=lod_1,
                lod_1=lod_1,
                lod_2=lod_2,
            ))

        # -- Relationship extraction (STACKED: spaCy SVO + GLiNER2 native) ----
        # spaCy SVO: high precision, low recall (~25-35%). Catches verb triples.
        extraction_stats = {"stopword_relations_skipped": 0}
        edges = _extract_relationships(doc, span_infos, extraction_stats)

        # GLiNER2 native relations: medium precision, medium recall.
        # Catches possessive, prepositional, appositive, copula, list/table.
        # STACKED — union of both, deduplicated by (source, target, relation).
        if self._ner_backend == "gliner2" and self._gliner2 is not None:
            try:
                rel_result = self._gliner2.extract_relations(
                    resolved_text, self.ENTITY_TYPES_V2,
                    threshold=self.GLINER_THRESHOLD,
                )
                # Normalize GLiNER2 relations → EdgeData
                # Format: {'relation_extraction': {'label': [(entity_a, entity_b), ...]}}
                seen_edges: set[tuple[str, str]] = {
                    (e.source, e.target) for e in edges
                }
                for label, pairs in rel_result.get("relation_extraction", {}).items():
                    for pair in pairs:
                        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                            continue
                        name_a, name_b = pair
                        if name_a == name_b:
                            continue  # skip self-relations
                        id_a = _name_to_entity_id(name_a)
                        id_b = _name_to_entity_id(name_b)
                        if id_a not in seen_ids or id_b not in seen_ids:
                            continue  # skip relations to unknown entities
                        if (id_a, id_b) in seen_edges or (id_b, id_a) in seen_edges:
                            continue  # deduplicate
                        if should_skip_extracted_relation(label, extraction_stats):
                            continue
                        seen_edges.add((id_a, id_b))
                        edges.append(EdgeData(
                            source=id_a,
                            target=id_b,
                            relation=f"related_via_{label}",
                        ))
            except Exception as exc:
                logger.warning("[GLiNER2] relation extraction failed: %s", exc)

        # Filter edges to only reference known entity_ids from this extraction
        valid_ids = seen_ids
        edges = [
            e for e in edges
            if e.source in valid_ids and e.target in valid_ids
        ]

        # -- Layer 2c: sub-sentence stitching between GLiNER sub-chunks ---
        # When text was split into multiple sub-chunks, create _follows edges
        # between adjacent sub-chunk entity groups (same pattern as Layer 2
        # inter-chunk stitching, but at sub-sentence scale).
        if len(per_subchunk_spans) > 1:
            node_ids = {n.entity_id for n in nodes}
            per_sc_eids: list[list[str]] = []
            for sc_spans in per_subchunk_spans:
                sc_eids = list(dict.fromkeys(
                    _name_to_entity_id(s["text"]) for s in sc_spans
                    if _name_to_entity_id(s["text"]) in node_ids
                ))
                per_sc_eids.append(sc_eids)

            for k in range(len(per_sc_eids) - 1):
                if not per_sc_eids[k] or not per_sc_eids[k + 1]:
                    continue
                for tail in per_sc_eids[k][-3:]:
                    for head in per_sc_eids[k + 1][:3]:
                        if tail != head:
                            edges.append(EdgeData(
                                source=tail, target=head,
                                relation="_follows", weight=0.5,
                            ))

        logger.info(
            "[GLiNER] %d nodes, %d edges from %d chars (resolved; "
            "stopword_relations_skipped=%d)",
            len(nodes), len(edges), len(resolved_text),
            extraction_stats["stopword_relations_skipped"],
        )
        return ExtractionResult(nodes=nodes, edges=edges)

    async def summarize(self, text: str, target_sentences: int = 2) -> str:
        """
        Extractive summarization: return the N longest sentences.

        Longer sentences tend to carry more information. This is deterministic
        and requires no LLM call.
        """
        if not text or not text.strip():
            return text
        doc = self._nlp(text)
        sents = [s.text.strip() for s in doc.sents if s.text.strip()]
        if not sents:
            return text
        top = sorted(sents, key=len, reverse=True)[:target_sentences]
        # Restore original order
        order = {s: i for i, s in enumerate(sents)}
        top_ordered = sorted(top, key=lambda s: order.get(s, 0))
        return " ".join(top_ordered)


class DeferredGLiNERProvider:
    """Background-loading wrapper for GLiNERSpacyProvider (UX-15).

    Starts loading GLiNER + spaCy models in a background thread immediately
    on construction. Returns instantly so startup can proceed to load
    query-essential models (embeddings, SQLite) without waiting.

    Ingestion calls block until loading completes. Query operations never
    touch this provider, so the user can query/browse while models load.
    """

    def __init__(
        self,
        gliner_model: str | None = None,
        spacy_model: str | None = None,
        coref_mode: str | None = None,
    ) -> None:
        import threading

        self._gliner_model = gliner_model
        self._spacy_model = spacy_model
        self._init_coref_mode = coref_mode
        self._pending_coref_mode: str | None = None
        self._provider: GLiNERSpacyProvider | None = None
        self._error: Exception | None = None
        self._ready = threading.Event()

        self._thread = threading.Thread(target=self._load, daemon=True, name="gliner-preload")
        self._thread.start()

    @staticmethod
    def _set_gliner_stage(message: str) -> None:
        try:
            import tp_vrg.api_server as _api_server
            _api_server._state.gliner_stage = message
        except Exception:
            pass

    def _emit_gliner_progress(
        self,
        current: int,
        total: int,
        message: str,
        state_message: str | None = None,
    ) -> None:
        progress.emit("gliner", current=current, total=total, message=message)
        self._set_gliner_stage(state_message or message)

    @staticmethod
    def _gliner_lock_payload() -> dict[str, object]:
        return {
            "pid": os.getpid(),
            "image": os.path.basename(sys.executable),
            "cmdline": " ".join(sys.argv),
        }

    @staticmethod
    def _is_cross_process_init_lock_stale(lock_path: str) -> tuple[bool, dict[str, object]]:
        try:
            with open(lock_path, encoding="utf-8") as fh:
                payload = json.load(fh)
        except (json.JSONDecodeError, OSError):
            return True, {"pid": None, "image": "", "cmdline": ""}

        if not isinstance(payload, dict):
            return True, {"pid": payload, "image": "", "cmdline": ""}

        pid = payload.get("pid")
        image = str(payload.get("image") or "")
        cmdline = str(payload.get("cmdline") or "")
        detail = {"pid": pid, "image": image, "cmdline": cmdline}
        try:
            pid_int = int(pid)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return True, detail

        import psutil

        try:
            proc = psutil.Process(pid_int)
            proc_name = proc.name()
            proc_cmdline = " ".join(proc.cmdline())
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            return True, detail

        proc_images = {proc_name.lower()}
        try:
            proc_images.add(os.path.basename(proc.exe()).lower())
        except (psutil.AccessDenied, psutil.NoSuchProcess, psutil.ZombieProcess, OSError):
            pass
        if image.lower() not in proc_images:
            return True, detail
        proc_cmdline_lower = proc_cmdline.lower()
        if "tp_vrg" not in proc_cmdline_lower and "tpvrg" not in proc_cmdline_lower:
            return True, detail
        return False, detail

    def _acquire_cross_process_init_lock(self):
        """Acquire a best-effort cross-process lock for first GLiNER model load."""
        import errno
        import tempfile
        lock_path = os.path.join(tempfile.gettempdir(), "tp_vrg_gliner_init.lock")
        timeout_s = float(os.environ.get("TPVRG_GLINER_INIT_LOCK_TIMEOUT", "120"))
        start = time.monotonic()
        next_wait_emit_s = 10.0
        fd = None
        while True:
            try:
                fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_RDWR)
                os.write(
                    fd,
                    json.dumps(self._gliner_lock_payload(), sort_keys=True).encode("utf-8"),
                )
                logger.info("[deferred-gliner] acquired init lock: %s", lock_path)
                break
            except OSError as exc:
                if exc.errno != errno.EEXIST:
                    raise
                is_stale, stale_detail = self._is_cross_process_init_lock_stale(lock_path)
                if is_stale:
                    logger.warning(
                        "[deferred-gliner] stale lock cleaned (writer pid=%r, image=%r); proceeding with fresh acquire",
                        stale_detail.get("pid"),
                        stale_detail.get("image"),
                    )
                    try:
                        os.unlink(lock_path)
                    except FileNotFoundError:
                        pass
                    continue
                elapsed = time.monotonic() - start
                if elapsed >= timeout_s:
                    logger.warning(
                        "[deferred-gliner] lock timeout after %.1fs (%s); proceeding without lock",
                        timeout_s,
                        lock_path,
                    )
                    return None, lock_path
                if elapsed >= next_wait_emit_s:
                    elapsed_s = int(elapsed)
                    timeout_label = f"{timeout_s:g}"
                    self._emit_gliner_progress(
                        2,
                        3,
                        f"Waiting on GLiNER init lock ({elapsed_s}s / {timeout_label}s timeout)...",
                        f"Waiting on init lock ({elapsed_s}s / {timeout_label}s)...",
                    )
                    next_wait_emit_s += 10.0
                time.sleep(0.2)
        return fd, lock_path

    @staticmethod
    def _release_cross_process_init_lock(fd, lock_path: str) -> None:
        if fd is None:
            return
        try:
            os.close(fd)
        finally:
            try:
                os.unlink(lock_path)
            except OSError:
                pass

    def _load(self) -> None:
        lock_fd = None
        lock_path = ""
        try:
            t0 = time.monotonic()
            logger.info("[deferred-gliner] background thread starting")
            self._emit_gliner_progress(
                1,
                3,
                "GLiNER2 background thread starting...",
                "Background thread starting...",
            )
            lock_fd, lock_path = self._acquire_cross_process_init_lock()
            self._emit_gliner_progress(
                2,
                3,
                "Loading GLiNER2 model from HuggingFace...",
                "Loading GLiNER2 model...",
            )
            self._provider = GLiNERSpacyProvider(
                gliner_model=self._gliner_model,
                spacy_model=self._spacy_model,
                coref_mode=self._init_coref_mode,
            )
            duration = time.monotonic() - t0
            logger.info(
                "[deferred-gliner] model loaded successfully (duration=%.2fs)",
                duration,
            )
            self._emit_gliner_progress(
                3,
                3,
                f"GLiNER2 ready ({duration:.0f}s)",
                f"Ready ({duration:.0f}s)",
            )
            if self._pending_coref_mode is not None:
                self._provider.set_coref_mode(self._pending_coref_mode)
        except Exception as e:
            self._error = e
            self._set_gliner_stage(f"Error: {e}")
            logger.exception("[deferred-gliner] error in background load: %s", e)
            # Log the FULL traceback to the file sink — otherwise pythonw
            # eats it and every user bug report becomes guesswork.
            # (_wait_for_provider later re-raises the exception instance,
            # but Python preserves only partial traceback through that
            # re-raise path; the file log is the only complete record.)
            logger.exception(
                "DeferredGLiNERProvider._load failed (gliner_model=%r, spacy_model=%r)",
                self._gliner_model, self._spacy_model,
            )
        finally:
            logger.info("[deferred-gliner] signalling main thread via event.set()")
            self._release_cross_process_init_lock(lock_fd, lock_path)
            self._ready.set()

    @property
    def is_ready(self) -> bool:
        """True when background loading completed successfully."""
        return self._ready.is_set() and self._error is None

    @property
    def loading_failed(self) -> bool:
        return self._ready.is_set() and self._error is not None

    @property
    def status(self) -> str:
        if not self._ready.is_set():
            return "loading"
        if self._error is not None:
            return f"failed: {self._error}"
        return "ready"

    def _wait_for_provider(self) -> GLiNERSpacyProvider:
        self._ready.wait()
        if self._error is not None:
            raise self._error
        assert self._provider is not None
        return self._provider

    async def extract_entities_and_edges(self, raw_text: str) -> ExtractionResult:
        return await self._wait_for_provider().extract_entities_and_edges(raw_text)

    async def summarize(self, text: str, target_sentences: int = 2) -> str:
        return await self._wait_for_provider().summarize(text, target_sentences)

    def set_coref_mode(self, coref_mode: str) -> None:
        if self._provider is not None:
            self._provider.set_coref_mode(coref_mode)
        else:
            self._pending_coref_mode = coref_mode

    def reset_coref_context(self) -> None:
        if self._provider is not None:
            self._provider.reset_coref_context()


# -- Mock data -----------------------------------------------------------------

def _mock_extract(raw_text: str) -> ExtractionResult:
    """
    Deterministic mock extractor that demonstrates the data flow.
    Returns a hard-coded demo graph regardless of input text.
    """
    demo_nodes = [
        NodeData(
            entity_id="openai",
            name="OpenAI",
            category="organization",
            lod_0=(
                "OpenAI is an artificial intelligence research laboratory consisting of "
                "the for-profit OpenAI LP and the non-profit OpenAI Inc. Founded in 2015 "
                "by Sam Altman, Elon Musk, and others, it aims to ensure that artificial "
                "general intelligence benefits all of humanity. OpenAI developed GPT-4, "
                "ChatGPT, DALL-E, and Codex among other influential AI systems."
            ),
            lod_1="OpenAI is an AI research lab founded in 2015 that created GPT-4 and ChatGPT.",
            lod_2="OpenAI [organization]",
        ),
        NodeData(
            entity_id="sam_altman",
            name="Sam Altman",
            category="person",
            lod_0=(
                "Sam Altman is the CEO of OpenAI. Previously he was the president of "
                "Y Combinator. He has been a prominent voice in AI policy discussions "
                "and testified before the US Senate on AI regulation in 2023. He was "
                "briefly ousted from OpenAI in November 2023 before being reinstated."
            ),
            lod_1="Sam Altman is the CEO of OpenAI and former president of Y Combinator.",
            lod_2="Sam Altman [person]",
        ),
        NodeData(
            entity_id="gpt4",
            name="GPT-4",
            category="technology",
            lod_0=(
                "GPT-4 is a large multimodal language model created by OpenAI, released "
                "in March 2023. It accepts text and image inputs and produces text outputs. "
                "It demonstrates human-level performance on various professional and "
                "academic benchmarks, including passing the bar exam in the 90th percentile."
            ),
            lod_1="GPT-4 is OpenAI's multimodal LLM released in March 2023 with strong benchmark results.",
            lod_2="GPT-4 [technology]",
        ),
        NodeData(
            entity_id="anthropic",
            name="Anthropic",
            category="organization",
            lod_0=(
                "Anthropic is an AI safety company founded in 2021 by Dario Amodei and "
                "Daniela Amodei, former members of OpenAI. The company focuses on AI "
                "safety research and developed the Claude family of AI assistants. "
                "Anthropic has raised significant funding and is headquartered in "
                "San Francisco."
            ),
            lod_1="Anthropic is an AI safety company founded by ex-OpenAI researchers, creators of Claude.",
            lod_2="Anthropic [organization]",
        ),
        NodeData(
            entity_id="dario_amodei",
            name="Dario Amodei",
            category="person",
            lod_0=(
                "Dario Amodei is the CEO of Anthropic. He previously served as VP of "
                "Research at OpenAI before co-founding Anthropic in 2021 with his sister "
                "Daniela Amodei. He is a leading voice on AI safety and responsible "
                "scaling policies."
            ),
            lod_1="Dario Amodei is the CEO of Anthropic and a prominent AI safety advocate.",
            lod_2="Dario Amodei [person]",
        ),
        NodeData(
            entity_id="ai_safety",
            name="AI Safety",
            category="concept",
            lod_0=(
                "AI Safety is a field of research focused on ensuring that artificial "
                "intelligence systems are beneficial and do not pose existential risks. "
                "Key areas include alignment, interpretability, robustness, and "
                "governance. Both OpenAI and Anthropic cite AI safety as core to "
                "their missions."
            ),
            lod_1="AI Safety research aims to ensure AI systems are beneficial and aligned with human values.",
            lod_2="AI Safety [concept]",
        ),
        NodeData(
            entity_id="y_combinator",
            name="Y Combinator",
            category="organization",
            lod_0=(
                "Y Combinator is a technology startup accelerator founded in 2005. "
                "It has funded over 4,000 startups including Airbnb, Stripe, and "
                "Dropbox. Sam Altman served as its president from 2014 to 2019 "
                "before leaving to lead OpenAI full-time."
            ),
            lod_1="Y Combinator is a major startup accelerator where Sam Altman was president.",
            lod_2="Y Combinator [organization]",
        ),
    ]

    demo_edges = [
        EdgeData(source="sam_altman", target="openai", relation="leads"),
        EdgeData(source="openai", target="gpt4", relation="developed"),
        EdgeData(source="dario_amodei", target="anthropic", relation="founded"),
        EdgeData(source="dario_amodei", target="openai", relation="formerly_at"),
        EdgeData(source="anthropic", target="ai_safety", relation="focuses_on"),
        EdgeData(source="openai", target="ai_safety", relation="focuses_on"),
        EdgeData(source="sam_altman", target="y_combinator", relation="formerly_led"),
    ]

    return ExtractionResult(nodes=demo_nodes, edges=demo_edges)
