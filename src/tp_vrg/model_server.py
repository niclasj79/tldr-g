"""Persistent model daemon for benchmark and engine model calls."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import time
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from tp_vrg.embeddings import SentenceTransformerProvider
from tp_vrg.llm_service import GLiNERSpacyProvider
from tp_vrg.models import CROSS_ENCODER_MODEL, ExtractionResult
from tp_vrg.reranker import CrossEncoderReranker

logger = logging.getLogger(__name__)


class EmbedRequest(BaseModel):
    text: str | None = None
    texts: list[str] | None = None
    model_name: str | None = None


class EmbedResponse(BaseModel):
    embedding: list[float] | None = None
    embeddings: list[list[float]] | None = None
    dimension: int
    model_id: str


class ExtractEntitiesRequest(BaseModel):
    text: str
    coref_mode: str = "sieve"
    reset_coref_context: bool = False


class ExtractEntitiesResponse(BaseModel):
    result: ExtractionResult


class RerankPassage(BaseModel):
    id: str
    text: str = ""


class RerankRequest(BaseModel):
    query: str
    passages: list[RerankPassage] = Field(default_factory=list)
    top_k: int = 25
    model_name: str | None = None


class RerankResponse(BaseModel):
    passage_ids: list[str]
    scores: list[float]
    model_id: str


class ModelServerState:
    """Lazy, process-wide model pool."""

    def __init__(self) -> None:
        self._embedder: Any | None = None
        self._embedder_model_name: str | None = None
        self._extractors: dict[str, Any] = {}
        self._reranker: Any | None = None
        self._reranker_model_name: str | None = None
        self._embedder_lock = asyncio.Lock()
        self._extractor_lock = asyncio.Lock()
        self._reranker_lock = asyncio.Lock()
        self.started_at = time.time()
        self.request_counts = {"embed": 0, "extract_entities": 0, "rerank": 0}

    def reset_for_tests(
        self,
        *,
        embedder: Any | None = None,
        extractor: Any | None = None,
        reranker: Any | None = None,
    ) -> None:
        self._embedder = embedder
        self._embedder_model_name = getattr(embedder, "model_id", None)
        self._extractors = {"__test__": extractor} if extractor is not None else {}
        self._reranker = reranker
        self._reranker_model_name = getattr(reranker, "model_id", None)
        self.request_counts = {"embed": 0, "extract_entities": 0, "rerank": 0}
        self.started_at = time.time()

    async def get_embedder(self, model_name: str | None) -> Any:
        requested = model_name or os.environ.get(
            "TPVRG_MODEL_SERVER_EMBEDDING_MODEL",
            "BAAI/bge-large-en-v1.5",
        )
        async with self._embedder_lock:
            if self._embedder is None:
                logger.info("[model-server] loading embedder %s", requested)
                self._embedder = await asyncio.to_thread(
                    SentenceTransformerProvider,
                    model_name=requested,
                )
                self._embedder_model_name = self._embedder.model_id
            elif self._embedder_model_name != requested:
                raise ValueError(
                    "model server already loaded embedder "
                    f"{self._embedder_model_name!r}; requested {requested!r}"
                )
            return self._embedder

    async def get_extractor(self, coref_mode: str) -> Any:
        if "__test__" in self._extractors:
            return self._extractors["__test__"]
        mode = (coref_mode or "sieve").strip().lower()
        async with self._extractor_lock:
            provider = self._extractors.get(mode)
            if provider is None:
                logger.info("[model-server] loading GLiNERSpacyProvider (%s)", mode)
                provider = await asyncio.to_thread(
                    GLiNERSpacyProvider,
                    coref_mode=mode,
                )
                self._extractors[mode] = provider
            return provider

    async def get_reranker(self, model_name: str | None) -> Any:
        requested = (
            model_name
            if model_name is not None
            else os.environ.get("TPVRG_MODEL_SERVER_CROSS_ENCODER", CROSS_ENCODER_MODEL)
        ).strip()
        async with self._reranker_lock:
            if self._reranker is None:
                logger.info("[model-server] loading reranker %s", requested)
                self._reranker = CrossEncoderReranker(requested)
                self._reranker_model_name = requested
                if requested:
                    await asyncio.to_thread(self._reranker.warmup)
            elif self._reranker_model_name != requested:
                raise ValueError(
                    "model server already loaded reranker "
                    f"{self._reranker_model_name!r}; requested {requested!r}"
                )
            return self._reranker


_state = ModelServerState()

app = FastAPI(
    title="TP-VRG Model Server",
    description="Persistent model pool for embeddings, extraction, and reranking.",
    version="0.1.0",
)


def _request_texts(request: EmbedRequest) -> tuple[list[str], bool]:
    if request.text is not None and request.texts is not None:
        raise HTTPException(status_code=422, detail="send either text or texts, not both")
    if request.text is not None:
        return [request.text], True
    if request.texts is not None:
        if not request.texts:
            raise HTTPException(status_code=422, detail="texts must not be empty")
        return list(request.texts), False
    raise HTTPException(status_code=422, detail="send text or texts")


def _as_float_list(vec: Any) -> list[float]:
    arr = np.asarray(vec, dtype=np.float32)
    if arr.ndim != 1 or arr.size == 0:
        raise ValueError(f"invalid embedding shape {arr.shape}")
    return [float(v) for v in arr]


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "uptime_s": round(time.time() - _state.started_at, 3),
        "embedder_loaded": _state._embedder is not None,
        "extractor_modes_loaded": sorted(
            key for key in _state._extractors if key != "__test__"
        ),
        "reranker_loaded": _state._reranker is not None,
        "request_counts": dict(_state.request_counts),
    }


@app.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest) -> EmbedResponse:
    _state.request_counts["embed"] += 1
    texts, single = _request_texts(request)
    try:
        embedder = await _state.get_embedder(request.model_name)
        if len(texts) == 1:
            vectors = [await embedder.embed(texts[0])]
        elif hasattr(embedder, "embed_batch"):
            vectors = await embedder.embed_batch(texts)
        else:
            vectors = [await embedder.embed(text) for text in texts]
        embeddings = [_as_float_list(vec) for vec in vectors]
        dimension = int(getattr(embedder, "dimension", len(embeddings[0])))
        model_id = str(getattr(embedder, "model_id", request.model_name or "unknown"))
    except Exception as exc:
        logger.exception("[model-server] /embed failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if single:
        return EmbedResponse(
            embedding=embeddings[0],
            embeddings=None,
            dimension=dimension,
            model_id=model_id,
        )
    return EmbedResponse(
        embedding=None,
        embeddings=embeddings,
        dimension=dimension,
        model_id=model_id,
    )


@app.post("/extract_entities", response_model=ExtractEntitiesResponse)
async def extract_entities(
    request: ExtractEntitiesRequest,
) -> ExtractEntitiesResponse:
    _state.request_counts["extract_entities"] += 1
    try:
        provider = await _state.get_extractor(request.coref_mode)
        if request.reset_coref_context and hasattr(provider, "reset_coref_context"):
            provider.reset_coref_context()
        result = await provider.extract_entities_and_edges(request.text)
    except Exception as exc:
        logger.exception("[model-server] /extract_entities failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return ExtractEntitiesResponse(result=result)


@app.post("/rerank", response_model=RerankResponse)
async def rerank(request: RerankRequest) -> RerankResponse:
    _state.request_counts["rerank"] += 1
    if len(request.passages) <= 1:
        return RerankResponse(
            passage_ids=[p.id for p in request.passages],
            scores=[],
            model_id=request.model_name or CROSS_ENCODER_MODEL,
        )
    top_k = max(1, min(request.top_k, len(request.passages)))
    try:
        reranker = await _state.get_reranker(request.model_name)
        model_name = str(getattr(reranker, "_model_name", request.model_name or ""))
        if not model_name:
            return RerankResponse(
                passage_ids=[p.id for p in request.passages],
                scores=[],
                model_id=model_name,
            )
        model = reranker._ensure_model()
        head = request.passages[:top_k]
        tail = request.passages[top_k:]
        pairs = [(request.query, passage.text[:1000]) for passage in head]
        raw_scores = await asyncio.to_thread(model.predict, pairs)
        scored = list(zip(head, raw_scores, strict=False))
        scored.sort(key=lambda item: float(item[1]), reverse=True)
        passage_ids = [passage.id for passage, _score in scored]
        passage_ids.extend(passage.id for passage in tail)
        scores = [float(score) for _passage, score in scored]
    except Exception as exc:
        logger.exception("[model-server] /rerank failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return RerankResponse(
        passage_ids=passage_ids,
        scores=scores,
        model_id=model_name,
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run the TP-VRG model server.")
    parser.add_argument("--host", default=os.environ.get("TPVRG_MODEL_SERVER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("TPVRG_MODEL_SERVER_PORT", "8765")))
    parser.add_argument("--log-level", default=os.environ.get("TPVRG_MODEL_SERVER_LOG_LEVEL", "info"))
    args = parser.parse_args(argv)

    try:
        import uvicorn
    except ImportError as exc:
        raise RuntimeError(
            "uvicorn is required for the model server. Install with: pip install tp-vrg[api]"
        ) from exc
    uvicorn.run(
        "tp_vrg.model_server:app",
        host=args.host,
        port=args.port,
        log_level=args.log_level,
        reload=False,
    )


if __name__ == "__main__":
    main()
