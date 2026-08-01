"""Algorithm-qualified digest identifiers — hash agility without a retrofit.

A bare hex digest does not say which algorithm produced it. That is fine right
up until the day you add a second algorithm, and then it is a silent
correctness bug: the same content under two algorithms yields two different
strings, a comparison returns "not equal", and your system concludes the
content changed when it did not. Nothing in the stored data can tell you which
of the two you are holding.

Git is going through exactly this transition (SHA-1 to SHA-256) and is the
cautionary prior art: retrofitting an identifier format after it is embedded in
millions of artifacts is enormously harder than choosing a self-describing one
at the start. The cost of the qualified form is seven bytes.

The four rules that make it work:

- **Forward-only.** Existing artifacts are never rewritten and pinned hashes
  stay pinned. Only NEW writes emit the qualified form. A migration that
  requires touching old data is a migration that does not happen.
- **Readers normalize.** Every reader accepts BOTH the bare legacy form and the
  qualified form (``normalize``), so the two coexist indefinitely.
- **Comparisons never use raw ``==``.** Go through ``digests_equal``, or a value
  that differs only in qualification reads as a mismatch.
- **Fail loud on an unknown algorithm.** A ``sha3:…`` value from a future format
  must raise, never silently compare unequal as an opaque string. This is the
  rule the whole module exists for: **a wrong verdict is worse than a crash.**
  A crash gets fixed; a wrong "content changed" verdict gets believed.

**Where the boundary sits.** Qualification happens at serialization and
normalization at parse — the *artifact* is the boundary. In-memory fields and
database columns can stay bare, which keeps CHECK constraints and fixed-width
indexes intact. Do not scatter qualification through your internals.

Part of the TLDR-G primitives drop — https://tldr-g.ai
"""

from __future__ import annotations

__all__ = [
    "SHA256_PREFIX",
    "is_bare_sha256",
    "qualify",
    "normalize",
    "digests_equal",
]

SHA256_PREFIX = "sha256:"
_HEX_DIGITS = frozenset("0123456789abcdef")


def is_bare_sha256(value: str) -> bool:
    """True iff ``value`` is a bare 64-char hex digest (case-insensitive)."""
    return (
        isinstance(value, str)
        and len(value) == 64
        and set(value.lower()) <= _HEX_DIGITS
    )


def qualify(value: str) -> str:
    """Return the algorithm-qualified form of a sha256 digest.

    Empty stays empty (an unfilled field). An already-qualified value is
    returned unchanged, so this is idempotent and safe to apply twice. Anything
    else that is not a bare 64-hex digest raises — a producer qualifying a
    non-digest is a bug, and silently passing it through would put a malformed
    identifier into an artifact that outlives the bug.
    """
    if not value:
        return value
    if value.startswith(SHA256_PREFIX):
        rest = value[len(SHA256_PREFIX):]
        if not is_bare_sha256(rest):
            raise ValueError(f"malformed qualified sha256 digest: {value!r}")
        return value
    if not is_bare_sha256(value):
        raise ValueError(f"not a sha256 digest, refusing to qualify: {value!r}")
    return SHA256_PREFIX + value


def normalize(value: str) -> str:
    """Return the bare-hex form of a digest that may be legacy or qualified.

    Accepts ``""`` (returned as-is), bare 64-hex, and ``sha256:<hex>``. Any
    other algorithm prefix or malformed value raises.

    The raise is the point. An unknown-algorithm digest compared as an opaque
    string would produce a *wrong verification verdict* rather than an error,
    and a wrong verdict is the one outcome a content-addressed system must
    never produce.
    """
    if not value:
        return value
    if value.startswith(SHA256_PREFIX):
        rest = value[len(SHA256_PREFIX):]
        if not is_bare_sha256(rest):
            raise ValueError(f"malformed qualified sha256 digest: {value!r}")
        return rest.lower()
    if is_bare_sha256(value):
        return value.lower()
    raise ValueError(
        f"unrecognized digest format (unknown algorithm or malformed): {value!r}"
    )


def digests_equal(a: str, b: str) -> bool:
    """Compare two digests regardless of qualification form.

    Use this everywhere instead of ``==``. It is the single place the
    legacy/qualified duality is resolved, and it inherits ``normalize``'s
    fail-loud behaviour on an unknown algorithm.
    """
    return normalize(a) == normalize(b)
