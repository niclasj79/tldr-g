# The TLDR-G Edge Ontology

**A measured domain-general edge ontology, the ruler that measured it, and the open format to extend it.**

Most relation ontologies *assert* generality. This one *measured* it: **~94–97% of the relations a frontier-grade reader proposes across 12 text registers** (financial, legal statute, clinical, telecom, scientific, news, code, multilingual, and more — including real GDPR statute at 100% and formal 3GPP specs at 100%) resolve to one of its **84 canonical relation families**. The number, the method, and the honest floors are in [coverage-report.md](coverage-report.md).

## What's in this bundle

| File | What it is |
|---|---|
| [`edge-ontology-reference.md`](edge-ontology-reference.md) | The human reference — all 84 families by axis, with directional glosses, tiers, σ-classes, and inverses. |
| [`edge-ontology.json`](edge-ontology.json) | The machine export — every family's gloss + type hints + tier + σ-class, plus the ~300-entry observed-string → family normalization map. Language-neutral; load it from anything. |
| [`packs/`](packs/) | The open extension format: domain relation packs as plain JSON (`telecom.json`, `legal.json` bundled). Extend the vocabulary for your domain **by adding a file, not by retraining or forking the core.** |
| [`closure-test/`](closure-test/) | The ruler — the vocabulary-closure test that produced the coverage numbers. Run it on **your own corpus** to measure how much of your domain the core already covers, and to derive your pack's candidate families from the gap residue. |
| [`coverage-report.md`](coverage-report.md) | The measurement: 12-register coverage table, method, threshold calibration, and the honest caveats. |

## The design in one paragraph

Every edge stores its relation as a **canonical family** from a closed, corpus-harvested vocabulary, with the original free string preserved as an open-world `subtype`. Each family carries a directional gloss (head → tail), a **tier** (`structural` / `semantic` / `temporal`), and a **σ-class** (`factual` / `episodic` / `authorial` / `causal` / `temporal`) — the render/bundle class downstream algebra consumes. Free strings resolve to families via an exact-string map (~300 entries) backed by an embedding-nearest-gloss resolver; what resolves nowhere is a measured **gap**, and gaps are how the vocabulary grows: cluster the residue, gloss the clusters, ship them as a pack.

## Why the trio matters

1. **A measured generality number** — not a claim; reproduce it with the closure test.
2. **The ruler ships with the ontology** — anyone can validate the vocabulary on their own corpus and get their own number.
3. **Extension without retraining** — knowledge updated by extending a shared explicit structure, with provenance and domains of validity, rather than by retraining a model. Packs are additive JSON; the core never forks.

For the knowledge-management / taxonomy audience: the families are explicit, addressable, and provenanced; σ-classes and tiers are facets in the Ranganathan sense, and a SKOS/PROV-O export is a natural rendering of the same structure (the JSON export carries everything such an export needs).

## License & provenance

Released as an open data artifact of the [TLDR-G](https://tldr-g.ai) project under the repository license. The vocabulary is **corpus-driven** — harvested from observed edges across diverse registers, never designed to fit an evaluation. Coverage numbers carry their result files; see the report.
