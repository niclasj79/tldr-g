# Content addressing, done so it survives contact with reality

Two small files. Both exist because of a specific afternoon lost to a specific bug.

- **`content_identity.py`** (~60 lines, stdlib only) — hash the *content*, not the checkout.
- **`digests.py`** (~110 lines, **zero imports**) — hash identifiers that survive an algorithm migration.

No dependencies. Copy them into your project, or read them and steal the rules.

---

## 1. Your content-addressed pin is hashing your checkout

You pin a test fixture, a golden file, or a cache key by `sha256(path.read_bytes())`. It works. Then a colleague clones the repo on Windows and the same file hashes differently — because git handed them CRLF line endings while your working tree has LF. A `.gitattributes` with `eol=lf` helps, but it is not honored everywhere and not by every tool.

The result is a pin that passes on one machine and fails on another, for a reason that has nothing to do with the content. Ours cost **6 failures on one developer's box and 0 on a fresh clone of the same commit** before anyone thought to look at line endings.

```python
from content_identity import eol_normalized_sha256

digest = eol_normalized_sha256("fixtures/gold.jsonl")   # same on every platform
```

**The property that makes this adoptable:** for a file that is already pure-LF UTF-8, the result is *byte-identical* to the raw-bytes hash. Switching an existing pin to this function does not invalidate values generated on an LF checkout — it only makes them robust. You can adopt it without a migration.

Use it on **both** sides — the generator that writes the pin and the loader that verifies it. A normalization applied on one side only is worse than none, because now the two disagree by design.

**Do not use it on binary artifacts.** Databases, embeddings, images, archives: `0x0D` in those is data, not a carriage return, and normalizing it corrupts the identity you were trying to establish. Raw bytes are correct there. This boundary is the entire subtlety of the file.

---

## 2. A bare hash does not say what made it

`a94f2b…` is not self-describing. The day you add a second algorithm, the same content produces two different strings, a comparison returns "not equal", and your system concludes the content **changed** when it did not. Nothing in the stored value can tell you which algorithm you are holding.

Git is living through exactly this (SHA-1 → SHA-256) and is the cautionary prior art: retrofitting an identifier format after it is embedded in millions of artifacts is vastly harder than choosing a self-describing one on day one. The qualified form costs seven bytes.

```python
from digests import qualify, normalize, digests_equal

stored = qualify(hexdigest)          # "sha256:a94f2b…" — written to new artifacts
bare   = normalize(stored)           # accepts BOTH forms — used by every reader
digests_equal(legacy_value, stored)  # never compare digests with ==
```

### The four rules

1. **Forward-only.** Never rewrite existing artifacts; pinned hashes stay pinned. Only *new* writes emit the qualified form. A migration that requires touching old data is a migration that does not happen.
2. **Readers normalize.** Every reader accepts both forms, so legacy and qualified coexist indefinitely and you are never forced into a flag day.
3. **Comparisons never use `==`.** Go through `digests_equal`, or a value differing only in qualification reads as a mismatch.
4. **Fail loud on an unknown algorithm.** A future `sha3:…` value must **raise**, not compare unequal as an opaque string.

Rule 4 is the one worth internalising: **a wrong verdict is worse than a crash.** A crash gets fixed within the hour. A false "content changed" gets *believed* — and in a system whose job is proving integrity, a false tamper verdict is the worst output it can produce.

### Where to put the boundary

Qualify at **serialization**, normalize at **parse**. The artifact is the boundary. In-memory fields and database columns can stay bare, which keeps `CHECK` constraints and fixed-width indexes intact. Do not scatter qualification through your internals — you will spend the rest of the project wondering which form a given variable holds.

---

## Tests

`pytest primitives/` — 20 tests covering both files. Each names the failure it prevents rather than the function it calls, including the CRLF/LF equivalence, the LF-identical adoption property, replacement ordering (CRLF must be handled before lone CR, or a `\r\n` becomes two newlines), and the unknown-algorithm raise.

---

Part of the [TLDR-G](https://tldr-g.ai) primitives drop — small pieces of method extracted from a knowledge-rendering engine, published because they are useful on their own. Apache-2.0.
