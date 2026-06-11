"""
Search functions with Rust acceleration and numpy fallback.

Tries to import the tp_vrg_rs Rust extension for SIMD-accelerated
batch cosine similarity and BM25. Falls back to pure numpy/Python
implementations when the extension is not installed.
"""

from __future__ import annotations

import numpy as np

_RUST_AVAILABLE = False
try:
    from tp_vrg_rs import batch_cosine_top_k as _rust_cosine
    from tp_vrg_rs import bm25_search as _rust_bm25

    _RUST_AVAILABLE = True
except ImportError:
    pass


def batch_cosine_top_k(
    query: np.ndarray,
    matrix: np.ndarray,
    top_k: int,
) -> list[tuple[int, float]]:
    """
    Find top-k most similar rows in matrix to query by cosine similarity.

    Args:
        query: 1-D float32 array of shape (dim,)
        matrix: 2-D float32 array of shape (N, dim)
        top_k: number of results to return

    Returns:
        List of (row_index, similarity_score) sorted descending.
        Only rows with positive similarity are returned.
    """
    if matrix.shape[0] == 0 or query.shape[0] == 0:
        return []

    if _RUST_AVAILABLE:
        # Rust extension expects contiguous float32 arrays
        q = np.ascontiguousarray(query, dtype=np.float32)
        m = np.ascontiguousarray(matrix, dtype=np.float32)
        return _rust_cosine(q, m, top_k)

    # --- numpy fallback ---
    query_norm = np.linalg.norm(query)
    if query_norm == 0:
        return []

    norms = np.linalg.norm(matrix, axis=1)
    valid = norms > 0
    if not np.any(valid):
        return []

    sims = np.zeros(matrix.shape[0], dtype=np.float32)
    sims[valid] = (matrix[valid] @ query) / (norms[valid] * query_norm)

    # Filter to positive similarities only
    positive = sims > 0
    if not np.any(positive):
        return []

    actual_k = min(top_k, int(np.sum(positive)))
    # argpartition is O(n) vs O(n log n) for full sort
    top_indices = np.argpartition(sims, -actual_k)[-actual_k:]
    top_indices = top_indices[np.argsort(sims[top_indices])[::-1]]

    return [(int(i), float(sims[i])) for i in top_indices if sims[i] > 0]


def bm25_search(
    query: str,
    documents: list[str],
    top_k: int,
) -> list[tuple[int, float]]:
    """
    BM25 text search over a list of documents.

    Args:
        query: search query string
        documents: list of document strings
        top_k: number of results to return

    Returns:
        List of (doc_index, bm25_score) sorted descending.
    """
    if not documents or not query.strip():
        return []

    if _RUST_AVAILABLE:
        return _rust_bm25(query, documents, top_k)

    # --- Python fallback ---
    import math
    from collections import Counter

    k1 = 1.2
    b = 0.75
    n = len(documents)

    query_terms = query.lower().split()
    if not query_terms:
        return []

    doc_tokens = [d.lower().split() for d in documents]
    avg_dl = sum(len(t) for t in doc_tokens) / n

    # Document frequency
    df: dict[str, int] = {}
    for term in query_terms:
        df[term] = sum(1 for tokens in doc_tokens if term in tokens)

    scored: list[tuple[int, float]] = []
    for i, tokens in enumerate(doc_tokens):
        tf_counts = Counter(tokens)
        score = 0.0
        dl = len(tokens)

        for term in query_terms:
            tf = tf_counts.get(term, 0)
            doc_freq = df.get(term, 0)
            if tf == 0 or doc_freq == 0:
                continue

            idf = math.log((n - doc_freq + 0.5) / (doc_freq + 0.5) + 1.0)
            tf_component = (tf * (k1 + 1.0)) / (
                tf + k1 * (1.0 - b + b * dl / avg_dl)
            )
            score += idf * tf_component

        if score > 0:
            scored.append((i, score))

    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:top_k]


def is_rust_available() -> bool:
    """Check if the Rust search extension is installed."""
    return _RUST_AVAILABLE
