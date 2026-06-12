# TP-VRG — Contracts & Verification

TP-VRG is a local-first **knowledge rendering engine**: it turns source material into a graph and renders query-specific, source-grounded context at the right level of detail under a token budget — not a RAG wrapper, not a hosted memory SaaS.

**This repository is the open boundary of TP-VRG — its contracts and its offline verification surface, not the engine itself.** It lets you (a) integrate against the stable boundary contracts and (b) independently verify any artifact the engine produces, without trusting a server. The rendering engine is the commercial product.

![TP-VRG launch architecture](docs/diagrams/launch-architecture-tiny.png)

## What's in here

- **Boundary contracts** — `docs/contracts/` (the artifact + render-trace formats) and `src/tp_vrg/adapters/` (the adapter interface a host integrates against). The two exportable boundary objects are the `PortableArtifact` (a rung-level subgraph export, GDPR Art-20 shaped) and the render trace (the answer + citations "memory you can audit" record).
- **Offline attestation / verify** — `src/tp_vrg/attestation.py` + the `tp-vrg-verify` CLI: Ed25519 detached signatures over those artifacts (same family as Sigstore / Certificate Transparency / eIDAS 2.0 qualified seals — **not** a blockchain, no token, no ledger). Anyone holding an exported artifact can run `tp-vrg-verify <file>` and check tamper-evidence offline.
- **Provenance audit** — `tools/provenance_audit.py`: a stdlib-only tool that checks every cited snippet in a render trace actually exists in the source material — the "no hallucinated citations" proof.

## What's NOT in here

The rendering engine itself — ingestion, scoring, the render selector, the Janitor, partition/bake, mode profiles, and the runnable MCP / HTTP / Cockpit surfaces. Those are the commercial product. This repo is the **integration + verification** surface: build against a stable boundary and prove the engine's outputs are faithful, without the engine source.

## Quickstart (no engine, no API key)

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate   •   macOS/Linux: source .venv/bin/activate
pip install -e .
python examples/quickstart.py
```

`examples/quickstart.py` signs a sample artifact, verifies it offline, then tampers one byte and shows verification fail — the whole trust story in ~20 lines.

## Tests

```bash
pip install -e ".[dev]"
python -m pytest -q
```

## Status

Private, pre-launch candidate — please don't redistribute.
