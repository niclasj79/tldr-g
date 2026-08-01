# The TLDR-G Edge Ontology — Canonical Relation Vocabulary (human reference)

**Status:** 📖 **REFERENCE — the for-humans view of the closed relation vocabulary.** The machine SSOT is [`edge-ontology.json`](edge-ontology.json) in this bundle; this doc is the human-readable rendering of it. When they disagree, the machine export wins and this doc is corrected.
**Companion (the measurement):** [coverage-report.md](coverage-report.md) — the 12-register domain-generality result + the closure-test method.
**Companion (the extension format):** [`packs/`](packs/) — extend the vocabulary for your domain by adding a JSON file, not by forking the core.

---

## What this is

TLDR-G stores every edge's relation as a **canonical family** drawn from a **closed vocabulary** (this doc), plus the original free string preserved as an open-world `subtype`. The families are the *label space* the whole typed-substrate design is built on:

- **Typed extraction emits *into* these families.** "Typed vs. generic" is undefined without this vocabulary.
- **Distribution-health metrics are computed against this alphabet.** A thin vocabulary cannot express a healthy relation distribution — collapse to a handful of generic labels is a measurable failure mode.
- **It is a federation interop floor** — typed-edge bridging across graphs requires shared canonical types.
- **It is the vocabulary gate** in governed augmentation: an LLM may *propose* an edge freely, but the relation must resolve to a family (or be dropped) before it enters the trusted graph.

**Honesty guardrail:** the families are **corpus-driven** — harvested from observed edges, never designed to make topology "win." Designing families to rig the ruler is forbidden; the ruler is what the moat is measured against.

## How to read a family

Every family carries two orthogonal classifications:

**1. Tier** — what *kind* of edge it is:
- **structural** — engine topology (part/whole, is-a, document/session flow). Not a semantic claim; exempt from the truth gate.
- **semantic** — a factual/relational assertion about the world. The gate-bearing majority.
- **temporal** — time-ordering and sequence.

**2. σ-class (sigma_family)** — the render/bundle-algebra class the edge diffuses under. Five values: **factual · episodic · authorial · causal · temporal**. This is what σ-fingerprints, edge-bundle algebra, and typed centrality consume. (Structural edges still carry a σ-class for bundling but represent topology, not claims.)

Directionality: every gloss is written **head → tail** (the head performs/holds the relation toward the tail). Inverses are listed where both directions are canonical families.

---

## The families (84)

### S · Structural tier — topology, not semantic claims
_tier = structural. These are the graph's skeleton; the truth gate is exempt for them (`is_gate_exempt`)._

| Family | Gloss (head → tail) | σ | Inverse / note |
|---|---|---|---|
| `part_of` | something is a part or component of a larger whole | factual | ↔ `has_part` |
| `has_part` | a whole contains a part or component | factual | ↔ `part_of` |
| `contains` | a whole contains or includes a part, member, or component | factual | broader than `has_part` (allows person members) |
| `is_a` | something is a kind, class, or subtype of a broader concept | factual | taxonomy |
| `instance_of` | something is an instance or type of a more general category | factual | taxonomy |
| `made_of` | a thing is made of a material, component, or substance | factual | |
| `form_of` | a word, object, or concept is a form or variant of another | factual | |
| `has_attribute` | an entity has an attribute or descriptive property | factual | |
| `has_property` | an entity has a property, trait, or quality | factual | near-synonym of `has_attribute` |

**Also structural (engine flow tokens, not part of the semantic vocabulary):** the `_`-prefixed document/session-flow tokens — `_follows`, `_precedes`, `_co_doc`, `_mentioned_before`, `_session_follows`, `_session_precedes`, `_covers_period`. These are the Reading-Order Fiber / authorial-axis skeleton; enforced by `frozenset` membership, orthogonal to the semantic families here.

### A · Creation, authorship & publication (σ = authorial)

| Family | Gloss (head → tail) | σ | Inverse / note |
|---|---|---|---|
| `created` | a person or org created a work, product, or concept | authorial | ↔ `created_by` |
| `created_by` | a work, product, or concept was created by a person or org | authorial | ↔ `created` |
| `founded` | a person or org founded an organization or institution | authorial | ↔ `founded_by` |
| `founded_by` | an organization was founded by a person | authorial | ↔ `founded` |
| `authored` | a person authored or wrote a document, book, or work | authorial | |
| `developed` | a person or org developed a product or technology | authorial | |
| `publishes` | an agent publishes, releases, ships, or launches a work or version | authorial | |
| `signed` | a person or org signed or enacted a law, agreement, or document | authorial | |
| `derived_from` | a concept, product, or work is derived from another source | authorial | |

### B · Communication, description & reference (σ = authorial)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `describes` | a work or person describes, represents, shows, or illustrates a thing | authorial | |
| `asserts` | an agent claims, reports, proposes, recommends, or discusses something | authorial | the stance/claim family |
| `references` | a work references, cites, mentions, or links to another work or entity | authorial | the provenance/citation family |
| `defined_as` | a term, entity, or concept is defined as another concept or description | authorial | |

