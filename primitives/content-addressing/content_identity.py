"""Platform-independent content identity for committed text files.

A byte-exact ``sha256(path.read_bytes())`` over a *committed text* file is a
content-addressed key over **checkout state, not content**. The git blob is LF,
but a working tree can carry CRLF — a ``.gitattributes`` ``eol=lf`` is not
always honored on every box — so the same file hashes differently per checkout.

The failure is quiet and expensive. A pinned fixture passes on a fresh clone and
fails on a colleague's machine, or a content-addressed cache key relabels an
artifact, for a reason that has nothing whatever to do with the content. The
incident that produced this file: **6 failures on one developer's machine, 0 on
a fresh clone of the same commit.**

``eol_normalized_sha256`` is the fix: decode UTF-8, normalize every CRLF and
lone CR to LF, re-encode UTF-8, hash. For a file that is already pure-LF UTF-8
this is **byte-identical to the raw-bytes hash** — so switching an existing pin
to this function does not invalidate a value generated on an LF checkout. It
only makes the pin robust to a CRLF working tree. That property is what makes it
adoptable in an existing system rather than a migration.

Use it for BOTH the generator that writes a pin and the loader that verifies it.
A normalization applied on only one side is worse than none.

**Scope boundary — do not use this for binary artifacts.** Databases, embeddings,
images, and archives have no line endings; ``0x0D`` inside them is data, not a
carriage return, and normalizing it corrupts the identity you are trying to
establish. Raw-bytes hashing is correct for those.

Part of the TLDR-G primitives drop — https://tldr-g.ai
"""

from __future__ import annotations

import hashlib
from pathlib import Path

__all__ = ["normalize_eol", "eol_normalized_sha256", "eol_normalized_sha256_text"]


def normalize_eol(text: str) -> str:
    """CRLF and lone-CR to LF. The one normalization rule, shared.

    Order matters: CRLF is replaced first, so a CRLF does not become a doubled
    newline via the lone-CR pass.
    """
    return text.replace("\r\n", "\n").replace("\r", "\n")


def eol_normalized_sha256_text(text: str) -> str:
    """SHA-256 over EOL-normalized UTF-8 text (for content already in memory)."""
    return hashlib.sha256(normalize_eol(text).encode("utf-8")).hexdigest()


def eol_normalized_sha256(path: str | Path) -> str:
    """SHA-256 over the EOL-normalized UTF-8 content of a text file.

    Platform-independent: identical on an LF checkout and a CRLF working tree.
    Byte-identical to ``sha256(path.read_bytes())`` when the file is already
    pure-LF UTF-8, so it does not invalidate LF-generated pins.
    """
    raw = Path(path).read_bytes()
    return eol_normalized_sha256_text(raw.decode("utf-8"))
