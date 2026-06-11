"""
MCP stdio server for the TP-VRG knowledge graph engine.

Exposes tp-vrg as a Model Context Protocol server so LLM clients
(e.g. Claude Desktop) can ingest text, query the graph, and inspect
metrics over a persistent knowledge graph.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import uuid
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from tp_vrg.centrality import get_active_centrality_measure
from tp_vrg.engine import LODGraphMemory, maybe_wrap_embedding_cache
from tp_vrg.logging_setup import configure_file_logging
from tp_vrg.models import LODLevel, TokenProfile, WaterConfig
from tp_vrg.probe import probe_backend
from tp_vrg.provenance_storage import ProvenanceBackend
from tp_vrg.query_stats import (
    compute_query_stats,
    lod_distribution_from_last_query,
)
from tp_vrg.storage_sqlite import SQLiteBackend
from tp_vrg.tokens import estimate_tokens

# Tag progress.jsonl events from this process as source="mcp"
# (mirrors the pattern in tools/tpvrg_ingestor.py — see item-2-progress-file.md).
os.environ.setdefault("TPVRG_PROGRESS_SOURCE", "mcp")

# Configure file logging BEFORE any module-level work that might fail.
# MCP speaks JSON-RPC over stdout, so stdout must stay untouched; our
# logger writes to ~/.tp_vrg/mcp.log, never to stdout. The DIAG-print
# incident (commit 734954e, 2026-04-15) burned us once — never again.
configure_file_logging("mcp.log")

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Server instance
# ---------------------------------------------------------------------------

mcp_server = FastMCP("tp-vrg")

# ---------------------------------------------------------------------------
# Daemon proxy mode (engine-daemon Tier 1, 2026-04-22)
# ---------------------------------------------------------------------------
# When a long-running tp-vrg-api daemon is detected at main() startup, this
# module sets _DAEMON_URL to its base URL (e.g. "http://127.0.0.1:8321").
# Tool wrappers that see _DAEMON_URL != None skip the local-engine path
# entirely and HTTP-proxy the request to the daemon. This lets MCP attach
# to a shared engine instead of loading its own 4 GB of GLiNER+embedding
# models on every Claude Desktop session start.
#
# When _DAEMON_URL is None (no daemon detected OR probe failed), every tool
# falls through to the historical in-process path — local engine, own
# models, own SQLite handle. That is the fallback for dev machines that
# don't run a daemon + for CI + for users on the old launcher model.

_DAEMON_URL: str | None = None
_PROXY_TIMEOUT_SECONDS: float = float(os.environ.get("TPVRG_MCP_PROXY_TIMEOUT", "300"))


async def _proxy(method: str, path: str, **kwargs: Any) -> str:
    """Forward a request to the tp-vrg-api daemon and return the raw JSON body.

    Each MCP tool has a ``/foo`` counterpart in api_server. When in proxy
    mode, we just make the HTTP call and return the response text as-is —
    the daemon already returns the same JSON shape the local tool would.
    No transformation needed.

    Errors from the daemon (including engine failures) come back as
    JSON error objects; the MCP client handles them the same as local
    errors.

    Raises RuntimeError only if called without ``_DAEMON_URL`` being set
    (programmer error — tool should have fallen through to local path).
    """
    if _DAEMON_URL is None:
        raise RuntimeError("_proxy called but _DAEMON_URL is not set")
    import httpx  # httpx>=0.27 is declared in pyproject [project.dependencies]
    url = f"{_DAEMON_URL.rstrip('/')}{path}"
    try:
        async with httpx.AsyncClient(timeout=_PROXY_TIMEOUT_SECONDS) as client:
            r = await client.request(method, url, **kwargs)
    except httpx.TimeoutException as exc:
        logger.error("MCP proxy timeout: %s %s: %s", method, url, exc)
        return json.dumps({"status": "error", "message": f"daemon timeout: {exc}"})
    except httpx.RequestError as exc:
        logger.error("MCP proxy request error: %s %s: %s", method, url, exc)
        return json.dumps({"status": "error", "message": f"daemon unreachable: {exc}"})
    if r.status_code >= 400:
        logger.warning("MCP proxy HTTP %d: %s %s: %s", r.status_code, method, url, r.text[:500])
        # Preserve the daemon's error body; add status-code field for diagnosis.
        return json.dumps({
            "status": "error",
            "http_status": r.status_code,
            "message": r.text[:2000],
        })
    return r.text


# ---------------------------------------------------------------------------
# Constants (read-only — not mutable state)
# ---------------------------------------------------------------------------

from tp_vrg.data_dir import (
    ensure_data_dir_layout,
    get_data_dir,
    get_graph_db_path,
    get_provenance_db_path,
)

_DATA_DIR: Path = get_data_dir()
ensure_data_dir_layout(_DATA_DIR)

# Baseline tokens/query for flat-retrieval competitors (top-k vector search).
# Based on published benchmark data: Supermemory, Mem0, Letta average ~15 000
# context tokens per query. Adjust via TPVRG_FLAT_BASELINE_TOKENS env var.
_FLAT_BASELINE_TOKENS: int = int(os.environ.get("TPVRG_FLAT_BASELINE_TOKENS", 15000))

# ---------------------------------------------------------------------------
# ServerState — all mutable server-level state in one place
# ---------------------------------------------------------------------------


class ServerState:
    """Encapsulates all mutable MCP server state with async write serialization.

    A single asyncio.Lock serializes writes (ingest, clear, reset_stats).
    Reads (query, metrics, health) do NOT acquire the lock — SQLite WAL mode
    supports concurrent readers without blocking.
    """

    def __init__(self) -> None:
        self.memory: LODGraphMemory | None = None
        self.persist_path: Path | None = None
        self.use_sqlite: bool = False
        self.total_queries: int = 0
        self.total_tokens_served: int = 0
        self._lock: asyncio.Lock = asyncio.Lock()
        # F16: user-facing provenance layer (separate SQLite file)
        self.provenance: Any = None  # ProvenanceBackend | None

    async def get_memory(self) -> LODGraphMemory:
        """Return (and lazily initialise) the LODGraphMemory instance.

        Initialization is serialized through the write lock so only one
        coroutine bootstraps the engine even under concurrent calls.
        """
        if self.memory is not None:
            return self.memory

        async with self._lock:
            # Double-checked locking — another coroutine may have initialized
            # while we were waiting for the lock.
            if self.memory is not None:
                return self.memory

            _DATA_DIR.mkdir(parents=True, exist_ok=True)
            self.memory = _build_memory(self)
        return self.memory

    def save(self) -> None:
        """Persist the current graph state to disk.

        Raises on failure — callers must propagate or handle.
        """
        if self.memory is None or self.persist_path is None:
            return
        self.memory.save(self.persist_path)


# Module-level singleton
_state = ServerState()


# ---------------------------------------------------------------------------
# Engine factory (extracted from old _get_memory for clarity)
# ---------------------------------------------------------------------------


def _build_memory(state: ServerState) -> LODGraphMemory:
    """Construct and return a fully initialised LODGraphMemory.

    UX-15: GLiNER/spaCy start loading in a background thread immediately,
    while embeddings + SQLite load synchronously (query-essential).
    User can query/browse as soon as this function returns. Ingestion
    blocks until GLiNER finishes loading in the background.

    Mutates ``state.persist_path`` and ``state.use_sqlite`` as a side effect.
    """
    extraction_mode = os.environ.get("TPVRG_EXTRACTION_MODE", "gliner").lower()

    # -- LLM provider (UX-15: GLiNER starts in background) ------------------
    if extraction_mode == "local":
        from tp_vrg.llm_service import OllamaLLMProvider
        ollama_model = os.environ.get("TPVRG_OLLAMA_MODEL", OllamaLLMProvider.DEFAULT_MODEL)
        ollama_host = os.environ.get("TPVRG_OLLAMA_HOST", OllamaLLMProvider.DEFAULT_HOST)
        llm = OllamaLLMProvider(model=ollama_model, host=ollama_host)
        print(
            f"[tp-vrg] LLM provider: OllamaLLMProvider ({ollama_model} @ {ollama_host})",
            file=sys.stderr,
        )

    elif extraction_mode == "api":
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError(
                "[tp-vrg] ANTHROPIC_API_KEY is not set and TPVRG_EXTRACTION_MODE=api.\n"
                "Either set ANTHROPIC_API_KEY in your claude_desktop_config.json, or\n"
                "switch to local mode: TPVRG_EXTRACTION_MODE=local\n"
                "  (requires: pip install tp-vrg[local]  +  Ollama running locally)\n"
                "  See docs/local-setup.md for setup instructions."
            )
        try:
            from tp_vrg.llm_service import AnthropicLLMProvider
        except ImportError:
            raise RuntimeError(
                "[tp-vrg] 'anthropic' package is not installed. "
                "Fix: pip install tp-vrg[mcp]"
            )
        model = os.environ.get("TPVRG_MODEL", "haiku")
        llm = AnthropicLLMProvider(api_key=api_key, model=model)
        resolved = llm._model  # full model string after alias resolution
        print(f"[tp-vrg] LLM provider: AnthropicLLMProvider ({resolved})", file=sys.stderr)

    elif extraction_mode == "gliner":
        # UX-15: start GLiNER loading in background thread — returns instantly.
        # User can query/browse while models load. Ingestion blocks until ready.
        try:
            from tp_vrg.llm_service import DeferredGLiNERProvider, GLiNERSpacyProvider
            # INV-1: pass None so GLiNERSpacyProvider can pick the default that
            # matches the active NER_BACKEND. Same bug root-caused in
            # ~/.tp_vrg/mcp.log 2026-04-16 — see api_server.py comment.
            gliner_model = os.environ.get("TPVRG_GLINER_MODEL")
            spacy_model = os.environ.get("TPVRG_SPACY_MODEL")
            llm = DeferredGLiNERProvider(gliner_model=gliner_model, spacy_model=spacy_model)
            print(
                f"[tp-vrg] LLM provider: DeferredGLiNERProvider ({gliner_model} + {spacy_model}) — loading in background",
                file=sys.stderr,
            )
            logger.info(
                "[startup] DeferredGLiNERProvider configured (cross-process init lock enabled)"
            )
        except ImportError as exc:
            print(f"[tp-vrg] GLiNERSpacyProvider failed to import: {exc}", file=sys.stderr)
            sys.exit(1)

    else:
        raise RuntimeError(
            f"[tp-vrg] Unknown TPVRG_EXTRACTION_MODE='{extraction_mode}'.\n"
            "Valid values: api (default), local, gliner"
        )

    # -- Embedding provider (query-essential, loads synchronously) -----------
    try:
        from tp_vrg.embeddings import SentenceTransformerProvider
    except ImportError:
        raise RuntimeError(
            "[tp-vrg] 'sentence-transformers' package is not installed. "
            "Fix: pip install tp-vrg[mcp]"
        )

    embedding = SentenceTransformerProvider()
    print("[tp-vrg] Embedding provider: SentenceTransformerProvider", file=sys.stderr)

    # -- Storage backend -----------------------------------------------------
    # SQL-I1 / pipeline contract C2: thread the embedder's actual dimension
    # through to the storage backend. Without this, SQLiteBackend defaults to
    # embedding_dim=384 regardless of the model loaded, causing silent dim
    # mismatches at ingest time. See backlog.md SQL-I1 for the history.
    state.persist_path = get_graph_db_path(_DATA_DIR)
    try:
        storage = SQLiteBackend(
            state.persist_path,
            embedding_dim=embedding.dimension,
        )
    except Exception:
        logger.exception(
            "[startup] SQLiteBackend failed for %s; MCP startup aborting",
            state.persist_path,
        )
        raise
    state.use_sqlite = True
    print(
        f"[tp-vrg] Storage: SQLiteBackend ({state.persist_path}, "
        f"embedding_dim={embedding.dimension})",
        file=sys.stderr,
    )

    # -- Water mode (Fire/Water Doctrine) --------------------------------------
    water_mode = os.environ.get("TPVRG_WATER_MODE", "false").lower() == "true"
    water_config = WaterConfig(enabled=water_mode)
    water_llm = None
    if water_mode:
        # Water LLM: separate provider for augmentation (query expansion, reranking, enrichment).
        # Uses Ollama by default; falls back to the extraction LLM if it has complete().
        water_llm_mode = os.environ.get("TPVRG_WATER_LLM", "ollama").lower()
        if water_llm_mode == "ollama":
            from tp_vrg.llm_service import OllamaLLMProvider
            water_ollama_model = os.environ.get(
                "TPVRG_WATER_OLLAMA_MODEL",
                os.environ.get("TPVRG_OLLAMA_MODEL", "qwen2.5:14b-instruct-q4_K_M"),
            )
            water_ollama_host = os.environ.get("TPVRG_OLLAMA_HOST", OllamaLLMProvider.DEFAULT_HOST)
            water_llm = OllamaLLMProvider(model=water_ollama_model, host=water_ollama_host)
            print(f"[tp-vrg] Water LLM: OllamaLLMProvider ({water_ollama_model})", file=sys.stderr)
        elif water_llm_mode == "api":
            # Reuse the extraction LLM if it supports complete()
            if hasattr(llm, "complete"):
                water_llm = llm
                print("[tp-vrg] Water LLM: reusing extraction LLM (API)", file=sys.stderr)
            else:
                print("[tp-vrg] WARNING: Water mode API requested but extraction LLM has no complete()", file=sys.stderr)
        print(f"[tp-vrg] Water mode: ENABLED", file=sys.stderr)

    # F16: open the provenance backend alongside the graph backend.
    # Failure to open is non-fatal — the engine still works without it,
    # but tp_vrg_explain will return "provenance backend not initialized".
    try:
        prov_path = get_provenance_db_path(_DATA_DIR)
        state.provenance = ProvenanceBackend(prov_path)
        print(f"[tp-vrg] Provenance: ProvenanceBackend ({prov_path})", file=sys.stderr)
    except Exception as exc:
        print(f"[tp-vrg] Provenance backend unavailable: {exc}", file=sys.stderr)
        state.provenance = None

    embedding = maybe_wrap_embedding_cache(embedding, storage)
    logger.info(
        "[embedding] cache=%s model_id=%s dimension=%s",
        os.environ.get("TPVRG_EMBEDDING_CACHE", "on").strip().lower(),
        getattr(embedding, "model_id", "unknown"),
        getattr(embedding, "dimension", "unknown"),
    )
    logger.info("[centrality] measure=%s", get_active_centrality_measure())
    return LODGraphMemory(
        llm_provider=llm,
        embedding_provider=embedding,
        storage=storage,
        water_config=water_config,
        water_llm=water_llm,
        provenance=state.provenance,
    )


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@mcp_server.tool()
async def tp_vrg_ingest(text: str, source: str = "", event_timestamp: float | None = None) -> str:
    """Ingest text into the TP-VRG knowledge graph.

    Extracts entities and relationships from the provided text and merges
    them into the persistent knowledge graph.

    Args:
        text: The text to ingest and extract knowledge from.
        source: Optional label describing the text source.
        event_timestamp: Unix timestamp of the described event (e.g.
            conversation create_time from a ChatGPT export).
    """
    if _DAEMON_URL:
        return await _proxy(
            "POST", "/ingest",
            json={"text": text, "source": source, "event_timestamp": event_timestamp},
        )
    # Serialize writes — only one ingest at a time to protect SQLite state.
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            result = await mem.ingest(text, source=source, event_timestamp=event_timestamp)

            try:
                _state.save()
            except Exception as save_exc:
                # Ingest succeeded but persistence failed — warn but don't hide data
                return json.dumps({
                    "status": "partial",
                    "message": f"Ingested but failed to persist: {save_exc}",
                    "source": source or "(none)",
                    "nodes_added": len(result.nodes),
                    "edges_added": len(result.edges),
                    "total_nodes": mem.node_count,
                    "total_edges": mem.edge_count,
                })

            return json.dumps({
                "status": "ok",
                "source": source or "(none)",
                "nodes_added": len(result.nodes),
                "edges_added": len(result.edges),
                "total_nodes": mem.node_count,
                "total_edges": mem.edge_count,
            })
        except Exception as exc:
            return json.dumps({"status": "error", "message": str(exc)})


@mcp_server.tool()
async def tp_vrg_query(question: str, token_budget: int = 10000) -> str:
    """Query the TP-VRG knowledge graph.

    Assembles a context string from the knowledge graph using topology-aware
    variable-resolution (LOD) selection, constrained by a token budget.

    Args:
        question: The question or topic to query about.
        token_budget: Maximum token budget for context assembly (default 10000).
    """
    if _DAEMON_URL:
        return await _proxy(
            "POST", "/query",
            json={"question": question, "token_budget": token_budget},
        )
    try:
        # Reads do NOT acquire the write lock — WAL mode supports concurrent readers.
        mem = await _state.get_memory()

        if mem.node_count == 0:
            return json.dumps({
                "context": "[Knowledge graph is empty. Ingest some text first.]",
                "stats": {
                    "nodes_used": 0,
                    "tokens_used": 0,
                    "lod_distribution": {"LOD_0": 0, "LOD_1": 0, "LOD_2": 0},
                },
            })

        profile = TokenProfile(name="mcp_query", max_tokens=token_budget)
        context = await mem.render_context(question, profile=profile)
        tokens_used = estimate_tokens(context)

        # Accumulate runtime query stats (non-critical counters; minor race is acceptable)
        _state.total_queries += 1
        _state.total_tokens_served += tokens_used

        # F16: record the answer + citations to the provenance log.
        # Best-effort — failure does not affect the query result.
        answer_id: str | None = str(uuid.uuid4())
        if _state.provenance is not None:
            try:
                _state.provenance.begin_batch()
                _state.provenance.record_answer(
                    answer_id=answer_id,
                    query_text=question,
                    model_label="tp-vrg",
                    user_id=None,  # future: multi-user account backend
                )
                rendered_pids = list(mem._last_rendered_passage_ids)
                if rendered_pids:
                    _state.provenance.record_citations(
                        answer_id,
                        [(pid, i, "") for i, pid in enumerate(rendered_pids)],
                    )
                _state.provenance.commit_batch()
            except Exception as exc:
                try:
                    _state.provenance.rollback_batch()
                except Exception:
                    pass
                logger.warning(
                    "F16: provenance write for answer %s failed: %s", answer_id, exc
                )
                answer_id = None

        # API-STATS-TELEMETRY-PASSAGE-MODE-ZERO fix (2026-05-17 overnight
        # batch Block 3): use shared compute_query_stats helper that handles
        # both entity-mode (_active_lods) AND passage-mode
        # (_last_rendered_passage_ids fallback). Previously this block counted
        # only entity-mode LODs, so passage-mode queries reported all zeros
        # (nodes_used=0, empty lod_distribution, zero savings) despite real
        # rendered context. Shared with api_server.py /query + /answer +
        # /answer/stream to prevent the UX-10-style drift.
        stats = compute_query_stats(mem, tokens_used)

        return json.dumps({
            "context": context,
            "answer_id": answer_id,  # F16: pass to tp_vrg_explain to retrieve the provenance trace
            "stats": stats,
        })
    except Exception as exc:
        return json.dumps({"status": "error", "message": str(exc)})


@mcp_server.tool()
async def tp_vrg_explain(answer_id: str) -> str:
    """Return the provenance trace for a previous answer (F16).

    Given an answer_id from a prior tp_vrg_query response, returns the
    original query text, timestamp, and the list of source citations
    (segment_id, source_label, text excerpt) that contributed to the
    rendered answer. Use this to audit which documents supported an
    answer — the user-facing explanation layer.

    Args:
        answer_id: UUID returned in the `answer_id` field of a prior
            tp_vrg_query response. Pre-F16 queries (or queries where
            provenance writes failed) will have `answer_id=null` and
            cannot be explained.
    """
    if _DAEMON_URL:
        return await _proxy("GET", f"/explain/{answer_id}")
    if _state.provenance is None:
        return json.dumps({
            "status": "error",
            "message": "provenance backend not initialized — answers cannot be explained",
        })
    try:
        answer = _state.provenance.get_answer(answer_id)
        if answer is None:
            return json.dumps({"status": "not_found", "answer_id": answer_id})

        raw_citations = _state.provenance.get_citations_for_answer(answer_id)

        # Classify provenance coverage — how much of the citation chain
        # resolved to known source segments. Pre-F16 content produces
        # orphaned citations with source_label=None.
        total = len(raw_citations)
        null_sources = sum(1 for c in raw_citations if c.get("source_label") is None)
        if total == 0:
            coverage = "none"
        elif null_sources == 0:
            coverage = "full"
        elif null_sources == total:
            coverage = "none"  # all orphaned (pre-F16 content)
        else:
            coverage = "partial"

        citations_out = []
        for c in raw_citations:
            source_label = c.get("source_label")
            text = c.get("text")
            citations_out.append({
                "cite_order": c.get("cite_order"),
                "segment_id": c.get("segment_id"),
                "source_label": source_label if source_label else "(unknown — pre-F16 content)",
                "text_excerpt": (text or "")[:200],
                "full_text_available": bool(text),
            })

        return json.dumps({
            "status": "ok",
            "answer_id": answer["answer_id"],
            "query": answer["query_text"],
            "answered_at": answer["answered_at"],
            "model_label": answer["model_label"],
            "provenance_coverage": coverage,
            "citations": citations_out,
        })
    except Exception as exc:
        return json.dumps({"status": "error", "message": str(exc)})


@mcp_server.tool()
async def tp_vrg_delete_source(source_id: str) -> str:
    """Delete one ingested source for GDPR right-to-erasure workflows.

    Removes the source's passages and any nodes derived only from those
    passages. Nodes that still have provenance from other sources are
    preserved with the deleted source's provenance removed.
    """
    if _DAEMON_URL:
        return await _proxy("DELETE", f"/source/{source_id}")
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            storage = mem._storage
            if not isinstance(storage, SQLiteBackend):
                return json.dumps({
                    "status": "error",
                    "message": "delete_source requires SQLite storage.",
                })
            report = await asyncio.to_thread(
                storage.delete_source,
                source_id,
                _state.provenance,
            )
            return json.dumps(report)
        except KeyError:
            return json.dumps({"status": "not_found", "source_id": source_id})
        except Exception as exc:
            logger.exception("tp_vrg_delete_source failed for %s", source_id)
            return json.dumps({"status": "error", "message": str(exc)})


def _maybe_sign_artifact_mcp(artifact: dict, payload_type: str, sign: bool) -> dict:
    """Sign an export payload when requested (IV-2 Q1 federation artifact).

    Sigstore-class detached Ed25519 envelope, NOT blockchain. Raises
    ImportError (fail loud) when the attestation extras are missing —
    never silently returns unsigned data the caller asked to have signed.
    """
    if not sign:
        return artifact
    from tp_vrg.attestation import sign_envelope
    return sign_envelope(artifact, payload_type)


@mcp_server.tool()
async def tp_vrg_extract_source(
    source_id: str,
    include_embeddings: bool = False,
    sign: bool = False,
) -> str:
    """Export one ingested source as a PortableArtifact (GDPR Art 20 portability).

    Non-destructive: the live graph is NOT mutated; the artifact is a
    pure-read serialization of the source's derived-only closure plus typed
    stubs (lod_2 labels only — never lod_0/lod_1) for boundary nodes. See
    docs/design/arch-rung-level-subgraph-migration-2026-06-08.md §4 + §6.

    sign=True wraps the artifact in a signed attestation envelope
    (audit-grade verifiable export; verify offline with `tp-vrg verify`).

    Legacy graphs whose passages.source_id is empty require running the
    Janitor backfill_node_provenance task once first (the same prerequisite
    as delete_source — see backlog [GDPR-LIVE-GRAPH-BACKFILL-PREREQ]).
    """
    if _DAEMON_URL:
        params = []
        if include_embeddings:
            params.append("include_embeddings=true")
        if sign:
            params.append("sign=true")
        suffix = ("?" + "&".join(params)) if params else ""
        return await _proxy("GET", f"/source/{source_id}/export{suffix}")
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            storage = mem._storage
            if not isinstance(storage, SQLiteBackend):
                return json.dumps({
                    "status": "error",
                    "message": "extract_source requires SQLite storage.",
                })
            artifact = await asyncio.to_thread(
                storage.extract_source,
                source_id,
                _state.provenance,
                include_embeddings=include_embeddings,
            )
            artifact = await asyncio.to_thread(
                _maybe_sign_artifact_mcp, artifact, "portable_artifact", sign
            )
            return json.dumps(artifact)
        except KeyError:
            return json.dumps({"status": "not_found", "source_id": source_id})
        except Exception as exc:
            logger.exception("tp_vrg_extract_source failed for %s", source_id)
            return json.dumps({"status": "error", "message": str(exc)})


@mcp_server.tool()
async def tp_vrg_delete_asset(asset_id: str) -> str:
    """Delete one Asset (document-level unit) and cascade its derived-only nodes.

    The Asset-rung sibling of tp_vrg_delete_source (GDPR Art 17 at the
    granularity buyers think in — 'the merger agreement', not 'source 3').
    Nodes shared with other assets — including other assets of the same
    source — are preserved with the asset's provenance removed. The asset
    row + its asset_entities + edge_provenance rows are cascaded.

    Membership unmaterialized / unresolvable (the Asset overlay backfill or
    the node_provenance backfill is pending) returns status
    "precondition_failed" with the required Janitor task in the message.
    """
    if _DAEMON_URL:
        return await _proxy("DELETE", f"/asset/{asset_id}")
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            storage = mem._storage
            if not isinstance(storage, SQLiteBackend):
                return json.dumps({
                    "status": "error",
                    "message": "delete_asset requires SQLite storage.",
                })
            report = await asyncio.to_thread(storage.delete_asset, asset_id)
            return json.dumps(report)
        except KeyError:
            return json.dumps({"status": "not_found", "asset_id": asset_id})
        except ValueError as exc:
            return json.dumps({
                "status": "precondition_failed",
                "asset_id": asset_id,
                "message": str(exc),
            })
        except Exception as exc:
            logger.exception("tp_vrg_delete_asset failed for %s", asset_id)
            return json.dumps({"status": "error", "message": str(exc)})


@mcp_server.tool()
async def tp_vrg_extract_asset(
    asset_id: str,
    include_embeddings: bool = False,
    sign: bool = False,
) -> str:
    """Export one Asset as a PortableArtifact (GDPR Art 20 at the Asset rung).

    Non-destructive: the live graph is NOT mutated. The artifact carries
    the full Authorial asset record (lineage, edition, source hash,
    declared-by), the asset's derived-only closure as full content,
    lod_2-only stubs for every shared entity the asset mentions, and the
    asset-scoped evidence (asset_entities + edge_provenance). See
    docs/design/arch-rung-level-subgraph-migration-2026-06-08.md §4+§5+§6.

    sign=True wraps the artifact in a signed attestation envelope
    (audit-grade verifiable export; verify offline with `tp-vrg verify`).

    Membership unmaterialized / unresolvable returns status
    "precondition_failed" naming the required Janitor backfill — the
    pure-read extract never self-heals.
    """
    if _DAEMON_URL:
        params = []
        if include_embeddings:
            params.append("include_embeddings=true")
        if sign:
            params.append("sign=true")
        suffix = ("?" + "&".join(params)) if params else ""
        return await _proxy("GET", f"/asset/{asset_id}/export{suffix}")
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            storage = mem._storage
            if not isinstance(storage, SQLiteBackend):
                return json.dumps({
                    "status": "error",
                    "message": "extract_asset requires SQLite storage.",
                })
            artifact = await asyncio.to_thread(
                storage.extract_asset,
                asset_id,
                include_embeddings=include_embeddings,
            )
            artifact = await asyncio.to_thread(
                _maybe_sign_artifact_mcp, artifact, "portable_artifact", sign
            )
            return json.dumps(artifact)
        except KeyError:
            return json.dumps({"status": "not_found", "asset_id": asset_id})
        except ValueError as exc:
            return json.dumps({
                "status": "precondition_failed",
                "asset_id": asset_id,
                "message": str(exc),
            })
        except Exception as exc:
            logger.exception("tp_vrg_extract_asset failed for %s", asset_id)
            return json.dumps({"status": "error", "message": str(exc)})


@mcp_server.tool()
async def tp_vrg_extract_community(
    community_id: str,
    rung: str = "island",
    include_embeddings: bool = False,
    sign: bool = False,
) -> str:
    """Export one Island or Continent as a PortableArtifact (rung-migration step 4).

    The union of the community's member assets' closures: knowledge shared
    WITHIN the community travels as full content (the rung defines the
    boundary); knowledge shared with the rest of the graph becomes
    lod_2-only stubs. The artifact carries every member asset's Authorial
    record + the membership/labels as re-bakeable Systemic state.
    Pure-read. sign=True wraps in the attestation envelope. Returns
    "precondition_failed" on stale partitions (re-bake first).
    """
    if _DAEMON_URL:
        params = []
        if include_embeddings:
            params.append("include_embeddings=true")
        if sign:
            params.append("sign=true")
        suffix = ("?" + "&".join(params)) if params else ""
        return await _proxy("GET", f"/{rung}/{community_id}/export{suffix}")
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            storage = mem._storage
            if not isinstance(storage, SQLiteBackend):
                return json.dumps({
                    "status": "error",
                    "message": "extract_community requires SQLite storage.",
                })
            artifact = await asyncio.to_thread(
                lambda: storage.extract_community(
                    community_id,
                    rung=rung,
                    include_embeddings=include_embeddings,
                )
            )
            artifact = await asyncio.to_thread(
                _maybe_sign_artifact_mcp, artifact, "portable_artifact", sign
            )
            return json.dumps(artifact)
        except KeyError:
            return json.dumps({"status": "not_found", "community_id": community_id})
        except ValueError as exc:
            return json.dumps({
                "status": "precondition_failed",
                "community_id": community_id,
                "message": str(exc),
            })
        except Exception as exc:
            logger.exception("tp_vrg_extract_community failed for %s", community_id)
            return json.dumps({"status": "error", "message": str(exc)})


async def _mcp_move_unit(
    rung: str,
    unit_id: str,
    artifact_dir: str,
    sign: bool,
    include_embeddings: bool,
) -> str:
    if _DAEMON_URL:
        from urllib.parse import quote

        params = f"?artifact_dir={quote(artifact_dir)}&sign={'true' if sign else 'false'}"
        if not include_embeddings:
            params += "&include_embeddings=false"
        return await _proxy("POST", f"/{rung}/{unit_id}/move{params}")
    if not (artifact_dir or "").strip():
        return json.dumps({
            "status": "precondition_failed",
            "message": "artifact_dir is required: the move persists the artifact "
            "to disk BEFORE deleting (a lost response must never lose knowledge).",
        })
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            storage = mem._storage
            if not isinstance(storage, SQLiteBackend):
                return json.dumps({
                    "status": "error", "message": "move requires SQLite storage.",
                })
            from tp_vrg.api_server import _persist_move_artifact

            persist = _persist_move_artifact(artifact_dir, rung, unit_id, sign)
            if rung == "asset":
                report = await asyncio.to_thread(
                    lambda: storage.move_asset(
                        unit_id,
                        include_embeddings=include_embeddings,
                        persist_artifact=persist,
                    )
                )
            else:
                report = await asyncio.to_thread(
                    lambda: storage.move_source(
                        unit_id,
                        _state.provenance,
                        include_embeddings=include_embeddings,
                        persist_artifact=persist,
                    )
                )
            report.pop("artifact", None)  # on disk; never echo the only-copy
            return json.dumps(report)
        except KeyError:
            return json.dumps({"status": "not_found", "unit_id": unit_id})
        except (ValueError, OSError) as exc:
            return json.dumps({
                "status": "precondition_failed",
                "unit_id": unit_id,
                "message": f"move ABORTED, graph unchanged: {exc}",
            })
        except Exception as exc:
            logger.exception("tp_vrg_move_%s failed for %s", rung, unit_id)
            return json.dumps({"status": "error", "message": str(exc)})


@mcp_server.tool()
async def tp_vrg_move_asset(
    asset_id: str,
    artifact_dir: str,
    sign: bool = True,
    include_embeddings: bool = True,
) -> str:
    """MOVE one Asset out of this graph (extract → persist → delete → stub).

    The 'context cartridge': the asset's knowledge leaves as one signed,
    verifiable file written to artifact_dir BEFORE the delete commits —
    a persist failure aborts with the graph unchanged. The residual graph
    keeps a content-free stub + a migration_log hash for merge-back
    verification. Import the file elsewhere with import_portable_artifact;
    verify it with `tp-vrg verify`.
    """
    return await _mcp_move_unit("asset", asset_id, artifact_dir, sign, include_embeddings)


@mcp_server.tool()
async def tp_vrg_move_source(
    source_id: str,
    artifact_dir: str,
    sign: bool = True,
    include_embeddings: bool = True,
) -> str:
    """MOVE one source out of this graph. See tp_vrg_move_asset."""
    return await _mcp_move_unit("source", source_id, artifact_dir, sign, include_embeddings)


@mcp_server.tool()
async def tp_vrg_export_trace(answer_id: str, sign: bool = True) -> str:
    """Export one rendered answer's trace as a (signed) file-able object.

    The audit-grade render trace: the query, model, and citation chain
    back to source segments, composed from the Provenance Layer. By
    default wrapped in a Sigstore-class signed attestation envelope
    (detached Ed25519; NOT blockchain) so a third party can verify the
    trace offline with `tp-vrg verify <file>`. Use tp_vrg_explain for the
    human-readable view; this tool is the verifiable-export form.
    """
    if _DAEMON_URL:
        suffix = "" if sign else "?sign=false"
        return await _proxy("GET", f"/trace/{answer_id}/export{suffix}")
    async with _state._lock:
        try:
            from tp_vrg.attestation import build_render_trace

            if _state.provenance is None:
                return json.dumps({
                    "status": "error",
                    "message": "render-trace export requires the provenance store.",
                })
            trace = await asyncio.to_thread(
                build_render_trace, answer_id, _state.provenance
            )
            trace = await asyncio.to_thread(
                _maybe_sign_artifact_mcp, trace, "render_trace", sign
            )
            return json.dumps(trace)
        except KeyError:
            return json.dumps({"status": "not_found", "answer_id": answer_id})
        except ImportError as exc:
            return json.dumps({"status": "error", "message": str(exc)})
        except Exception as exc:
            logger.exception("tp_vrg_export_trace failed for %s", answer_id)
            return json.dumps({"status": "error", "message": str(exc)})


@mcp_server.tool()
async def tp_vrg_metrics() -> str:
    """Get metrics about the current TP-VRG knowledge graph.

    Returns node/edge counts, LOD distribution from the last query,
    storage-level token savings, and cumulative runtime query savings
    compared to flat-retrieval competitors.
    """
    if _DAEMON_URL:
        return await _proxy("GET", "/metrics")
    try:
        mem = await _state.get_memory()
        nodes = mem._storage.get_all_nodes()

        # LOD distribution from last query (zeros if no query run yet).
        # API-STATS-TELEMETRY-PASSAGE-MODE-ZERO fix (2026-05-17 overnight
        # batch Block 3): use shared helper that handles passage-mode
        # fallback. Previously this loop only counted _active_lods, so
        # passage-mode queries left the distribution empty.
        lod_counts, _nodes_used = lod_distribution_from_last_query(mem)

        # Storage savings: LOD_0 (full text) vs LOD_2 (name + category)
        raw_tokens = sum(estimate_tokens(n.lod_0) for n in nodes.values())
        compact_tokens = sum(estimate_tokens(n.lod_2) for n in nodes.values())
        storage_savings_pct = (
            ((raw_tokens - compact_tokens) / raw_tokens * 100)
            if raw_tokens > 0
            else 0.0
        )

        # Cumulative runtime savings vs flat-retrieval baseline
        flat_total = _state.total_queries * _FLAT_BASELINE_TOKENS
        tokens_saved = max(0, flat_total - _state.total_tokens_served)
        runtime_savings_pct = (
            (tokens_saved / flat_total * 100) if flat_total > 0 else 0.0
        )

        return json.dumps({
            "total_nodes": mem.node_count,
            "total_edges": mem.edge_count,
            "lod_distribution": lod_counts,
            # Storage-level metrics
            "raw_storage_tokens": raw_tokens,
            "compact_storage_tokens": compact_tokens,
            "storage_savings_pct": round(storage_savings_pct, 1),
            # Cumulative runtime query metrics
            "total_queries": _state.total_queries,
            "cumulative_tokens_served": _state.total_tokens_served,
            "flat_retrieval_baseline_tokens": flat_total,
            "cumulative_tokens_saved": tokens_saved,
            "runtime_savings_pct": round(runtime_savings_pct, 1),
            "flat_baseline_per_query": _FLAT_BASELINE_TOKENS,
        })
    except Exception as exc:
        return json.dumps({"status": "error", "message": str(exc)})


@mcp_server.tool()
async def tp_vrg_health() -> str:
    """Check the health and integrity of the TP-VRG knowledge graph.

    Returns node/edge/passage counts, FTS5 sync status, vec0 embedding row
    counts, orphaned edges, and graph connectivity. Also includes F16
    provenance backend statistics (sources, segments, answers, citations)
    when available.
    """
    if _DAEMON_URL:
        return await _proxy("GET", "/health")
    try:
        mem = await _state.get_memory()
        storage = mem._storage
        if isinstance(storage, SQLiteBackend):
            health = storage.health_check()
        else:
            health = {
                "status": "ok",
                "backend": "InMemoryBackend",
                "note": "Full diagnostics only available with SQLiteBackend",
                "node_count": storage.node_count(),
                "edge_count": storage.edge_count(),
            }

        # F16: add provenance backend stats if available
        if _state.provenance is not None:
            try:
                health["provenance"] = _state.provenance.health_check()
            except Exception as exc:
                health["provenance"] = {"status": "error", "message": str(exc)}
        else:
            health["provenance"] = {"status": "not_initialized"}

        return json.dumps(health)
    except Exception as exc:
        return json.dumps({"status": "error", "message": str(exc)})


@mcp_server.tool()
async def tp_vrg_reset_stats(confirm: bool = False) -> str:
    """Reset cumulative query statistics for TP-VRG.

    Zeroes the total_queries and cumulative_tokens_served counters so you
    can isolate token savings for a specific scenario or benchmark run.
    Does NOT touch the knowledge graph itself — use tp_vrg_clear for that.

    Args:
        confirm: Must be True to actually reset the counters.
    """
    if _DAEMON_URL:
        return await _proxy("POST", "/reset-stats", json={"confirm": confirm})
    if not confirm:
        return json.dumps({
            "status": "aborted",
            "message": "Set confirm=True to reset query stats.",
            "current_stats": {
                "total_queries": _state.total_queries,
                "cumulative_tokens_served": _state.total_tokens_served,
            },
        })

    async with _state._lock:
        snapshot = {
            "total_queries": _state.total_queries,
            "cumulative_tokens_served": _state.total_tokens_served,
        }
        _state.total_queries = 0
        _state.total_tokens_served = 0

    return json.dumps({
        "status": "reset",
        "message": "Query stats zeroed. Knowledge graph unchanged.",
        "snapshot_before_reset": snapshot,
    })


@mcp_server.tool()
async def tp_vrg_clear(confirm: bool = False) -> str:
    """Clear the TP-VRG knowledge graph.

    Resets the in-memory graph and removes persisted state.
    Requires confirm=True to proceed as a safety measure.

    Args:
        confirm: Must be True to actually clear the graph.
    """
    if _DAEMON_URL:
        return await _proxy("POST", "/clear", json={"confirm": confirm})
    if not confirm:
        return json.dumps({
            "status": "aborted",
            "message": "Set confirm=True to clear the knowledge graph.",
        })

    async with _state._lock:
        try:
            # F16: clear the provenance audit trail FIRST (Windows file lock
            # safety — close the file before attempting any file ops).
            if _state.provenance is not None:
                try:
                    _state.provenance.clear_all()
                except Exception:
                    pass

            # Close persistent backend if active
            if _state.memory is not None and _state.use_sqlite:
                try:
                    _state.memory._storage.close()
                except Exception:
                    pass

            # Remove persisted file
            if _state.persist_path is not None and _state.persist_path.exists():
                try:
                    _state.persist_path.unlink()
                except Exception:
                    pass

            # Force re-initialization on next access
            _state.memory = None
            await _state.get_memory()

            return json.dumps({
                "status": "cleared",
                "message": "Knowledge graph has been reset.",
            })
        except Exception as exc:
            return json.dumps({"status": "error", "message": str(exc)})


@mcp_server.tool()
async def tp_vrg_janitor(
    task: str = "backbone",
    dry_run: bool = False,
    force_rebake: bool = False,
    recompute_centroids: bool = True,
    repo_root: str | None = None,
    rebake_after_ingest: bool = False,
) -> str:
    """Run a Janitor maintenance task on the TP-VRG knowledge graph.

    Janitor tasks perform background graph maintenance that improves query
    quality without changing the public API.

    Available tasks:
      backbone  — Pre-compute betweenness centrality and cache in the backbone
                  table. Moves O(V*E) cost from query-time to background.
                  Run after bulk ingestion sessions for best query performance.
      shred     — Retroactively chunk oversized LOD0 nodes (>2000 chars).
      polish    — Generate unique per-chunk LOD1 summaries for chunk nodes.
      merge     — Detect and merge duplicate entities by embedding similarity
                  (cosine >= 0.92, same category, non-chunk). Redirects edges
                  from duplicate to survivor, then deletes duplicate.
      stitch    — Retroactively apply Layer 0 (_session_follows) and Layer 2
                  (_follows) stitching edges to passages ingested before the
                  Stitching Protocol shipped. Groups session passages by
                  source_label family (e.g. all "chatgpt/*" conversations),
                  sorts chronologically, and creates inter-session edges.
                  Also applies approximate intra-session _follows edges for
                  passages with many entities. Idempotent — safe to run
                  repeatedly. Run once after upgrading to get stitching on
                  existing graphs without re-ingestion.
      bake_partitions - Bake Asset, Island, and Continent community partitions
                  plus per-rung centroids for multi-resolution descent.
      backfill_node_provenance - Rebuild the source->node reverse index used by
                  source-cascade deletion.
      repo_ingest_new_docs - Ingest changed repo docs through the canonical
                  ingest path. Use rebake_after_ingest for a deliberate
                  post-ingest partition bake.

    Args:
        task: Which task to run ("backbone", "shred", "polish", "merge",
            "stitch", "temporal", "profiles", "fts5_sync_repair",
            "integrity_verify", "backfill_node_provenance", or
            "bake_partitions"). Default: "backbone".
        dry_run: If True, report what would be done without modifying the graph.
        force_rebake: Forwarded to bake_partitions.
        recompute_centroids: Forwarded to bake_partitions.
        repo_root: Repo root for repo_ingest_new_docs. Defaults to
            TPVRG_REPO_ROOT or process cwd.
        rebake_after_ingest: For repo_ingest_new_docs, rebake partitions after
            a non-empty ingest batch.
    """
    if _DAEMON_URL:
        payload = {"task": task, "dry_run": dry_run}
        if task == "bake_partitions" or force_rebake or not recompute_centroids:
            payload["force_rebake"] = force_rebake
            payload["recompute_centroids"] = recompute_centroids
        if task == "repo_ingest_new_docs":
            payload["repo_root"] = repo_root
            payload["rebake_after_ingest"] = rebake_after_ingest
        return await _proxy(
            "POST",
            "/janitor",
            json=payload,
        )
    memory = await _state.get_memory()
    from tp_vrg.janitor import GraphJanitor

    janitor = GraphJanitor(memory, dry_run=dry_run)
    try:
        report = await janitor.run_task(
            task,
            dry_run=dry_run,
            force_rebake=force_rebake,
            recompute_centroids=recompute_centroids,
            repo_root=repo_root,
            rebake_after_ingest=rebake_after_ingest,
        )
        if isinstance(report, dict):
            return json.dumps({
                "status": "ok",
                "task": task,
                "dry_run": dry_run,
                **report,
            })
        return json.dumps({
            "status": "ok",
            "task": task,
            "dry_run": dry_run,
            "nodes_scanned": report.nodes_scanned,
            "nodes_affected": report.nodes_affected,
            "nodes_modified": report.nodes_modified,
            "errors": report.errors,
        })
    except ValueError as exc:
        return json.dumps({"status": "error", "message": str(exc)})
    except Exception as exc:
        return json.dumps({"status": "error", "message": str(exc)})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    """Run the TP-VRG MCP server over stdio."""
    # Log device info to mcp.log so CPU fallback is visible in postmortem.
    # Never blocks: MCP is headless and owns stdout for JSON-RPC, so the
    # modal warning is Cockpit-only.
    from tp_vrg.device_check import log_device_for_headless
    log_device_for_headless("tp-vrg-mcp")

    # Daemon probe (engine-daemon Tier 1, 2026-04-22):
    # if a tp-vrg-api daemon is already running on the configured host/port,
    # switch to proxy mode and skip the expensive local engine pre-init.
    # Otherwise, fall through to historical in-process behavior.
    global _DAEMON_URL
    daemon_host = os.environ.get("TPVRG_API_HOST", "127.0.0.1")
    daemon_port = int(os.environ.get("TPVRG_API_PORT", "8321"))
    probe = probe_backend(daemon_host, daemon_port)
    if probe.alive:
        _DAEMON_URL = f"http://{daemon_host}:{daemon_port}"
        version = (probe.response or {}).get("version")
        logger.info(
            "MCP proxy mode: attached to tp-vrg-api daemon at %s "
            "(version=%s, initializing=%s). Skipping local engine pre-init.",
            _DAEMON_URL, version, probe.initializing,
        )
    else:
        logger.info(
            "MCP standalone mode: no daemon at %s:%d (%s). Loading local engine.",
            daemon_host, daemon_port, probe.error or "not alive",
        )
        # Pre-initialize synchronously so startup errors surface immediately.
        # We run in a temporary event loop here; the MCP server creates its own.
        import asyncio as _asyncio
        _asyncio.run(_state.get_memory())

    mcp_server.run(transport="stdio")


if __name__ == "__main__":
    main()
