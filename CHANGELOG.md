# Changelog

All notable changes to the TLDR-G open boundary — the contract formats, the
verification surface, and the adapter interface.

## Versioning — what the number on this repo means

**This version tracks the contract surface, not the engine binary.**

The engine ships as a free local app on its own version line (v0.1.x today). This
repository ships the *boundary*: the artifact formats, the offline verification
behaviour, and the interface an integration is written against. They change for
different reasons and at different rates — a Cockpit UI release should not bump
the number your integration pins, and a change to a signed artifact's shape
matters to you even if the app looks identical.

So they are versioned separately, and the two numbers are not expected to match.

What a bump means here:

| Change | Bump |
|---|---|
| A payload format gains an **optional** field; a new tool or adapter is added | **minor** |
| Verification behaviour, canonicalization, or a **required** field changes | **major** |
| Documentation, examples, tests, or wording | **patch** |

**The stability promise.** Within a major version, an artifact that verifies today
verifies tomorrow. We will not change canonicalization, the signature construction,
or the meaning of a verdict in a minor release — those are the things you would
have to re-run to trust again, and re-verification is exactly what this repo exists
to make cheap. Formats carry their own version string (`render-trace-v1`,
`portable-artifact-v1`) so a future v2 can arrive alongside v1 rather than
underneath it.

**What is not covered.** The engine's internals are not part of this contract and
are not open. Rendering quality, scoring, and retrieval behaviour can change freely
between engine releases; none of that changes whether an artifact verifies.

---

## [0.4.0] — 2026-07-26

The theme: **you should not have to install anything to check a receipt.**

### Added

- **`verify.html` — a zero-install, offline receipt verifier.** One self-contained
  file. Open it in any browser, drop in a receipt, get a verdict. No Python, no
  install, no network — there is no server to upload to, and the page works from a
  `file://` URL with no connection at all. This closes the gap that mattered most:
  verification was real but only reachable through a CLI, which for a lawyer,
  auditor, or procurement reviewer meant it was not reachable at all. A property
  you cannot exercise reads as a promise.

  It performs the same three checks as the `tp-vrg-verify` CLI — payload hash,
  key-id binding, Ed25519 signature over the protected header — and states plainly
  what a valid verdict does *not* prove (that it does not establish *who* the
  signer is, and makes no claim about whether the content is true).

- **`docs/MCP-QUICKSTART.md`** — wiring `tp-vrg-mcp` into Claude Desktop, Cursor,
  or any MCP client, with the full tool list, guidance on `token_budget` as the
  real control surface, and an honest statement of the current trust posture
  around destructive tools.

- **`primitives/` — the first method drop**, delivering the README's standing promise
  to publish design notes, standalone primitives, and a starter-kit of the
  development harness. Three bundles, each carrying the incident that produced it:

  - **`content-addressing/`** — `content_identity.py` (hash the content, not the
    checkout: EOL normalization so a pin does not depend on whether git handed you
    CRLF) and `digests.py` (algorithm-qualified `sha256:<hex>` identifiers, so a
    future hash migration is a new prefix rather than a retrofit of every consumer).
    ~170 lines, zero dependencies.
  - **`open-core-boundary/`** — `boundary_scan.py`, an AST scanner that reads a
    *published* tree and fails the release if anything in it imports a module that
    was not published. Self-demonstrating: it is the check that this repository
    passes. ~230 lines, standard library only.
  - **`agent-harness/`** — the task-contract template used to delegate work to
    coding agents, plus four reactive disciplines (search-before-invent, cost gate,
    known-technique check, method extraction). The load-bearing idea is that every
    acceptance clause must be *demonstrable from the agent's own output*, not merely
    true.

  20 tests over the two code bundles, each named for the failure it prevents.

- **This changelog**, and the versioning rule above.

### Notes

- The verifier is held to the Python implementation by a **differential test**
  that signs a spread of envelopes with the real signer and requires identical
  verdicts from the browser code running under Node. The fixtures exist because a
  naive re-implementation gets them wrong: `1.0` must not collapse to `1`, Python
  writes `1e-07` where JavaScript writes `1e-7`, `-0.0` must survive, large
  integers exceed what a JavaScript number holds, and object keys sort by Unicode
  code point rather than UTF-16 code unit — so a key beginning with an emoji sorts
  differently in the two languages. Any one of those would report a genuine
  receipt as tampered, which is the worst failure this artifact could have.

  The verifier avoids the whole class by never re-serializing parsed numbers: it
  preserves each number's original literal text and re-emits it verbatim.

- Both the Web Crypto path and the pure-JavaScript fallback (for browsers without
  Ed25519 in `crypto.subtle`) are covered by that test, so a verdict does not
  depend on the recipient's browser version.

### Changed

- `version` moved from `0.3.0` to `0.4.0` under the rule above. The previous
  number tracked nothing in particular; it is now defined.

---

## [0.3.0] and earlier

Released before this changelog existed. The boundary at that point comprised:

- **Contracts** — `docs/contracts/portable-artifact-v1.md` (rung-level subgraph
  export, GDPR Art-20 shaped), `docs/contracts/render-trace-v1.md` (the answer +
  citations receipt), and `docs/contracts/third-party-verify-walkthrough.md`.
- **Verification** — `src/tp_vrg/attestation.py` (Ed25519 detached signatures over
  canonical JSON) and the `tp-vrg-verify` CLI.
- **Provenance audit** — `tools/provenance_audit.py`, a stdlib-only check that
  every cited snippet in a render trace exists in the source.
- **Adapter contracts** — `src/tp_vrg/adapters/`.
- **Edge ontology** — `ontology/` with the telecom and legal packs, the vocabulary
  closure test, and its coverage reports.
- **`examples/quickstart.py`** — sign, verify, tamper, in about twenty lines.

For history before this file, see the repository's commit log.
