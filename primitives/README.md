# Primitives

Small pieces of method extracted from building TLDR-G, published because they are useful on their own. No dependency on the engine, on each other, or on anything you would have to install.

Take a file, take a rule, take the whole directory. Apache-2.0.

| Bundle | What it is | Size |
|---|---|---|
| [`content-addressing/`](content-addressing/) | Hash the content, not the checkout. And hash identifiers that survive an algorithm migration. | ~170 lines, zero deps |
| [`open-core-boundary/`](open-core-boundary/) | Prove that everything your published repo imports is actually in your published repo. | ~230 lines, stdlib only |
| [`agent-harness/`](agent-harness/) | The contract you hand a coding agent instead of a prompt, plus four disciplines that fire on observations. | documents |

Each carries the specific incident that produced it. That is deliberate: a rule with a story attached gets followed, and a rule that reads as generic best practice gets skimmed.

- The content hasher exists because a pinned fixture failed 6 times on one machine and 0 times on a fresh clone of the same commit.
- The boundary scanner exists because a developer's clean clone of our published repo failed its own test suite on the first `pytest`.
- The cost gate exists because an "$8–12" estimate hit ~$60 on a 20-instance slice, and was aborted before reaching the ~$900 the full run was heading for.
- The operator-surface section of the task contract exists because we shipped a feature that was fully tested, fully merged, and completely unreachable for six days.

## Running the tests

```bash
pytest primitives/
```

20 tests over the two code bundles. Each is named for the failure it prevents rather than the function it calls.

## Why these and not others

The criteria were: **self-contained** (few or no imports), **useful outside this project**, **no engine internals**, and **small enough to read in one sitting**. Plenty of good code failed the third test — the parts of the engine that make it interesting are exactly the parts that are not general, and shipping them as "primitives" would be neither honest nor useful.

More drops will follow. If one of these is useful, or wrong, we would like to know: **`niclas@tldr-g.ai`**.

---

Part of the [TLDR-G](https://tldr-g.ai) open boundary — see the [repo README](../README.md) for the contracts and the offline verification surface.
