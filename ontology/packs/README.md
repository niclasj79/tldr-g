# Domain Relation Packs

**Open, forkable extensions to the TLDR-G edge vocabulary.** The core is a *lean, domain-general* set of 84 relation families ([../edge-ontology-reference.md](../edge-ontology-reference.md)), measured **~94–97% domain-general** across 12 registers ([../coverage-report.md](../coverage-report.md)). Domain-*specific* relations do **not** grow that core — they live here, as open JSON packs any domain owner can fork.

## What a pack is

A single JSON file, `packs/<name>.json`, declaring extra relation families in the **same shape as the core** — so authoring one needs zero engine code:

```json
{
  "pack": "telecom",
  "version": 1,
  "extends": "core",
  "families": {
    "hands_over": {
      "description": "a network node hands over a session or user to another node or cell",
      "head_types": ["organization", "product"],
      "tail_types": ["organization", "product", "concept"],
      "tier": "semantic",
      "sigma_family": "episodic"
    }
  }
}
```

Field rules:
- `description` — a directional **head → tail** gloss. Extraction and the embedding-nearest resolver condition on this text, so make it concrete.
- `tier` ∈ `structural | semantic | temporal`.
- `sigma_family` ∈ `factual | episodic | authorial | causal | temporal` (the render/bundle classes).
- `head_types` / `tail_types` — optional hints (not enforced in v1).
- Packs are **additive** — a family whose name collides with a core family is ignored (the core wins). You extend, you don't override.

## Authoring your own (the closure-test loop)

1. Run the closure test ([../closure-test/vocab_closure.py](../closure-test/vocab_closure.py)) over **your** corpus, mapping against the core. The **covered %** is how general the core already is for you (usually 90%+).
2. The **gap residue** (relations with no nearest core family) clusters into your candidate pack families.
3. Name + gloss them as `packs/<yourdomain>.json`; re-run the closure test with `--pack packs/<yourdomain>.json` → coverage approaches ~100%.
4. Ship it — or open a PR to add it here as an example for others.

## Bundled packs

- **`telecom.json`** — 3GPP/RAN deployment, handover, bearer/slice configuration, spectrum allocation, interfaces. Seeded from the closure test's telecom gap residue.
- **`legal.json`** — statutory obligation/prohibition/right/penalty/supersession. Seeded from the real-GDPR register's gap residue.
