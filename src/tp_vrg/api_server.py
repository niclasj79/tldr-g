"""
FastAPI HTTP wrapper for the TP-VRG knowledge graph engine.

Exposes the same operator operations as the MCP server as REST endpoints,
using the same ServerState + _build_memory() pattern.  Intended as a
thin transport layer — all business logic lives in engine.py.

Endpoints:
  POST /ingest         — ingest text into the graph
  POST /query          — render context for a question
  GET  /metrics        — graph and runtime metrics
  GET  /health         — storage health check
  GET  /graph/glance   — content summary for Cockpit glance panel
  POST /reset-stats    — zero cumulative query counters
  POST /clear          — wipe the graph (requires confirm=True)
  POST /janitor        — run background maintenance tasks
  DELETE /source/{id}  — delete one source and cascade derived-only graph rows
  GET /source/{id}/export — export one source as a PortableArtifact (Art 20)
  DELETE /asset/{id}   — delete one Asset and cascade derived-only graph rows
  GET /asset/{id}/export — export one Asset as a PortableArtifact (Art 20)
  GET /trace/{id}/export — export one answer's render trace, signed by default
  GET /attestation/identity — did:web identity document for the signing key
  GET /diagnostics/node_provenance — inspect source-to-node reverse index

Start with:
  uvicorn tp_vrg.api_server:app --host 0.0.0.0 --port 8000

Or via the console-script entry point:
  tp-vrg-api
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import psutil
from pydantic import BaseModel

from tp_vrg import __version__ as _TPVRG_VERSION
from tp_vrg.centrality import get_active_centrality_measure
from tp_vrg.engine import LODGraphMemory, maybe_wrap_embedding_cache
from tp_vrg.models import TokenProfile
from tp_vrg.prompts import (
    COCKPIT,
    COCKPIT_OPENAI_SYSTEM,
    resolve_answer_prompt,
)
from tp_vrg.probe import SERVICE_NAME as _SERVICE_SIGNATURE
from tp_vrg.progress import progress
from tp_vrg.progress_file_writer import DEFAULT_PROGRESS_FILE
from tp_vrg.provenance_storage import ProvenanceBackend
from tp_vrg.query_stats import (
    compute_query_stats as _shared_compute_query_stats,
    lod_distribution_from_last_query,
)
from tp_vrg.repo_doc_ingest import read_repo_ingest_watermark
from tp_vrg.storage import InMemoryBackend, StorageInitError
from tp_vrg.storage.connection_isolation import isolated_sqlite_connection
from tp_vrg.storage.graph_glance import collect_graph_glance_summary
from tp_vrg.storage.health import collect_sqlite_health_snapshot
from tp_vrg.storage_sqlite import SQLiteBackend
from tp_vrg.tokens import estimate_tokens
from tp_vrg.ingestion_progress import list_active_sources
from tp_vrg.startup_watchdog import startup_status

logger = logging.getLogger(__name__)
os.environ.setdefault("TPVRG_PROGRESS_SOURCE", "api")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

from tp_vrg.data_dir import (
    ensure_data_dir_layout,
    get_data_dir,
    get_graph_db_path,
    get_provenance_db_path,
)

_DATA_DIR: Path = get_data_dir()
ensure_data_dir_layout(_DATA_DIR)
_FLAT_BASELINE_TOKENS: int = int(os.environ.get("TPVRG_FLAT_BASELINE_TOKENS", 15000))
_COCKPIT_WEDGE_DIAG: bool = os.environ.get(
    "TPVRG_COCKPIT_WEDGE_DIAG", ""
).strip().lower() in {"1", "true", "yes", "on"}
COCKPIT_ANSWER_PROMPT = COCKPIT
_OPENAI_SYSTEM_PROMPT = COCKPIT_OPENAI_SYSTEM


def _cockpit_wedge_marker(message: str, **fields: Any) -> None:
    """Emit opt-in endpoint markers for the Cockpit wedge sprint."""
    if not _COCKPIT_WEDGE_DIAG:
        return
    if fields:
        suffix = " ".join(f"{key}={value!r}" for key, value in sorted(fields.items()))
        logger.info("[cockpit-wedge] %s %s", message, suffix)
    else:
        logger.info("[cockpit-wedge] %s", message)

# ---------------------------------------------------------------------------
# AppState — mirrors ServerState from mcp_server.py
# ---------------------------------------------------------------------------


class AppState:
    """All mutable HTTP server state with async write serialization."""

    _BACKBONE_DEBOUNCE_SECS: float = 30.0

    def __init__(self) -> None:
        self.memory: LODGraphMemory | None = None
        self.persist_path: Path | None = None
        self.use_sqlite: bool = False
        self.total_queries: int = 0
        self.total_tokens_served: int = 0
        self._lock: asyncio.Lock = asyncio.Lock()
        self._backbone_timer: asyncio.TimerHandle | None = None
        self._init_task: asyncio.Task | None = None
        # Post-warmup integrity_verify auto-fire (throttled >24h). Held on
        # state so the background task is not GC'd before completion.
        self._integrity_verify_task: asyncio.Task | None = None
        self.warmup_stage: str = ""  # current model-loading stage for /health
        self.gliner_stage: str = "pending"  # GLiNER background-load stage for /health
        self.coref_stage: str = "queued"  # LingMess/fastcoref load stage for /health
        self.build_memory_timing: dict[str, float] = {}
        # F16: user-facing provenance layer (separate SQLite file)
        self.provenance: Any = None  # ProvenanceBackend | None
        self.watch_process: subprocess.Popen | None = None
        self.watch_folder: str = str(Path("~/tp-vrg-inbox/").expanduser())
        self._janitor_pulse_task: asyncio.Task | None = None
        self._janitor_active: bool = False
        self._janitor_last_pulse_at: float | None = None
        self._janitor_last_task: str | None = None
        self._janitor_pulse_interval_seconds: float = float(
            os.environ.get("TPVRG_JANITOR_PULSE_INTERVAL_SECONDS", "300")
        )
        self._repo_docs_pending_cache: int | None = None
        self._repo_docs_pending_checked_at: float | None = None
        self._repo_docs_pending_ttl_seconds: float = float(
            os.environ.get("TPVRG_REPO_DOCS_PENDING_HEALTH_TTL_SECONDS", "300")
        )
        # Async multi-res bake jobs (job_id -> status dict). HTTP surface only
        # (see admin_multi_res_bake). Ephemeral; not persisted across restarts.
        self.bake_jobs: dict[str, dict[str, Any]] = {}
        self._bake_task: asyncio.Task | None = None
        self.similarity_bake_jobs: dict[str, dict[str, Any]] = {}
        self._similarity_bake_task: asyncio.Task | None = None

    async def get_memory(self) -> LODGraphMemory:
        """Return (and lazily initialize) the LODGraphMemory instance.

        Model loading runs in a thread executor so the event loop stays
        responsive for /health polls and other lightweight requests.

        After warmup completes the daemon schedules a background
        ``integrity_verify`` run (throttled >24h via the existing janitor
        ``integrity_verify_due`` check). This populates the cached
        ``/health`` snapshot's ``integrity_last_check_*`` meta rows so the
        first hot poll after fresh start serves an authoritative status
        rather than ``integrity: unknown``. Matches Pattern 1 workload-
        adaptive bake doctrine (Doctrine A: janitor owns derived state;
        reads never compute). Skipped entirely when
        ``TPVRG_SKIP_INTEGRITY_VERIFY=1`` is set.
        """
        if self.memory is not None:
            return self.memory

        async with self._lock:
            if self.memory is not None:
                return self.memory
            _DATA_DIR.mkdir(parents=True, exist_ok=True)
            loop = asyncio.get_event_loop()
            self.memory = await loop.run_in_executor(None, _build_memory, self)
            if (
                os.environ.get("TPVRG_SKIP_INTEGRITY_VERIFY", "").strip() != "1"
                and self._integrity_verify_task is None
            ):
                self._integrity_verify_task = asyncio.create_task(
                    _schedule_post_warmup_integrity_verify(self.memory)
                )
            self.ensure_janitor_pulse()
        return self.memory

    def kick_init(self) -> None:
        """Start background engine initialization (non-blocking, idempotent)."""
        if self.memory is not None or self._init_task is not None:
            return
        self._init_task = asyncio.ensure_future(self.get_memory())

    def save(self) -> None:
        if self.memory is None or self.persist_path is None:
            return
        if not self.use_sqlite:
            self.memory.save(self.persist_path)

    def schedule_debounced_backbone(self) -> None:
        """Schedule backbone computation 30s after the last ingest.

        Cancels any pending timer so rapid successive ingests don't each
        trigger a full backbone recompute.  The backbone runs once, 30s
        after the *last* ingest in a burst.
        """
        if self._backbone_timer is not None:
            self._backbone_timer.cancel()

        loop = asyncio.get_event_loop()

        def _fire() -> None:
            if self.memory is not None:
                asyncio.ensure_future(self.memory._schedule_backbone())

        self._backbone_timer = loop.call_later(
            self._BACKBONE_DEBOUNCE_SECS, _fire,
        )

    def ensure_janitor_pulse(self) -> None:
        """Start the low-rate janitor maintenance pulse once per process."""
        if os.environ.get("TPVRG_DISABLE_JANITOR_PULSE", "").strip() == "1":
            return
        if self._janitor_pulse_interval_seconds <= 0:
            return
        if self._janitor_pulse_task is not None and not self._janitor_pulse_task.done():
            return
        self._janitor_pulse_task = asyncio.create_task(_janitor_pulse_loop(self))


# Module-level singleton
_state = AppState()


def _watch_status_snapshot() -> dict[str, Any]:
    queue = list_active_sources()
    processed_count = sum(1 for item in queue if item.get("status") == "completed")
    failed_count = sum(1 for item in queue if item.get("status") == "failed")
    watching = _state.watch_process is not None and _state.watch_process.poll() is None
    return {
        "watching": watching,
        "folder": _state.watch_folder,
        "queue": queue,
        "processed_count": processed_count,
        "failed_count": failed_count,
    }


async def _schedule_post_warmup_integrity_verify(memory: LODGraphMemory) -> None:
    """Fire integrity_verify in the background after warmup completes.

    Throttled via the janitor's ``integrity_verify_due(24)`` check (skips
    when the previous run was within the last 24h). The PRAGMA scan runs
    on an isolated SQLite connection (see commit ``b0cdad6``), so this
    background task does not block the engine connection used by the query
    and cached ``/health`` paths.

    Brief pre-delay lets the first user interaction settle before competing
    for SQLite I/O. Failures are logged but never crash the daemon — the
    auto-fire is best-effort; the manual ``tp_vrg_janitor`` MCP tool
    remains the authoritative entry point for explicit verification.
    """
    from tp_vrg.janitor import GraphJanitor

    try:
        await asyncio.sleep(10.0)
        janitor = GraphJanitor(memory)
        print(
            "[tp-vrg-api] Auto-fire integrity_verify (post-warmup, throttled >24h)...",
            file=sys.stderr,
            flush=True,
        )
        report = await janitor.integrity_verify()
        if report.nodes_modified:
            outcome = "ok" if not report.errors else f"errors: {report.errors}"
            print(
                f"[tp-vrg-api] integrity_verify complete: "
                f"scanned {report.nodes_scanned}, result={outcome}",
                file=sys.stderr,
                flush=True,
            )
        elif report.errors:
            print(
                f"[tp-vrg-api] integrity_verify reported errors: {report.errors}",
                file=sys.stderr,
                flush=True,
            )
        else:
            print(
                "[tp-vrg-api] integrity_verify skipped (not due per 24h throttle)",
                file=sys.stderr,
                flush=True,
            )
    except asyncio.CancelledError:
        # Daemon shutdown or test teardown — propagate without noise.
        raise
    except Exception as exc:  # pragma: no cover — log + swallow defensively
        print(
            f"[tp-vrg-api] Auto-fire integrity_verify FAILED: {exc!r}",
            file=sys.stderr,
            flush=True,
        )


def _janitor_runtime_status() -> dict[str, Any]:
    return {
        "running": _state._janitor_active,
        "last_pulse_at": _state._janitor_last_pulse_at,
        "last_task": _state._janitor_last_task,
        "pulse_interval_seconds": _state._janitor_pulse_interval_seconds,
    }


def _repo_ingest_health_defaults() -> dict[str, object]:
    return {
        "repo_ingest_last_at": None,
        "repo_docs_ingested_count": 0,
        "repo_docs_pending": None,
    }


def _repo_ingest_health_fields(memory: Any | None) -> dict[str, object]:
    if memory is None:
        return _repo_ingest_health_defaults()
    storage = getattr(memory, "_storage", None)
    if not isinstance(storage, SQLiteBackend):
        return _repo_ingest_health_defaults()
    storage_path = getattr(storage, "_path", None)
    if storage_path is None:
        return _repo_ingest_health_defaults()
    try:
        with isolated_sqlite_connection(storage_path, read_only=True) as conn:
            fields = read_repo_ingest_watermark(conn)
            fields["repo_docs_pending"] = _repo_docs_pending_count_cached(conn)
            return fields
    except Exception:
        logger.debug("repo-doc ingest health fields unavailable", exc_info=True)
        return _repo_ingest_health_defaults()


def _repo_docs_pending_count_cached(conn) -> int | None:
    now = time.time()
    checked_at = _state._repo_docs_pending_checked_at
    if (
        checked_at is not None
        and _state._repo_docs_pending_cache is not None
        and now - checked_at < _state._repo_docs_pending_ttl_seconds
    ):
        return _state._repo_docs_pending_cache

    try:
        from tp_vrg.repo_doc_watch import detect_changed_repo_docs

        repo_root = Path(os.environ.get("TPVRG_REPO_ROOT") or Path.cwd()).resolve()
        pending = len(detect_changed_repo_docs(repo_root, conn))
    except Exception:
        logger.debug("repo-doc pending count unavailable", exc_info=True)
        pending = None

    _state._repo_docs_pending_cache = pending
    _state._repo_docs_pending_checked_at = now
    return pending


def _similarity_edges_health_defaults(reason: str = "sqlite_connection_unavailable") -> dict[str, object]:
    return {
        "available": False,
        "reason": reason,
        "enabled": False,
        "total_count": 0,
        "counts_by_rung": {"asset": 0, "passage": 0},
        "latest_created_at": None,
        "latest_run_id": None,
        "latest_model_id": None,
    }


def _similarity_edges_connection_for_memory(memory: Any) -> Any | None:
    storage = getattr(memory, "_storage", None)
    conn = getattr(storage, "_conn", None)
    if conn is not None:
        return conn
    return getattr(storage, "conn", None)


def _similarity_edges_health_fields(memory: Any | None) -> dict[str, object]:
    if memory is None:
        return _similarity_edges_health_defaults("engine_not_ready")
    storage = getattr(memory, "_storage", None)
    try:
        from tp_vrg.storage.similarity_edges import similarity_edges_health

        if isinstance(storage, SQLiteBackend):
            storage_path = getattr(storage, "_path", None)
            if storage_path is not None:
                with isolated_sqlite_connection(storage_path, read_only=True) as conn:
                    return similarity_edges_health(conn)
        conn = _similarity_edges_connection_for_memory(memory)
        if conn is None:
            return _similarity_edges_health_defaults()
        return similarity_edges_health(conn)
    except Exception:
        logger.debug("similarity_edges health fields unavailable", exc_info=True)
        return _similarity_edges_health_defaults("error")


def _storage_conn_for_memory(memory: Any) -> Any | None:
    storage = getattr(memory, "_storage", None)
    if isinstance(storage, SQLiteBackend):
        return getattr(storage, "_conn", None)
    return None


def _bump_cockpit_counter_for_memory(memory: Any, counter: str) -> None:
    conn = _storage_conn_for_memory(memory)
    if conn is None:
        return
    try:
        from tp_vrg.storage.cockpit_stats import bump_counter

        bump_counter(conn, counter)
    except Exception:
        logger.debug("Cockpit counter bump failed (%s)", counter, exc_info=True)


def _record_cockpit_snapshot_for_memory(memory: Any, reason: str) -> None:
    conn = _storage_conn_for_memory(memory)
    if conn is None:
        return
    try:
        from tp_vrg.storage.cockpit_stats import record_stats_snapshot

        record_stats_snapshot(conn, reason=reason)
    except Exception:
        logger.debug("Cockpit stats snapshot failed (%s)", reason, exc_info=True)


def _reset_cockpit_query_counter_for_memory(memory: Any) -> None:
    conn = _storage_conn_for_memory(memory)
    if conn is None:
        return
    try:
        from tp_vrg.storage.cockpit_stats import reset_counter

        reset_counter(conn, "query")
    except Exception:
        logger.debug("Cockpit query counter reset failed", exc_info=True)


async def _janitor_pulse_loop(state: AppState) -> None:
    """Low-rate active maintenance pulse for the Inspect activity surface."""
    await asyncio.sleep(state._janitor_pulse_interval_seconds)
    while True:
        claimed = False
        try:
            memory = state.memory
            if memory is not None and not state._janitor_active and not state._lock.locked():
                from tp_vrg.janitor import GraphJanitor

                state._janitor_active = True
                claimed = True
                state._janitor_last_task = "scheduled integrity pulse"
                state._janitor_last_pulse_at = time.time()
                progress.emit(
                    "janitor",
                    message="Scheduled janitor integrity pulse started",
                )
                report = await GraphJanitor(memory, dry_run=False).integrity_verify()
                _bump_cockpit_counter_for_memory(memory, "janitor")
                _record_cockpit_snapshot_for_memory(memory, "janitor:pulse")
                status = "completed" if not report.errors else "completed with errors"
                progress.emit(
                    "janitor",
                    message=(
                        f"Scheduled janitor integrity pulse {status}: "
                        f"{report.nodes_scanned} rows scanned"
                    ),
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("Scheduled janitor pulse failed", exc_info=True)
        finally:
            if claimed:
                state._janitor_active = False
        await asyncio.sleep(state._janitor_pulse_interval_seconds)


# ---------------------------------------------------------------------------
# Engine factory (mirrors _build_memory from mcp_server.py)
# ---------------------------------------------------------------------------


def _build_memory(state: AppState) -> LODGraphMemory:
    """Construct and return a fully initialised LODGraphMemory.

    UX-15: GLiNER/spaCy start loading in a background thread immediately,
    while embeddings + SQLite load synchronously (query-essential).
    Cockpit is usable for querying/browsing as soon as this returns.
    Ingestion blocks until GLiNER finishes loading in the background.
    """
    def _stage(n: int, msg: str) -> None:
        state.warmup_stage = msg
        progress.emit("warmup", current=n, total=5, message=msg)

    state.build_memory_timing = {}
    _stage(0, "Starting engine initialization...")
    extraction_mode = os.environ.get("TPVRG_EXTRACTION_MODE", "gliner").lower()
    coref_mode = os.environ.get("TPVRG_COREF_MODE", "sieve").strip().lower()
    state.coref_stage = "ready" if coref_mode in {"none", "rules"} else "queued"

    # -- LLM provider (UX-15: GLiNER starts in background) ------------------
    _stage(1, f"Starting extraction model ({extraction_mode})...")
    _stage_started_at = time.monotonic()
    if extraction_mode == "local":
        from tp_vrg.llm_service import OllamaLLMProvider
        ollama_model = os.environ.get("TPVRG_OLLAMA_MODEL", OllamaLLMProvider.DEFAULT_MODEL)
        ollama_host = os.environ.get("TPVRG_OLLAMA_HOST", OllamaLLMProvider.DEFAULT_HOST)
        llm = OllamaLLMProvider(model=ollama_model, host=ollama_host)
        print(
            f"[tp-vrg-api] LLM provider: OllamaLLMProvider ({ollama_model} @ {ollama_host})",
            file=sys.stderr,
        )

    elif extraction_mode == "api":
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError(
                "[tp-vrg-api] ANTHROPIC_API_KEY not set and TPVRG_EXTRACTION_MODE=api."
            )
        try:
            from tp_vrg.llm_service import AnthropicLLMProvider
        except ImportError:
            raise RuntimeError(
                "[tp-vrg-api] 'anthropic' package is not installed. "
                "Fix: pip install tp-vrg[api]"
            )
        model = os.environ.get("TPVRG_MODEL", "haiku")
        llm = AnthropicLLMProvider(api_key=api_key, model=model)
        resolved = llm._model
        print(f"[tp-vrg-api] LLM provider: AnthropicLLMProvider ({resolved})", file=sys.stderr)

    elif extraction_mode == "gliner":
        # UX-15: start GLiNER loading in background thread — returns instantly.
        # Cockpit can serve queries while models load. Ingestion blocks until ready.
        try:
            from tp_vrg.llm_service import DeferredGLiNERProvider, GLiNERSpacyProvider
            # INV-1: pass None so GLiNERSpacyProvider can pick the default that
            # matches the active NER_BACKEND (v2.1 → DEFAULT_GLINER_MODEL,
            # gliner2 → DEFAULT_GLINER2_MODEL). Hardcoding
            # DEFAULT_GLINER_MODEL here silently fed the v2.1 model name into
            # the gliner2 branch and 404'd on HuggingFace (see
            # ~/.tp_vrg/mcp.log 2026-04-16 09:37:14).
            gliner_model = os.environ.get("TPVRG_GLINER_MODEL")
            spacy_model = os.environ.get("TPVRG_SPACY_MODEL")
            llm = DeferredGLiNERProvider(gliner_model=gliner_model, spacy_model=spacy_model)
            print(
                f"[tp-vrg-api] LLM provider: DeferredGLiNERProvider ({gliner_model} + {spacy_model}) — loading in background",
                file=sys.stderr,
            )
        except ImportError as exc:
            print(f"[tp-vrg-api] GLiNERSpacyProvider failed to import: {exc}", file=sys.stderr)
            sys.exit(1)

    else:
        raise RuntimeError(
            f"[tp-vrg-api] Unknown TPVRG_EXTRACTION_MODE='{extraction_mode}'.\n"
            "Valid values: api, local, gliner"
        )
    state.build_memory_timing["llm_provider"] = time.monotonic() - _stage_started_at

    # -- Embedding provider (query-essential, loads synchronously) -----------
    _stage(2, "Loading embedding model (bge-large-en-v1.5)...")
    _stage_started_at = time.monotonic()
    try:
        from tp_vrg.embeddings import SentenceTransformerProvider
    except ImportError:
        raise RuntimeError(
            "[tp-vrg-api] 'sentence-transformers' not installed. "
            "Fix: pip install tp-vrg[api]"
        )

    embedding = SentenceTransformerProvider()
    print("[tp-vrg-api] Embedding provider: SentenceTransformerProvider", file=sys.stderr)
    state.build_memory_timing["embedding_model"] = time.monotonic() - _stage_started_at

    # -- Storage backend ----------------------------------------------------
    _stage(3, "Opening graph database...")
    _stage_started_at = time.monotonic()
    # SQL-I1 / pipeline contract C2: thread the embedder's actual dimension
    # through to the storage backend. Without this, SQLiteBackend defaults to
    # embedding_dim=384 regardless of the model loaded, causing silent dim
    # mismatches at ingest time. See backlog.md SQL-I1 for the history.
    try:
        state.persist_path = get_graph_db_path(_DATA_DIR)
        storage: SQLiteBackend | InMemoryBackend = SQLiteBackend(
            state.persist_path,
            embedding_dim=embedding.dimension,
        )
        state.use_sqlite = True
        print(
            f"[tp-vrg-api] Storage: SQLiteBackend ({state.persist_path}, "
            f"embedding_dim={embedding.dimension})",
            file=sys.stderr,
        )
    except Exception as exc:
        # INV-2 + 2026-05-17 substrate-coherent reframe: storage init failure
        # must raise. Silent fallback to InMemoryBackend masks the underlying
        # issue (path misconfig, file lock, permissions, schema mismatch) and
        # produces "data that looks valid" — the most expensive failure mode.
        # The operator MUST fix the underlying issue and restart the daemon.
        # See [[docs/diagnostics/2026-05-14-cockpit-substrate-coherent-reframe.md]] §3.
        print(
            f"[tp-vrg-api] FATAL: SQLiteBackend init failed at {state.persist_path!s}: {exc!r}. "
            "Daemon refuses to start; fix the underlying issue (check graph.db permissions, "
            "lock contention, schema version) and re-launch.",
            file=sys.stderr,
        )
        raise StorageInitError(
            f"SQLiteBackend init failed at {state.persist_path!s}: {exc!r}. "
            "Daemon refuses silent InMemory fallback per INV-2."
        ) from exc
    state.build_memory_timing["storage_open"] = time.monotonic() - _stage_started_at

    # F16: open the provenance backend alongside the graph backend.
    _stage(3, "Opening provenance backend...")
    _stage_started_at = time.monotonic()
    try:
        prov_path = get_provenance_db_path(_DATA_DIR)
        state.provenance = ProvenanceBackend(prov_path)
        print(f"[tp-vrg-api] Provenance: ProvenanceBackend ({prov_path})", file=sys.stderr)
    except Exception as exc:
        print(f"[tp-vrg-api] Provenance backend unavailable: {exc}", file=sys.stderr)
        state.provenance = None
    state.build_memory_timing["provenance_open"] = time.monotonic() - _stage_started_at

    embedding = maybe_wrap_embedding_cache(embedding, storage)
    logger.info(
        "[embedding] cache=%s model_id=%s dimension=%s",
        os.environ.get("TPVRG_EMBEDDING_CACHE", "on").strip().lower(),
        getattr(embedding, "model_id", "unknown"),
        getattr(embedding, "dimension", "unknown"),
    )
    logger.info("[centrality] measure=%s", get_active_centrality_measure())
    _stage(4, "Loading backbone centrality cache...")
    _stage_started_at = time.monotonic()
    get_backbone = getattr(storage, "get_backbone", None)
    if callable(get_backbone):
        get_backbone()
    state.build_memory_timing["backbone_load"] = time.monotonic() - _stage_started_at

    _stage(4, "Initializing scorer + governor...")
    _stage_started_at = time.monotonic()
    mem = LODGraphMemory(
        llm_provider=llm,
        embedding_provider=embedding,
        storage=storage,
        provenance=state.provenance,
    )
    state.build_memory_timing["lod_graph_memory_init"] = time.monotonic() - _stage_started_at
    _stage(4, "Finalizing rendering engine...")
    _stage(5, "Ready")
    return mem


# ---------------------------------------------------------------------------
# Pydantic request / response models
# ---------------------------------------------------------------------------


class IngestRequest(BaseModel):
    text: str
    source: str = ""
    event_timestamp: float | None = None


class QueryRequest(BaseModel):
    question: str
    token_budget: int = 10000
    # Visible-intelligence: opt-in topological shading (bold the most
    # query-relevant sentences in the returned context; deterministic,
    # markdown markers, zero LLM calls). Default off = byte-identical.
    shade: bool = False


class ResetStatsRequest(BaseModel):
    confirm: bool = False


class ClearRequest(BaseModel):
    confirm: bool = False


class JanitorRequest(BaseModel):
    task: str = "backbone"
    dry_run: bool = False
    force_rebake: bool = False
    recompute_centroids: bool = True
    repo_root: str | None = None
    rebake_after_ingest: bool = False


class MultiResBakeRequest(BaseModel):
    force_rebake: bool = False
    recompute_centroids: bool = True


class SimilarityEdgesBakeRequest(BaseModel):
    rung: str = "passage"
    k: int = 10
    hub_cap: int | None = None


class AnswerRequest(BaseModel):
    question: str
    token_budget: int = 10000
    provider: str = "ollama"  # "ollama" | "openai"
    ollama_model: str = "llama3.2"
    ollama_host: str = "http://localhost:11434"
    openai_model: str = "gpt-4o-mini"
    openai_base_url: str = "https://api.openai.com/v1"


# ---------------------------------------------------------------------------
# FastAPI app + lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(application: FastAPI):  # noqa: ARG001
    """Server lifespan. Memory initialises lazily on first request (model load is too slow to block startup)."""
    yield
    # Graceful shutdown: nothing to do for SQLiteBackend (WAL auto-checkpoint)


app = FastAPI(
    title="TP-VRG HTTP API",
    description=(
        "Topology-Preserving Variable-Resolution Graph — HTTP interface. "
        "Mirrors the 7 MCP tools as REST endpoints."
    ),
    version="0.3.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten for production / hosted tier
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.post("/ingest")
async def ingest(body: IngestRequest) -> dict[str, Any]:
    """Ingest text into the TP-VRG knowledge graph."""
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            result = await mem.ingest(
                body.text,
                source=body.source,
                event_timestamp=body.event_timestamp,
                suppress_backbone=True,
            )

            try:
                _state.save()
            except Exception as save_exc:
                return {
                    "status": "partial",
                    "message": f"Ingested but failed to persist: {save_exc}",
                    "source": body.source or "(none)",
                    "nodes_added": len(result.nodes),
                    "edges_added": len(result.edges),
                    "total_nodes": mem.node_count,
                    "total_edges": mem.edge_count,
                }

            _record_cockpit_snapshot_for_memory(mem, "ingest")
            _state.schedule_debounced_backbone()
            return {
                "status": "ok",
                "source": body.source or "(none)",
                "nodes_added": len(result.nodes),
                "edges_added": len(result.edges),
                "total_nodes": mem.node_count,
                "total_edges": mem.edge_count,
            }
        except Exception as exc:
            logger.exception("POST /ingest failed (source=%r)", body.source)
            return {"status": "error", "message": str(exc)}


_MAX_UPLOAD_BYTES = 1 * 1024 * 1024  # 1 MB


@app.post("/ingest/file")
async def ingest_file(
    file: UploadFile = File(...),
    source: str = "",
) -> dict[str, Any]:
    """Ingest a .txt or .md file upload into the TP-VRG knowledge graph.

    Accepts a multipart/form-data upload.  Rejects files larger than 1 MB
    with HTTP 413.  Returns the same response schema as POST /ingest.
    """
    raw = await file.read()
    if len(raw) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({len(raw):,} bytes). Maximum is 1 MB.",
        )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File must be valid UTF-8 text.")

    effective_source = source.strip() or (file.filename or "uploaded_file")
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            result = await mem.ingest(
                text, source=effective_source, suppress_backbone=True,
            )
            try:
                _state.save()
            except Exception as save_exc:
                return {
                    "status": "partial",
                    "message": f"Ingested but failed to persist: {save_exc}",
                    "source": effective_source,
                    "nodes_added": len(result.nodes),
                    "edges_added": len(result.edges),
                    "total_nodes": mem.node_count,
                    "total_edges": mem.edge_count,
                }
            _record_cockpit_snapshot_for_memory(mem, "ingest:file")
            _state.schedule_debounced_backbone()
            return {
                "status": "ok",
                "source": effective_source,
                "nodes_added": len(result.nodes),
                "edges_added": len(result.edges),
                "total_nodes": mem.node_count,
                "total_edges": mem.edge_count,
            }
        except Exception as exc:
            logger.exception("POST /ingest/file failed (source=%r)", effective_source)
            return {"status": "error", "message": str(exc)}


_MAX_CHATGPT_UPLOAD_BYTES = 200 * 1024 * 1024  # 200 MB

_CHATGPT_SAVE_INTERVAL = 50  # persist every N conversations


@app.post("/ingest/chatgpt")
async def ingest_chatgpt(
    file: UploadFile = File(...),
) -> StreamingResponse:
    """Import a ChatGPT ``conversations.json`` export into the knowledge graph.

    Parses the OpenAI export, extracts conversations, and ingests each one
    with its ``create_time`` as ``event_timestamp`` for temporal ordering.

    Returns a streaming NDJSON response with progress updates::

        {"type": "parsed", "conversations_found": 847, ...}
        {"type": "progress", "current": 1, "total": 824, "title": "..."}
        ...
        {"type": "done", "conversations_ingested": 824, ...}
    """
    # Read the upload — enforce size limit before parsing
    raw = await file.read()
    if len(raw) > _MAX_CHATGPT_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({len(raw):,} bytes). Maximum is 200 MB.",
        )

    async def _stream():
        from tp_vrg.importers.chatgpt import parse_conversations

        # Parse
        try:
            conversations = parse_conversations(raw)
        except Exception as exc:
            logger.exception("POST /ingest/chatgpt parse failed")
            yield json.dumps({"type": "error", "message": f"Parse error: {exc}"}) + "\n"
            return

        skipped = 0
        to_ingest = len(conversations)
        # Count how many were in the original JSON but got filtered
        try:
            total_in_file = len(json.loads(raw))
            skipped = total_in_file - to_ingest
        except Exception:
            pass

        yield json.dumps({
            "type": "parsed",
            "conversations_found": to_ingest + skipped,
            "conversations_skipped": skipped,
            "to_ingest": to_ingest,
        }) + "\n"

        if to_ingest == 0:
            yield json.dumps({
                "type": "done",
                "conversations_ingested": 0,
                "total_nodes": 0,
                "total_edges": 0,
            }) + "\n"
            return

        # Ingest — hold the lock for the entire batch to avoid interleaving
        total_nodes_added = 0
        total_edges_added = 0
        ingested = 0
        session_passage_ids: list[str] = []

        async with _state._lock:
            mem = await _state.get_memory()

            for i, conv in enumerate(conversations):
                try:
                    source = f"chatgpt/{conv.title[:80]}"
                    t0 = time.monotonic()
                    text_len = len(conv.session_text)
                    result = await mem.ingest(
                        conv.session_text,
                        source=source,
                        event_timestamp=conv.create_time,
                        suppress_backbone=True,
                    )
                    elapsed = time.monotonic() - t0
                    total_nodes_added += len(result.nodes)
                    total_edges_added += len(result.edges)
                    ingested += 1
                    if result.session_passage_id:
                        session_passage_ids.append(result.session_passage_id)
                    print(
                        f"[chatgpt] {i+1}/{to_ingest} "
                        f"({text_len:,} chars, {len(result.nodes)} nodes) "
                        f"in {elapsed:.1f}s",
                        file=sys.stderr,
                    )
                except Exception as exc:
                    logger.exception(
                        "ChatGPT conv ingest failed (i=%d/%d, title=%r)",
                        i + 1, to_ingest, conv.title[:50],
                    )
                    yield json.dumps({
                        "type": "warning",
                        "message": f"Failed to ingest '{conv.title[:50]}': {exc}",
                        "current": i + 1,
                        "total": to_ingest,
                    }) + "\n"

                yield json.dumps({
                    "type": "progress",
                    "current": i + 1,
                    "total": to_ingest,
                    "title": conv.title[:80],
                }) + "\n"

                # Periodic save to prevent data loss on crash
                if (i + 1) % _CHATGPT_SAVE_INTERVAL == 0:
                    try:
                        _state.save()
                    except Exception:
                        pass  # non-fatal — we'll save at the end

            # Layer 0: stitch conversations in chronological order
            # parse_conversations() already sorted by create_time ascending
            if len(session_passage_ids) > 1:
                mem.stitch_sequence(session_passage_ids)

            # Backbone deferred from per-conversation suppression — run once now
            await mem._schedule_backbone()

            # Final save
            try:
                _state.save()
            except Exception as save_exc:
                yield json.dumps({
                    "type": "warning",
                    "message": f"Ingested but final save failed: {save_exc}",
                }) + "\n"

            _record_cockpit_snapshot_for_memory(mem, "ingest:chatgpt")

        yield json.dumps({
            "type": "done",
            "conversations_ingested": ingested,
            "total_nodes": mem.node_count,
            "total_edges": mem.edge_count,
            "nodes_added": total_nodes_added,
            "edges_added": total_edges_added,
        }) + "\n"

    return StreamingResponse(
        _stream(),
        media_type="text/x-ndjson",
    )


@app.get("/watch_folder/status")
async def watch_folder_status() -> dict[str, Any]:
    return _watch_status_snapshot()


@app.get("/watch_folder/queue")
async def watch_folder_queue() -> list[dict[str, Any]]:
    return list_active_sources()


class WatchFolderControlRequest(BaseModel):
    folder: str | None = None


@app.post("/watch_folder/start")
async def watch_folder_start(body: WatchFolderControlRequest) -> dict[str, Any]:
    watching = _state.watch_process is not None and _state.watch_process.poll() is None
    if watching:
        return _watch_status_snapshot()

    requested = (body.folder or _state.watch_folder or "~/tp-vrg-inbox/").strip()
    folder = str(Path(requested).expanduser())
    Path(folder).mkdir(parents=True, exist_ok=True)
    _state.watch_folder = folder

    script_path = Path(__file__).resolve().parents[2] / "tools" / "tpvrg_ingestor.py"
    cmd = [sys.executable, str(script_path), "--watch-folder", folder]
    _state.watch_process = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return _watch_status_snapshot()


@app.post("/watch_folder/stop")
async def watch_folder_stop() -> dict[str, Any]:
    proc = _state.watch_process
    if proc is not None and proc.poll() is None:
        proc.terminate()
    _state.watch_process = None
    snapshot = _watch_status_snapshot()
    snapshot["watching"] = False
    return snapshot


# ---------------------------------------------------------------------------
# Shared stats helper (used by /query, /answer, /answer/stream)
# ---------------------------------------------------------------------------
def _compute_query_stats(mem: Any, tokens_used: int) -> dict[str, Any]:
    """Compute per-query token stats for the last query on *mem*.

    Thin wrapper around `tp_vrg.query_stats.compute_query_stats` so legacy
    `from tp_vrg.api_server import _compute_query_stats` imports + tests
    keep working. The actual implementation lives in `query_stats.py` and
    is shared with mcp_server (preventing the
    [API-STATS-TELEMETRY-PASSAGE-MODE-ZERO] drift class).

    Shared between /query, /answer, and /answer/stream so all three
    endpoints return an identical stats shape.
    """
    return _shared_compute_query_stats(mem, tokens_used)


@app.post("/query")
async def query(body: QueryRequest) -> dict[str, Any]:
    """Query the TP-VRG knowledge graph and return assembled context."""
    try:
        mem = await _state.get_memory()

        if mem.node_count == 0:
            return {
                "context": "[Knowledge graph is empty. Ingest some text first.]",
                "stats": {
                    "nodes_used": 0,
                    "tokens_used": 0,
                    "lod_distribution": {"LOD_0": 0, "LOD_1": 0, "LOD_2": 0},
                },
            }

        profile = TokenProfile(name="api_query", max_tokens=body.token_budget)
        context = await mem.render_context(body.question, profile=profile)
        if body.shade and context:
            # The never-called shading capability, wired at the operator
            # surface (the render itself stays untouched; tokens_used is
            # measured BEFORE markers so the receipt stays honest).
            from tp_vrg.shading import apply_topological_shading

            tokens_used = estimate_tokens(context)
            context = await asyncio.to_thread(
                apply_topological_shading, context, body.question
            )
        else:
            tokens_used = estimate_tokens(context)

        _state.total_queries += 1
        _state.total_tokens_served += tokens_used

        # F16: record answer + citations (best-effort).
        answer_id: str | None = str(uuid.uuid4())
        if _state.provenance is not None:
            try:
                _state.provenance.begin_batch()
                _state.provenance.record_answer(
                    answer_id=answer_id,
                    query_text=body.question,
                    model_label="tp-vrg",
                    user_id=None,
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

        # Shared stats helper — includes savings_pct_this_query, the
        # demo headline. See _compute_query_stats docstring.
        stats = _compute_query_stats(mem, tokens_used)
        _bump_cockpit_counter_for_memory(mem, "query")
        _record_cockpit_snapshot_for_memory(mem, "query")

        # Intent signal from the last query (if available)
        intent_data = None
        last_intent = getattr(mem, '_last_intent', None)
        if last_intent is not None:
            intent_data = {
                "content_axes": {
                    k: round(v, 3) for k, v in last_intent.content_axes.items() if v > 0.01
                },
                "wh_type": last_intent.wh_type,
                "specificity": round(last_intent.specificity, 2),
                "exhaustiveness": round(last_intent.exhaustiveness, 2),
                "reasoning_depth": round(last_intent.reasoning_depth, 2),
                "detected_entities": last_intent.detected_entities,
                "root_verb": last_intent.root_verb,
                "reasoning_intent": getattr(last_intent, "reasoning_intent", "factual_lookup"),
            }

        return {
            "context": context,
            "answer_id": answer_id,  # F16: pass to /explain/{answer_id}
            "stats": stats,
            "intent": intent_data,
        }
    except Exception as exc:
        logger.exception("POST /query failed (question=%r)", body.question[:80])
        return {"status": "error", "message": str(exc)}


@app.get("/explain/{answer_id}")
async def explain(answer_id: str) -> dict[str, Any]:
    """Return the provenance trace for a previous answer (F16).

    Given an answer_id from a prior /query response, returns the original
    query text, timestamp, and list of source citations that contributed
    to the rendered answer.
    """
    if _state.provenance is None:
        return {
            "status": "error",
            "message": "provenance backend not initialized — answers cannot be explained",
        }
    try:
        answer = _state.provenance.get_answer(answer_id)
        if answer is None:
            return {"status": "not_found", "answer_id": answer_id}

        raw_citations = _state.provenance.get_citations_for_answer(answer_id)
        total = len(raw_citations)
        null_sources = sum(1 for c in raw_citations if c.get("source_label") is None)
        if total == 0:
            coverage = "none"
        elif null_sources == 0:
            coverage = "full"
        elif null_sources == total:
            coverage = "none"
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

        return {
            "status": "ok",
            "answer_id": answer["answer_id"],
            "query": answer["query_text"],
            "answered_at": answer["answered_at"],
            "model_label": answer["model_label"],
            "provenance_coverage": coverage,
            "citations": citations_out,
        }
    except Exception as exc:
        logger.exception("GET /explain/%s failed", answer_id)
        return {"status": "error", "message": str(exc)}


@app.delete("/source/{source_id}")
async def delete_source(source_id: str) -> dict[str, Any]:
    """Delete one source and cascade nodes derived only from that source."""
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            storage = mem._storage
            if not isinstance(storage, SQLiteBackend):
                raise HTTPException(
                    status_code=400,
                    detail="delete_source requires SQLite storage.",
                )
            report = await asyncio.to_thread(
                storage.delete_source,
                source_id,
                _state.provenance,
            )
            _record_cockpit_snapshot_for_memory(mem, f"source:delete:{source_id}")
            return report
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("DELETE /source/%s failed", source_id)
            return {"status": "error", "message": str(exc)}


def _maybe_sign_artifact(
    artifact: dict[str, Any],
    payload_type: str,
    sign: bool,
) -> dict[str, Any]:
    """Wrap an export payload in a signed attestation envelope when requested.

    The IV-2 Q1 federation-artifact surface: Sigstore-class detached
    Ed25519 signature (NOT blockchain; Certificate Transparency family).
    Raises 501 when the attestation extras are not installed — fail loud,
    never silently return unsigned data the caller asked to have signed.
    """
    if not sign:
        return artifact
    try:
        from tp_vrg.attestation import sign_envelope
    except ImportError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    return sign_envelope(artifact, payload_type)


@app.get("/source/{source_id}/export")
async def export_source(
    source_id: str,
    include_embeddings: bool = False,
    sign: bool = False,
) -> dict[str, Any]:
    """Export one source as a PortableArtifact (GDPR Art 20 portability).

    Non-destructive: zero mutation of the live graph. The artifact is a
    pure-read JSON envelope with derived-only nodes (full content),
    passages, internal edges, and boundary-node stubs (lod_2 label only).
    See docs/design/arch-rung-level-subgraph-migration-2026-06-08.md §4+§6.

    ``sign=true`` wraps the artifact in a signed attestation envelope
    (audit-grade verifiable export; verify offline with `tp-vrg verify`).

    Legacy-graph prerequisite (same as DELETE /source/{id}): run
    `POST /janitor` with `{"task": "backfill_node_provenance"}` once
    before extracting at scale on graphs whose `passages.source_id` is
    empty — see backlog `[GDPR-LIVE-GRAPH-BACKFILL-PREREQ]`.
    """
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            storage = mem._storage
            if not isinstance(storage, SQLiteBackend):
                raise HTTPException(
                    status_code=400,
                    detail="extract_source requires SQLite storage.",
                )
            artifact = await asyncio.to_thread(
                storage.extract_source,
                source_id,
                _state.provenance,
                include_embeddings=include_embeddings,
            )
            return await asyncio.to_thread(
                _maybe_sign_artifact, artifact, "portable_artifact", sign
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("GET /source/%s/export failed", source_id)
            return {"status": "error", "message": str(exc)}


@app.delete("/asset/{asset_id}")
async def delete_asset(asset_id: str) -> dict[str, Any]:
    """Delete one Asset and cascade nodes derived only from that Asset.

    The Asset-rung sibling of DELETE /source/{id} (rung-migration ladder
    step 3): nodes shared with other assets — including other assets of
    the same source — survive with reduced provenance; the Asset overlay
    rows (asset row + asset_entities + edge_provenance) are cascaded.
    Membership unmaterialized / unresolvable (overlay or node_provenance
    backfill pending) returns 409 with the prerequisite in the detail.
    """
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            storage = mem._storage
            if not isinstance(storage, SQLiteBackend):
                raise HTTPException(
                    status_code=400,
                    detail="delete_asset requires SQLite storage.",
                )
            report = await asyncio.to_thread(storage.delete_asset, asset_id)
            _record_cockpit_snapshot_for_memory(mem, f"asset:delete:{asset_id}")
            return report
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("DELETE /asset/%s failed", asset_id)
            return {"status": "error", "message": str(exc)}


@app.get("/asset/{asset_id}/export")
async def export_asset(
    asset_id: str,
    include_embeddings: bool = False,
    sign: bool = False,
) -> dict[str, Any]:
    """Export one Asset as a PortableArtifact (Art 20 at the Asset rung).

    Non-destructive: zero mutation of the live graph. The artifact carries
    the full Authorial Layer-1 asset record, derived-only nodes, passages,
    edges, lod_2-only stubs for every shared entity the asset mentions,
    and the asset-scoped evidence (asset_entities + edge_provenance). See
    docs/design/arch-rung-level-subgraph-migration-2026-06-08.md §4+§5+§6.

    ``sign=true`` wraps the artifact in a signed attestation envelope
    (audit-grade verifiable export; verify offline with `tp-vrg verify`).

    Membership unmaterialized / unresolvable returns 409 with the
    prerequisite (backfill_assets_by_source_document /
    backfill_node_provenance) in the detail — extract never self-heals.
    """
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            storage = mem._storage
            if not isinstance(storage, SQLiteBackend):
                raise HTTPException(
                    status_code=400,
                    detail="extract_asset requires SQLite storage.",
                )
            artifact = await asyncio.to_thread(
                storage.extract_asset,
                asset_id,
                include_embeddings=include_embeddings,
            )
            return await asyncio.to_thread(
                _maybe_sign_artifact, artifact, "portable_artifact", sign
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("GET /asset/%s/export failed", asset_id)
            return {"status": "error", "message": str(exc)}


async def _export_community(
    rung: str,
    community_id: str,
    include_embeddings: bool,
    sign: bool,
) -> dict[str, Any]:
    """Shared island/continent export implementation (rung-migration step 4)."""
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            storage = mem._storage
            if not isinstance(storage, SQLiteBackend):
                raise HTTPException(
                    status_code=400,
                    detail="extract_community requires SQLite storage.",
                )
            artifact = await asyncio.to_thread(
                lambda: storage.extract_community(
                    community_id,
                    rung=rung,
                    include_embeddings=include_embeddings,
                )
            )
            return await asyncio.to_thread(
                _maybe_sign_artifact, artifact, "portable_artifact", sign
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("GET /%s/%s/export failed", rung, community_id)
            return {"status": "error", "message": str(exc)}


@app.get("/island/{community_id}/export")
async def export_island(
    community_id: str,
    include_embeddings: bool = False,
    sign: bool = False,
) -> dict[str, Any]:
    """Export one Island (community rung) as a PortableArtifact.

    The union of the island's member assets' closures: knowledge shared
    WITHIN the island travels as full content; knowledge shared with the
    rest of the graph becomes lod_2-only stubs. Membership + labels travel
    as re-bakeable Systemic state. 409 on stale partitions / unresolvable
    membership; ``sign=true`` for the attestation envelope.
    """
    return await _export_community("island", community_id, include_embeddings, sign)


@app.get("/continent/{community_id}/export")
async def export_continent(
    community_id: str,
    include_embeddings: bool = False,
    sign: bool = False,
) -> dict[str, Any]:
    """Export one Continent (top community rung) as a PortableArtifact.

    Same semantics as the island export, one rung up: the artifact carries
    the island substructure (labels + per-island asset membership).
    """
    return await _export_community("continent", community_id, include_embeddings, sign)


def _persist_move_artifact(
    artifact_dir: str,
    rung: str,
    unit_id: str,
    sign: bool,
):
    """Build the persist callback for a MOVE: sign (default) + write + fsync.

    Runs BETWEEN extract and delete inside the storage move — any failure
    here (bad dir, disk full, signing error) aborts the move with the graph
    unchanged. The artifact lands on disk BEFORE the delete commits, so a
    lost HTTP response can never lose knowledge.
    """
    import re as _re

    target_dir = Path(artifact_dir).expanduser()

    def _persist(artifact: dict, payload_hash: str) -> dict[str, Any]:
        payload: dict[str, Any] = artifact
        if sign:
            from tp_vrg.attestation import sign_envelope

            payload = sign_envelope(artifact, "portable_artifact")
        target_dir.mkdir(parents=True, exist_ok=True)
        safe_id = _re.sub(r"[^A-Za-z0-9._-]", "_", unit_id)
        suffix = "signed.json" if sign else "json"
        out = target_dir / f"move-{rung}-{safe_id}-{payload_hash.split(':')[-1][:16]}.{suffix}"
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
            fh.flush()
            os.fsync(fh.fileno())
        return {"artifact_path": str(out), "signed": sign}

    return _persist


async def _move_unit_http(
    rung: str,
    unit_id: str,
    artifact_dir: str,
    sign: bool,
    include_embeddings: bool,
) -> dict[str, Any]:
    """Shared implementation for POST /asset|source/{id}/move."""
    if not (artifact_dir or "").strip():
        raise HTTPException(
            status_code=422,
            detail="artifact_dir is required: the move persists the artifact "
            "to disk BEFORE deleting (a lost response must never lose knowledge).",
        )
    async with _state._lock:
        try:
            mem = await _state.get_memory()
            storage = mem._storage
            if not isinstance(storage, SQLiteBackend):
                raise HTTPException(
                    status_code=400, detail="move requires SQLite storage."
                )
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
            _record_cockpit_snapshot_for_memory(mem, f"{rung}:move:{unit_id}")
            # The artifact is ON DISK; don't echo the (potentially large)
            # only-copy through the response — return its path + hash.
            report.pop("artifact", None)
            return report
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"artifact persist failed; move ABORTED, graph unchanged: {exc}",
            ) from exc
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("POST /%s/%s/move failed", rung, unit_id)
            return {"status": "error", "message": str(exc)}


@app.post("/asset/{asset_id}/move")
async def move_asset(
    asset_id: str,
    artifact_dir: str,
    sign: bool = True,
    include_embeddings: bool = True,
) -> dict[str, Any]:
    """MOVE one Asset out of this graph (extract → persist → delete → stub).

    The rung-migration §4 MOVE with the only-copy safety built in: the
    artifact is signed (default) and fsync'd to ``artifact_dir`` BEFORE
    the delete commits; a persist failure aborts with the graph unchanged.
    The response carries ``artifact_persisted.artifact_path`` +
    ``payload_hash`` (recorded in migration_log for merge-back
    verification), never the only-copy itself.
    """
    return await _move_unit_http("asset", asset_id, artifact_dir, sign, include_embeddings)


@app.post("/source/{source_id}/move")
async def move_source(
    source_id: str,
    artifact_dir: str,
    sign: bool = True,
    include_embeddings: bool = True,
) -> dict[str, Any]:
    """MOVE one source out of this graph. See POST /asset/{id}/move."""
    return await _move_unit_http("source", source_id, artifact_dir, sign, include_embeddings)


@app.get("/trace/{answer_id}/export")
async def export_render_trace(
    answer_id: str,
    sign: bool = True,
) -> dict[str, Any]:
    """Export one rendered answer's trace as a (signed) file-able object.

    THE IV-2 Q1 federation artifact: "every render produces a
    cryptographically signed trace object emittable as a file." The trace
    composes the Provenance Layer's answer + citation chain (emission-time
    composition over the existing two-file schema — no migration); by
    default it ships wrapped in a Sigstore-class signed attestation
    envelope (``sign=false`` for the raw trace). Verify offline with
    `tp-vrg verify <file>`.
    """
    try:
        from tp_vrg.attestation import build_render_trace

        if _state.provenance is None:
            raise HTTPException(
                status_code=400,
                detail="render-trace export requires the provenance store.",
            )
        trace = await asyncio.to_thread(
            build_render_trace, answer_id, _state.provenance
        )
        return await asyncio.to_thread(
            _maybe_sign_artifact, trace, "render_trace", sign
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ImportError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("GET /trace/%s/export failed", answer_id)
        return {"status": "error", "message": str(exc)}


@app.get("/attestation/identity")
async def attestation_identity(domain: str) -> dict[str, Any]:
    """The operator's did:web identity document publishing the signing key.

    Serve the returned JSON at ``https://<domain>/.well-known/did.json``
    so counterparties can bind envelope ``key_id`` to an identity they
    trust. Key distribution only — no transparency log yet (that is the
    Q3 artifact per IV-2).
    """
    try:
        from tp_vrg.attestation import build_did_web_document

        return await asyncio.to_thread(build_did_web_document, domain)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ImportError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("GET /attestation/identity failed")
        return {"status": "error", "message": str(exc)}


@app.get("/diagnostics/node_provenance")
async def diagnostics_node_provenance(sample_limit: int = 5) -> dict[str, Any]:
    """Inspect the source->node reverse index used by source deletion."""
    try:
        mem = await _state.get_memory()
        storage = mem._storage
        if not isinstance(storage, SQLiteBackend):
            return {
                "status": "error",
                "message": "node_provenance diagnostics require SQLite storage.",
            }
        return storage.node_provenance_summary(sample_limit=sample_limit)
    except Exception as exc:
        logger.exception("GET /diagnostics/node_provenance failed")
        return {"status": "error", "message": str(exc)}


@app.get("/metrics")
async def metrics() -> dict[str, Any]:
    """Return graph and runtime metrics."""
    try:
        mem = await _state.get_memory()
        nodes = mem._storage.get_all_nodes()

        # API-STATS-TELEMETRY-PASSAGE-MODE-ZERO fix: use shared helper that
        # falls back to _last_rendered_passage_ids when _active_lods is empty
        # (passage-mode queries). Previously this loop counted only entity-mode
        # LODs, so passage-mode queries reported all zeros.
        lod_counts, _nodes_used = lod_distribution_from_last_query(mem)

        raw_tokens = sum(estimate_tokens(n.lod_0) for n in nodes.values())
        compact_tokens = sum(estimate_tokens(n.lod_2) for n in nodes.values())
        storage_savings_pct = (
            ((raw_tokens - compact_tokens) / raw_tokens * 100) if raw_tokens > 0 else 0.0
        )

        flat_total = _state.total_queries * _FLAT_BASELINE_TOKENS
        tokens_saved = max(0, flat_total - _state.total_tokens_served)
        runtime_savings_pct = (
            (tokens_saved / flat_total * 100) if flat_total > 0 else 0.0
        )

        return {
            "total_nodes": mem.node_count,
            "total_edges": mem.edge_count,
            "lod_distribution": lod_counts,
            "raw_storage_tokens": raw_tokens,
            "compact_storage_tokens": compact_tokens,
            "storage_savings_pct": round(storage_savings_pct, 1),
            "total_queries": _state.total_queries,
            "cumulative_tokens_served": _state.total_tokens_served,
            "flat_retrieval_baseline_tokens": flat_total,
            "cumulative_tokens_saved": tokens_saved,
            "runtime_savings_pct": round(runtime_savings_pct, 1),
            "flat_baseline_per_query": _FLAT_BASELINE_TOKENS,
        }
    except Exception as exc:
        logger.exception("GET /metrics failed")
        return {"status": "error", "message": str(exc)}

@app.get("/graph/glance")
async def graph_glance() -> dict[str, Any]:
    """Return a summary of ingested content sources for the Cockpit glance panel.

    Groups passages by clean source label (strips '[chunk-N]' suffixes so each
    document appears once).  Orders by graph connectivity — sources whose entities
    participate in the most graph edges appear first.  This gives a rough
    "most central documents first" ordering rather than arbitrary recency.
    """
    try:
        started_at = time.monotonic()
        _cockpit_wedge_marker("GET /graph/glance start")
        mem = await _state.get_memory()
        _cockpit_wedge_marker("GET /graph/glance memory-ready")
        storage = mem._storage
        if not isinstance(storage, SQLiteBackend):
            return {
                "status": "ok",
                "sources": [],
                "total_passages": 0,
                "note": "Glance only available with SQLiteBackend",
            }

        storage_path = getattr(storage, "_path", None)
        if storage_path is None:
            return {
                "status": "error",
                "message": "SQLite storage path unavailable for graph glance.",
            }

        _cockpit_wedge_marker("GET /graph/glance before-isolated-summary")
        summary = await asyncio.to_thread(
            collect_graph_glance_summary,
            storage_path,
        )
        _cockpit_wedge_marker(
            "GET /graph/glance after-isolated-summary",
            sources=len(summary["sources"]),
        )
        _cockpit_wedge_marker(
            "GET /graph/glance done",
            sources=len(summary["sources"]),
            elapsed_ms=round((time.monotonic() - started_at) * 1000.0, 3),
        )
        return {"status": "ok", **summary}

    except Exception as exc:
        logger.exception("GET /graph/glance failed")
        return {"status": "error", "message": str(exc)}


@app.delete("/graph/clear")
async def graph_clear() -> dict[str, Any]:
    """Delete all graph data and reinitialise a fresh empty graph.

    No confirmation parameter required — the Cockpit UI shows a confirmation
    dialog before calling this endpoint.
    """
    async with _state._lock:
        try:
            if _state.memory is not None and _state.use_sqlite:
                try:
                    _state.memory._storage.close()
                except Exception:
                    pass
            if _state.persist_path is not None and _state.persist_path.exists():
                try:
                    _state.persist_path.unlink()
                except Exception:
                    pass
            _state.memory = None
        except Exception as exc:
            logger.exception("DELETE /graph/clear failed during reset")
            return {"status": "error", "message": str(exc)}

    try:
        mem = await _state.get_memory()
        _record_cockpit_snapshot_for_memory(mem, "graph:clear")
    except BaseException:
        logger.exception("DELETE /graph/clear: pre-warm after reset failed (non-fatal)")

    return {"status": "cleared", "message": "Graph cleared."}


@app.get("/health")
async def health() -> dict[str, Any]:
    """Liveness check. Returns ok immediately; full diagnostics once engine is ready.

    Contract (2026-04-21 sprint): response ALWAYS includes an explicit
    ``initializing: bool`` key — ``True`` while the engine is being built,
    ``False`` once it is usable. The frontend state-machine (cockpit_ui)
    dismisses the startup overlay on ``initializing: False``. Relying on
    key-omission (``!data.initializing`` evaluating ``!undefined`` to
    ``true``) was fragile — any code path that returned a dict missing
    the key would coincidentally dismiss the overlay, including error
    responses. Now the key is explicit in every return path.
    """
    _cockpit_wedge_marker("GET /health start", memory_ready=_state.memory is not None)
    if _state.memory is None:
        _state.kick_init()  # start loading models in background thread
        return {
            "service": _SERVICE_SIGNATURE,
            "version": _TPVRG_VERSION,
            "status": "ok",
            "initializing": True,
            "warmup_stage": _state.warmup_stage or "Starting...",
            "gliner_stage": _state.gliner_stage,
            "coref_stage": _state.coref_stage,
            "memory_mb": int(psutil.Process().memory_info().rss // (1024 * 1024)),
            "similarity_edges": _similarity_edges_health_defaults("engine_not_ready"),
            **_repo_ingest_health_defaults(),
        }
    try:
        started_at = time.monotonic()
        mem = _state.memory
        storage = mem._storage
        if isinstance(storage, SQLiteBackend):
            storage_path = getattr(storage, "_path", None)
            if storage_path is None:
                _cockpit_wedge_marker("GET /health before-storage-health")
                result = storage.health_check()
                _cockpit_wedge_marker("GET /health after-storage-health")
            else:
                _cockpit_wedge_marker("GET /health before-cached-health")
                result = collect_sqlite_health_snapshot(
                    storage_path,
                    node_count=storage.node_count(),
                    edge_count=storage.edge_count(),
                )
                _cockpit_wedge_marker("GET /health after-cached-health")
        else:
            result = {
                "status": "ok",
                "backend": "InMemoryBackend",
                "note": "Full diagnostics only available with SQLiteBackend",
                "node_count": storage.node_count(),
                "edge_count": storage.edge_count(),
            }
        # Service signature — lets probes distinguish us from unrelated
        # services that happen to respond on the same port. Stable across
        # initializing/ready/degraded paths.
        result["service"] = _SERVICE_SIGNATURE
        result["version"] = _TPVRG_VERSION
        # Explicit contract: engine is up, frontend can dismiss the overlay.
        result["initializing"] = False
        result["warmup_stage"] = _state.warmup_stage or "Ready"
        result["gliner_stage"] = _state.gliner_stage
        result["coref_stage"] = _state.coref_stage
        result["memory_mb"] = int(psutil.Process().memory_info().rss // (1024 * 1024))
        result.update(_repo_ingest_health_fields(mem))
        result["similarity_edges"] = _similarity_edges_health_fields(mem)
        # Unified Component Registry (K-B): active mode + Fire/Water component catalog.
        from tp_vrg import component_registry
        result["component_registry"] = component_registry.registry_summary()
        # Dormancy probe (registry Phase-2a): does derived state actually fire? Memoized
        # so /health stays a cheap hot path; the fresh full probe is /diagnostics/dormancy.
        try:
            from tp_vrg import dormancy as _dormancy
            result["dormancy"] = _dormancy.dormancy_health_field()
        except Exception:  # a diagnostic must never break /health
            result["dormancy"] = {"error": "probe_failed"}

        # UX-15: report extraction model readiness
        from tp_vrg.llm_service import DeferredGLiNERProvider
        if isinstance(mem._llm, DeferredGLiNERProvider):
            result["extraction_model"] = {
                "status": mem._llm.status,
                "ready": mem._llm.is_ready,
            }

        # F16: include provenance backend stats
        if _state.provenance is not None:
            try:
                result["provenance"] = _state.provenance.health_check()
            except Exception as exc:
                result["provenance"] = {"status": "error", "message": str(exc)}
        else:
            result["provenance"] = {"status": "not_initialized"}

        _cockpit_wedge_marker(
            "GET /health done",
            elapsed_ms=round((time.monotonic() - started_at) * 1000.0, 3),
        )
        return result
    except Exception as exc:
        # Degraded but engine-exists path: storage.health_check() threw,
        # but _state.memory is still set so the engine CAN serve queries.
        # Mark initializing:False explicitly so the frontend stops spinning,
        # and include the error detail for operator visibility.
        logger.exception("GET /health failed")
        return {
            "service": _SERVICE_SIGNATURE,
            "version": _TPVRG_VERSION,
            "status": "degraded",
            "initializing": False,
            "warmup_stage": _state.warmup_stage or "Ready",
            "gliner_stage": _state.gliner_stage,
            "coref_stage": _state.coref_stage,
            "memory_mb": int(psutil.Process().memory_info().rss // (1024 * 1024)),
            "similarity_edges": _similarity_edges_health_defaults("error"),
            "error": str(exc),
            **_repo_ingest_health_defaults(),
        }


@app.get("/health/build_memory_timing")
async def health_build_memory_timing() -> dict[str, Any]:
    """Read-only diagnostic for the most recent engine initialization timing."""
    timing = dict(_state.build_memory_timing)
    return {
        "timing": timing,
        "total_s": sum(timing.values()),
        "stage_count": len(timing),
    }


@app.get("/query/timing")
async def query_timing() -> dict[str, Any]:
    """Read-only diagnostic for the most recent /query (or /answer) timing.

    Exposes ``LODGraphMemory.last_query_timing`` over HTTP. The instrumentation
    fields (``timed_stage_sum_s``, ``unaccounted_s``, ``unaccounted_pct``) were
    shipped by Sprint 2026-05-03 Item 5 (commit 9057446) on the engine; this
    endpoint adds the HTTP exposure missing from that sprint, in service of
    the [QUERY-LATENCY-COLD-CACHE-PERSONAL-GRAPH-TRACE] founder-graph trace
    needed to scope Item 4 of Sprint 2026-05-11-sprint-cockpit-cold-start-
    subsumption (Bake Daemon admission/prewarm cache).

    Usage: fire a query via POST /query, then GET /query/timing to capture
    per-stage costs of that query. Repeat with cold vs warm caches to
    identify dominant cost.
    """
    if _state.memory is None:
        return {
            "status": "no_memory",
            "message": "engine not yet initialized; fire a /query first OR wait for query_essential_ready",
        }
    timing = dict(getattr(_state.memory, "_last_query_timing", {}) or {})
    return {
        "timing": timing,
        "stage_count": len(timing),
    }


@app.get("/diagnostics/descent_trace")
async def descent_trace(query_id: str | None = None) -> dict[str, Any]:
    """Return the latest multi-resolution descent trace."""
    from tp_vrg.multi_res.telemetry import get_last_descent_trace

    return get_last_descent_trace(query_id)


@app.get("/diagnostics/cardinality")
async def diagnostics_cardinality(limit: int = Query(default=50, ge=1, le=500)) -> dict[str, Any]:
    """Return recent input/intermediate/output cardinality samples."""
    from tp_vrg.cardinality import cardinality

    return {"samples": cardinality.recent(limit)}


@app.get("/diagnostics/dormancy")
async def diagnostics_dormancy() -> dict[str, Any]:
    """Dormancy probe (registry Phase-2a): does each derived-state writer actually fire?

    Read-only — static source scan + read-only DB introspection — run in a thread so the
    source scan never blocks the event loop. The memoized summary is on /health.
    """
    from tp_vrg import dormancy as _dormancy

    mem = await _state.get_memory()
    storage = getattr(mem, "_storage", None)
    db_path = getattr(storage, "_path", None) if isinstance(storage, SQLiteBackend) else None

    def _run() -> dict[str, Any]:
        return _dormancy.probe_dormancy(db_path)

    return await asyncio.to_thread(_run)


@app.get("/diagnostics/similarity_edges")
async def diagnostics_similarity_edges(
    sample_limit: int = Query(default=10, ge=1, le=100),
) -> dict[str, Any]:
    """Return similarity-edge count, degree, and sample diagnostics."""
    mem = await _state.get_memory()
    storage = getattr(mem, "_storage", None)
    from tp_vrg.storage.similarity_edges import similarity_edges_diagnostics

    if isinstance(storage, SQLiteBackend):
        storage_path = getattr(storage, "_path", None)
        if storage_path is not None:
            def _read_similarity_edges() -> dict[str, Any]:
                with isolated_sqlite_connection(storage_path, read_only=True) as conn:
                    return similarity_edges_diagnostics(conn, sample_limit=sample_limit)

            return await asyncio.to_thread(_read_similarity_edges)

    conn = _similarity_edges_connection_for_memory(mem)
    if conn is None:
        return {
            **_similarity_edges_health_defaults(),
            "degree_distribution": {"out": {}, "in": {}},
            "sample_top_k": {"asset": [], "passage": []},
        }
    return similarity_edges_diagnostics(conn, sample_limit=sample_limit)


@app.get("/diagnostics/embedding_health")
async def diagnostics_embedding_health(
    table: str = "node_embedding_store",
    limit: int = 2048,
) -> dict[str, Any]:
    """Deterministic embedding-space health report (the SIGReg monitor).

    Spectral + norm statistics over a bounded sample of the stored
    vectors: effective rank, anisotropy, collapse verdicts. Run before
    quantization decisions and after embedder swaps. Per
    docs/intelligence/2026-06-10-creative-opportunity-sweep.md s2 #2.
    """
    try:
        from tp_vrg.embedding_health import embedding_health, sample_stored_embeddings

        mem = await _state.get_memory()
        storage = mem._storage
        vectors = await asyncio.to_thread(
            lambda: sample_stored_embeddings(storage, table=table, limit=limit)
        )
        report = await asyncio.to_thread(embedding_health, vectors)
        return {"status": "ok", "table": table, **report}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("GET /diagnostics/embedding_health failed")
        return {"status": "error", "message": str(exc)}


@app.get("/diagnostics/surprise_scan")
async def diagnostics_surprise_scan(
    fit_limit: int = 2048,
    scan_limit: int = 200,
    top_n: int = 12,
) -> dict[str, Any]:
    """The latent-surprise scan — curiosity-surface phase-0.

    Ranks recent passages by Mahalanobis distance in the whitened
    embedding space (novelty / contradiction / drift candidates).
    Deterministic, zero LLM calls, pure-read. surprise_ratio ~1.0 is
    typical; materially higher flags candidates. Feeds the question-pool
    G5/G8 signatures + the Cockpit curiosity surface.
    """
    try:
        from tp_vrg.embedding_health import surprise_scan

        mem = await _state.get_memory()
        storage = mem._storage
        report = await asyncio.to_thread(
            lambda: surprise_scan(
                storage,
                fit_limit=int(fit_limit),
                scan_limit=int(scan_limit),
                top_n=int(top_n),
            )
        )
        return {"status": "ok", **report}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("GET /diagnostics/surprise_scan failed")
        return {"status": "error", "message": str(exc)}


@app.get("/diagnostics/implied_questions")
async def diagnostics_implied_questions(
    limit: int = 12,
    passage_sample: int = 24,
) -> dict[str, Any]:
    """Questions this graph implies — the curiosity widget's backend.

    Regenerates the deterministic topology-aware questions (the same
    generator the HyPE ingest channel embeds, whose TEXTS are not stored)
    over a bounded sample of recent passages' subgraphs. Zero LLM calls.
    Visible-intelligence per the 2026-06-10 sweep; Surface O phase-0.
    """
    try:
        from tp_vrg.hype_templates import generate_topology_questions

        mem = await _state.get_memory()
        storage = mem._storage
        conn = getattr(storage, "_conn", None)
        if conn is None:
            return {"status": "error", "message": "requires SQLite storage."}

        def _generate() -> list[str]:
            rows = conn.execute(
                "SELECT passage_id, entity_ids FROM passages "
                "ORDER BY rowid DESC LIMIT ?",
                (max(1, int(passage_sample)),),
            ).fetchall()
            entity_ids: list[str] = []
            for _pid, eids_json in rows:
                try:
                    entity_ids.extend(e for e in json.loads(eids_json or "[]") if e)
                except (TypeError, ValueError):
                    continue
            entity_ids = list(dict.fromkeys(entity_ids))[:200]
            if not entity_ids:
                return []
            node_map = storage.get_nodes(entity_ids)
            nodes = list(node_map.values())
            get_edges = getattr(storage, "get_edges_for_nodes", None)
            edge_rows = get_edges(set(entity_ids)) if callable(get_edges) else []
            from tp_vrg.models import EdgeData

            edges = [
                EdgeData(source=str(u), target=str(v), relation=str(r))
                for u, v, r in edge_rows
            ]
            name_map = {n.entity_id: n.name for n in nodes}
            questions = generate_topology_questions(
                nodes, edges, name_map, max_questions=max(1, int(limit))
            )
            return list(dict.fromkeys(questions))[: max(1, int(limit))]

        questions = await asyncio.to_thread(_generate)
        return {
            "status": "ok",
            "passage_sample": passage_sample,
            "questions": questions,
        }
    except Exception as exc:
        logger.exception("GET /diagnostics/implied_questions failed")
        return {"status": "error", "message": str(exc)}


@app.get("/diagnostics/query_clusters")
async def diagnostics_query_clusters(
    window_hours: int = 72,
    top_n: int = 5,
) -> dict[str, Any]:
    """Your most common reasoning patterns — the query-shape clusters.

    Surfaces the clustering that already feeds the speculative pre-render
    cache (the engine adapts to your query distribution today; this lets
    you SEE it). Visible-intelligence exposure per
    docs/intelligence/2026-06-10-creative-opportunity-sweep.md §2 #1.
    """
    try:
        from tp_vrg.janitor.query_shape_cluster import (
            cluster_query_shapes,
            read_recent_query_events,
        )

        mem = await _state.get_memory()
        storage = mem._storage
        conn = getattr(storage, "_conn", None)
        if conn is None:
            return {"status": "error", "message": "query clusters require SQLite storage."}
        events = await asyncio.to_thread(
            lambda: read_recent_query_events(conn, window_hours=int(window_hours))
        )
        clusters = await asyncio.to_thread(
            lambda: cluster_query_shapes(events, top_n=max(1, int(top_n)))
        )
        return {
            "status": "ok",
            "window_hours": window_hours,
            "event_count": len(events),
            "clusters": [
                {
                    "cluster_id": c.cluster_id,
                    "representative": c.representative_query_text,
                    "member_count": c.member_count,
                    "members": list(c.member_queries)[:10],
                }
                for c in clusters
            ],
        }
    except Exception as exc:
        logger.exception("GET /diagnostics/query_clusters failed")
        return {"status": "error", "message": str(exc)}


@app.get("/diagnostics/speculative_cache_hit_rate")
async def speculative_cache_hit_rate() -> dict[str, Any]:
    """Return Pattern 2 speculative pre-render cache hit-rate diagnostics."""
    mem = await _state.get_memory()
    conn = getattr(getattr(mem, "_storage", None), "_conn", None)
    if conn is None:
        return {"available": False, "reason": "sqlite_connection_unavailable"}
    from tp_vrg.janitor.cache_invalidation import compute_graph_state_hash, invalidation_stats
    from tp_vrg.storage.speculative_cache import cache_stats

    stats = cache_stats(conn)
    stats["available"] = True
    stats["current_invalidation_token"] = compute_graph_state_hash(conn)
    stats["staleness_counter"] = invalidation_stats(conn)
    return stats


@app.get("/graph/view")
async def graph_view(
    rung: str,
    parent_id: str | None = None,
    top_k: int = Query(1500, ge=1, le=1500),
) -> dict[str, Any]:
    """Bounded multi-resolution graph browser geometry (U9 backend).

    Returns server-fed geometry for one rung (continent / island / asset /
    passage). Reads baked partition / label / centroid / community_edges
    tables. No community detection, no graph-wide NetworkX, no expensive
    layout computation on the hot read path (Doctrine A).

    Args (query string):
        rung: one of continent / island / asset / passage.
        parent_id: optional drill-down filter. Required for asset rung
            (would otherwise be unbounded for typical graphs).
        top_k: hard ceiling on returned nodes/edges (default 1500).

    Returns:
        Per [[../../docs/design/arch-multi-resolution-macro-retrieval-2026-05-12.md]]
        and [[../../prd-cockpit-ux-sprint-2026-04-12.md]] U9 reframe (Codex
        commit `419366d`): `{available, rung, parent_id, layout_version,
        graph_state_token, nodes, edges, total_nodes, total_edges, truncated}`
        or `{available: False, reason: ...}` for stale-substrate signaling.

    Spec reference: [[../../prd-cockpit-ux-sprint-2026-04-12.md]] U9 acceptance
    criteria (reframed 2026-05-21).
    """
    mem = await _state.get_memory()
    storage = getattr(mem, "_storage", None)
    if isinstance(storage, SQLiteBackend):
        storage_path = getattr(storage, "_path", None)
        if storage_path is not None:
            from tp_vrg.graph_view import get_graph_view
            from tp_vrg.storage.connection_isolation import isolated_sqlite_connection

            def _read_graph_view() -> dict[str, Any]:
                with isolated_sqlite_connection(storage_path, read_only=True) as iso:
                    return get_graph_view(
                        iso,
                        rung,
                        parent_id=parent_id,
                        top_k=int(top_k),
                    )

            return await asyncio.to_thread(_read_graph_view)

    conn = getattr(storage, "_conn", None)
    if conn is None:
        return {
            "available": False,
            "reason": "sqlite_connection_unavailable",
            "rung": rung,
            "parent_id": parent_id,
            "nodes": [],
            "edges": [],
            "total_nodes": 0,
            "total_edges": 0,
            "truncated": False,
        }
    from tp_vrg.graph_view import get_graph_view

    return get_graph_view(conn, rung, parent_id=parent_id, top_k=int(top_k))


@app.get("/inspect/summary")
async def inspect_summary() -> dict[str, Any]:
    """Inspect-tab graph totals, deltas, snapshots, and janitor runtime state."""
    try:
        mem = await _state.get_memory()
        storage = getattr(mem, "_storage", None)
        if isinstance(storage, SQLiteBackend):
            storage_path = getattr(storage, "_path", None)
            if storage_path is not None:
                from tp_vrg.storage.cockpit_stats import collect_inspect_summary

                summary = await asyncio.to_thread(collect_inspect_summary, storage_path)
            else:
                from tp_vrg.storage.cockpit_stats import collect_inspect_summary_from_conn

                summary = collect_inspect_summary_from_conn(
                    storage._conn,
                    graph_file_bytes=None,
                )
        else:
            passage_count = 0
            if hasattr(storage, "passage_count"):
                try:
                    passage_count = int(storage.passage_count())
                except Exception:
                    passage_count = 0
            summary = {
                "status": "ok",
                "node_count": mem.node_count,
                "edge_count": mem.edge_count,
                "passage_count": passage_count,
                "community_count": 0,
                "query_count": _state.total_queries,
                "janitor_pass_count": 0,
                "merge_count": 0,
                "graph_file_bytes": None,
                "graph_file_mb": None,
                "latest_snapshot": None,
                "baseline_snapshot": None,
                "snapshot_count": 0,
                "deltas_24h": {
                    "node_count": 0,
                    "edge_count": 0,
                    "passage_count": 0,
                    "community_count": 0,
                    "query_count": 0,
                    "janitor_pass_count": 0,
                    "merge_count": 0,
                },
            }
        summary["janitor"] = _janitor_runtime_status()
        return summary
    except Exception as exc:
        logger.exception("GET /inspect/summary failed")
        return {"status": "error", "message": str(exc), "janitor": _janitor_runtime_status()}


@app.get("/health/startup")
async def health_startup() -> dict[str, Any]:
    """Startup diagnostic status + thread dump."""
    return startup_status()


@app.post("/reset-stats")
async def reset_stats(body: ResetStatsRequest) -> dict[str, Any]:
    """Reset cumulative query statistics (does NOT clear the graph)."""
    if not body.confirm:
        return {
            "status": "aborted",
            "message": "Set confirm=true to reset query stats.",
            "current_stats": {
                "total_queries": _state.total_queries,
                "cumulative_tokens_served": _state.total_tokens_served,
            },
        }

    async with _state._lock:
        snapshot = {
            "total_queries": _state.total_queries,
            "cumulative_tokens_served": _state.total_tokens_served,
        }
        _state.total_queries = 0
        _state.total_tokens_served = 0
        if _state.memory is not None:
            _reset_cockpit_query_counter_for_memory(_state.memory)
            _record_cockpit_snapshot_for_memory(_state.memory, "query:reset")

    return {
        "status": "reset",
        "message": "Query stats zeroed. Knowledge graph unchanged.",
        "snapshot_before_reset": snapshot,
    }


@app.post("/clear")
async def clear(body: ClearRequest) -> dict[str, Any]:
    """Clear the TP-VRG knowledge graph (requires confirm=True)."""
    if not body.confirm:
        return {
            "status": "aborted",
            "message": "Set confirm=true to clear the knowledge graph.",
        }

    async with _state._lock:
        try:
            # F16: clear provenance FIRST (Windows file-lock safety).
            if _state.provenance is not None:
                try:
                    _state.provenance.clear_all()
                except Exception:
                    pass

            if _state.memory is not None and _state.use_sqlite:
                try:
                    _state.memory._storage.close()
                except Exception:
                    pass

            if _state.persist_path is not None and _state.persist_path.exists():
                try:
                    _state.persist_path.unlink()
                except Exception:
                    pass

            # Mark for lazy re-initialization on next request.
            # Do NOT call get_memory() here — asyncio.Lock is not reentrant and
            # we already hold the lock; calling get_memory() would deadlock.
            _state.memory = None

        except Exception as exc:
            logger.exception("POST /clear failed")
            return {"status": "error", "message": str(exc)}

    # Pre-warm the fresh graph outside the lock (optional; keeps first-request fast).
    # Use BaseException so SystemExit from _build_memory (e.g. missing GLiNER)
    # doesn't propagate — the clear already succeeded; pre-warm is best-effort.
    try:
        mem = await _state.get_memory()
        _record_cockpit_snapshot_for_memory(mem, "graph:clear")
    except BaseException:
        logger.exception("POST /clear: pre-warm after clear failed (non-fatal)")

    return {
        "status": "cleared",
        "message": "Knowledge graph has been reset.",
    }


# Phase names mirror bake_partitions._PHASES; used only as the pre-first-callback
# placeholder for job["phase_total"] (on_phase overwrites it with the orchestrator's
# authoritative count).
_BAKE_PHASES: tuple[str, ...] = ("asset", "island", "continent", "centroids")


def _prune_bake_jobs(*, retain: int = 20) -> None:
    """Cap the ephemeral bake-job registry; never drop a running job."""
    jobs = _state.bake_jobs
    if len(jobs) <= retain:
        return
    finished = sorted(
        (j for j in jobs.values() if j["status"] != "running"),
        key=lambda j: j["started_at"],
    )
    for job in finished[: max(0, len(jobs) - retain)]:
        jobs.pop(job["job_id"], None)


async def _run_bake_job(
    job_id: str,
    memory: LODGraphMemory,
    request: MultiResBakeRequest,
) -> None:
    """Execute a bake in the background, updating the job-status record."""
    job = _state.bake_jobs[job_id]
    from tp_vrg.janitor import GraphJanitor

    def on_phase(name: str, index: int, total: int) -> None:
        job["phase"] = name
        job["phase_index"] = index
        job["phase_total"] = total
        job["wall_time_s"] = time.time() - job["started_at"]
        progress.emit("bake", current=index, total=total, message=f"bake phase: {name}")

    try:
        janitor = GraphJanitor(memory)
        result = await janitor.bake_partitions(
            force_rebake=request.force_rebake,
            recompute_centroids=request.recompute_centroids,
            on_phase=on_phase,
        )
        job["result"] = result
        job["status"] = "done"
        job["phase"] = "done"
        job["wall_time_s"] = float(
            result.get("wall_time_s", time.time() - job["started_at"])
        )
        progress.emit(
            "bake",
            current=job["phase_total"],
            total=job["phase_total"],
            message="bake complete",
        )
        logger.info(
            "[admin] bake job_id=%s done "
            "(asset_count=%s island_count=%s continent_count=%s wall_time_s=%.2f)",
            job_id,
            result["asset_count"],
            result["island_count"],
            result["continent_count"],
            float(result["wall_time_s"]),
        )
    except Exception as exc:  # job surface records the failure for polling
        job["status"] = "error"
        job["error"] = str(exc)
        job["wall_time_s"] = time.time() - job["started_at"]
        progress.emit("bake", message=f"bake failed: {exc}")
        logger.exception("[admin] bake job_id=%s failed", job_id)


@app.post("/admin/multi_res/bake", status_code=202)
async def admin_multi_res_bake(
    body: MultiResBakeRequest | None = None,
) -> dict[str, Any]:
    """Launch a multi-resolution partition bake as a background job.

    The bake is compute-bound and minute-scale on a real graph, so the HTTP
    surface is async: it returns a ``job_id`` immediately (202) and the caller
    polls ``GET /admin/multi_res/bake/status/{job_id}`` for phase + progress +
    wall-time. Per-phase markers are also written to the engine log. The MCP /
    CLI / janitor surfaces stay synchronous by design (foreground or
    request-response contexts) and still emit the per-phase log markers.
    """
    request = body or MultiResBakeRequest()
    # Single-flight: surface an in-progress bake rather than starting a second.
    for existing in _state.bake_jobs.values():
        if existing["status"] == "running":
            return {
                "status": "busy",
                "job_id": existing["job_id"],
                "job": existing,
                "status_url": f"/admin/multi_res/bake/status/{existing['job_id']}",
            }
    # Surface engine-init errors synchronously before launching the job.
    memory = await _state.get_memory()
    job_id = uuid.uuid4().hex
    job: dict[str, Any] = {
        "job_id": job_id,
        "status": "running",
        "phase": "queued",
        "phase_index": 0,
        "phase_total": len(_BAKE_PHASES),
        "started_at": time.time(),
        "wall_time_s": 0.0,
        "result": None,
        "error": None,
    }
    _state.bake_jobs[job_id] = job
    _prune_bake_jobs()
    _state._bake_task = asyncio.create_task(_run_bake_job(job_id, memory, request))
    logger.info("[admin] /admin/multi_res/bake accepted job_id=%s", job_id)
    return {
        "status": "accepted",
        "job_id": job_id,
        "job": job,
        "status_url": f"/admin/multi_res/bake/status/{job_id}",
    }


@app.get("/admin/multi_res/bake/status/{job_id}")
async def admin_multi_res_bake_status(job_id: str) -> dict[str, Any]:
    """Report phase + progress + wall-time for a multi-res bake job."""
    job = _state.bake_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown bake job {job_id!r}")
    if job["status"] == "running":
        job["wall_time_s"] = time.time() - job["started_at"]
    return job


def _prune_similarity_bake_jobs(*, retain: int = 20) -> None:
    """Cap the ephemeral similarity-bake job registry; keep running jobs."""
    jobs = _state.similarity_bake_jobs
    if len(jobs) <= retain:
        return
    finished = sorted(
        (job for job in jobs.values() if job["status"] != "running"),
        key=lambda job: job["started_at"],
    )
    for job in finished[: max(0, len(jobs) - retain)]:
        jobs.pop(job["job_id"], None)


async def _run_similarity_edges_bake_job(
    job_id: str,
    memory: LODGraphMemory,
    request: SimilarityEdgesBakeRequest,
) -> None:
    """Execute a similarity-edge bake in the background."""
    job = _state.similarity_bake_jobs[job_id]
    from tp_vrg.janitor import GraphJanitor

    try:
        job["phase"] = "baking"
        progress.emit("bake", current=0, total=1, message="similarity_edges bake started")
        result = await GraphJanitor(memory).bake_similarity_edges(
            rung=request.rung,
            k=request.k,
            hub_cap=request.hub_cap,
        )
        job["result"] = result
        job["status"] = "done"
        job["phase"] = "done"
        job["wall_time_s"] = float(
            result.get("wall_time_s", time.time() - job["started_at"])
        )
        progress.emit("bake", current=1, total=1, message="similarity_edges bake complete")
        logger.info(
            "[admin] similarity_edges bake job_id=%s done "
            "(rung=%s edge_count=%s wall_time_s=%.2f)",
            job_id,
            result.get("rung"),
            result.get("edge_count"),
            float(job["wall_time_s"]),
        )
    except Exception as exc:
        job["status"] = "error"
        job["error"] = str(exc)
        job["wall_time_s"] = time.time() - job["started_at"]
        progress.emit("bake", message=f"similarity_edges bake failed: {exc}")
        logger.exception("[admin] similarity_edges bake job_id=%s failed", job_id)


@app.post("/admin/similarity_edges/bake", status_code=202)
async def admin_similarity_edges_bake(
    body: SimilarityEdgesBakeRequest | None = None,
) -> dict[str, Any]:
    """Launch a similarity-edge bake as a background job."""
    request = body or SimilarityEdgesBakeRequest()
    for existing in _state.similarity_bake_jobs.values():
        if existing["status"] == "running":
            return {
                "status": "busy",
                "job_id": existing["job_id"],
                "job": existing,
                "status_url": f"/admin/similarity_edges/bake/status/{existing['job_id']}",
            }
    memory = await _state.get_memory()
    job_id = uuid.uuid4().hex
    job: dict[str, Any] = {
        "job_id": job_id,
        "status": "running",
        "phase": "queued",
        "phase_index": 0,
        "phase_total": 1,
        "started_at": time.time(),
        "wall_time_s": 0.0,
        "request": request.model_dump(),
        "result": None,
        "error": None,
    }
    _state.similarity_bake_jobs[job_id] = job
    _prune_similarity_bake_jobs()
    _state._similarity_bake_task = asyncio.create_task(
        _run_similarity_edges_bake_job(job_id, memory, request)
    )
    logger.info("[admin] /admin/similarity_edges/bake accepted job_id=%s", job_id)
    return {
        "status": "accepted",
        "job_id": job_id,
        "job": job,
        "status_url": f"/admin/similarity_edges/bake/status/{job_id}",
    }


@app.get("/admin/similarity_edges/bake/status/{job_id}")
async def admin_similarity_edges_bake_status(job_id: str) -> dict[str, Any]:
    """Report progress for a similarity-edge bake job."""
    job = _state.similarity_bake_jobs.get(job_id)
    if job is None:
        raise HTTPException(
            status_code=404,
            detail=f"unknown similarity_edges bake job {job_id!r}",
        )
    if job["status"] == "running":
        job["wall_time_s"] = time.time() - job["started_at"]
    return job


@app.post("/janitor")
async def janitor(body: JanitorRequest) -> dict[str, Any]:
    """Run a background maintenance task on the knowledge graph."""
    if _state._janitor_active:
        return {"status": "busy", "janitor": _janitor_runtime_status()}
    try:
        memory = await _state.get_memory()
        from tp_vrg.janitor import GraphJanitor

        _state._janitor_active = True
        _state._janitor_last_task = body.task
        _state._janitor_last_pulse_at = time.time()
        progress.emit("janitor", message=f"Janitor task started: {body.task}")
        j = GraphJanitor(memory, dry_run=body.dry_run)
        report = await j.run_task(
            body.task,
            dry_run=body.dry_run,
            force_rebake=body.force_rebake,
            recompute_centroids=body.recompute_centroids,
            repo_root=body.repo_root,
            rebake_after_ingest=body.rebake_after_ingest,
        )
        _bump_cockpit_counter_for_memory(memory, "janitor")
        if body.task == "merge":
            _bump_cockpit_counter_for_memory(memory, "merge")
        _record_cockpit_snapshot_for_memory(memory, f"janitor:{body.task}")
        if isinstance(report, dict):
            progress.emit(
                "janitor",
                message=(
                    f"Janitor task complete: {body.task} "
                    f"({report.get('asset_count', 0)} assets baked)"
                ),
            )
            return {
                "status": "ok",
                "task": body.task,
                "dry_run": body.dry_run,
                **report,
                "janitor": _janitor_runtime_status(),
            }
        progress.emit(
            "janitor",
            message=f"Janitor task complete: {body.task} ({report.nodes_modified} modified)",
        )
        return {
            "status": "ok",
            "task": body.task,
            "dry_run": body.dry_run,
            "nodes_scanned": report.nodes_scanned,
            "nodes_affected": report.nodes_affected,
            "nodes_modified": report.nodes_modified,
            "errors": report.errors,
            "janitor": _janitor_runtime_status(),
        }
    except ValueError as exc:
        return {"status": "error", "message": str(exc)}
    except Exception as exc:
        logger.exception("POST /janitor failed (task=%r)", body.task)
        return {"status": "error", "message": str(exc)}
    finally:
        _state._janitor_active = False


@app.get("/janitor/status")
async def janitor_status() -> dict[str, Any]:
    """Lightweight status check: count merge candidates without modifying graph."""
    try:
        started_at = time.monotonic()
        _cockpit_wedge_marker("GET /janitor/status start")
        memory = await _state.get_memory()
        _cockpit_wedge_marker("GET /janitor/status memory-ready")
        if isinstance(memory._storage, SQLiteBackend):
            _cockpit_wedge_marker("GET /janitor/status skipped-sqlite-graph-scan")
            return {
                "status": "ok",
                "merge_candidate_status": "not_computed",
                "merge_candidates": None,
                "candidates": [],
                "janitor": _janitor_runtime_status(),
                "message": (
                    "Merge-candidate computation is Janitor-owned; "
                    "status reads do not scan the graph."
                ),
            }

        from tp_vrg.janitor import GraphJanitor

        j = GraphJanitor(memory, dry_run=True)
        _cockpit_wedge_marker("GET /janitor/status before-find-merge-candidates")
        candidates = await j.find_merge_candidates()
        _cockpit_wedge_marker(
            "GET /janitor/status after-find-merge-candidates",
            candidates=len(candidates),
        )
        _cockpit_wedge_marker(
            "GET /janitor/status done",
            elapsed_ms=round((time.monotonic() - started_at) * 1000.0, 3),
        )
        return {
            "status": "ok",
            "merge_candidates": len(candidates),
            "janitor": _janitor_runtime_status(),
            "candidates": [
                {"survivor": s, "duplicate": d, "similarity": round(sim, 4)}
                for s, d, sim in candidates[:20]  # Cap at 20 for UI
            ],
        }
    except Exception as exc:
        return {"status": "error", "message": str(exc)}


# ---------------------------------------------------------------------------
# OpenAI status endpoint
# ---------------------------------------------------------------------------


@app.get("/openai/status")
async def openai_status() -> dict[str, Any]:
    """Check if OPENAI_API_KEY is available (no API call — just env check)."""
    has_key = bool(os.environ.get("OPENAI_API_KEY"))
    return {
        "status": "ok",
        "has_key": has_key,
        "model_default": "gpt-4o-mini",
    }


# ---------------------------------------------------------------------------
# Ollama integration endpoints
# ---------------------------------------------------------------------------

_OLLAMA_DEFAULT_HOST = "http://localhost:11434"


@app.get("/ollama/models")
async def ollama_models(host: str = _OLLAMA_DEFAULT_HOST) -> dict[str, Any]:
    """List models installed in a local Ollama instance."""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{host}/api/tags")
            resp.raise_for_status()
            data = resp.json()
            models = [m["name"] for m in data.get("models", [])]
            return {"status": "ok", "models": models, "host": host}
    except ImportError:
        return {"status": "error", "message": "httpx not installed — run: pip install httpx"}
    except Exception as exc:
        return {"status": "error", "message": str(exc), "models": []}


@app.post("/answer")
async def answer(body: AnswerRequest) -> dict[str, Any]:
    """Query TP-VRG for context, then send to Ollama for a natural-language answer."""
    try:
        import httpx
    except ImportError:
        return {"status": "error", "message": "httpx not installed — run: pip install httpx"}

    # Step 1: get context from TP-VRG
    try:
        mem = await _state.get_memory()
        if mem.node_count == 0:
            return {
                "status": "error",
                "message": "Knowledge graph is empty. Ingest some text first.",
            }
        profile = TokenProfile(name="answer_query", max_tokens=body.token_budget)
        context = await mem.render_context(body.question, profile=profile)
        tokens_used = estimate_tokens(context)

        _state.total_queries += 1
        _state.total_tokens_served += tokens_used

        # Shared stats — includes savings_pct_this_query for demo display.
        stats = _compute_query_stats(mem, tokens_used)
        _bump_cockpit_counter_for_memory(mem, "query")
        _record_cockpit_snapshot_for_memory(mem, "answer")

    except Exception as exc:
        logger.exception("POST /answer TP-VRG query step failed")
        return {"status": "error", "message": f"TP-VRG query failed: {exc}"}

    # Step 2: send to LLM provider (Ollama or OpenAI-compatible)
    generated = ""
    provider_stats: dict[str, Any] = {}

    if body.provider == "openai":
        # --- OpenAI-compatible chat completions ---
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            return {
                "status": "error",
                "message": "OPENAI_API_KEY environment variable is not set.",
            }
        # Intent-driven reasoning guidance
        reasoning_hint = ""
        last_intent = getattr(mem, '_last_intent', None)
        if last_intent is not None:
            hint = last_intent.reasoning_guidance(query=body.question)
            if hint:
                reasoning_hint = f"\n{hint}"
        system_msg = resolve_answer_prompt(
            "cockpit_openai_system",
            context=context,
            question=body.question,
            reasoning_hint=reasoning_hint,
            format_prompt=True,
        )
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    f"{body.openai_base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": body.openai_model,
                        "messages": [
                            {"role": "system", "content": system_msg},
                            {"role": "user", "content": body.question},
                        ],
                        "temperature": 0.3,
                        "max_tokens": 2048,
                    },
                )
                resp.raise_for_status()
                openai_data = resp.json()
                generated = openai_data["choices"][0]["message"]["content"].strip()
                usage = openai_data.get("usage", {})
                provider_stats = {
                    "provider": "openai",
                    "openai_model": body.openai_model,
                    "prompt_tokens": usage.get("prompt_tokens"),
                    "completion_tokens": usage.get("completion_tokens"),
                }
        except Exception as exc:
            return {
                "status": "partial",
                "message": f"OpenAI call failed: {exc}",
                "context": context,
                "stats": stats,
            }
    else:
        # --- Ollama (existing path) ---
        # Intent-driven reasoning guidance (Ollama path)
        reasoning_hint = ""
        last_intent = getattr(mem, '_last_intent', None)
        if last_intent is not None:
            hint = last_intent.reasoning_guidance(query=body.question)
            if hint:
                reasoning_hint = f"\n{hint}"
        prompt = resolve_answer_prompt(
            "cockpit",
            context=context,
            question=body.question,
            reasoning_hint=reasoning_hint,
            format_prompt=True,
        )
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    f"{body.ollama_host}/api/generate",
                    json={
                        "model": body.ollama_model,
                        "prompt": prompt,
                        "stream": False,
                    },
                )
                resp.raise_for_status()
                ollama_data = resp.json()
                generated = ollama_data.get("response", "").strip()
                provider_stats = {
                    "provider": "ollama",
                    "ollama_model": body.ollama_model,
                    "ollama_eval_count": ollama_data.get("eval_count"),
                }
        except Exception as exc:
            return {
                "status": "partial",
                "message": f"Ollama call failed: {exc}",
                "context": context,
                "stats": stats,
            }

    # Intent signal
    intent_data = None
    last_intent = getattr(mem, '_last_intent', None)
    if last_intent is not None:
        intent_data = {
            "content_axes": {
                k: round(v, 3) for k, v in last_intent.content_axes.items() if v > 0.01
            },
            "wh_type": last_intent.wh_type,
            "specificity": round(last_intent.specificity, 2),
            "exhaustiveness": round(last_intent.exhaustiveness, 2),
            "reasoning_depth": round(last_intent.reasoning_depth, 2),
            "detected_entities": last_intent.detected_entities,
            "root_verb": last_intent.root_verb,
            "reasoning_intent": getattr(last_intent, "reasoning_intent", "factual_lookup"),
        }

    return {
        "status": "ok",
        "answer": generated,
        "context": context,
        "stats": {
            **stats,
            **provider_stats,
        },
        "intent": intent_data,
    }


# ---------------------------------------------------------------------------
# UX-10: Streaming answer endpoint (NDJSON — context first, then tokens)
# ---------------------------------------------------------------------------


@app.post("/answer/stream")
async def answer_stream(body: AnswerRequest) -> StreamingResponse:
    """Streaming version of /answer — yields NDJSON lines.

    Wire format (one JSON object per ``\\n``-delimited line):
      1. ``{"type":"context", "context":"...", "stats":{...}, "intent":{...}}``
      2. ``{"type":"token", "text":"..."}``   (repeated per LLM token)
      3. ``{"type":"done", "answer":"full concatenated answer"}``
      4. ``{"type":"error", "message":"..."}``  (on failure)
    """
    try:
        import httpx
    except ImportError:
        async def _err():
            yield json.dumps({"type": "error", "message": "httpx not installed"}) + "\n"
        return StreamingResponse(_err(), media_type="application/x-ndjson")

    async def generate():  # noqa: C901 — streaming generator, linear flow
        # -- Step 1: render context (fast) --
        try:
            mem = await _state.get_memory()
            if mem.node_count == 0:
                yield json.dumps({"type": "error", "message": "Knowledge graph is empty."}) + "\n"
                return
            profile = TokenProfile(name="answer_query", max_tokens=body.token_budget)
            context = await mem.render_context(body.question, profile=profile)
            tokens_used = estimate_tokens(context)
            _state.total_queries += 1
            _state.total_tokens_served += tokens_used

            # Shared stats — includes savings_pct_this_query for demo display.
            stats = _compute_query_stats(mem, tokens_used)
            _bump_cockpit_counter_for_memory(mem, "query")
            _record_cockpit_snapshot_for_memory(mem, "answer:stream")

            # Intent data
            intent_data = None
            last_intent = getattr(mem, "_last_intent", None)
            if last_intent is not None:
                intent_data = {
                    "content_axes": {
                        k: round(v, 3)
                        for k, v in last_intent.content_axes.items()
                        if v > 0.01
                    },
                    "wh_type": last_intent.wh_type,
                    "specificity": round(last_intent.specificity, 2),
                    "exhaustiveness": round(last_intent.exhaustiveness, 2),
                    "reasoning_depth": round(last_intent.reasoning_depth, 2),
                    "detected_entities": last_intent.detected_entities,
                    "root_verb": last_intent.root_verb,
                    "reasoning_intent": getattr(last_intent, "reasoning_intent", "factual_lookup"),
                }

        except Exception as exc:
            yield json.dumps({"type": "error", "message": f"TP-VRG query failed: {exc}"}) + "\n"
            return

        # Yield context immediately so the frontend can show evidence
        yield json.dumps({
            "type": "context",
            "context": context,
            "stats": stats,
            "intent": intent_data,
        }) + "\n"

        # -- Step 2: stream LLM tokens --
        # Build reasoning hint
        reasoning_hint = ""
        if last_intent is not None:
            hint = last_intent.reasoning_guidance(query=body.question)
            if hint:
                reasoning_hint = f"\n{hint}"

        full_answer = ""

        if body.provider == "openai":
            api_key = os.environ.get("OPENAI_API_KEY")
            if not api_key:
                yield json.dumps({"type": "error", "message": "OPENAI_API_KEY not set."}) + "\n"
                return
            system_msg = resolve_answer_prompt(
                "cockpit_openai_system",
                context=context,
                question=body.question,
                reasoning_hint=reasoning_hint,
                format_prompt=True,
            )
            try:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    async with client.stream(
                        "POST",
                        f"{body.openai_base_url}/chat/completions",
                        headers={
                            "Authorization": f"Bearer {api_key}",
                            "Content-Type": "application/json",
                        },
                        json={
                            "model": body.openai_model,
                            "messages": [
                                {"role": "system", "content": system_msg},
                                {"role": "user", "content": body.question},
                            ],
                            "temperature": 0.3,
                            "max_tokens": 2048,
                            "stream": True,
                        },
                    ) as resp:
                        resp.raise_for_status()
                        async for line in resp.aiter_lines():
                            if not line.startswith("data: "):
                                continue
                            payload = line[6:]
                            if payload.strip() == "[DONE]":
                                break
                            try:
                                chunk = json.loads(payload)
                                delta = chunk["choices"][0].get("delta", {})
                                token = delta.get("content", "")
                                if token:
                                    full_answer += token
                                    yield json.dumps({"type": "token", "text": token}) + "\n"
                            except (json.JSONDecodeError, KeyError, IndexError):
                                continue
            except Exception as exc:
                yield json.dumps({"type": "error", "message": f"OpenAI streaming failed: {exc}"}) + "\n"
                return

        else:
            # Ollama streaming
            prompt = resolve_answer_prompt(
                "cockpit",
                context=context,
                question=body.question,
                reasoning_hint=reasoning_hint,
                format_prompt=True,
            )
            try:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    async with client.stream(
                        "POST",
                        f"{body.ollama_host}/api/generate",
                        json={
                            "model": body.ollama_model,
                            "prompt": prompt,
                            "stream": True,
                        },
                    ) as resp:
                        resp.raise_for_status()
                        async for line in resp.aiter_lines():
                            if not line.strip():
                                continue
                            try:
                                chunk = json.loads(line)
                                token = chunk.get("response", "")
                                if token:
                                    full_answer += token
                                    yield json.dumps({"type": "token", "text": token}) + "\n"
                                if chunk.get("done"):
                                    break
                            except json.JSONDecodeError:
                                continue
            except Exception as exc:
                yield json.dumps({"type": "error", "message": f"Ollama streaming failed: {exc}"}) + "\n"
                return

        yield json.dumps({"type": "done", "answer": full_answer}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


# ---------------------------------------------------------------------------
# WebSocket: real-time progress events (UX-1)
# ---------------------------------------------------------------------------


@app.websocket("/ws/progress")
async def ws_progress(websocket: WebSocket) -> None:
    """Stream engine progress events to the Cockpit (or any WebSocket client).

    The ProgressHub singleton broadcasts events from ingestion, janitor, and
    query rendering.  Each connected client gets its own asyncio.Queue so
    slow consumers don't block fast ones.
    """
    await websocket.accept()
    q = progress.subscribe()
    tail_since = max(0.0, time.time() - 5.0)
    seen: set[str] = set()

    try:
        for event in progress.history(since=tail_since, limit=100):
            key = _progress_event_key(event)
            if key in seen:
                continue
            seen.add(key)
            tail_since = max(tail_since, _progress_event_timestamp(event))
            await websocket.send_text(json.dumps(event))

        while True:
            # Bridge external-process events from progress.jsonl.
            tail_events = _read_progress_tail_events(since=tail_since, limit=100)
            for event in tail_events:
                key = _progress_event_key(event)
                if key in seen:
                    continue
                seen.add(key)
                tail_since = max(tail_since, _progress_event_timestamp(event))
                await websocket.send_text(json.dumps(event))
                if len(seen) > 1024:
                    seen.clear()

            try:
                payload = await asyncio.wait_for(q.get(), timeout=2.0)
            except asyncio.TimeoutError:
                continue
            await websocket.send_text(payload)
            try:
                parsed = json.loads(payload)
                tail_since = max(tail_since, _progress_event_timestamp(parsed))
            except Exception:
                pass
    except WebSocketDisconnect:
        # Normal close — don't log, not informative.
        pass
    except Exception:
        # Unexpected — log the traceback so we can distinguish client-gone
        # from server-side bugs in the progress stream. Returning silently
        # is still the right behavior (client is gone either way), but we
        # want the evidence in the log for future debugging.
        logger.exception("ws_progress stream terminated unexpectedly")
    finally:
        progress.unsubscribe(q)


def _read_progress_tail_events(*, since: float = 0.0, limit: int = 100) -> list[dict[str, Any]]:
    """Read recent JSONL progress events, filtered by timestamp."""
    path = DEFAULT_PROGRESS_FILE
    if not path.exists():
        return []
    limit = max(1, min(limit, 500))
    try:
        with path.open("rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            block = bytearray()
            pos = end
            while pos > 0 and block.count(b"\n") <= (limit * 8):
                read = min(8192, pos)
                pos -= read
                f.seek(pos)
                block = bytearray(f.read(read)) + block
                if len(block) > 2_000_000:
                    break
        lines = block.decode("utf-8", errors="ignore").splitlines()
        events: list[dict[str, Any]] = []
        for line in reversed(lines):
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = float(event.get("ts", 0.0) or 0.0)
            if ts <= since:
                if since > 0:
                    break
                continue
            events.append(event)
            if len(events) >= limit:
                break
        events.reverse()
        return events
    except Exception:
        logger.exception("Failed reading progress tail from %s", path)
        return []


def _progress_event_timestamp(event: dict[str, Any]) -> float:
    try:
        return float(event.get("timestamp", event.get("ts", 0.0)) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _progress_event_key(event: dict[str, Any]) -> str:
    ts = _progress_event_timestamp(event)
    return "|".join(
        [
            f"{ts:.6f}",
            str(event.get("stage", "")),
            str(event.get("current", "")),
            str(event.get("total", "")),
            str(event.get("message", "")),
        ]
    )


def _read_recent_progress_events(*, since: float = 0.0, limit: int = 100) -> list[dict[str, Any]]:
    """Merge in-process history with JSONL tail events for late-joining clients."""
    limit = max(1, min(int(limit), 500))
    candidates = [
        *progress.history(since=since, limit=limit),
        *_read_progress_tail_events(since=since, limit=limit),
    ]
    candidates.sort(key=_progress_event_timestamp)
    seen: set[str] = set()
    events: list[dict[str, Any]] = []
    for event in candidates:
        key = _progress_event_key(event)
        if key in seen:
            continue
        seen.add(key)
        events.append(event)
    return events[-limit:]


@app.get("/progress/tail")
async def progress_tail(
    since: float = Query(0.0, description="Return events where ts > since."),
    limit: int = Query(100, ge=1, le=500),
) -> dict[str, Any]:
    """Return recent progress events from the shared JSONL tail."""
    events = _read_progress_tail_events(since=since, limit=limit)
    return {"events": events, "count": len(events), "since": since}


@app.get("/progress/events")
async def progress_events(
    since: float = Query(0.0, description="Return events where event timestamp > since."),
    limit: int = Query(100, ge=1, le=500),
) -> dict[str, Any]:
    """Return recent in-process and JSONL progress events for cockpit replay."""
    events = _read_recent_progress_events(since=since, limit=limit)
    return {"events": events, "count": len(events), "since": since}


# ---------------------------------------------------------------------------
# Entry point (console script: tp-vrg-api)
# ---------------------------------------------------------------------------


def main() -> None:
    """Run the TP-VRG HTTP API server with uvicorn."""
    # File logging: if we're embedded inside Cockpit, Cockpit already
    # configured cockpit.log and this call is a no-op (idempotent). If we're
    # standalone (tp-vrg-api CLI), we need our own sink.
    from tp_vrg.logging_setup import configure_file_logging
    configure_file_logging("api.log")

    # Log device info. Standalone API is headless (no UI), so we never show
    # a modal — log-warn only. Cockpit-embedded api_server never reaches
    # this main() (Cockpit imports `app` directly at cockpit_app.py:67).
    from tp_vrg.device_check import log_device_for_headless
    log_device_for_headless("tp-vrg-api")

    try:
        import uvicorn
    except ImportError:
        logger.error("tp-vrg-api: 'uvicorn' not installed. Fix: pip install tp-vrg[api]")
        print(
            "[tp-vrg-api] 'uvicorn' not installed. Fix: pip install tp-vrg[api]",
            file=sys.stderr,
        )
        sys.exit(1)

    host = os.environ.get("TPVRG_API_HOST", "0.0.0.0")
    port = int(os.environ.get("TPVRG_API_PORT", "8000"))
    logger.info("tp-vrg-api starting on http://%s:%d", host, port)
    print(f"[tp-vrg-api] Starting on http://{host}:{port}", file=sys.stderr)
    uvicorn.run("tp_vrg.api_server:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
