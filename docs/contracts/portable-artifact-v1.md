# Contract: PortableArtifact v1 (+ Attestation Envelope v1)

**Version 1.** Documented from the reference implementation
(`extract_source` / `extract_asset` / `import_portable_artifact` and
`tp_vrg.attestation.sign_envelope` / `verify_envelope`).

---

## §1 — What this contract is

The **PortableArtifact** is the engine's rung-level subgraph export: a JSON
object carrying everything derived *only* from one membership unit (a source, or
an Asset) as full content, with knowledge shared beyond that unit reduced to
**privacy-preserving stubs** (label-only typed references — never the full
content of shared knowledge). It is simultaneously:

- the GDPR **Art-20 data-portability** format (the non-destructive dual of
  Art-17 erasure — both are the same derived-only-vs-shared closure computation
  with opposite terminal halves),
- the **migration shard** for moving graph regions between engine instances
  (delete / extract / move / federate),
- the payload class of the **signed federation artifact** (wrapped in the
  Attestation Envelope, §4).

A conforming consumer can verify, inspect, and import an artifact without access
to the producing graph.

## §2 — PortableArtifact envelope (rung-dispatched)

Common fields, both rungs:

| Field | Type | Semantics |
|---|---|---|
| `artifact_version` | int, `1` | Reject anything else. |
| `rung` | `"source"` \| `"asset"` | Membership unit. Island/Continent rungs are future versions (unions of member-asset closures). |
| `derived_only_nodes` | list | Full-content nodes derived ONLY from this unit's passages: `{entity_id, name, category, lod_0, lod_1, lod_2, embedding?}`. |
| `passages` | list | The unit's passages verbatim: `{passage_id, raw_text, source_id, source_label, entity_ids, ingested_at, embedding?}` (asset rung adds `temporal_min`, `temporal_max`, `asset_id`). |
| `internal_edges` | list | `{source, target, relation}` — both endpoints in `derived_only_nodes`. |
| `boundary_stubs` | list | `{entity_id, stub: true, lod_2, points_to: {shard, node_id}}` — **label-only**; the privacy property: `lod_0`/`lod_1` of shared knowledge NEVER travels. |
| `boundary_edges` | list | `{source, target, relation, crosses_to_stub}` — exactly one endpoint inside the extract. |

`rung: "source"` adds `source_id`. `rung: "asset"` adds:

| Field | Semantics |
|---|---|
| `asset_id` + `asset` | The **Authorial record** (`asset_id, lineage_id, edition_seq, source_label, source_hash, provenance_source_id, title, byte_size, declared_by, declared_at, …`) — the asset travels as a first-class authorial unit. |
| `asset_entities` | The asset's entity map (`entity_id, mention_count, section_position`); every row resolves inside the artifact. |
| `edge_provenance` | Asset-scoped edge evidence (`source, target, relation, evidence_passage_id, confidence`). |
| `evidenced_shared_edges` | Stub↔stub edges carried solely so their `edge_provenance` rows stay importable. |
| `asset_entity_rows_dropped` / `edge_provenance_rows_dropped` | Honest counts of rows not representable in the artifact. |

## §3 — Import semantics (the receiving side)

- **Idempotent**: re-importing the same artifact creates no duplicates (UPSERT throughout).
- **Stub no-overwrite**: a label-only stub NEVER downgrades a full node the destination already has.
- **Stub materialization**: missing shared nodes land as `category: "extraction_stub"` with empty `lod_0`/`lod_1` — the privacy property persists across the round-trip.
- **Closure locality**: derived-only-vs-shared is computed against the DESTINATION's knowledge on re-export.
- **Fail-loud validation**: unsupported version/rung, missing Authorial record (asset rung), envelope/record ID mismatch → error, never partial-silent import.

## §4 — Attestation Envelope v1 (the signed form)

Any PortableArtifact (or render trace) may travel wrapped in a detached-signature
envelope — Sigstore / Certificate-Transparency family; **explicitly NOT a
blockchain** (no token, no distributed ledger):

```json
{
  "attestation_version": 1,
  "payload_type": "portable_artifact" | "render_trace",
  "payload": { ... },
  "payload_hash": "sha256:<hex of canonical-JSON payload>",
  "signed_at": "<ISO-8601 UTC>",
  "signed_by": "<did:web:... or operator label>",
  "key_id": "ed25519:<fingerprint16>",
  "public_key": "<base64 raw Ed25519 key>",
  "signature": "<base64 Ed25519 over the protected header>"
}
```

- **Canonicalization:** key-sorted, compact-separator, UTF-8 JSON; non-finite numbers rejected.
- **Signature scope:** the protected header (all fields except `payload` + `signature`); the payload is bound via `payload_hash`.
- **Verification:** offline, self-contained for INTEGRITY (tamper-evidence on payload, header, and signature). IDENTITY trust additionally requires resolving the signer's **did:web** document and matching `key_id` — the envelope does not claim to prove who signed by itself.
- **Reference verifier:** `tp-vrg-verify <file>` (exit 0 valid / 1 invalid / 2 unusable).

## §5 — Producing surfaces (reference implementation)

| Surface | Operation |
|---|---|
| `GET /source/{id}/export?sign=true` · `GET /asset/{id}/export?sign=true` | Signed PortableArtifact |
| `GET /trace/{answer_id}/export` | Signed render trace (signed by default) |
| `GET /attestation/identity?domain=…` | did:web identity document (serve at `/.well-known/did.json`) |
| MCP `tp_vrg_extract_source` / `tp_vrg_extract_asset` (`sign=True`) · `tp_vrg_export_trace` | Same, agent-facing |

## §6 — Compatibility commitment

v1 fields are additive-stable — consumers MUST ignore unknown fields; producers
MUST NOT change the meaning of existing fields within
`artifact_version` / `attestation_version` 1. Rung extensions (island/continent)
and transparency-log inclusion proofs arrive as new fields or new versions,
never as silent mutations.
