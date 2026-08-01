# Prove your open-core boundary holds

One file, ~230 lines, standard library only. It reads a **published** tree and fails the release if anything in it imports something you did not publish.

```bash
python boundary_scan.py path/to/published-tree
# boundary clean: 16 modules, packages=tp_vrg,tools,examples

python boundary_scan.py path/to/published-tree --json   # for CI
```

Exit codes: `0` clean · `1` findings · `2` bad usage.

---

## The failure it prevents

You keep a private repo and publish part of it — an SDK, an open-core subset, a vendored client, a contracts package. Something in the published part imports something that stayed private.

**On your machine it works.** The private code is right there on the path, so it imports fine, the tests pass, and you ship. Every check in your release process runs in a tree where the missing module is present, so nothing can catch it.

The first person to clone the published repo gets `ModuleNotFoundError` on their first command.

That is not a hypothetical. This tool exists because a developer's clean clone of our published repo failed its own test suite on the first `pytest` — two failures, from a single import of a module that was **correctly** not published. The boundary was right; the check that it held did not exist.

## Why an AST scan, and not grep

Because the interesting cases are the ones grep gets wrong:

- **Relative imports.** `from ..gone import x` inside `mypkg/sub/a.py` refers to `mypkg.gone`. You cannot resolve that without knowing where the file sits in the package.
- **`from . import sibling`** binds names, not a module path — each name is a separate module reference.
- **`src/` layouts.** `src/` is a packaging convention, not part of the module path, and treating it as one breaks every resolution.
- **Guarded imports.** An import inside `try:` is a *declared optional dependency*, not a defect — and a grep cannot see the block structure.

## The one deliberate exception

An import inside a `try:` body is allowed:

```python
try:
    from mypkg.extras import enrich       # optional enrichment
except ImportError:
    enrich = None                          # graceful degradation
```

This is the correct way to ship a module that does more when a bigger package is present and still works when it is not. The scanner must not punish it, or you will be pushed toward a worse design to satisfy the tool.

An import in the **`except` handler** is *not* guarded, and the scanner says so — a fallback import runs precisely when things have already gone wrong, so it had better resolve.

## Wiring it into a release

```bash
python boundary_scan.py "$PUBLISH_DIR" || exit 1
```

Run it against the **generated** tree, after the copy, before the publish. Running it against your source repo proves nothing: that is the tree where everything resolves.

Two things it deliberately does not do. It does not check third-party dependencies — those belong to your dependency metadata, not your boundary. And it does not do call-reachability, only import-reachability: a module can ship and still be unreachable at runtime. That is a different (also worthwhile) analysis.

## Self-demonstrating

This scanner is how the repository you are reading it in was verified. Run it on this repo's published tree and it reports clean; reintroduce the historical `kro_temporal` import that caused the original incident and it names the file, the line, and the module.

---

Part of the [TLDR-G](https://tldr-g.ai) primitives drop — small pieces of method extracted from a knowledge-rendering engine, published because they are useful on their own. Apache-2.0.