### C · Possession, membership & commerce (σ = factual; `acquired`/`transacts` = episodic)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `has` | an entity has, holds, possesses, or receives a thing | factual | broad possession |
| `owns` | a person or org owns an asset, product, or organization | factual | ownership proper |
| `acquired` | an organization acquired or bought another organization | episodic | |
| `transacts` | an agent buys, sells, pays for, or funds a thing | episodic | |
| `member_of` | a person or org is a member of a group or organization | factual | |
| `subsidiary_of` | an organization is a subsidiary or division of another | factual | |
| `partnered_with` | an organization partnered or collaborated with another | episodic→factual | symmetric |
| `combines_with` | things are combined, merged, or integrated into a whole | factual | symmetric |

### D · Usage, dependency & enablement (σ = factual / causal)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `uses` | an agent or system uses, applies, or consumes a tool, method, or resource | factual | |
| `used_for` | an entity, product, or concept is used for a purpose or activity | factual | |
| `requires` | an action, event, or concept requires another condition or resource | causal | |
| `has_prerequisite` | an event, concept, or action requires another condition before it | causal | temporal-flavored `requires` |
| `depends_on` | an entity, event, or concept depends on another | causal | |
| `enables` | a thing enables, supports, or allows another thing or capability | causal | |
| `capable_of` | a person, org, product, or concept is capable of an action | factual | |
| `applies_to` | a law, rule, or concept applies to or governs a subject | causal | |

### E · Causation & change (σ = causal)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `caused` | an event or thing caused or led to another event or outcome | causal | |
| `prevents_constrains` | a thing prevents, blocks, limits, gates, or protects against another | causal | |
| `improves` | a change improves, enhances, or optimizes a thing | causal | |
| `transforms` | a thing changes, extends, reduces, scales, or otherwise transforms another | causal | |
| `entails` | a statement, event, or concept logically entails another | causal | |
| `motivated_by_goal` | an action or entity is motivated by a goal or intended outcome | causal | |
| `targets_aims` | an agent targets, aims at, focuses on, or plans toward a goal | causal | |
| `replaces_supersedes` | a newer thing replaces, supersedes, or retires an older one | temporal | the current-not-stale family (tier = temporal) |

### F · Identity & similarity (σ = factual)

| Family | Gloss (head → tail) | σ | Inverse / note |
|---|---|---|---|
| `becomes` | an entity becomes, remains, or emerges as a state or role | factual | state transition |
| `similar_to` | two entities or concepts are similar in meaning, role, or behavior | factual | ↔ `distinct_from` |
| `distinct_from` | two entities or concepts are distinct and should not be conflated | factual | ↔ `similar_to` |
| `synonym` | two terms have the same or very similar meaning | factual | ↔ `antonym` |
| `antonym` | two terms have opposite meanings | factual | ↔ `synonym` |
| `manner_of` | an action or concept is a manner, method, or style of another | factual | |
| `related_to` | two concepts or entities are meaningfully related (**catch-all**) | factual | weakest-typed; never dropped |

### G · Cognition, evaluation & evidence (σ = episodic; `verifies` = factual)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `measures_evaluates` | an agent measures, tests, scores, ranks, or evaluates a thing | episodic | |
| `verifies` | an agent verifies, validates, confirms, audits, or proves a claim | factual | the attestation/evidence family |
| `discovers` | an agent finds, discovers, identifies, detects, or surfaces a thing | episodic | |
| `selects_decides` | an agent selects, chooses, picks, or decides on an option | episodic | |
| `knows_learns` | an agent learns, understands, teaches, or trains on knowledge | episodic | |
| `tracks_monitors` | an agent tracks, monitors, observes, or traces a thing over time | episodic | |
| `expects_predicts` | an agent expects, predicts, assumes, or projects an outcome | episodic | |
| `receives_action` | an entity receives, undergoes, or is affected by an action | episodic | passive/patient role |

### H · Operation, roles & achievement (σ = factual; achievement = episodic)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `operates_maintains` | a person or org operates, runs, manages, maintains, or administers a facility, system, or process | factual | |
| `leads` | a person leads, heads, directs, or chairs an org, program, or effort | factual | generalizes `ceo_of` |
| `ceo_of` | a person is or was the chief executive or leader of an organization | factual | starter specialization |
| `works_at` | a person is employed by or works at an organization | factual | |
| `achieves_addresses` | an agent achieves, reaches, delivers, solves, or addresses a goal or problem | episodic | |
| `competes_outperforms` | a thing competes with, outperforms, beats, or exceeds another | episodic | benchmark/competitive prose |
| `fails_on` | a thing fails, breaks, crashes, or misses on a task or condition | episodic | diagnostic prose |
| `participated_in` | a person or org participated in an event | episodic | |

### I · Movement, connection & location (σ = factual; `transfers_to` = episodic)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `transfers_to` | a thing moves, sends, feeds, routes, or distributes something to a destination | episodic | |
| `connects_to` | things are connected, linked, bridged, or bound to each other | factual | the bridge-entity family |
| `located_in` | a person, org, or place is located in a place | factual | |
| `at_location` | an entity, event, or object is at or associated with a location | factual | broader `located_in` |
| `headquartered_in` | an organization is headquartered in a place | factual | |

