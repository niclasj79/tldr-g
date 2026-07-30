/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE GLOSSARY
 * =============================================================================
 *
 * The product's vocabulary, defined once.
 *
 * These are not marketing definitions. Each entry says what the thing IS in this
 * engine, and several of them volunteer a limitation, because a term that is
 * defined more strongly than it is implemented is a term that will be believed
 * more strongly than it deserves.
 *
 * `short` is the tooltip: one clause, no subordinate structure.
 * `long`  is the overlay: two or three sentences, and the honest edge cases.
 *
 * Terms are lowercase unless the product capitalises them on screen. `see` names
 * other entries in this list, and is checked at module load in dev.
 * =============================================================================
 */

import type { GlossaryEntry } from '@/copy/types';

export const GLOSSARY: readonly GlossaryEntry[] = Object.freeze([
  /* ---- the thesis ------------------------------------------------------ */
  {
    term: 'render, don’t retrieve',
    short: 'Decide how much of each node the question is worth, then show the decision.',
    long: 'Retrieval finds passages and hands you the pile; you never learn what it skipped. Rendering chooses a resolution per node — verbatim, summary, label, or nothing — spends a stated budget doing it, and then reports every choice, including the nodes it reached and declined to pay for.',
    see: ['shortest sufficient view', 'resolution ramp', 'render trace'],
  },
  {
    term: 'shortest sufficient view',
    short: 'The smallest rendering that still answers the question, with the topology left intact.',
    long: 'Not the smallest context — the smallest SUFFICIENT one. Nodes on the answer path are carried at full resolution, their neighbours at summary, the rest as pointers, and everything else stays present as topology rather than being cut away. Sufficiency is estimated by the engine and reported as render confidence, so you can disagree with it.',
    see: ['render confidence', 'latent', 'token budget'],
  },

  /* ---- the spine ------------------------------------------------------- */
  {
    term: 'rung',
    short: 'One level of the containment spine. There are exactly four.',
    long: 'Continent, island, asset, passage — in that order, and there are no others. There is no rung above continent: the world is a set of continents. Verbatim evidence is not a rung either; it lives inside a passage as its source segment. Adding a fifth would break the zoom semantics, the resolution budget and the breadcrumb, in that order.',
    see: ['asset', 'passage', 'island', 'continent'],
  },
  {
    term: 'continent',
    short: 'A top-level semantic region — the coarsest grouping of islands.',
    long: 'Continents carry a community hue as a low-saturation wash, so you can tell which region you are looking at from maximum zoom-out without reading a label.',
    see: ['rung', 'community hue'],
  },
  {
    term: 'island',
    short: 'A coherent cluster of documents inside a continent.',
    long: 'Islands are what straits run between. A relation that leaves an island is the visual event the terrain is built around, and it is only possible because some entity is mentioned on both sides.',
    see: ['strait', 'bridge entity'],
  },
  {
    term: 'asset',
    short: 'One authored artifact with a declared boundary. The molecule.',
    long: 'A contract, a paper, a thread, a merged change, a chapter, a dated session — something that somebody, at some point, declared to be one thing. The asset is the unit of resolution and the context extraction happens inside, which is why the same name in two assets may be two different entities until they are reconciled. If you cannot name the boundary, you do not have an asset; you have a pile of text.',
    see: ['passage', 'entity', 'rung'],
  },
  {
    term: 'passage',
    short: 'A verbatim span inside a document. The provenance floor.',
    long: 'A passage carries character offsets into its source’s verbatim segment, a hash over exactly those bytes, and a disclosure of how far its rendered text has travelled from them. It is never the molecule and never an entity — it lives inside an asset and has no independent existence.',
    see: ['source segment', 'resolution disclosure', 'content hash'],
  },
  {
    term: 'entity',
    short: 'The named concept, reconciled across documents. The atom.',
    long: 'Entities are the only nodes that are not on the containment spine, and that is the point: one entity mentioned in documents on two different islands is a bridge, and the route through it is what crosses a strait. Without the entity layer the terrain is four disconnected zoom levels; with it, the terrain has routes.',
    see: ['bridge entity', 'asset'],
  },
  {
    term: 'bridge entity',
    short: 'An entity mentioned on more than one island.',
    long: 'Bridge entities are what make an answer able to leave its island. The flag is derived from the entity’s own island list, not asserted — so a constellation can never draw a crossing the data does not support. Remove the bridge and the two sides of a bridge answer have no route between them.',
    see: ['strait', 'entity'],
  },
  {
    term: 'strait',
    short: 'A relation whose two ends sit on different islands.',
    long: 'Straits are the visually expensive crossings on the map, and they are the reason a bridge question looks different from a lookup: the constellation spans the terrain instead of clustering in one region.',
    see: ['bridge entity', 'trade route'],
  },
  {
    term: 'trade route',
    short: 'A bundled corridor of relations between two regions.',
    long: 'At the continent and island rungs the terrain draws corridors, not individual relations — that is how it stays legible. Each corridor reports how many relations it actually carries, and ships a small sample of them so hovering shows real families rather than a made-up summary. The sample is never the corridor’s truth, and the interface says so.',
    see: ['edges are earned', 'strait'],
  },

  /* ---- the relation vocabulary ----------------------------------------- */
  {
    term: 'σ-class',
    short: 'What kind of claim a relation makes.',
    long: 'Six classes: factual, temporal, causal, episodic, authorial, structural. The class decides the relation’s colour, whether it bundles into a corridor, and whether it has to pass the truth gate. Structural is the exception in every one of those respects.',
    see: ['relation family', 'truth gate'],
  },
  {
    term: 'relation family',
    short: 'The typed token on a relation, such as `operates` or `acquired`.',
    long: 'Families come in inverse pairs wherever a reversal is meaningful, so a traversal that crosses an edge backwards can print `operated by` instead of printing the stored direction and reading backwards. A family with no meaningful inverse declares none rather than inventing one.',
    see: ['σ-class'],
  },
  {
    term: 'structural relation',
    short: 'An underscore-prefixed relation that describes the artifact, not the world.',
    long: 'Reading order, co-document membership, session ordering. `_follows` says “this passage came after that one in the document”, which is a fact about the file. Structural relations are exempt from the truth gate because there is nothing about them to verify, and gating them would quarantine the graph’s own skeleton.',
    see: ['truth gate', 'σ-class'],
  },

  /* ---- the resolution ramp --------------------------------------------- */
  {
    term: 'resolution ramp',
    short: 'The five tiers a node can be rendered at.',
    long: 'Verbatim, summary, label, ghost, latent. Every node on screen is at exactly one of them, and the tier is a spending decision by the engine rather than a consequence of zoom. A node stays latent at maximum magnification if nothing was spent on it.',
    see: ['fovea', 'ghost', 'latent'],
  },
  {
    term: 'fovea',
    short: 'The verbatim tier — what is being read to you in full.',
    long: 'Borrowed from vision deliberately: the eye resolves a tiny centre in detail and the rest coarsely, and it does not experience that as a loss. The fovea of a render is the set of passages carried byte for byte, and it is the only tier a citation may rest on.',
    see: ['penumbra', 'periphery', 'resolution ramp'],
  },
  {
    term: 'penumbra',
    short: 'The summary tier — enough of a node to reason with, not enough to quote.',
    long: 'Nodes just off the answer path, carried as engine-written summaries at a fraction of the cost of their source. A summary is never quotable: cite the passage underneath it.',
    see: ['fovea', 'periphery'],
  },
  {
    term: 'periphery',
    short: 'The label tier — enough to point at and navigate to.',
    long: 'Label and identifier only. Pointer nodes are how a render keeps the topology intact without paying for it, and they are the reason a cheap answer can still show you where it sits.',
    see: ['fovea', 'penumbra'],
  },
  {
    term: 'ghost',
    short: 'Present in the terrain, not spent on. Label on hover only.',
    long: 'A ghost node is in the payload and drawn in its real position; the renderer simply did not spend on it. Its label appears when you point at it and nowhere else, because a screen full of labels is a way of showing nothing.',
    see: ['latent', 'resolution ramp'],
  },
  {
    term: 'latent',
    short: 'Outline only: known to exist, resolved to nothing.',
    long: 'Latent is load-bearing. It exists so the terrain never has holes — content the engine omitted is still there, in its real position, at its real size, as topology. Omission is a budget decision, not a deletion, and latent is what makes the decision visible instead of invisible.',
    see: ['omitted but connected', 'resolution ramp'],
  },

  /* ---- the budget ------------------------------------------------------ */
  {
    term: 'token budget',
    short: 'The ceiling a render is given, and it binds.',
    long: 'Admission stops at the node that would cross the ceiling. Everything past that point is reported as omitted-but-connected rather than quietly dropped, which is the difference between a budget and a rounding error.',
    see: ['counterfactual tokens', 'omitted but connected'],
  },
  {
    term: 'counterfactual tokens',
    short: 'What the naive alternative would have cost.',
    long: 'Every passage of every document the constellation touches, summed from the corpus’s own per-passage token counts. It is a measured inventory of the stuffed context, not a guess — and it is the denominator the savings figure is computed against, which is why it has to be honest.',
    see: ['token budget', 'render trace'],
  },
  {
    term: 'admission',
    short: 'One node the renderer spent budget on, with its cost and its reason.',
    long: 'Every admitted node is recorded with the resolution it was carried at, what it cost, why it was let in, and the score that cleared the threshold. The render’s total is the sum of these rows; it is never asserted separately.',
    see: ['render trace', 'omitted but connected'],
  },
  {
    term: 'omitted but connected',
    short: 'What the renderer reached and chose not to spend on.',
    long: 'The honesty mechanism of the whole product. It turns “here is your answer” into “here is your answer, here is what I chose not to spend on, and here is how far away it was”. Everything on the list is drawn latent in the terrain, so the omission is visible as topology rather than as a hole.',
    see: ['latent', 'token budget'],
  },

  /* ---- the receipt ----------------------------------------------------- */
  {
    term: 'render trace',
    short: 'The signed receipt for one render.',
    long: 'The question, what produced the answer, every quote with its source hash, every node admitted with its cost and reason, and everything connected that was left out. The whole payload is hashed and the hash is signed, so the receipt can be checked outside this application by someone who does not trust it. That is the entire reason it is signed.',
    see: ['payload hash', 'render confidence', 'omitted but connected'],
  },
  {
    term: 'render confidence',
    short: 'The engine’s own estimate that what it rendered is sufficient for the question.',
    long: 'A weighted composite of four measured signals: semantic fit, topology, temporal validity and authorial density. It is displayed as a gauge and never as a verdict — a high confidence over a thin composite is exactly the case worth looking at, which is why the decomposition sits next to the number instead of behind a click. It is not a claim that the answer is true.',
    see: ['render trace', 'shortest sufficient view'],
  },
  {
    term: 'content hash',
    short: 'SHA-256 over verbatim source bytes.',
    long: 'Computed over the bytes on disk — never over a summary, a normalisation or a re-serialisation of what is on screen. It is what lets a third party go back to the original document and check a quote without trusting this application. It is displayed truncated so it can be compared by eye; the full value is one click away.',
    see: ['source segment', 'payload hash'],
  },
  {
    term: 'payload hash',
    short: 'The hash over a whole trace: answer, citations and admissions.',
    long: 'Distinct from a content hash, which covers source bytes. The payload hash covers the receipt itself, and it is the thing the signature signs — which is why a mutated quote breaks the payload hash while leaving the signature verifiable, and a mutated signature does the opposite. Reporting the two halves separately is the receipt’s whole diagnostic value.',
    see: ['render trace', 'content hash'],
  },
  {
    term: 'source segment',
    short: 'One layer of an ingested document. Segment 0 is the verbatim text.',
    long: 'A source may carry derived layers — normalisations, corrections — and they are useful, but only segment 0 may satisfy a citation. Every passage hash and every citation hash chains back to those bytes; if they change, every citation against that document is stale and the interface must say so.',
    see: ['content hash', 'passage'],
  },
  {
    term: 'resolution disclosure',
    short: 'How far a quote has travelled from the bytes on disk, printed with the quote.',
    long: 'Three states: verbatim, coreference-resolved, term-resolved. A resolved quote is no longer literally what the document says, so the distance is stated next to it — on every quote, including the ones that have not travelled at all. A label that only appears when something is awkward reads as an admission; a label that is always present is a method.',
    see: ['passage', 'content hash'],
  },

  /* ---- the truth gate -------------------------------------------------- */
  {
    term: 'truth gate',
    short: 'The admission test every non-structural relation has to pass.',
    long: 'A relation is admitted when its extraction confidence clears the declared floor and it carries at least one evidence passage. Structural relations are exempt because they describe the artifact rather than the world. Both the floor and every rejection reason are on the record, so the gate’s report can be recomputed instead of believed.',
    see: ['quarantine', 'verified edge'],
  },
  {
    term: 'quarantine',
    short: 'A claim the truth gate rejected. It stays in the graph.',
    long: 'Quarantined relations ship in the payload and render latent, so the terrain shows what was rejected rather than hiding it. They are never traversed and may never carry an answer: a route through a rejected claim is not a shorter answer, it is a wrong one. Every rejection carries a named reason, and the reasons are grouped so you can go and look at what was thrown out.',
    see: ['truth gate', 'latent'],
  },
  {
    term: 'verified edge',
    short: 'A relation that passed the truth gate — not one a person checked by hand.',
    long: '“Verified” here means exactly two things: extraction confidence above the floor, and at least one evidence passage behind the claim. It does not mean a human confirmed it, and it does not mean the underlying document is correct. The term is defined narrowly on purpose, because the wider reading is the one people assume.',
    see: ['truth gate', 'quarantine'],
  },

  /* ---- modes ----------------------------------------------------------- */
  {
    term: 'Deterministic mode',
    short: 'Graph traversal only. Same question, same answer, every time.',
    long: 'The answer is produced by walking admitted relations and nothing else. No model participates, so the result is reproducible and every hop traces back to the relation that carried it. This is the default, and it is what the demo receipt is built from.',
    see: ['LLM-augmented mode', 'render trace'],
  },
  {
    term: 'LLM-augmented mode',
    short: 'A model participated in producing the answer, and the interface says so.',
    long: 'The citations, the path and the budget are still measured the same way — but the answer wording is not a pure function of the graph and is not reproducible in the way a deterministic render is. The disclosure sits on the answer itself rather than in a setting somewhere, because it is a property of that answer.',
    see: ['Deterministic mode'],
  },

  /* ---- rendering policy ------------------------------------------------ */
  {
    term: 'edges are earned',
    short: 'The terrain never draws every relation, and always says which rule chose the ones it drew.',
    long: 'Three rules: the trade-route skeleton, the neighbourhood of what you are pointing at, and the constellation of an answer. Drawing everything is not a rendering problem to be solved with better shaders — it is a semantic failure, because a picture of everything is a picture of nothing. The policy lives in the engine seam so a renderer cannot opt out of it by being clever.',
    see: ['trade route', 'constellation'],
  },
  {
    term: 'constellation',
    short: 'The subgraph an answer was rendered from.',
    long: 'The nodes the render admitted, the ordered path between the question and the answer, and the bridge entity that made the path possible. It is what lights up in the terrain when an answer lands, and it is exactly what the receipt accounts for.',
    see: ['bridge entity', 'render trace'],
  },
  {
    term: 'bake',
    short: 'A frozen layout. Every coordinate on screen is expressed against one.',
    long: 'Positions are computed once and then held. Nothing in the interface recomputes a layout on a read path, because a map that moves when the data did not is a map nobody can remember. A response that references a different bake than the one on screen is a stale frame, and it is detectable rather than merely unlikely.',
    see: ['anchored re-projection', 'spatial memory'],
  },
  {
    term: 'anchored re-projection',
    short: 'A new bake is aligned onto the old one instead of replacing it.',
    long: 'When the corpus changes, a naive re-layout moves everything and destroys the thing that made the terrain worth having. Instead the new embedding is aligned to the previous one by a rigid transform over shared anchor nodes, and the mean drift that remains is reported. A high drift means spatial memory genuinely broke, and the interface says so rather than pretending the map is unchanged.',
    see: ['bake', 'spatial memory'],
  },
  {
    term: 'spatial memory',
    short: 'Knowing where something is on the map without reading a label.',
    long: 'It is the return on looking at a terrain more than once, and it is fragile: it survives new data only if positions and hues are stable across bakes. Community hue is a stable hash of the community id for exactly this reason.',
    see: ['anchored re-projection', 'community hue'],
  },
  {
    term: 'community hue',
    short: 'A cluster’s colour, derived from a stable hash of its id.',
    long: 'Eight hue families, assigned by hashing the community identifier, so a cluster keeps its colour across a re-layout. Hue is constant down the spine — the continent wash, the island, and the documents inside it are all the same family — which is why the hue tells you where you are before any label does.',
    see: ['spatial memory'],
  },
  {
    term: 'corpus provenance',
    short: 'Where the content in a response came from. Stamped on every envelope.',
    long: 'In this build the value is `synthetic-design-concept`: the world is generated and reproducible from a seed. The engine stamps it on every response and this interface surfaces it rather than filtering it out, because a synthetic receipt that looks like a real one is a forgery regardless of intent.',
    see: ['render trace'],
  },
] as const satisfies readonly GlossaryEntry[]);

