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
| `part_of` | a structural component, section, geographic subdivision, or organizational unit belongs within a larger whole, not merely a class or association | factual | ↔ `has_part` |
| `has_part` | a whole has a structurally identifiable component, section, geographic subdivision, or organizational unit; incidental contents do not qualify | factual | ↔ `part_of` |
| `contains` | a container, document, collection, location, or event includes non-structural content, occupants, items, or participants | factual | broader than `has_part` (allows person members) |
| `is_a` | a class or named type is a subtype of a broader class, not one individual instance of it | factual | taxonomy |
| `instance_of` | a specific named subject or occurrence is one concrete member of a general class, not a subtype of that class | factual | taxonomy |
| `made_of` | a physical object or structure consists materially of a substance or component, not organizational or class members | factual | |
| `form_of` | a subject is an alternate version, inflection, or embodiment of the same identity or content, not the action 'to form' | factual | |
| `has_attribute` | a subject is assigned an explicit descriptive attribute, classification, status, role, or measured value | factual | |
| `has_property` | a subject intrinsically exhibits an explicit trait, capability, physical characteristic, or quality | factual | near-synonym of `has_attribute` |

**Also structural (engine flow tokens, not part of the semantic vocabulary):** the `_`-prefixed document/session-flow tokens — `_follows`, `_precedes`, `_co_doc`, `_mentioned_before`, `_session_follows`, `_session_precedes`, `_covers_period`. These are the Reading-Order Fiber / authorial-axis skeleton; enforced by `frozenset` membership, orthogonal to the semantic families here.

### A · Creation, authorship & publication (σ = authorial)

| Family | Gloss (head → tail) | σ | Inverse / note |
|---|---|---|---|
| `created` | a person or organization created a work, product, or concept | authorial | ↔ `created_by` |
| `created_by` | a work, product, or concept was created by a person or organization | authorial | ↔ `created` |
| `founded` | a person or organization founded an organization or institution | authorial | ↔ `founded_by` |
| `founded_by` | an organization was founded by a person | authorial | ↔ `founded` |
| `authored` | a person authored or wrote a document, book, or work | authorial | |
| `developed` | a person or organization designed, engineered, or substantially advanced a product, technology, method, or technical system | authorial | |
| `publishes` | an agent publishes, releases, ships, or launches a work or version | authorial | |
| `signed` | a person or organization formally signs, executes, or ratifies a named law, agreement, treaty, or document | authorial | |
| `derived_from` | a concept, product, or work is derived from another source | authorial | |

### B · Communication, description & reference (σ = authorial)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `describes` | an authored work, depiction, or person is the describer and explicitly describes, represents, depicts, or illustrates a named subject, object, event, or state of affairs; a date or place mentioned alongside a description is not what is described | authorial | |
| `asserts` | a person, organization, or authored work explicitly states a claim, report, proposal, prediction, or recommendation, not a mere mention | authorial | the stance/claim family |
| `references` | a person, organization, or authored work explicitly cites, quotes, names, or hyperlinks a source or referent | authorial | the provenance/citation family |
| `defined_as` | a term or symbol receives an explicit meaning, criterion, scope, or value, not a classification, alias, or state change | authorial | |

### C · Possession, membership & commerce (σ = factual; `acquired`/`transacts` = episodic)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `has` | a person or organization owns or formally holds an asset, right, credential, position, or resource, not merely receives it | factual | broad possession |
| `owns` | a person or organization owns an asset, product, or organization | factual | ownership proper |
| `acquired` | an organization acquired or bought another organization | episodic | |
| `transacts` | a person or organization buys, sells, pays for, or funds a named good, service, asset, security, contract, or funded undertaking; the date, place, or amount of a transaction is not the thing transacted | episodic | |
| `member_of` | a person or organization is a member of a group or organization | factual | |
| `subsidiary_of` | an organization is a subsidiary or division of another organization | factual | |
| `partnered_with` | an organization partnered or collaborated with another organization | episodic→factual | symmetric |
| `combines_with` | two inputs are merged, mixed, integrated, or joined into one composite system, substance, organization, or result | factual | symmetric |

### D · Usage, dependency & enablement (σ = factual / causal)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `uses` | an agent or system uses, applies, or consumes a tool, method, or resource | factual | |
| `used_for` | a tool, artifact, method, facility, or resource is intentionally employed to perform a stated task or achieve a stated purpose | factual | |
| `requires` | an action, event, or concept requires another condition or resource | causal | |
| `has_prerequisite` | an event, concept, or action requires another condition before it | causal | temporal-flavored `requires` |
| `depends_on` | the continued existence, operation, validity, or outcome of a subject materially relies on a specified resource, condition, system, or actor | causal | |
| `enables` | a condition, capability, tool, law, or action makes a specified action or outcome possible | causal | |
| `capable_of` | a person, organization, product, or concept is capable of an action | factual | |
| `applies_to` | a named law, rule, policy, requirement, standard, or formal classification governs a subject or jurisdiction | causal | |

