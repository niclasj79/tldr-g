"""
Embedding provider abstraction layer.

Defines the EmbeddingProvider protocol and implementations:
- MockEmbeddingProvider: deterministic random vectors for testing
- SentenceTransformerProvider: local embeddings via sentence-transformers
"""

from __future__ import annotations

import asyncio
import logging
from typing import Protocol, runtime_checkable

import numpy as np
from tp_vrg.embedding_cache import EmbeddingCache

logger = logging.getLogger(__name__)


@runtime_checkable
class EmbeddingProvider(Protocol):
    """Interface for text embedding providers."""

    @property
    def dimension(self) -> int: ...
    @property
    def model_id(self) -> str: ...

    async def embed(self, text: str) -> np.ndarray: ...

    async def embed_batch(self, texts: list[str]) -> list[np.ndarray]:
        """Default fallback implementation for providers without native batching."""
        return [await self.embed(t) for t in texts]

    def similarity(self, a: np.ndarray, b: np.ndarray) -> float: ...


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute cosine similarity between two vectors."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


class MockEmbeddingProvider:
    """
    Deterministic mock embedding provider for testing.

    Uses a seeded RNG so the same text always produces the same vector.
    """

    def __init__(self, dimension: int = 384) -> None:
        self._dimension = dimension

    @property
    def dimension(self) -> int:
        return self._dimension
    @property
    def model_id(self) -> str:
        return "mock"

    async def embed(self, text: str) -> np.ndarray:
        seed = hash(text) % (2**31)
        rng = np.random.default_rng(seed)
        vec = rng.standard_normal(self._dimension).astype(np.float32)
        # Normalize to unit length
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm
        return vec

    async def embed_batch(self, texts: list[str]) -> list[np.ndarray]:
        return [await self.embed(t) for t in texts]

    def similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        return cosine_similarity(a, b)


# SOTA: Dense embeddings — adopted from sentence-transformers (Reimers & Gurevych, 2019)
# Default model: BAAI/bge-large-en-v1.5 (Beijing Academy of AI, 2023)
class SentenceTransformerProvider:
    """
    Local embedding provider using the sentence-transformers library.

    Default model: BAAI/bge-large-en-v1.5 (1024-dim, current Fire alloy floor).

    The default is the current deterministic-SOTA alloy, not the historically
    fastest model. Per the Fire/Water Doctrine clarification (2026-04-05): the
    alloy floor only moves up. Regression to MiniLM under default construction
    is treated as a broken Fire, not a cheap Fire.

    Tests that need the fast 384d model for mechanics-only assertions must pass
    ``model_name="all-MiniLM-L6-v2"`` explicitly.
    """

    def __init__(
        self,
        model_name: str = "BAAI/bge-large-en-v1.5",
        device: str | None = None,
    ) -> None:
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError:
            raise ImportError(
                "sentence-transformers is required for SentenceTransformerProvider. "
                "Install with: pip install tp-vrg[embeddings]"
            )
        import os
        import torch
        requested = device or os.environ.get("TPVRG_EMBED_DEVICE", "cuda:0")
        if requested.startswith("cuda") and not torch.cuda.is_available():
            _device = "cpu"
        else:
            _device = requested
        self._device = _device
        self._model_id = model_name
        self._model = SentenceTransformer(model_name, device=_device)
        self._dimension = self._model.get_sentence_embedding_dimension()

    @property
    def dimension(self) -> int:
        return self._dimension
    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def device(self) -> str:
        return self._device

    async def embed(self, text: str) -> np.ndarray:
        vec = await asyncio.to_thread(self._model.encode, text, normalize_embeddings=True)
        return np.asarray(vec, dtype=np.float32)

    async def embed_batch(self, texts: list[str]) -> list[np.ndarray]:
        vecs = await asyncio.to_thread(self._model.encode, texts, normalize_embeddings=True)
        return [np.asarray(v, dtype=np.float32) for v in vecs]

    def similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        return cosine_similarity(a, b)


class CachedEmbeddingProvider:
    """Decorator that fronts an embedding provider with an EmbeddingCache."""

    def __init__(self, underlying: EmbeddingProvider, cache: EmbeddingCache) -> None:
        self._underlying = underlying
        self._cache = cache

    @property
    def model_id(self) -> str:
        return self._underlying.model_id

    @property
    def dimension(self) -> int:
        return self._underlying.dimension

    async def embed(self, text: str) -> np.ndarray:
        if not text or not text.strip():
            return await self._underlying.embed(text)
        h = self._cache.hash_text(text)
        hit = self._cache.lookup(h, self.model_id)
        if hit is not None:
            if hit.size != self.dimension:
                raise ValueError(f"Cached embedding dimension mismatch for model_id={self.model_id}: {hit.size} != {self.dimension}")
            return hit
        emb = await self._underlying.embed(text)
        self._cache.write(h, self.model_id, emb, self.dimension)
        return emb

    async def embed_batch(self, texts: list[str]) -> list[np.ndarray]:
        result: list[np.ndarray | None] = [None] * len(texts)
        miss_ix: list[int] = []
        miss_texts: list[str] = []
        for i, t in enumerate(texts):
            if not t or not t.strip():
                miss_ix.append(i)
                miss_texts.append(t)
                continue
            h = self._cache.hash_text(t)
            hit = self._cache.lookup(h, self.model_id)
            if hit is not None:
                if hit.size != self.dimension:
                    raise ValueError(f"Cached embedding dimension mismatch for model_id={self.model_id}: {hit.size} != {self.dimension}")
                result[i] = hit
            else:
                miss_ix.append(i)
                miss_texts.append(t)
        if miss_texts:
            miss_vecs = await self._underlying.embed_batch(miss_texts)
            for idx, text, vec in zip(miss_ix, miss_texts, miss_vecs):
                result[idx] = vec
                if text and text.strip():
                    self._cache.write(self._cache.hash_text(text), self.model_id, vec, self.dimension)
        hits = len(texts) - len(miss_texts)
        misses = len(miss_texts)
        rate = (hits / len(texts) * 100.0) if texts else 0.0
        logger.info(
            "[embedding] batch complete: cache_hits=%d misses=%d rate=%.1f%%",
            hits, misses, rate,
        )
        return [r for r in result if r is not None]

    def similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        return self._underlying.similarity(a, b)
