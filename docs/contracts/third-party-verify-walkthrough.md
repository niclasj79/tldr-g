# Third-party verification walkthrough

The procedure half of the verification story: *a third party can verify an
exported trace given the operator's public-key infrastructure.* The tooling is
`tp-vrg-verify` (integrity) + `tp-vrg-identity` / a published did:web document
(identity).

---

## What a counterparty can verify, and how

**You received** a TLDR-G export — a signed render trace (`*.signed.json` from
`GET /trace/{id}/export`) or a signed PortableArtifact (from
`GET /asset/{id}/export?sign=true`). You do NOT need access to the producing
system.

**Step 1 — integrity (offline):**

```
pip install tp-vrg
tp-vrg-verify the-export.signed.json
```

Exit 0 + `Attestation: VALID` proves the payload is byte-identical (under
canonical JSON) to what the holder of the printed `key_id` signed. Tamper with
one character and verification fails. This step requires no network and no trust
in anyone.

**Step 2 — identity (one HTTPS fetch):**

The operator publishes their signing key as a did:web document, served at
`https://<their-domain>/.well-known/did.json`. Fetch it and check:

1. The document's `id` is `did:web:<their-domain>` — identity is anchored to
   domain control, exactly like TLS.
2. The `publicKeyJwk` corresponds to the envelope's `key_id` (the `tp-vrg-verify`
   output prints the key id).

If they match: the export was signed by the operator of that domain.
Certificate-Transparency-family trust — **no blockchain, no token, no ledger**;
the same trust shape as fetching a TLS certificate.

**What this does NOT yet prove (honest boundary):** that the envelope was signed
at the *claimed time*, or that the operator hasn't *withheld* other exports. Both
require transparency-log inclusion proofs (Rekor-style) — a future artifact. Key
rotation: a new key means a new `key_id`; operators MUST keep superseded keys
listed in the did:web document (`verificationMethod` is an array) so old exports
stay verifiable — generation of a new key is logged loudly by the engine for
exactly this reason.

## Operator-side checklist

1. Generate `did.json` for your domain.
2. Serve it at `https://your-domain.example/.well-known/did.json`.
3. Hand counterparties this walkthrough with any signed export.

## Related

[portable-artifact-v1.md](portable-artifact-v1.md) · [render-trace-v1.md](render-trace-v1.md) (the payload contracts).
