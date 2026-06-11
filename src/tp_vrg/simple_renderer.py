"""Simple cosine-fill renderer used by C.3 triple-render selection."""

from __future__ import annotations

import numpy as np

from tp_vrg.embeddings import EmbeddingProvider
from tp_vrg.storage import StorageBackend
from tp_vrg.tokens import estimate_tokens


async def cosine_fill_render(
    query: str,
    storage: StorageBackend,
    embedder: EmbeddingProvider,
    token_budget: int = 4000,
) -> tuple[str, list[str]]:
    """Render context by cosine ranking + greedy token-budget fill.

    Returns (context_str, rendered_passage_ids) so C.3 can capture citations
    for the cosine_fill strategy (F16).
    """
    query_emb = np.asarray(await embedder.embed(query), dtype=np.float32)
    passage_results = storage.passage_vector_search(query_emb, top_k=50)

    selected_texts: list[str] = []
    selected_pids: list[str] = []
    tokens_used = 0
    for pid, _sim in passage_results:
        passage = storage.get_passage(pid)
        if passage is None or not passage.raw_text:
            continue
        chunk_tokens = estimate_tokens(passage.raw_text)
        if tokens_used + chunk_tokens > token_budget:
            continue
        selected_texts.append(passage.raw_text)
        selected_pids.append(pid)
        tokens_used += chunk_tokens

    return "\n\n".join(selected_texts), selected_pids
