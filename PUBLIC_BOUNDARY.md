# Public Boundary

This is a private candidate for the launch repo. It is intentionally built from an allowlist, not from the original git history.

## Included For Launch

- `src/tp_vrg/`: runnable local engine candidate.
- `tests/`: small public smoke/contract subset.
- `tools/provenance_audit.py`: proof-pack audit harness.
- `examples/quickstart.py`: no-key local quickstart using mock providers.
- `docs/diagrams/launch-architecture-tiny.png`: README architecture sketch.

## Excluded By Construction

- `.claude/`, `.agents/`, memory files, founder ledgers, strategy briefs, internal research/council material.
- `research/`, private benchmark result dumps, private corpora, diagnostic scratch files.
- GTM, IP, investor, and internal operating documents.
- Worktree history and original repository commit history.

## Must Decide Before Publishing

This candidate currently includes the full package source for smoke-test continuity. Before public release, either ratify these as open or split them behind an internal package boundary:

- advanced Janitor/pre-render modules,
- federation adapter placeholders and production federation-adjacent surfaces,
- mode profile/tuning defaults that are meant to remain commercial,
- Cockpit UI surfaces that are not part of the launch promise.

The public rule should be: a stranger can install, ingest, render, inspect, and verify without proprietary services.