/** O(1) lookup by exact term. */
export const GLOSSARY_BY_TERM: ReadonlyMap<string, GlossaryEntry> = new Map(
  GLOSSARY.map((entry) => [entry.term.toLowerCase(), entry]),
);

/**
 * Find an entry by term, case-insensitively. Returns `undefined` rather than a
 * placeholder: a tooltip with no definition should not render, and a tooltip
 * containing "no definition available" is worse than none at all.
 */
export function glossaryFor(term: string): GlossaryEntry | undefined {
  return GLOSSARY_BY_TERM.get(term.trim().toLowerCase());
}

/* -----------------------------------------------------------------------------
 * DEV-TIME SELF-CHECK — a `see` pointing at nothing is a dead link in a glossary,
 * which is exactly the sort of small rot that makes a reference stop being used.
 * -------------------------------------------------------------------------- */

const __DEV__ = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);

if (__DEV__) {
  const dangling: string[] = [];
  for (const entry of GLOSSARY) {
    for (const ref of entry.see ?? []) {
      if (!GLOSSARY_BY_TERM.has(ref.toLowerCase())) {
        dangling.push(`"${entry.term}" -> "${ref}"`);
      }
    }
  }
  if (dangling.length > 0) {
    // eslint-disable-next-line no-console
    console.error('[copy/glossary] cross-references pointing at nothing:\n' + dangling.join('\n'));
  }
}
