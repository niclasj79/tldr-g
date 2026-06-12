# Contract: RenderTrace v1 (+ signed form)

**Version 1.** Documented from the reference implementation
(`tp_vrg.attestation.build_render_trace`). The signed envelope is specified in
[portable-artifact-v1.md](portable-artifact-v1.md) §4.

---

## §1 — What this contract is

The **RenderTrace** is the auditable record of ONE rendered answer: the
question, the answering model, when it was answered, and the citation chain back
to source segments. It is the "memory you can audit" surface in exportable form.
A third party holding a signed trace can verify offline that it is exactly what
the operator's key signed.

## §2 — Shape

```json
{
  "trace_version": 1,
  "answer_id": "<id>",
  "query_text": "<the question as asked>",
  "answered_at": "<ISO-8601>",
  "model_label": "<answering model label>",
  "provenance_coverage": "full" | "partial" | "none",
  "citations": [
    {
      "cite_order": 1,
      "segment_id": "<source segment id>",
      "source_label": "<human-readable source>",
      "source_uri": "<uri or null>",
      "text": "<the cited segment text or null>",
      "evidence_snippet": "<extracted evidence or null>"
    }
  ]
}
```

- `provenance_coverage` classifies how much of the citation chain resolves to
  known source segments (`none` covers both zero citations and fully orphaned
  content — honest degradation, never fabricated coverage).
- Consumers MUST ignore unknown fields; producers MUST NOT change field meanings
  within `trace_version` 1 (same compatibility commitment as
  [portable-artifact-v1.md](portable-artifact-v1.md) §6).

## §3 — Producing + verifying surfaces

| Surface | Operation |
|---|---|
| `GET /trace/{answer_id}/export` | Signed by default (`sign=false` for the raw trace) |
| MCP `tp_vrg_export_trace` | Same, agent-facing |
| `tp-vrg-verify <file>` | Offline third-party integrity verification |
| `GET /attestation/identity?domain=…` | did:web document binding `key_id` to an operator identity |
