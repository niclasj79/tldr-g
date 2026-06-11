"""Errors raised by multi-resolution retrieval."""


class StaleSubstrateError(RuntimeError):
    """Raised when a required baked multi-resolution substrate is missing or stale."""
