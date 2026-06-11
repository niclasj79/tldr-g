"""Token estimation utilities for the TP-VRG context budget system."""

from __future__ import annotations


def estimate_tokens(text: str) -> int:
    """
    Estimate the token count for a piece of text.

    Uses tiktoken (cl100k_base encoding) if available, otherwise falls
    back to a simple character-count heuristic (~4 chars per token).
    """
    try:
        import tiktoken

        enc = tiktoken.get_encoding("cl100k_base")
        return len(enc.encode(text))
    except ImportError:
        # Fallback: ~4 chars per token for English text
        return max(1, len(text) // 4)
