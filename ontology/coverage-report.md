# Coverage report — how domain-general is the 84-family core?

**Question:** if a frontier-grade LLM reads text from many different registers and proposes relations *in its own words* (not constrained to any list), what fraction of those relations does the 84-family core vocabulary already express?

**Answer:** **~94–97% of distinct proposed relations, ~97–99% edge-weighted**, across 12 registers — with the floors named honestly below.

## Method (two phases; script in [`closure-test/`](closure-test/))

1. **Extract** — a frontier reader (Qwen-72B via vLLM, temperature 0) reads each corpus and proposes `[head, relation, tail]` triples with the relation phrased in its **own idiom** — deliberately *not* restricted to the vocabulary. This makes the test adversarial to the vocabulary: coverage is only earned if the families genuinely express what the reader finds.
2. **Map** — every distinct proposed relation and all 84 family glosses are embedded (BGE, 1024-dim); each relation maps to its nearest family by cosine. A relation counts **covered** if its best similarity clears the threshold.

**Threshold calibration:** the threshold (0.541) is the 5th percentile of similarities between the ~300 *known-good* string→family mappings and their true family's gloss — i.e., it is set so ~95% of mappings we know to be correct would pass. It is not tuned against the test corpora.

## Results by register

Three runs, same threshold (result files: `2026-07-13-vocab-closure-coverage-6domain.json`, `-vocab-closure-coverage-11domain.json`, `-3gpp-coverage.json`; distinct-relation coverage / edge-weighted coverage):

| Register | Distinct coverage | Edge-weighted | Distinct relations |
|---|---|---|---|
| legal statute (real GDPR text) | **99.6%** | 100% | 454 |
| synthetic | 100% | 100% | 47 |
| formal telecom specs (3GPP) | **100%** | 100% | 102 |
| scientific | 98.6% | 99.5% | 948 |
| regulatory | 98.0% | 99.5% | 453 |
| technical | 97.7% | 99.0% | 8,344 |
| financial | 96.7% | 99.1% | 2,778 |
| telecom (mixed) | 96.5% | 99.3% | 1,164 |
| code | 95.9% | 99.8% | 390 |
| clinical | 95.0% | 99.3% | 1,289 |
| multilingual | 90.9% | 97.7% | 3,771 |
| news | **86.9%** | 97.1% | 3,519 |
| **11-domain aggregate** | **93.9%** | **97.0%** | 19,947 |
| 6-domain run (first pass) | 97.2% | 98.6% | 12,289 |

## The honest caveats

- **News is the floor (86.9% distinct).** Narrative journalism produces the widest relational idiom; even so, edge-weighted coverage stays at 97.1% — the misses are overwhelmingly rare phrasings, not frequent relation types.
- **Frontier-reader idiom inflates the distinct-relation denominator.** The reader phrases the *same* underlying relation many ways ("feeds its results into", "routes output to", …). Distinct-relation coverage therefore *understates* practical coverage; edge-weighted is the operationally honest number, and distinct is reported anyway as the stricter one.
- **The exact-string normalizer alone is much weaker than these numbers.** Of relations the shipped ~300-entry string map couldn't resolve, the embedding-nearest step reclaimed ~94–95% (18,519 of 19,729 in the 11-domain run) — the coverage claim belongs to *ontology + embedding resolver*, not to the string map.
- **Gap residue is the extension queue, not noise.** The uncovered tail clusters into a small number of multi-member candidate families per domain; the bundled `telecom` and `legal` packs were seeded exactly this way.
- **The vocabulary was harvested from observed corpora, then tested on registers including ones it never saw** (real statute, 3GPP) — but it was not derived independently of all test registers; treat the 12-register table as a strong generality signal, not a held-out-benchmark claim.

## Reproduce it on your corpus

```bash
# phase 1 — any OpenAI-compatible endpoint (vLLM shown); one subdir per register under corpus/
python closure-test/vocab_closure.py extract --corpus-root corpus/ --host http://127.0.0.1:8000 --model qwen72b --out edges.json
# phase 2 — embeds glosses + proposed relations, maps, buckets, clusters the gaps
python closure-test/vocab_closure.py map --edges edges.json --out coverage.json
```

Your `coverage.json` gives you the same table for your corpus — and the `extension_candidates` block is your candidate domain pack.
