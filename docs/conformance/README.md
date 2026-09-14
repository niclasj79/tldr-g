# Contract conformance kit

Check that an envelope you produce, or receive, has the shape the TLDR-G contracts specify — before you check its signature.

## What it checks

An **Attestation Envelope** and the payload it carries — a **render trace** or a **`PortableArtifact`** — against the JSON Schemas in [`../contracts/schemas/`](../contracts/schemas/) (Draft 2020-12). The prose for every field is in [`../contracts/`](../contracts/).

This is the *shape* check. Cryptographic *validity* — the payload hash, the key-id binding, the Ed25519 signature — is the verifier's job: `tp-vrg-verify` or [`verify.html`](../../verify.html). An envelope can conform and still fail verification; a conformance pass says the object is well-formed, not that it is authentic.

## Run it

From the repository root:

```bash
python docs/conformance/conformance.py
```

That runs the fixture suite and exits 0 only if every valid fixture conforms and every invalid fixture is rejected. To check your own file:

```bash
python docs/conformance/conformance.py validate path/to/envelope.json
```

To force the dependency-free backend:

```bash
python docs/conformance/conformance.py --stdlib
```

## Two backends, one verdict

With `jsonschema` installed, the runner uses it as the reference validator. Without it, a small standard-library validator covers the same rules the schemas use (required, const, enum, type, pattern, array items, if/then), so there is nothing to install to run the check. `test_conformance.py` proves the two reach the same verdict on every fixture.

## The fixtures

- `fixtures/valid/` — envelopes that must conform, one per payload type and rung.
- `fixtures/invalid/` — envelopes that must be rejected. Each breaks exactly one rule; `fixtures/invalid/manifest.json` says which.

Keys and signatures in the fixtures are placeholders, and the signer `did:web:conformance.example` sits under a reserved domain that cannot be registered. These files are shapes, not receipts.

## Compatibility

The v1 schemas are additive-stable. They allow additional properties, so a consumer must ignore fields it does not know, and a producer must not change the meaning of an existing field within v1. New fields arrive as additions; a breaking change arrives as a new version (`render-trace-v2`) beside v1, never underneath it. The rule and the bump table are in [`../../CHANGELOG.md`](../../CHANGELOG.md).

If a field is ambiguous when you build against it, that is a defect in the contract, not in your integration: open an issue, or write to `niclas@tldr-g.ai`.