### J · People, kinship & origin (σ = factual / temporal)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `married_to` | a person is or was married to another person | episodic | symmetric |
| `parent_of` | a person is the parent of another person | factual | |
| `born_in` | a person was born in a place | temporal | tier = temporal |
| `died_in` | a person died in a place | temporal | tier = temporal |
| `nationality` | a person is a citizen or national of a place or country | factual | |

### K · Temporal & sequence (σ = temporal)

| Family | Gloss (head → tail) | σ | Inverse / note |
|---|---|---|---|
| `succeeded_by` | a person or thing was succeeded or followed by another in a role | temporal | ↔ `preceded_by` |
| `preceded_by` | a person or thing was preceded by another in a role or sequence | temporal | ↔ `succeeded_by` |
| `occurred_on` | an event occurred on or during a date or time period | temporal | head=event, tail=date |

### L · Data pipeline — TP-VRG extension families (σ = episodic / factual)
_Domain-specific but dominate the repo-docs/personal corpora; they carry the provenance story. Ratified as v1 families._

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `processes_data` | a system ingests, extracts, retrieves, renders, computes, or queries data | episodic | |
| `stores_preserves` | a system stores, saves, records, logs, archives, or preserves data or provenance | factual | the Lighthouse/provenance family |

---

## The normalization layer (observed string → family)

Extraction and legacy edges produce **free strings**. The normalizer (the `string_to_family` map in [`edge-ontology.json`](edge-ontology.json)) resolves each to a family or a bucket. The `kind` tells you *how* it resolved:

| `kind` | Meaning | Example | Routing |
|---|---|---|---|
| `family` | already a canonical family | `transfers_to` | kept as-is |
| `mapped` | a heap string mapped to a family via the ratified v1 map (~300 strings) | `feed` → `transfers_to` | kept, relation = family, string = subtype |
| `generic` | a light/copular verb with little relational signal | `provide`, `offer`, `treat` | → `related_to` (weakest-typed, **never dropped**) |
| `non_english` | Swedish function-word contamination (pre-language-gate) | `som`, `skapa` | janitor cleanup class |
| `junk` | code/parse artifact | `def`, `=`, `mode` | janitor cleanup class |
| `unknown` | **no family, no bucket — the tail** | a relation nothing covers | `(CANONICAL_UNKNOWN, subtype)` + janitor batch retrofit |

> ⚠️ **The shipped normalizer is exact-string only.** `STRING_TO_FAMILY.get(rel)` matches single-token lemmas; it does **not** do semantic-nearest matching. So `feeds its results into` → `unknown` even though it is plainly `transfers_to`. Today's `unknown` tail therefore **over-counts gaps** (multi-word phrases + synonyms the map didn't enumerate). Distinguishing a *real* gap ("no family expresses this relation at all") from a *coverage* miss ("the map just didn't list this phrasing") requires the **embedding-nearest-family** mechanism the closure test introduces (embed the phrase, cosine against the 84 glosses, threshold). This is why the closure test is the completeness gate, not the existing heap-harvest.

---

## The completeness contract — why `unknown` matters and how the vocabulary grows

The vocabulary is only safe as a **closed set with a drop policy** if it is *complete enough* that "no nearest family" reliably means "not a real relation." If the vocabulary is too small, `map-to-nearest-or-drop` silently discards real relations — a plausible-looking substrate that has quietly lost signal.

**The closure criterion:** run a frontier-grade reader over *all* corpora, extract the relations that actually exist, embed-map each against the family glosses. **If a real relation has no nearest family, the vocabulary isn't big enough** — that residue is the extension candidate list. The test ships in [`closure-test/`](closure-test/); results in [coverage-report.md](coverage-report.md).

**Extension protocol:** a new *core* family enters v-next only by explicit maintainer decision + migration (the lock rule); domain-specific families go in [`packs/`](packs/) instead. The closure test *proposes*; a human *ratifies*; the machine export + this doc + the σ-assignment update together. Never extend to chase singletons (the heap is not Zipfian — 957 of 2,650 observed strings are singletons; inventing a family per singleton is the failure mode the buckets exist to prevent).

---

## Reconciliation notes (code vs. prior surrogates)

- **Family count:** the machine SSOT ([`edge-ontology.json`](edge-ontology.json)) carries **84 families**: a ~50-family corpus-harvested set layered on a business/legal/ConceptNet-style starter block, reconciled into one census.
- **σ-classes:** the five values (`factual`, `episodic`, `authorial`, `causal`, `temporal`) are `models.RELATION_CLASSES`; `relation_to_sigma_family()` maps every family (and every unknown, via marker fallback) onto exactly one, so renderers and bundle algebra never grow divergent heuristics.
- **Structural `_`-prefixed flow tokens** live in `models.py`, not `relation_schema.py`; they are topology, listed in §S for completeness of the *topological* ontology.

## Related
[`edge-ontology.json`](edge-ontology.json) (machine SSOT) · [coverage-report.md](coverage-report.md) (the 12-register measurement) · [`closure-test/`](closure-test/) (the ruler) · [`packs/`](packs/) (the open extension format)
