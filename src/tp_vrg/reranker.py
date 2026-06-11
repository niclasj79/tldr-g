"""Cross-encoder passage reranking for macro retrieval candidates."""

from __future__ import annotations

import asyncio
import logging

from tp_vrg.storage import StorageBackend

logger = logging.getLogger(__name__)


# SOTA: Cross-encoder reranking — adopted from sentence-transformers (Reimers & Gurevych, 2019)
class CrossEncoderReranker:
    """Rerank retrieved passages with a cross-encoder.

    Loads the sentence-transformers CrossEncoder lazily on first use.
    On any failure (import/model load/predict), returns original order.
    """

    def __init__(self, model_name: str = "cross-encoder/ms-marco-MiniLM-L6-v2") -> None:
        self._model_name = model_name
        self._model = None

    def _ensure_model(self):
        if not self._model_name:
            raise RuntimeError("Cross-encoder model name is empty")
        if self._model is not None:
            return self._model
        from sentence_transformers import CrossEncoder

        # Explicit device selection — sentence-transformers defaults vary by
        # version and torch install. Mirror EmbeddingProvider / LingMess
        # auto-CUDA pattern; override via TPVRG_CROSS_ENCODER_DEVICE=cpu.
        import os as _os
        device = _os.environ.get("TPVRG_CROSS_ENCODER_DEVICE", "").strip()
        if not device:
            try:
                import torch as _torch
                device = "cuda" if _torch.cuda.is_available() else "cpu"
            except Exception:
                device = "cpu"
        self._model = CrossEncoder(self._model_name, device=device)
        logger.info("[CrossEncoder] loaded %s on %s", self._model_name, device)
        return self._model

    def warmup(self) -> None:
        """Load the cross-encoder model before the first timed query."""
        self._ensure_model()

    async def rerank(
        self,
        query: str,
        passage_ids: list[str],
        storage: StorageBackend,
        top_k: int = 25,
    ) -> list[str]:
        """Return passage IDs reordered by cross-encoder relevance."""
        if len(passage_ids) <= 1:
            return passage_ids
        if not self._model_name:
            return passage_ids

        to_rerank = passage_ids[:top_k]
        rest = passage_ids[top_k:]

        try:
            model = self._ensure_model()

            # SQL-B1: batch fetch eliminates N+1 queries
            _batch = storage.get_passages_batch(to_rerank)
            pairs: list[tuple[str, str]] = []
            for pid in to_rerank:
                passage = _batch.get(pid)
                text = passage.raw_text if passage and passage.raw_text else ""
                pairs.append((query, text[:1000]))

            scores = await asyncio.to_thread(model.predict, pairs)
            scored = list(zip(to_rerank, scores, strict=False))
            scored.sort(key=lambda x: float(x[1]), reverse=True)
            reranked = [pid for pid, _ in scored]
            return reranked + rest
        except Exception as exc:
            logger.warning("[CrossEncoder] rerank failed, using original order: %s", exc)
            return passage_ids
