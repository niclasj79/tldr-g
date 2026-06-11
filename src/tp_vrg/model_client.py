"""HTTP client adapters for the TP-VRG model server."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

import numpy as np

from tp_vrg.embeddings import cosine_similarity
from tp_vrg.models import ExtractionResult

logger = logging.getLogger(__name__)


class ModelServerError(RuntimeError):
    """Raised when the model server returns an invalid response."""


class ModelServerClient:
    """Small JSON client for the persistent model daemon."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 300.0,
        transport: Any | None = None,
        transport_factory: Callable[[], Any] | None = None,
    ) -> None:
        if not base_url or not base_url.strip():
            raise ValueError("model server base_url must be non-empty")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._transport = transport
        self._transport_factory = transport_factory

    def _transport_for_call(self) -> Any | None:
        if self._transport_factory is not None:
            return self._transport_factory()
        return self._transport

    async def post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            import httpx
        except ImportError as exc:
            raise ImportError(
                "httpx is required when TPVRG_MODEL_SERVER_URL is set. "
                "Install with: pip install tp-vrg[api]"
            ) from exc

        async with httpx.AsyncClient(
            base_url=self.base_url,
            timeout=self.timeout,
            transport=self._transport_for_call(),
        ) as client:
            response = await client.post(path, json=payload)
            response.raise_for_status()
            data = response.json()
        if not isinstance(data, dict):
            raise ModelServerError(f"{path} returned non-object JSON")
        return data


class ModelServerEmbeddingProvider:
    """EmbeddingProvider adapter backed by /embed."""

    is_model_server = True

    def __init__(self, client: ModelServerClient, *, model_name: str) -> None:
        self._client = client
        self._model_name = model_name
        self._dimension: int | None = None
        self._model_id = model_name

    @property
    def dimension(self) -> int:
        if self._dimension is None:
            raise ModelServerError("model server embedder has not been warmed")
        return self._dimension

    @property
    def model_id(self) -> str:
        return self._model_id

    async def warmup(self) -> None:
        await self.embed("warmup")

    def warmup_sync(self) -> None:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(self.warmup())
            return
        raise RuntimeError(
            "BenchmarkHarness model-server warmup must run outside an active "
            "event loop so embedder.dimension is available before graph setup."
        )

    async def embed(self, text: str) -> np.ndarray:
        data = await self._client.post_json(
            "/embed",
            {"text": text, "model_name": self._model_name},
        )
        embedding = data.get("embedding")
        if not isinstance(embedding, list) or not embedding:
            raise ModelServerError("/embed returned an empty or invalid embedding")
        vec = np.asarray(embedding, dtype=np.float32)
        self._record_dimension(data, vec)
        return vec

    async def embed_batch(self, texts: list[str]) -> list[np.ndarray]:
        data = await self._client.post_json(
            "/embed",
            {"texts": texts, "model_name": self._model_name},
        )
        embeddings = data.get("embeddings")
        if not isinstance(embeddings, list):
            raise ModelServerError("/embed returned invalid embeddings")
        result: list[np.ndarray] = []
        for embedding in embeddings:
            if not isinstance(embedding, list) or not embedding:
                raise ModelServerError("/embed returned an empty embedding in batch")
            vec = np.asarray(embedding, dtype=np.float32)
            self._record_dimension(data, vec)
            result.append(vec)
        return result

    def _record_dimension(self, data: dict[str, Any], vec: np.ndarray) -> None:
        if vec.ndim != 1:
            raise ModelServerError(f"/embed returned non-vector shape {vec.shape}")
        dimension = int(data.get("dimension") or vec.shape[0])
        if dimension != vec.shape[0]:
            raise ModelServerError(
                f"/embed dimension mismatch: payload says {dimension}, "
                f"vector has {vec.shape[0]}"
            )
        if self._dimension is not None and dimension != self._dimension:
            raise ModelServerError(
                f"/embed dimension changed: {self._dimension} -> {dimension}"
            )
        self._dimension = dimension
        model_id = data.get("model_id")
        if isinstance(model_id, str) and model_id:
            self._model_id = model_id

    def similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        return cosine_similarity(a, b)


class ModelServerLLMProvider:
    """LLMProvider extraction adapter backed by /extract_entities."""

    def __init__(self, client: ModelServerClient, *, coref_mode: str) -> None:
        self._client = client
        self._coref_mode = coref_mode
        self._reset_coref_context = True

    def reset_coref_context(self) -> None:
        self._reset_coref_context = True

    async def extract_entities_and_edges(self, raw_text: str) -> ExtractionResult:
        data = await self._client.post_json(
            "/extract_entities",
            {
                "text": raw_text,
                "coref_mode": self._coref_mode,
                "reset_coref_context": self._reset_coref_context,
            },
        )
        self._reset_coref_context = False
        result = data.get("result")
        if not isinstance(result, dict):
            raise ModelServerError("/extract_entities returned invalid result")
        return ExtractionResult.model_validate(result)

    async def summarize(self, text: str, target_sentences: int = 2) -> str:
        raise NotImplementedError(
            "The model server extraction adapter does not expose summarize()."
        )


class ModelServerReranker:
    """Cross-encoder reranker adapter backed by /rerank."""

    def __init__(self, client: ModelServerClient, *, model_name: str) -> None:
        self._client = client
        self._model_name = model_name

    def warmup(self) -> None:
        return None

    async def rerank(
        self,
        query: str,
        passage_ids: list[str],
        storage: Any,
        top_k: int = 25,
    ) -> list[str]:
        if len(passage_ids) <= 1 or not self._model_name:
            return passage_ids
        to_rerank = passage_ids[:top_k]
        rest = passage_ids[top_k:]
        try:
            batch = storage.get_passages_batch(to_rerank)
            passages = []
            for passage_id in to_rerank:
                passage = batch.get(passage_id)
                text = passage.raw_text if passage and passage.raw_text else ""
                passages.append({"id": passage_id, "text": text[:1000]})
            data = await self._client.post_json(
                "/rerank",
                {
                    "query": query,
                    "passages": passages,
                    "top_k": top_k,
                    "model_name": self._model_name,
                },
            )
            reranked = data.get("passage_ids")
            if not isinstance(reranked, list) or not all(
                isinstance(pid, str) for pid in reranked
            ):
                raise ModelServerError("/rerank returned invalid passage_ids")
            expected = set(to_rerank)
            if set(reranked) != expected:
                raise ModelServerError(
                    "/rerank must return exactly the top_k passage IDs"
                )
            return list(reranked) + rest
        except Exception as exc:
            logger.warning("[ModelServer] rerank failed, using original order: %s", exc)
            return passage_ids