### E · Causation & change (σ = causal)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `caused` | an event, action, condition, or mechanism directly produces or materially brings about a distinct event or outcome | causal | |
| `prevents_constrains` | a law, condition, mechanism, or action materially blocks, limits, or binds a specified action or outcome | causal | |
| `improves` | a specified intervention, feature, or change produces an explicit improvement in a target's performance, quality, capability, or outcome | causal | |
| `transforms` | a process, input, or intervention explicitly changes the state, scale, quantity, or representation of a target | causal | |
| `entails` | a statement, event, or concept logically entails another | causal | |
| `motivated_by_goal` | an intentional action, person, or organization acts because it seeks a stated future goal or intended outcome | causal | |
| `targets_aims` | a person, organization, or product intentionally pursues, prioritizes, or is designed toward a stated goal, audience, outcome, or operational target | causal | |
| `replaces_supersedes` | a newer product, system, policy, standard, organization, or version displaces an older functional counterpart; role-holders use succeeded_by | temporal | the current-not-stale family (tier = temporal) |

### F · Identity & similarity (σ = factual)

| Family | Gloss (head → tail) | σ | Inverse / note |
|---|---|---|---|
| `becomes` | a subject enters a new role, class, condition, identity, or state rather than remaining unchanged | factual | state transition |
| `similar_to` | two named subjects are explicitly stated to resemble one another in kind, meaning, role, or behavior; rivalry, ranking, re-enactment, and mere relatedness are comparisons but not resemblance | factual | ↔ `distinct_from` |
| `distinct_from` | two named subjects are explicitly contrasted or stated not to be the same; replacement, independence, and separation from another are not identity distinctions | factual | ↔ `similar_to` |
| `synonym` | two terms have equivalent meaning, or two names or aliases denote the same referent; similarity and versioning do not qualify | factual | ↔ `antonym` |
| `antonym` | two concepts, names, or terms have opposite meanings | factual | ↔ `synonym` |
| `manner_of` | an action or concept is a manner, method, or style of another | factual | |
| `related_to` | two subjects have an explicit relationship with no more specific canonical family; co-occurrence alone does not qualify | factual | weakest-typed; never dropped |

### G · Cognition, evaluation & evidence (σ = episodic; `verifies` = factual)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `measures_evaluates` | a person, organization, or instrument explicitly measures, tests, scores, ranks, or evaluates a specified target against a criterion or metric | episodic | |
| `verifies` | an agent verifies, validates, confirms, audits, or proves a claim | factual | the attestation/evidence family |
| `discovers` | a person, organization, or instrument newly identifies a previously unknown object, location, phenomenon, fact, or pattern through observation or investigation | episodic | |
| `selects_decides` | an agent selects, chooses, picks, or decides on an option | episodic | |
| `knows_learns` | an agent learns, understands, teaches, or trains on knowledge | episodic | |
| `tracks_monitors` | a person, organization, or instrument repeatedly observes or records a target's state, location, or changes over time | episodic | |
| `expects_predicts` | an agent expects, predicts, assumes, or projects an outcome | episodic | |
| `receives_action` | a person, organization, product, law, or place receives or undergoes a named action, treatment, decision, designation, or award | episodic | passive/patient role |

### H · Operation, roles & achievement (σ = factual; achievement = episodic)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `operates_maintains` | a person or organization operates, runs, manages, maintains, or administers a facility, system, or process | factual | |
| `leads` | a person commands, directs, or chairs an organization, team, program, project, or effort; explicit CEO titles use ceo_of | factual | generalizes `ceo_of` |
| `ceo_of` | a person explicitly holds or held the title of chief executive officer or chief executive of an organization | factual | starter specialization |
| `works_at` | a person is employed by or works at an organization | factual | |
| `achieves_addresses` | a person, organization, or product attains a stated goal or outcome, or concretely addresses a specified problem | episodic | |
| `competes_outperforms` | a person, organization, team, or product directly competes with or explicitly outperforms another in the same contest or market | episodic | benchmark/competitive prose |
| `fails_on` | a person, organization, system, method, or action fails a task, requirement, operating condition, or intended outcome | episodic | diagnostic prose |
| `participated_in` | a person or organization participated in an event | episodic | |

### I · Movement, connection & location (σ = factual; `transfers_to` = episodic)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `transfers_to` | a person, organization, or product is explicitly moved, assigned, delivered, sold, or conveyed to a named recipient or destination | episodic | |
| `connects_to` | two endpoints have an explicit physical, network, transport, interface, or structural link that permits passage, communication, attachment, or coupling | factual | the bridge-entity family |
| `located_in` | a person resides in, an organization operates from, or a geographic location lies within another geographic location | factual | |
| `at_location` | an event occurs at, or a person, organization, physical object, or phenomenon is explicitly present at, a geographic location | factual | broader `located_in` |
| `headquartered_in` | an organization is explicitly stated to have its principal headquarters in a geographic location | factual | |

### J · People, kinship & origin (σ = factual / temporal)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `married_to` | a person is or was married to another person | episodic | symmetric |
| `parent_of` | a person is the parent of another person | factual | |
| `born_in` | a person's birth is explicitly stated to have occurred in a geographic location | temporal | tier = temporal |
| `died_in` | a person's death is explicitly stated to have occurred in a geographic location | temporal | tier = temporal |
| `nationality` | a person is explicitly identified as a citizen or national of a country or nation | factual | |

### K · Temporal & sequence (σ = temporal)

| Family | Gloss (head → tail) | σ | Inverse / note |
|---|---|---|---|
| `succeeded_by` | a person or organization is replaced by another holder of the same office, leadership position, governing role, or institutional function | temporal | ↔ `preceded_by` |
| `preceded_by` | a person or organization had another as the previous holder of the same office, governing role, or institutional function | temporal | ↔ `succeeded_by` |
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
