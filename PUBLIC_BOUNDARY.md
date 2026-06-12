# Public Boundary

This is a private candidate for the launch repo, built from an allowlist (not
from git history). Per founder direction 2026-06-11, it ships the **open
boundary — contracts + verification — NOT the rendering engine**.

## Included For Launch

- `src/tp_vrg/adapters/` — boundary adapter contracts + registry (the integration interface a host implements).
- `src/tp_vrg/attestation.py` — Ed25519 signed-artifact attestation + offline integrity verification.
- `src/tp_vrg/provenance_storage.py` — the user-facing provenance/audit store (sqlite3, stdlib).
- `src/tp_vrg/data_dir.py` — the minimal path helper attestation needs.
- `src/tp_vrg/__init__.py` — minimal package init (overlay-provided; does NOT import the engine).
- `tools/provenance_audit.py` — stdlib-only citation/provenance verifier.
- `docs/contracts/` — the artifact + render-trace + third-party-verify specs.
- `examples/quickstart.py` — sign → verify → tamper-fails, no engine, no key.

## Excluded By Construction

- **The rendering engine** — ingestion, scoring, retrieval, the render selector, the Janitor, partition/bake, manifolds, mode profiles, storage internals: the commercial core.
- **The runnable MCP / HTTP / Cockpit surfaces** — they import the engine.
- Agent-workflow directories, memory files, founder ledgers, strategy briefs, internal research/council/GTM/IP material.
- `research/`, private benchmark result dumps, private corpora, diagnostic scratch files.
- Worktree history and original repository commit history.

## Resolved (was "Must Decide Before Publishing")

The full-engine-open question is **resolved + RATIFIED 2026-06-11: NOT open at
this stage** (founder — "src/tp_vrg surely isn't supposed to launch as complete
open core at this stage — just the contracts and interactive surfaces"). License
ratified **Apache-2.0**.

The public rule: a stranger can **integrate against the contracts and
independently verify any TP-VRG artifact offline, without proprietary
services** — they do not receive the engine that produces those artifacts.

This is the gate-G1 surface. Whether to additionally ship a thin, engine-free
**MCP interface stub** (so agent builders can wire the tool contract without the
engine) is an open follow-on decision, not part of this candidate.
