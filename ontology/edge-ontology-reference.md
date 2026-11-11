# The TLDR-G Edge Ontology — Canonical Relation Vocabulary (human reference)

**Status:** 📖 **REFERENCE — the for-humans view of the closed relation vocabulary.** The machine SSOT is [`edge-ontology.json`](edge-ontology.json) in this bundle; this doc is the human-readable rendering of it. When they disagree, the machine export wins and this doc is corrected.
**Companion (the measurement):** [coverage-report.md](coverage-report.md) — the 12-register domain-generality result + the closure-test method.
**Companion (the extension format):** [`packs/`](packs/) — extend the vocabulary for your domain by adding a JSON file, not by forking the core.

---

## What this is

TLDR-G stores every edge's relation as a **canonical family** drawn from a **closed vocabulary** (this doc). While an edge is extracted the engine keeps the original free string beside the family as an open-world `subtype`; it does not yet persist that string with the stored edge (see [The extractor aliases](#the-extractor-aliases)). The families are the *label space* the whole typed-substrate design is built on:

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

Directionality: every gloss is written **head → tail** (the head performs/holds the relation toward the tail). No inverse pair has both directions as families: each pair keeps the head-performs direction, and the reverse-voice label is an extractor alias (see [The extractor aliases](#the-extractor-aliases)).

---

## The families (73)

### S · Structural tier — topology, not semantic claims
_tier = structural. These are the graph's skeleton; the truth gate is exempt for them (`is_gate_exempt`)._

| Family | Gloss (head → tail) | σ | Inverse / note |
|---|---|---|---|
| `part_of` | a structural component, section, geographic subdivision, or organizational unit belongs within a larger whole, not merely a class or association | factual | means the extractor alias `has_part` (head and tail swapped), which is held: stored as emitted (see [The extractor aliases](#the-extractor-aliases)); declared twin of `subsidiary_of`: either is scored correct |
| `contains` | a container, document, collection, location, or event includes non-structural content, occupants, items, or participants | factual | broader than `part_of`'s component-of-a-whole reading (allows person members) |
| `is_a` | a class or named type is a subtype of a broader class, not one individual instance of it | factual | taxonomy |
| `instance_of` | a specific named subject or occurrence is one concrete member of a general class, not a subtype of that class | factual | taxonomy |
| `made_of` | a physical object or structure consists materially of a substance or component, not organizational or class members | factual | |
| `version_of` | a subject is an alternate version, inflection, or embodiment of the same identity or content, not the action 'to form' | factual | renamed from `form_of` (2026-10-18); old graphs keep the old name |
| `has_attribute` | a subject is assigned an explicit descriptive attribute, status, role, or measured value; a class the subject belongs to uses is_a or instance_of, and an asset, right, credential, or position it owns or formally holds is a possession, not an attribute | factual | absorbs the extractor alias `has_property` |

**Also structural (engine flow tokens, not part of the semantic vocabulary):** the `_`-prefixed document/session-flow tokens — `_follows`, `_precedes`, `_co_doc`, `_mentioned_before`, `_session_follows`, `_session_precedes`, `_covers_period`. These are the Reading-Order Fiber / authorial-axis skeleton; enforced by `frozenset` membership, orthogonal to the semantic families here.

### A · Creation, authorship & publication (σ = authorial)

| Family | Gloss (head → tail) | σ | Inverse / note |
|---|---|---|---|
| `created` | a person or organization created a work, product, or concept, or founded an organization or institution | authorial | absorbs the extractor aliases `created_by` and `founded_by` (head and tail swapped) and `founded` |
| `authored` | a person authored or wrote a document, book, or work | authorial | |
| `developed` | a person or organization designed, engineered, or substantially advanced a product, technology, method, or technical system | authorial | |
| `publishes` | an agent publishes, releases, ships, or launches a work or version, making it available; bringing the work into being uses created | authorial | |
| `signed` | a person or organization formally signs, executes, ratifies, or approves a named law, agreement, treaty, or document | authorial | |
| `derived_from` | a concept, product, or work is derived from or based on another source, or a person, organization, or work is explicitly stated to be inspired by another person, organization, or work; resemblance or a shared topic alone does not qualify | authorial | |

### B · Communication, description & reference (σ = authorial)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `describes` | an authored work, depiction, or person is the describer and explicitly describes, represents, depicts, or illustrates a named subject, object, event, or state of affairs; a date or place mentioned alongside a description is not what is described, and a term or symbol receiving its meaning is a definition, not a description | authorial | |
| `asserts` | a person, organization, or authored work explicitly states a claim, report, proposal, prediction, or recommendation, not a mere mention | authorial | the stance/claim family |
| `references` | a person, organization, or authored work explicitly cites, quotes, names, or hyperlinks a source or referent | authorial | the provenance/citation family |
| `means` | a term or symbol receives an explicit meaning, criterion, scope, or value, not a classification, alias, or state change; a work depicting or describing a subject uses describes | authorial | renamed from `defined_as` (2026-10-18); old graphs keep the old name |

### C · Possession, membership & commerce (σ = factual; `acquired`/`transacts` = episodic)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `holds` | a person or organization owns or formally holds an asset, right, credential, position, or resource, not merely receives it; a descriptive trait, status, or measured value of the subject uses has_attribute | factual | broad possession; absorbs the extractor alias `owns` (stored as `holds` since its hold was lifted, 2026-10-18); renamed from `has` (2026-10-18); old graphs keep the old name |
| `acquired` | an organization acquired or bought another organization | episodic | |
| `transacts` | a person or organization buys, sells, pays for, or funds a named good, service, asset, security, contract, or funded undertaking, as a purchase or payment; the date, place, or amount of a transaction is not the thing transacted, and the movement of an item to its recipient uses transfers_to | episodic | |
| `member_of` | a person or organization belongs by membership to a group or organization; a structural unit of the group, such as a division or department, uses part_of | factual | membership; a structural unit of the group is `part_of` |
| `subsidiary_of` | an organization is a subsidiary or division of another organization | factual | declared twin of `part_of`: either is scored correct, nothing merges |
| `partnered_with` | a person or organization partnered, collaborated, or worked together with another person or organization on a shared work, project, or undertaking; co-authors and co-stars qualify, and co-occurrence or a shared topic alone does not | episodic→factual | symmetric |
| `combines_with` | two inputs are merged, mixed, integrated, or joined into one composite system, substance, organization, or result | factual | symmetric |

### D · Usage, dependency & enablement (σ = factual / causal)

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `uses` | an agent or system uses, applies, or consumes a tool, method, or resource | factual | |
| `used_for` | a tool, artifact, method, facility, or resource is intentionally employed to perform a stated task or achieve a stated purpose | factual | |
| `requires` | an action, event, or concept requires another condition or resource, or the continued existence, operation, validity, or outcome of a subject materially relies on a specified resource, condition, system, or actor | causal | absorbs the extractor aliases `has_prerequisite` and `depends_on` |
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
| `changes_into` | a subject enters a new role, class, condition, identity, or state rather than remaining unchanged, a change over time; a standing membership in a broader class uses is_a | factual | state transition, a sequence; renamed from `becomes` (2026-10-18); old graphs keep the old name |
| `similar_to` | two named subjects are explicitly stated to resemble one another in kind, meaning, role, or behavior; rivalry, ranking, re-enactment, and mere relatedness are comparisons but not resemblance | factual | symmetric; opposite of `distinct_from` |
| `distinct_from` | two named subjects are explicitly contrasted or stated not to be the same; replacement, independence, and separation from another are not identity distinctions | factual | symmetric; opposite of `similar_to` |
| `synonym` | two terms have equivalent meaning, or two names or aliases denote the same referent; similarity and versioning do not qualify | factual | symmetric; opposite of `antonym` |
| `antonym` | two concepts, names, or terms have opposite meanings | factual | symmetric; opposite of `synonym` |
| `manner_of` | an action or concept is a manner, method, or style of another | factual | |
| `related_to` | two subjects have an explicit relationship with no more specific canonical family; co-occurrence alone does not qualify | factual | symmetric; weakest-typed; never dropped |

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
| `transfers_to` | a person, organization, or product is explicitly moved, assigned, delivered, sold, or conveyed to a named recipient or destination, a movement to the recipient; the purchase or payment itself uses transacts | episodic | |
| `connects_to` | two endpoints have an explicit physical, network, transport, interface, or structural link that permits passage, communication, attachment, or coupling | factual | symmetric; the bridge-entity family |
| `located_in` | a person resides in or is present at, an organization operates from or is headquartered in, an event occurs at, or a physical object, phenomenon, or smaller geographic location lies within, a geographic location | factual | absorbs the extractor aliases `at_location` and `headquartered_in` |

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
| `succeeded_by` | a person or organization is replaced by another holder of the same office, leadership position, governing role, or institutional function | temporal | absorbs the extractor alias `preceded_by` (head and tail swapped) |
| `occurred_on` | an event occurred on or during a date or time period | temporal | head=event, tail=date |

### L · Data pipeline — TP-VRG extension families (σ = episodic / factual)
_Domain-specific but dominate the repo-docs/personal corpora; they carry the provenance story. Ratified as v1 families._

| Family | Gloss (head → tail) | σ | Note |
|---|---|---|---|
| `processes_data` | a system ingests, extracts, retrieves, renders, computes, or queries data | episodic | |
| `stores_preserves` | a system stores, saves, records, logs, archives, or preserves data or provenance | factual | the Lighthouse/provenance family |

---

## The extractor aliases

The vocabulary holds 73 families. Two re-locks retired eleven labels into extractor aliases: the first kept the head-performs direction of four inverse pairs and merged three near-duplicates into the broader gloss; the second merged four near-twins into their parent, where a judge or the extractor confused the two and one is a narrower case of the other. The eleven stay in the extractor's prompt, in their original places, because the extractor recognizes phrasings through them (reverse voice, "X was founded by Y", and the narrower wordings); ten are stored under their family, with head and tail swapped for the inverse pairs, and one is held and stored as emitted (below). The `extractor_aliases` table in [`edge-ontology.json`](edge-ontology.json) is the machine form (`stored_as_family`, and a `hold_reason` for the held alias).

| Extractor label → family | Head and tail | Stored as | Why |
|---|---|---|---|
| `created_by` → `created` | swapped | the family | inverse pair |
| `founded_by` → `created` | swapped | the family | inverse pair (the founding family merged into `created`) |
| `has_part` → `part_of` | swapped | **`has_part`, held** | inverse pair |
| `preceded_by` → `succeeded_by` | swapped | the family | inverse pair |
| `has_prerequisite` → `requires` | kept | the family | near-duplicate, same σ-class (causal) |
| `owns` → `holds` | kept | the family | near-duplicate, same σ-class (factual) |
| `has_property` → `has_attribute` | kept | the family | near-duplicate, same σ-class (factual) |
| `at_location` → `located_in` | kept | the family | near-twin, same σ-class and shape (factual) |
| `headquartered_in` → `located_in` | kept | the family | near-twin, a narrower case (factual) |
| `founded` → `created` | kept | the family | near-twin, a narrower case (authorial) |
| `depends_on` → `requires` | kept | the family | near-twin, same σ-class and shape (causal) |

**A merge keeps what the merged label admitted.** Each near-twin parent's endpoint types are the union with its merged labels' types, and its gloss states the merged sense (`located_in` covers an event at a place and a headquarters; `created` covers founding an organization; `requires` covers reliance). An edge the narrower label admitted is therefore not refused by the type check once it is stored under the parent. `holds` is the one parent whose types are not a literal union: it keeps the types it carried as `has`, and the organization tail `owns` admitted is admitted through its `concept` type, because the type check treats a `concept` type as a wildcard that admits an endpoint of any category except a date (a date-shaped endpoint, by its category or by a name that is a bare number of up to four digits or an ISO date, is refused in any slot that declares no date type, `concept` or not). The merged label keeps its own types and gloss in the alias table, for graphs that store it.

**The held alias.** `has_part` is stored as emitted. It was held, together with `owns`, because an earlier renderer did not show a hierarchy relation (`part_of`) or a function-word relation (`has`) as a fact. That renderer has since been removed; the `owns` hold has been lifted with the `has` → `holds` rename (`owns` is stored as `holds`), and lifting the `has_part` hold is a pending decision. It still means its family.

**The emitted label is not stored beside the edge.** The alias pass records the label an edge was emitted as while the edge is processed, but no stored field keeps it: after ingest an edge stored as `located_in` cannot say whether it was emitted as `headquartered_in`. What each alias means is in the alias table; persisting the emitted label is planned.

## The renamed labels

Four families were renamed so the extractor, which reads only the label names, sees names distinct from their near twins. Each keeps its place in the extractor's prompt, its endpoint types, tier and σ-class. The old names leave the prompt and the vocabulary; a graph written before the rename still stores them, and they are read as recorded, never relabelled. `renamed_labels` in [`edge-ontology.json`](edge-ontology.json) maps each old name to its family, with the gloss and types the old name carried.

| Old label → family now | Why |
|---|---|
| `defined_as` → `means` | the extractor co-emits it with `is_a` |
| `form_of` → `version_of` | the extractor co-emits it with `is_a` and `defined_as` |
| `becomes` → `changes_into` | the extractor co-emits it with `is_a`; a change of state is a sequence, not a class |
| `has` → `holds` | the extractor co-emits it with `has_attribute` |

`has` and `becomes` are English function words, which the extraction stopword filter drops, so possession and change-of-state facts in English text were never stored under the old names; under `holds` and `changes_into` they are.

## The declared twin set

`part_of` and `subsidiary_of` are declared **twins**: both are true of the same edge (a subsidiary is an organizational part) and neither is narrower in the way the merges are. Nothing merges and nothing is relabelled; an evaluation scores either family as correct for the other. `twin_sets` in [`edge-ontology.json`](edge-ontology.json) lists them.

**Symmetric families.** Nine families carry `"symmetric": true`, because their direction carries nothing: `married_to`, `partnered_with`, `synonym`, `antonym`, `similar_to`, `distinct_from`, `related_to`, `connects_to`, `combines_with`.

**Graphs written with an earlier vocabulary** can hold the retired and the renamed labels, and a new graph still stores the held one. They are read as recorded, never relabelled. The graph's provenance report says which vocabularies wrote to it (its relations predate the recorded vocabulary, one recorded vocabulary, or a mix) and counts the edges it stores under each retired or renamed label.

---

## The normalization layer (observed string → family)

Extraction and legacy edges produce **free strings**. The normalizer (the `string_to_family` map in [`edge-ontology.json`](edge-ontology.json)) resolves each to a family or a bucket; a string whose head and tail swap to read in its family's direction (`follow`, which means `succeeded_by` read the other way) is listed in `string_to_family_swaps`. The `kind` tells you *how* it resolved:

| `kind` | Meaning | Example | Routing |
|---|---|---|---|
| `family` | already a canonical family | `transfers_to` | kept as-is |
| `extractor_alias` | a label a re-lock retired into the extractor alias table, as a graph written before it stores it (or the held `has_part`, which a new graph stores too) | `founded_by` | kept as recorded, never relabelled |
| `renamed_label` | a family's old name after a rename, as a graph written before it stores it | `defined_as` | kept as recorded, never relabelled; means its new family |
| `mapped` | a heap string mapped to a family via the ratified v1 map (~300 strings) | `feed` → `transfers_to` | kept, relation = family, string = subtype |
| `generic` | a light/copular verb with little relational signal | `provide`, `offer`, `treat` | → `related_to` (weakest-typed, **never dropped**) |
| `non_english` | Swedish function-word contamination (pre-language-gate) | `som`, `skapa` | janitor cleanup class |
| `junk` | code/parse artifact | `def`, `=`, `mode` | janitor cleanup class |
| `unknown` | **no family, no bucket — the tail** | a relation nothing covers | `(CANONICAL_UNKNOWN, subtype)` + janitor batch retrofit |

> ⚠️ **The shipped normalizer is exact-string only.** `STRING_TO_FAMILY.get(rel)` matches single-token lemmas; it does **not** do semantic-nearest matching. So `feeds its results into` → `unknown` even though it is plainly `transfers_to`. Today's `unknown` tail therefore **over-counts gaps** (multi-word phrases + synonyms the map didn't enumerate). Distinguishing a *real* gap ("no family expresses this relation at all") from a *coverage* miss ("the map just didn't list this phrasing") requires the **embedding-nearest-family** mechanism the closure test introduces (embed the phrase, cosine against the family glosses, threshold). This is why the closure test is the completeness gate, not the existing heap-harvest.

---

## The completeness contract — why `unknown` matters and how the vocabulary grows

The vocabulary is only safe as a **closed set with a drop policy** if it is *complete enough* that "no nearest family" reliably means "not a real relation." If the vocabulary is too small, `map-to-nearest-or-drop` silently discards real relations — a plausible-looking substrate that has quietly lost signal.

**The closure criterion:** run a frontier-grade reader over *all* corpora, extract the relations that actually exist, embed-map each against the family glosses. **If a real relation has no nearest family, the vocabulary isn't big enough** — that residue is the extension candidate list. The test ships in [`closure-test/`](closure-test/); results in [coverage-report.md](coverage-report.md).

**Extension protocol:** a new *core* family enters v-next only by explicit maintainer decision + migration (the lock rule); domain-specific families go in [`packs/`](packs/) instead. The closure test *proposes*; a human *ratifies*; the machine export + this doc + the σ-assignment update together. Never extend to chase singletons (the heap is not Zipfian — 957 of 2,650 observed strings are singletons; inventing a family per singleton is the failure mode the buckets exist to prevent).

---

## Reconciliation notes (code vs. prior surrogates)

- **Family count:** the machine SSOT ([`edge-ontology.json`](edge-ontology.json)) carries **73 families**: a ~50-family corpus-harvested set layered on a business/legal/ConceptNet-style starter block, reconciled into one census of 84, re-locked to 77 by merging four inverse pairs and three near-duplicates, and to 73 by merging four near-twins (see [The extractor aliases](#the-extractor-aliases)). Four families were renamed at the same time, which keeps the count ([The renamed labels](#the-renamed-labels)).
- **σ-classes:** the five values (`factual`, `episodic`, `authorial`, `causal`, `temporal`) are `models.RELATION_CLASSES`; `relation_to_sigma_family()` maps every family (and every unknown, via marker fallback) onto exactly one, so renderers and bundle algebra never grow divergent heuristics.
- **Structural `_`-prefixed flow tokens** live in `models.py`, not `relation_schema.py`; they are topology, listed in §S for completeness of the *topological* ontology.

## Related
[`edge-ontology.json`](edge-ontology.json) (machine SSOT) · [coverage-report.md](coverage-report.md) (the 12-register measurement) · [`closure-test/`](closure-test/) (the ruler) · [`packs/`](packs/) (the open extension format)
