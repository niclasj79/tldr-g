"""Embedding health + whitening conditioner — the SIGReg steal, applied post-hoc.

The LeJEPA/SIGReg insight ([[the embedding-health design note]]
§1, promoted via the 2026-06-10 creative opportunity sweep §2 #2): an
embedding space whose marginals are isotropic-Gaussian is the space in
which (a) linear probes provably recover latent factors, (b) Mahalanobis
distance is a calibrated surprise/novelty measure, and (c) quantization
error distributes evenly. TLDR-G's embedders are frozen, so we apply the
discipline POST-HOC: a deterministic HEALTH MONITOR (is the stored space
collapsed/anisotropic?) and a WHITENING CONDITIONER (mean-center + ZCA)
fitted from the stored vectors.

Consumers (per the approved queue): the curiosity surface's latent-surprise
predicate (`[CURIOSITY-SURFACE-PHASE-0]`) and the learned-routing linear
probes (`[LEARNED-ROUTING-PHASE-0]`) — both operate in the conditioned
space. The conditioner is an OPT-IN utility: nothing in the retrieval path
changes by importing this module (benchmark-affecting wiring is a separate,
measured decision).

Deterministic, numpy-only, zero LLM calls (deterministic-sota discipline).
Single canonical implementation (INV-7).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

logger = logging.getLogger(__name__)

# Below this effective-rank fraction the space is flagged as collapsing —
# the classic embedding-collapse signature (mass concentrated in few
# directions). Threshold per the LeJEPA framing: healthy frozen-encoder
# spaces typically sit well above 0.2 of ambient dimension.
COLLAPSE_EFFECTIVE_RANK_FRACTION = 0.05
# Anisotropy warning on the TOP-EIGENVALUE SHARE (dimension-independent —
# the raw top/mean ratio saturates at dim, so a fixed ratio threshold
# would never fire in low dimensions): more than half the variance in one
# direction is the warning level.
ANISOTROPY_WARN_TOP_SHARE = 0.5
_EPS = 1e-8


def embedding_health(vectors: np.ndarray) -> dict[str, object]:
    """Deterministic health report for a sample of stored embeddings.

    Returns spectral + norm statistics with two boolean verdicts
    (``collapse_suspected``, ``anisotropy_warning``). Fail-loud on
    unusable input (INV-2) — an empty or degenerate sample must never
    yield a healthy-looking report.
    """
    if vectors is None or len(vectors) == 0:
        raise ValueError("embedding_health requires a non-empty vector sample")
    X = np.asarray(vectors, dtype=np.float64)
    if X.ndim != 2:
        raise ValueError(f"expected a 2-D (n, dim) array; got shape {X.shape}")
    n, dim = X.shape
    if n < 2:
        raise ValueError("embedding_health requires >= 2 vectors")

    norms = np.linalg.norm(X, axis=1)
    mean = X.mean(axis=0)
    centered = X - mean
    # Eigen-spectrum of the covariance (via SVD of the centered sample —
    # stable for n << dim and n >> dim alike).
    svals = np.linalg.svd(centered, compute_uv=False)
    eigvals = (svals**2) / max(n - 1, 1)
    total = float(eigvals.sum())
    if total <= _EPS:
        raise ValueError(
            "degenerate sample: zero covariance (all vectors identical?)"
        )
    p = eigvals / total
    p_nonzero = p[p > _EPS]
    # Effective rank (Roy & Vetterli): exp(entropy of the eigen-spectrum).
    effective_rank = float(np.exp(-(p_nonzero * np.log(p_nonzero)).sum()))
    anisotropy = float(eigvals[0] / max(eigvals.mean(), _EPS))
    rank_fraction = effective_rank / float(min(n, dim))

    return {
        "n_vectors": int(n),
        "dim": int(dim),
        "mean_norm": float(norms.mean()),
        "norm_std": float(norms.std()),
        "mean_offset_norm": float(np.linalg.norm(mean)),
        "effective_rank": round(effective_rank, 2),
        "effective_rank_fraction": round(rank_fraction, 4),
        "anisotropy_ratio": round(anisotropy, 2),
        "top_eigenvalue_share": round(float(p[0]), 4),
        "collapse_suspected": bool(rank_fraction < COLLAPSE_EFFECTIVE_RANK_FRACTION),
        "anisotropy_warning": bool(float(p[0]) > ANISOTROPY_WARN_TOP_SHARE),
    }


@dataclass(frozen=True)
class WhiteningConditioner:
    """A fitted mean-center + ZCA-whitening transform.

    In the conditioned space, the fitting sample has identity covariance —
    Mahalanobis distance to the sample mean reduces to the plain L2 norm
    (the surprise predicate's calibration property).
    """

    mean: np.ndarray
    transform: np.ndarray  # (dim, dim) ZCA matrix
    fitted_on: int

    def apply(self, vectors: np.ndarray) -> np.ndarray:
        X = np.asarray(vectors, dtype=np.float64)
        single = X.ndim == 1
        if single:
            X = X[None, :]
        out = (X - self.mean) @ self.transform.T
        return out[0] if single else out

    def surprise(self, vector: np.ndarray) -> float:
        """Mahalanobis distance of ``vector`` from the fitted distribution.

        ≈ sqrt(dim) for typical in-distribution points; materially larger
        values flag novelty/contradiction candidates (the curiosity
        surface's zero-LLM-cost signal).
        """
        return float(np.linalg.norm(self.apply(vector)))


def fit_whitening(
    vectors: np.ndarray, *, shrinkage: float = 0.1
) -> WhiteningConditioner:
    """Fit a ZCA whitening conditioner with Ledoit-Wolf-style shrinkage.

    ``shrinkage`` blends the sample covariance toward its isotropic mean
    (a deterministic regularizer keeping the inverse square root stable
    when n is small relative to dim). Fail-loud on degenerate input.
    """
    if not 0.0 <= shrinkage < 1.0:
        raise ValueError("shrinkage must be in [0, 1)")
    X = np.asarray(vectors, dtype=np.float64)
    if X.ndim != 2 or X.shape[0] < 2:
        raise ValueError("fit_whitening requires a (n>=2, dim) sample")
    n, dim = X.shape
    mean = X.mean(axis=0)
    centered = X - mean
    cov = (centered.T @ centered) / max(n - 1, 1)
    iso = np.trace(cov) / dim
    if iso <= _EPS:
        raise ValueError("degenerate sample: zero covariance")
    cov = (1.0 - shrinkage) * cov + shrinkage * iso * np.eye(dim)
    eigvals, eigvecs = np.linalg.eigh(cov)
    eigvals = np.clip(eigvals, _EPS, None)
    zca = eigvecs @ np.diag(eigvals**-0.5) @ eigvecs.T
    return WhiteningConditioner(mean=mean, transform=zca, fitted_on=int(n))


def sample_stored_embeddings(
    storage, *, table: str = "node_embedding_store", limit: int = 2048
) -> np.ndarray:
    """Read a bounded deterministic sample from a canonical embedding store.

    Ordered by id for reproducibility; bounded so the health probe stays
    cheap on multi-GB stores.
    """
    if table not in ("node_embedding_store", "passage_embedding_store"):
        raise ValueError(f"unknown embedding store: {table!r}")
    conn = getattr(storage, "_conn", None) or getattr(storage, "conn", None)
    if conn is None:
        raise ValueError("embedding sampling requires SQLite storage")
    rows = conn.execute(
        f"SELECT embedding FROM {table} ORDER BY id LIMIT ?", (int(limit),)
    ).fetchall()
    vectors = [
        np.frombuffer(blob, dtype=np.float32)
        for (blob,) in rows
        if blob is not None
    ]
    vectors = [v for v in vectors if v.size and bool(np.any(v != 0.0))]
    if not vectors:
        raise ValueError(f"no usable embeddings found in {table}")
    dim = vectors[0].size
    return np.stack([v for v in vectors if v.size == dim]).astype(np.float64)


def surprise_scan(
    storage,
    *,
    fit_limit: int = 2048,
    scan_limit: int = 200,
    top_n: int = 12,
) -> dict[str, object]:
    """Rank the most recently ingested passages by latent surprise.

    Curiosity-surface phase-0 (`[CURIOSITY-SURFACE-PHASE-0]`): fit the
    whitening conditioner on the stored passage-embedding distribution,
    then score the most recent passages' embeddings by Mahalanobis
    distance. High scorers are novelty / contradiction / drift candidates
    — surfaced for the question-pool's G5 (density gradient) and G8
    (inconsistency-triggered) gap signatures and for the Cockpit's
    curiosity surface. Deterministic; zero LLM calls; pure-read.

    ``surprise_ratio`` normalizes by sqrt(dim) (the in-distribution
    expectation in the conditioned space), so ~1.0 = typical, and
    materially higher values flag candidates regardless of embedder dim.
    """
    conn = getattr(storage, "_conn", None) or getattr(storage, "conn", None)
    if conn is None:
        raise ValueError("surprise_scan requires SQLite storage")
    sample = sample_stored_embeddings(
        storage, table="passage_embedding_store", limit=fit_limit
    )
    if len(sample) < 8:
        raise ValueError(
            f"surprise_scan needs >=8 stored passage embeddings to fit; got {len(sample)}"
        )
    conditioner = fit_whitening(sample)
    expected = float(np.sqrt(sample.shape[1]))

    rows = conn.execute(
        "SELECT p.passage_id, p.source_label, s.embedding "
        "FROM passages AS p JOIN passage_embedding_store AS s ON s.id = p.passage_id "
        "ORDER BY p.rowid DESC LIMIT ?",
        (max(1, int(scan_limit)),),
    ).fetchall()
    scored: list[dict[str, object]] = []
    for passage_id, source_label, blob in rows:
        if blob is None:
            continue
        vec = np.frombuffer(blob, dtype=np.float32).astype(np.float64)
        if vec.size != sample.shape[1] or not np.any(vec != 0.0):
            continue
        score = conditioner.surprise(vec)
        scored.append(
            {
                "passage_id": str(passage_id),
                "source_label": str(source_label or ""),
                "surprise": round(score, 3),
                "surprise_ratio": round(score / expected, 3),
            }
        )
    scored.sort(key=lambda r: -float(r["surprise"]))
    return {
        "fitted_on": conditioner.fitted_on,
        "dim": int(sample.shape[1]),
        "expected_surprise": round(expected, 3),
        "scanned": len(scored),
        "top_surprising": scored[: max(1, int(top_n))],
    }
