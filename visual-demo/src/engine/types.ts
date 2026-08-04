/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — ENGINE SCHEMA
 * =============================================================================
 *
 * This file is the API contract of a real engine, not a bag of demo props.
 * Written once, imported by everyone. Nobody downstream invents a field name.
 *
 * The shapes below are deliberately designed so that swapping the synthetic
 * corpus for a live TLDR-G backend is a BASE-URL CHANGE, not a rewrite. That is
 * why the response envelopes carry `bake_id`, `trace_id`, `latency_ms`,
 * `cache_hits` and `content_hash` even though the demo computes them locally:
 * the demo has to be shaped like the truth, or it teaches the wrong thing.
 *
 * -----------------------------------------------------------------------------
 * THE GRAIN (non-negotiable — the whole schema is a restatement of this)
 * -----------------------------------------------------------------------------
 *   Asset   = MOLECULE. The authored artifact with a DECLARED BOUNDARY
 *             (contract, paper, thread, PR, chapter, dated session). It is the
 *             semantic/LOD unit and the extraction context. Everything the
 *             engine reasons about "as one thing" is an Asset.
 *   Entity  = ATOM. The named concept. An Asset is a bounded graph of entities
 *             joined by typed relations.
 *   Passage = the verbatim sub-Asset span. Carries the LOD_0 provenance
 *             guarantee and is the embedding-retrieval entry point. Passages
 *             live INSIDE Assets (they share `asset_id`). A passage is never
 *             the molecule and never an entity.
 *   Source  = the ingested document. Its `seq === 0` segment is the verbatim
 *             text; `content_hash` is computed over those verbatim bytes.
 *
 * TWO OVERLAPPING STRUCTURES, both present in the data at all times:
 *   1. THE CONTAINMENT SPINE (the rungs) — continent > island > asset > passage.
 *      Strictly hierarchical. This is where you *are*.
 *   2. THE ENTITY LAYER — entities extracted from passages, joined by typed
 *      relations. CROSS-CUTTING: one entity is mentioned across many assets and
 *      often across many islands. An entity whose mentions span two islands is
 *      a BRIDGE ENTITY (`Entity.is_bridge`). Bridge entities are what make an
 *      answer constellation span islands, and the edges through them are what
 *      visually cross the strait.
 *
 * The spine gives you place. The entity layer gives you paths. Both must be in
 * the payload or the terrain is a lie.
 * =============================================================================
 */

/* =============================================================================
 * 0. PROVENANCE OF THE DEMO ITSELF
 * ========================================================================== */

/**
 * Every invented number, answer, quote and citation in this build must ship
 * VISIBLY LABELLED as a design concept. Every top-level API response carries
 * `corpus_provenance`, and the UI is required to surface it — not bury it in a
 * tooltip. A synthetic receipt that looks like a real receipt is a forgery,
 * even when the forger meant well.
 */
export type CorpusProvenance = 'synthetic-design-concept';

/** The only legal value of `corpus_provenance` in this build. */
export const CORPUS_PROVENANCE: CorpusProvenance = 'synthetic-design-concept';

/** ISO-8601 timestamp string, e.g. `2026-07-27T09:14:22.031Z`. */
export type IsoTimestamp = string;

/**
 * Lowercase hex SHA-256 digest, 64 chars.
 * TRUST GUARANTEE: wherever this type appears the hash is computed over
 * VERBATIM SOURCE BYTES, never over a summary, a normalisation or a
 * re-serialisation. It is the thing that makes a citation checkable.
 */
export type ContentHash = string;

/* =============================================================================
 * 1. THE RUNGS
 * ========================================================================== */

/**
 * The containment spine. EXACTLY THREE RUNGS, in descent order.
 *
 * There is NO "universe" rung — the top of the world is the set of continents.
 * Verbatim evidence is NOT a rung either: it lives inside a Passage as the
 * `seq === 0` segment of its Source.
 *
 * AND THE PASSAGE IS NOT A RUNG. It was one until 2026-08-02. The change is not
 * a simplification — it is the floor model
 * (`docs/design/arch-entity-rung-containment-vs-projection-2026-07-31.md` §8):
 * the Asset is the last DECLARED stratum, so descent ends there. Below it there
 * is no "down", only "within" — one plane covered twice, by passages
 * (boundary-respecting) and by entities+edges (boundary-crossing). Which
 * covering you are looking at is `assetTiling`, not a depth.
 *
 * A passage is therefore still a NODE — see `NodeKind`, which keeps it — with a
 * kind, a glyph and a position. It is simply not a place you can stand. The
 * deliberate consequence is that `Rung` is a STRICT SUBSET of `NodeKind`, and
 * anything that used to switch on "the rung of this node" must now decide which
 * of the two it meant. Use `KIND_GLYPH` when the answer is "any node", and
 * `RUNG_GLYPH` only when it is "a level of the spine".
 *
 * Adding a fourth rung breaks the zoom semantics, the LOD budget and the
 * breadcrumb, in that order.
 */
export type Rung = 'continent' | 'island' | 'asset';

/** The three rungs in descent order. Index === depth. */
export const RUNGS = Object.freeze(['continent', 'island', 'asset'] as const);

/**
 * The glyph for each rung. Used in breadcrumbs, legends and node badges so the
 * rung is readable at any zoom without a word. Diamond = landmass, hexagon =
 * island, bar = a bounded document.
 */
export const RUNG_GLYPH: Readonly<Record<Rung, string>> = Object.freeze({
  continent: '◆', // ◆
  island: '⬢', // ⬢
  asset: '▮', // ▮
});

/**
 * The glyph for ANY node kind — the superset `RUNG_GLYPH` used to be before the
 * passage stopped being a rung. A passage still gets its dot: it is drawn, it is
 * labelled and it is picked, so its mark outlives its rung. Entities and sources
 * are the cross-cutting layer and get no spine mark, because giving them one
 * would be a lie about the grain.
 */
export const KIND_GLYPH: Readonly<Record<NodeKind, string>> = Object.freeze({
  continent: '◆', // ◆
  island: '⬢', // ⬢
  asset: '▮', // ▮
  passage: '·', // ·
  entity: '',
  source: '',
});

/** Depth of a rung on the spine: continent 0 .. asset 2. */
export const RUNG_DEPTH: Readonly<Record<Rung, number>> = Object.freeze({
  continent: 0,
  island: 1,
  asset: 2,
});

/**
 * WHAT THE ENGINE WILL SERVE AS A GRAPH VIEW. The three rungs, plus `passage`.
 *
 * `passage` is a VIEW KEY and not a rung: `GET /graph/view/passage/{assetId}`
 * is how the reading-order tiling of one asset is fetched, and it is the only
 * request that returns an asset-scoped entity set (see `graphView`). Keeping it
 * out of `RUNGS` while keeping it here is the whole point of the split — you can
 * ask for the view without being able to stand in it.
 */
export const VIEW_KEYS = Object.freeze([...RUNGS, 'passage'] as const);

/** A thing `GET /graph/view/{key}` will accept. Superset of `Rung`. */
export type ViewKey = (typeof VIEW_KEYS)[number];

/**
 * THE TWO TILINGS OF AN ASSET — the floor model made operable.
 *
 * When you are standing on an asset (`assetId !== null`) there is no further
 * "down": the Asset is the last declared stratum. There is only "within", and
 * within is one surface covered TWICE —
 *
 *   'reading'  the boundary-RESPECTING covering: the asset's own passages, laid
 *              out at their true character offsets inside the declared boundary.
 *              A partition: every byte belongs to exactly one passage.
 *   'graph'    the boundary-CROSSING covering: the entities and typed relations
 *              the asset mentions. NOT a partition — entities overlap and they
 *              leave gaps, because not every span mentions something.
 *
 * This is deliberately NOT a `Lens` and NOT a `ResultTab`. A lens is a workspace
 * and pushes history; a tab is a detail surface. A tiling is neither: it is a
 * projection of the place you are already standing in, so Back must never pop it
 * and the breadcrumb must never grow a segment for it.
 *
 * Canon: docs/design/arch-entity-rung-containment-vs-projection-2026-07-31.md §8.
 */
export type AssetTiling = 'reading' | 'graph';

/** Both tilings, in the order the control renders them. Reading first: it is the declared one. */
export const ASSET_TILINGS: readonly AssetTiling[] = Object.freeze(['reading', 'graph'] as const);

/* =============================================================================
 * 2. SIGMA CLASSES + THE RELATION VOCABULARY
 * ========================================================================== */

/**
 * The sigma-class of a relation family — what KIND of claim the edge makes.
 *
 *   factual     - state of the world: composition, ownership, identity, role.
 *   temporal    - when, ordering, validity windows, supersession.
 *   causal      - because, enables, prevents, depends on.
 *   episodic    - discrete events that happened to somebody: acquisitions,
 *                 filings, participations.
 *   authorial   - who said it and where it came from: authorship, citation,
 *                 derivation, quotation.
 *   structural  - THE UNDERSCORE-TOKEN CLASS. The Reading-Order Fiber and the
 *                 co-document skeleton.
 *
 * TRUTH GATE: `structural` is EXEMPT. Structural edges assert nothing about the
 * world — `_follows` says "this passage came after that one in the document",
 * which is a fact about the file, not a claim to be verified. Gating them would
 * quarantine the graph's own skeleton and the terrain would fall apart into
 * unconnected dust. Every other sigma-class IS gated: see `Edge.quarantined`
 * and `IntegrityResponse.truth_gate_exempt_structural`.
 */
export type SigmaClass =
  | 'factual'
  | 'temporal'
  | 'causal'
  | 'episodic'
  | 'authorial'
  | 'structural';

/** All six sigma-classes. The first five are truth-gated; `structural` is not. */
export const SIGMA_CLASSES = Object.freeze([
  'factual',
  'temporal',
  'causal',
  'episodic',
  'authorial',
  'structural',
] as const);

/**
 * Loose shape used only to `satisfies`-check the table below. The strict,
 * public shape is `RelationFamilyDef`, where `family` and `inverse` are narrowed
 * to the `RelationFamily` union derived from the table itself.
 */
interface RelationFamilySpec {
  readonly family: string;
  readonly sigma: SigmaClass;
  readonly inverse: string | null;
  readonly label: string;
  readonly truthGated: boolean;
}

/**
 * The relation vocabulary: 84 typed families across the five semantic
 * sigma-classes, plus the 7 underscore-prefixed structural tokens = 91 total.
 *
 * Breakdown: factual 34 - temporal 14 - causal 12 - episodic 11 - authorial 13
 *            - structural 7.
 *
 * INVERSE CONSISTENCY IS ENFORCED: if `a.inverse === b.family` then
 * `b.inverse === a.family`. Self-inverse families (`same_as`, `overlaps`,
 * `_co_doc`, ...) name themselves. Families with no natural inverse declare
 * `null` — an inverse of `occurred_at` would be a date pointing at an event,
 * which is not a relation anybody traverses. Run `assertInverseConsistency()`
 * to check; it is called in dev on module load.
 */
const RELATION_FAMILY_TABLE = [
  /* ---------------------------------------------------------------------
   * FACTUAL (34) — the state of the world.
   * ------------------------------------------------------------------ */
  { family: 'part_of', sigma: 'factual', inverse: 'has_part', label: 'part of', truthGated: true },
  { family: 'has_part', sigma: 'factual', inverse: 'part_of', label: 'has part', truthGated: true },
  { family: 'contains', sigma: 'factual', inverse: 'contained_in', label: 'contains', truthGated: true },
  { family: 'contained_in', sigma: 'factual', inverse: 'contains', label: 'contained in', truthGated: true },
  { family: 'is_a', sigma: 'factual', inverse: 'has_subtype', label: 'is a', truthGated: true },
  { family: 'has_subtype', sigma: 'factual', inverse: 'is_a', label: 'has subtype', truthGated: true },
  { family: 'instance_of', sigma: 'factual', inverse: 'has_instance', label: 'instance of', truthGated: true },
  { family: 'has_instance', sigma: 'factual', inverse: 'instance_of', label: 'has instance', truthGated: true },
  { family: 'made_of', sigma: 'factual', inverse: 'material_in', label: 'made of', truthGated: true },
  { family: 'material_in', sigma: 'factual', inverse: 'made_of', label: 'material in', truthGated: true },
  { family: 'has_attribute', sigma: 'factual', inverse: 'attribute_of', label: 'has attribute', truthGated: true },
  { family: 'attribute_of', sigma: 'factual', inverse: 'has_attribute', label: 'attribute of', truthGated: true },
  { family: 'owns', sigma: 'factual', inverse: 'owned_by', label: 'owns', truthGated: true },
  { family: 'owned_by', sigma: 'factual', inverse: 'owns', label: 'owned by', truthGated: true },
  { family: 'operates', sigma: 'factual', inverse: 'operated_by', label: 'operates', truthGated: true },
  { family: 'operated_by', sigma: 'factual', inverse: 'operates', label: 'operated by', truthGated: true },
  { family: 'located_in', sigma: 'factual', inverse: 'location_of', label: 'located in', truthGated: true },
  { family: 'location_of', sigma: 'factual', inverse: 'located_in', label: 'location of', truthGated: true },
  { family: 'member_of', sigma: 'factual', inverse: 'has_member', label: 'member of', truthGated: true },
  { family: 'has_member', sigma: 'factual', inverse: 'member_of', label: 'has member', truthGated: true },
  { family: 'subsidiary_of', sigma: 'factual', inverse: 'has_subsidiary', label: 'subsidiary of', truthGated: true },
  { family: 'has_subsidiary', sigma: 'factual', inverse: 'subsidiary_of', label: 'has subsidiary', truthGated: true },
  { family: 'supplies', sigma: 'factual', inverse: 'supplied_by', label: 'supplies', truthGated: true },
  { family: 'supplied_by', sigma: 'factual', inverse: 'supplies', label: 'supplied by', truthGated: true },
  { family: 'regulates', sigma: 'factual', inverse: 'regulated_by', label: 'regulates', truthGated: true },
  { family: 'regulated_by', sigma: 'factual', inverse: 'regulates', label: 'regulated by', truthGated: true },
  { family: 'identifies', sigma: 'factual', inverse: 'identified_by', label: 'identifies', truthGated: true },
  { family: 'identified_by', sigma: 'factual', inverse: 'identifies', label: 'identified by', truthGated: true },
  { family: 'has_role', sigma: 'factual', inverse: 'role_of', label: 'has role', truthGated: true },
  { family: 'role_of', sigma: 'factual', inverse: 'has_role', label: 'role of', truthGated: true },
  /* self-inverse: the relation reads identically in both directions. */
  { family: 'same_as', sigma: 'factual', inverse: 'same_as', label: 'same as', truthGated: true },
  { family: 'differs_from', sigma: 'factual', inverse: 'differs_from', label: 'differs from', truthGated: true },
  { family: 'adjacent_to', sigma: 'factual', inverse: 'adjacent_to', label: 'adjacent to', truthGated: true },
  /* no natural inverse: the object is a unit, not a traversable node. */
  { family: 'denominated_in', sigma: 'factual', inverse: null, label: 'denominated in', truthGated: true },

  /* ---------------------------------------------------------------------
   * TEMPORAL (14) — when, in what order, and for how long.
   * ------------------------------------------------------------------ */
  { family: 'occurred_at', sigma: 'temporal', inverse: null, label: 'occurred at', truthGated: true },
  { family: 'started_at', sigma: 'temporal', inverse: null, label: 'started at', truthGated: true },
  { family: 'ended_at', sigma: 'temporal', inverse: null, label: 'ended at', truthGated: true },
  { family: 'valid_from', sigma: 'temporal', inverse: null, label: 'valid from', truthGated: true },
  { family: 'valid_until', sigma: 'temporal', inverse: null, label: 'valid until', truthGated: true },
  { family: 'scheduled_for', sigma: 'temporal', inverse: null, label: 'scheduled for', truthGated: true },
  { family: 'before', sigma: 'temporal', inverse: 'after', label: 'before', truthGated: true },
  { family: 'after', sigma: 'temporal', inverse: 'before', label: 'after', truthGated: true },
  { family: 'during', sigma: 'temporal', inverse: 'spans', label: 'during', truthGated: true },
  { family: 'spans', sigma: 'temporal', inverse: 'during', label: 'spans', truthGated: true },
  { family: 'supersedes', sigma: 'temporal', inverse: 'superseded_by', label: 'supersedes', truthGated: true },
  { family: 'superseded_by', sigma: 'temporal', inverse: 'supersedes', label: 'superseded by', truthGated: true },
  { family: 'overlaps', sigma: 'temporal', inverse: 'overlaps', label: 'overlaps', truthGated: true },
  { family: 'concurrent_with', sigma: 'temporal', inverse: 'concurrent_with', label: 'concurrent with', truthGated: true },

  /* ---------------------------------------------------------------------
   * CAUSAL (12) — the because-layer. Six symmetric pairs.
   * ------------------------------------------------------------------ */
  { family: 'causes', sigma: 'causal', inverse: 'caused_by', label: 'causes', truthGated: true },
  { family: 'caused_by', sigma: 'causal', inverse: 'causes', label: 'caused by', truthGated: true },
  { family: 'enables', sigma: 'causal', inverse: 'enabled_by', label: 'enables', truthGated: true },
  { family: 'enabled_by', sigma: 'causal', inverse: 'enables', label: 'enabled by', truthGated: true },
  { family: 'prevents', sigma: 'causal', inverse: 'prevented_by', label: 'prevents', truthGated: true },
  { family: 'prevented_by', sigma: 'causal', inverse: 'prevents', label: 'prevented by', truthGated: true },
  { family: 'triggers', sigma: 'causal', inverse: 'triggered_by', label: 'triggers', truthGated: true },
  { family: 'triggered_by', sigma: 'causal', inverse: 'triggers', label: 'triggered by', truthGated: true },
  { family: 'contributes_to', sigma: 'causal', inverse: 'has_contributor', label: 'contributes to', truthGated: true },
  { family: 'has_contributor', sigma: 'causal', inverse: 'contributes_to', label: 'has contributor', truthGated: true },
  { family: 'depends_on', sigma: 'causal', inverse: 'required_by', label: 'depends on', truthGated: true },
  { family: 'required_by', sigma: 'causal', inverse: 'depends_on', label: 'required by', truthGated: true },

  /* ---------------------------------------------------------------------
   * EPISODIC (11) — discrete events that happened to somebody.
   * `acquired` is the second link of the demo's gold chain.
   * ------------------------------------------------------------------ */
  { family: 'acquired', sigma: 'episodic', inverse: 'acquired_by', label: 'acquired', truthGated: true },
  { family: 'acquired_by', sigma: 'episodic', inverse: 'acquired', label: 'acquired by', truthGated: true },
  { family: 'divested', sigma: 'episodic', inverse: 'divested_by', label: 'divested', truthGated: true },
  { family: 'divested_by', sigma: 'episodic', inverse: 'divested', label: 'divested by', truthGated: true },
  { family: 'participated_in', sigma: 'episodic', inverse: 'had_participant', label: 'participated in', truthGated: true },
  { family: 'had_participant', sigma: 'episodic', inverse: 'participated_in', label: 'had participant', truthGated: true },
  { family: 'attended', sigma: 'episodic', inverse: null, label: 'attended', truthGated: true },
  { family: 'filed', sigma: 'episodic', inverse: null, label: 'filed', truthGated: true },
  { family: 'announced', sigma: 'episodic', inverse: null, label: 'announced', truthGated: true },
  { family: 'commissioned', sigma: 'episodic', inverse: null, label: 'commissioned', truthGated: true },
  { family: 'decommissioned', sigma: 'episodic', inverse: null, label: 'decommissioned', truthGated: true },

  /* ---------------------------------------------------------------------
   * AUTHORIAL (13) — who said it, and where it came from.
   * This class is what the EVIDENCE LIGHT is drawn from.
   * ------------------------------------------------------------------ */
  { family: 'authored', sigma: 'authorial', inverse: 'authored_by', label: 'authored', truthGated: true },
  { family: 'authored_by', sigma: 'authorial', inverse: 'authored', label: 'authored by', truthGated: true },
  { family: 'derived_from', sigma: 'authorial', inverse: 'has_derivative', label: 'derived from', truthGated: true },
  { family: 'has_derivative', sigma: 'authorial', inverse: 'derived_from', label: 'has derivative', truthGated: true },
  { family: 'cites', sigma: 'authorial', inverse: 'cited_by', label: 'cites', truthGated: true },
  { family: 'cited_by', sigma: 'authorial', inverse: 'cites', label: 'cited by', truthGated: true },
  { family: 'quotes', sigma: 'authorial', inverse: 'quoted_by', label: 'quotes', truthGated: true },
  { family: 'quoted_by', sigma: 'authorial', inverse: 'quotes', label: 'quoted by', truthGated: true },
  { family: 'edited', sigma: 'authorial', inverse: 'edited_by', label: 'edited', truthGated: true },
  { family: 'edited_by', sigma: 'authorial', inverse: 'edited', label: 'edited by', truthGated: true },
  { family: 'summarizes', sigma: 'authorial', inverse: 'summarized_by', label: 'summarizes', truthGated: true },
  { family: 'summarized_by', sigma: 'authorial', inverse: 'summarizes', label: 'summarized by', truthGated: true },
  { family: 'attributed_to', sigma: 'authorial', inverse: null, label: 'attributed to', truthGated: true },

  /* ---------------------------------------------------------------------
   * STRUCTURAL (7) — the underscore tokens. The Reading-Order Fiber and the
   * co-document skeleton. THESE ARE THE GRAPH'S SKELETON AND ARE EXEMPT FROM
   * THE TRUTH GATE (`truthGated: false`): they describe the artifact, not the
   * world, so there is nothing about them to verify. Quarantining them would
   * disconnect the terrain.
   * ------------------------------------------------------------------ */
  { family: '_follows', sigma: 'structural', inverse: '_precedes', label: 'follows (reading order)', truthGated: false },
  { family: '_precedes', sigma: 'structural', inverse: '_follows', label: 'precedes (reading order)', truthGated: false },
  { family: '_co_doc', sigma: 'structural', inverse: '_co_doc', label: 'same document', truthGated: false },
  { family: '_mentioned_before', sigma: 'structural', inverse: null, label: 'mentioned earlier in document', truthGated: false },
  { family: '_session_follows', sigma: 'structural', inverse: '_session_precedes', label: 'session follows', truthGated: false },
  { family: '_session_precedes', sigma: 'structural', inverse: '_session_follows', label: 'session precedes', truthGated: false },
  { family: '_covers_period', sigma: 'structural', inverse: null, label: 'covers period', truthGated: false },
] as const satisfies readonly RelationFamilySpec[];

/**
 * Every legal relation family token. Derived from the table so the union and
 * the data can never drift apart.
 */
export type RelationFamily = (typeof RELATION_FAMILY_TABLE)[number]['family'];

/** A single entry in the relation vocabulary. */
export interface RelationFamilyDef {
  /** The wire token, e.g. `operates`, `_follows`. snake_case; `_`-prefixed = structural. */
  readonly family: RelationFamily;
  /** Which kind of claim the edge makes. Drives colour, bundling and gating. */
  readonly sigma: SigmaClass;
  /** The family you get by reversing the edge, or `null` if reversal is meaningless. */
  readonly inverse: RelationFamily | null;
  /** Human label for legends, edge tooltips and the path readout. Lowercase. */
  readonly label: string;
  /** `false` ONLY for the structural class. See `SigmaClass` docs. */
  readonly truthGated: boolean;
}

/** The frozen relation vocabulary. 91 families: 84 semantic + 7 structural. */
export const RELATION_FAMILIES: readonly RelationFamilyDef[] =
  Object.freeze(RELATION_FAMILY_TABLE as readonly RelationFamilyDef[]);

/** O(1) lookup from family token to its definition. */
export const byFamily: Readonly<Record<RelationFamily, RelationFamilyDef>> = Object.freeze(
  RELATION_FAMILIES.reduce((acc, def) => {
    acc[def.family] = def;
    return acc;
  }, {} as Record<RelationFamily, RelationFamilyDef>),
);

/** True when the family is one of the underscore-prefixed structural tokens. */
export function isStructural(family: RelationFamily): boolean {
  return byFamily[family].sigma === 'structural';
}

/**
 * True when an edge of this family must pass the truth gate before it may be
 * admitted to an answer. Equivalent to `!isStructural(family)`, expressed
 * separately because the gate is a policy and the class is a taxonomy.
 */
export function isTruthGated(family: RelationFamily): boolean {
  return byFamily[family].truthGated;
}

/**
 * Verify inverse mutual consistency across the whole vocabulary.
 * Returns the list of violations; empty means the table is sound.
 * THIS WILL BE CHECKED — do not edit the table without re-running it.
 */
export function assertInverseConsistency(): string[] {
  const errors: string[] = [];
  for (const def of RELATION_FAMILIES) {
    if (def.inverse === null) continue;
    const other = byFamily[def.inverse];
    if (!other) {
      errors.push(`"${def.family}".inverse -> "${def.inverse}" which is not a declared family`);
      continue;
    }
    if (other.inverse !== def.family) {
      errors.push(
        `"${def.family}".inverse === "${def.inverse}" but "${other.family}".inverse === ` +
          `"${String(other.inverse)}" (expected "${def.family}")`,
      );
    }
    if (other.sigma !== def.sigma) {
      errors.push(`"${def.family}" (${def.sigma}) and its inverse "${other.family}" (${other.sigma}) disagree on sigma`);
    }
  }
  return errors;
}

/* =============================================================================
 * 3. RESOLUTION RAMP + NODE KINDS
 * ========================================================================== */

/**
 * The five-state resolution ramp. This is a VISUAL STATE MACHINE, and it is the
 * engine's rendering decision made visible — not a styling preference.
 *
 *   lod-0   verbatim / fovea    the passage is being read to you, in full
 *   lod-1   summary / penumbra  the node's summary was spent on
 *   lod-2   label / periphery   only the label was spent on
 *   ghost   present, not spent on; label on hover only
 *   latent  outline only — LOAD-BEARING. It exists so the terrain NEVER has
 *           holes. Content the engine omitted is still present as topology.
 *           "Omitted" is a budget decision, not a deletion.
 *
 * Opacities/strokes for each state live in design-tokens.css §7 and are read
 * through `@/styles/tokens.ts`. Never hardcode them.
 */
export type LodState = 'lod-0' | 'lod-1' | 'lod-2' | 'ghost' | 'latent';

/** The five LOD states in ramp order, sharpest first. */
export const LOD_STATES = Object.freeze(['lod-0', 'lod-1', 'lod-2', 'ghost', 'latent'] as const);

/**
 * What a drawable node actually is.
 *
 * Note this is NOT the same set as `Rung`: `entity` and `source` are real nodes
 * that are not rungs. Entities are the cross-cutting layer; sources sit behind
 * passages carrying the verbatim bytes. Conflating the two sets is the single
 * most common way to break the grain.
 */
export type NodeKind = 'continent' | 'island' | 'asset' | 'entity' | 'passage' | 'source';

/* =============================================================================
 * 4. THE CONTAINMENT SPINE — Continent / Island / Asset / Passage
 * ========================================================================== */

/** Fields every node in the graph carries, regardless of kind. */
export interface NodeBase {
  /** Stable identifier. Survives re-bakes; never reuse an id for new content. */
  id: string;
  /** Discriminant for the `GraphNode` union. */
  kind: NodeKind;
  /** Display label. May be truncated by the renderer; never truncate at source. */
  label: string;
  /**
   * Community assignment from the clustering pass. Drives the hue family via
   * `hueForCommunity()`'s stable hash, so a re-bake keeps the colour.
   */
  community_id: string;
  /** Normalised 0..1 centrality within the current view. Drives node radius. */
  centrality: number;
  /** Raw edge count (both directions, structural included). Monospaced in UI. */
  degree: number;
  /** When this node was materialised by the engine. */
  created_at: IsoTimestamp;
}

/**
 * RUNG 0. A continent is a top-level semantic region — the coarsest grouping of
 * islands. It renders its community hue as a low-saturation region wash so you
 * can tell where you are from maximum zoom-out without a single label.
 */
export interface Continent extends NodeBase {
  kind: 'continent';
  /** Continents have no parent. The world is a set of continents; there is no universe rung. */
  parent_id: null;
  /** Island ids contained by this continent (spine, downward). */
  island_ids: string[];
  /** Total assets beneath, transitively. Monospaced readout. */
  asset_count: number;
  /** Total passages beneath, transitively. Drives the LOD budget preview. */
  passage_count: number;
  /** One-line characterisation of the region, used at lod-1. */
  summary: string;
}

/**
 * RUNG 1. An island is a coherent cluster of assets inside a continent.
 * Islands are what STRAITS run between — an edge that leaves an island is the
 * visual event the demo is built around.
 */
export interface Island extends NodeBase {
  kind: 'island';
  /** The continent that contains this island. */
  parent_id: string;
  /** Asset ids contained by this island (spine, downward). */
  asset_ids: string[];
  /**
   * Entity ids that are mentioned here AND on at least one other island.
   * These are the bridge entities; the strait crossings run through them.
   */
  bridge_entity_ids: string[];
  passage_count: number;
  summary: string;
}

/**
 * The kinds of DECLARED BOUNDARY an asset can have. The boundary is what makes
 * an asset a molecule: somebody, at some point, said "this is one thing" — a
 * signed contract, a submitted paper, a merged PR, a dated session. If you
 * cannot name the boundary, you do not have an asset, you have a pile of text.
 */
export type BoundaryKind = 'contract' | 'paper' | 'thread' | 'pr' | 'chapter' | 'session';

/**
 * RUNG 2. THE MOLECULE. The authored artifact with a declared boundary. This is
 * the semantic and LOD unit, and the extraction context: entities and relations
 * are extracted WITHIN an asset's boundary, which is why the same surface form
 * in two assets may be two different entities until reconciled.
 */
export interface Asset extends NodeBase {
  kind: 'asset';
  /** The island that contains this asset. */
  parent_id: string;
  /** Denormalised continent id, so a renderer can wash by region without a join. */
  continent_id: string;
  /** What kind of boundary this artifact declares. */
  boundary_kind: BoundaryKind;
  /**
   * When the boundary was DECLARED — the contract's execution date, the paper's
   * submission, the PR's merge, the session's date. Not the ingest time. This
   * is the timestamp temporal relations are anchored against.
   */
  boundary_declared_at: IsoTimestamp;
  /** The `Source` this asset was extracted from. Provenance root of every passage below. */
  source_id: string;
  /** Passage ids inside this asset, in reading order (matching `Passage.seq`). */
  passage_ids: string[];
  /** Entity ids extracted anywhere inside this asset. Cross-cutting layer, upward link. */
  entity_ids: string[];
  /** Total tokens across the asset's passages. The denominator of the render budget. */
  token_count: number;
  /** Engine-generated abstract, shown at lod-1. NOT verbatim — never cite this. */
  summary: string;
}

/**
 * How much a passage's text has been transformed away from the bytes on disk.
 * TRUST GUARANTEE — this is the RESOLUTION DISCLOSURE. A citation that has been
 * coref- or term-resolved is no longer literally what the document says, and
 * the UI must say so next to the quote. Never render `coref_resolved` text as
 * though it were `verbatim`.
 *
 *   verbatim        - byte-identical to the source span. The LOD_0 guarantee.
 *   coref_resolved  - pronouns/anaphora replaced with their referents.
 *   term_resolved   - abbreviations/aliases normalised to canonical terms.
 */
export type PassageResolution = 'verbatim' | 'coref_resolved' | 'term_resolved';

/**
 * RUNG 3. The verbatim sub-asset span. Carries the LOD_0 provenance guarantee
 * and is the embedding-retrieval entry point.
 *
 * A passage lives INSIDE an asset — it shares `asset_id` with its siblings and
 * has no independent existence. It is never the molecule and never an entity.
 */
export interface Passage extends NodeBase {
  kind: 'passage';
  /** The asset that contains this passage. Same value as `asset_id`; kept for spine walks. */
  parent_id: string;
  /** The containing asset (the molecule). Passages in one asset share this. */
  asset_id: string;
  /** The ingested document these bytes came from. */
  source_id: string;
  /** Reading-order index within the asset, 0-based. Drives `_follows` / `_precedes`. */
  seq: number;
  /** Inclusive character offset into the source's verbatim segment. */
  char_start: number;
  /** Exclusive character offset into the source's verbatim segment. */
  char_end: number;
  /**
   * TRUST GUARANTEE. SHA-256 over the verbatim bytes in
   * `[char_start, char_end)` of the source's `seq === 0` segment. This is what
   * makes the quote checkable after the fact; it is computed over source bytes,
   * never over `text` as displayed if `resolution !== 'verbatim'`.
   */
  content_hash: ContentHash;
  /** The passage text as it will be rendered. See `resolution` before quoting it. */
  text: string;
  /** TRUST GUARANTEE. The resolution disclosure. See `PassageResolution`. */
  resolution: PassageResolution;
  /** Token count of `text`. The unit the render budget is spent in. */
  token_count: number;
  /** Entity ids whose mentions fall inside this passage. */
  entity_ids: string[];
}

/* =============================================================================
 * 5. SOURCE — the ingested document
 * ========================================================================== */

/**
 * One segment of a source document. Segment `seq === 0` is the VERBATIM TEXT;
 * higher seq values are derived layers (normalisations, translations, OCR
 * corrections) and MUST NOT be used to satisfy a citation.
 */
export interface SourceSegment {
  /** 0 = verbatim. This is a hard convention, not a convenience. */
  seq: number;
  /** What this layer is: `verbatim`, `normalized`, `ocr_corrected`, ... */
  kind: string;
  /** The segment's text. */
  text: string;
  /** SHA-256 over this segment's own bytes. */
  content_hash: ContentHash;
}

/** The ingested document. Behind every passage there is exactly one of these. */
export interface Source extends NodeBase {
  kind: 'source';
  parent_id: null;
  /** Original filename / URI / message id as ingested. Shown in provenance rows. */
  locator: string;
  /** MIME-ish type of the ingested artifact. */
  media_type: string;
  /**
   * Layers of this document. `segments[0].seq === 0` is the verbatim text and
   * `content_hash` (below) is computed over THOSE bytes.
   */
  segments: SourceSegment[];
  /**
   * TRUST GUARANTEE. SHA-256 over the verbatim (`seq === 0`) segment's bytes.
   * Every `Passage.content_hash` and every `Citation.content_hash` chains back
   * here. If this changes, every citation against this source is stale.
   */
  content_hash: ContentHash;
  /** When the document entered the system (NOT when it was authored). */
  ingested_at: IsoTimestamp;
  /** Asset ids extracted from this source. Usually one; several for compilations. */
  asset_ids: string[];
}

/* =============================================================================
 * 6. ENTITY — the cross-cutting atom layer
 * ========================================================================== */

/**
 * THE ATOM. The named concept, reconciled across assets.
 *
 * Entities are the only nodes that are NOT on the containment spine, and that
 * is the point: an entity mentioned in assets on two different islands is a
 * BRIDGE, and the path through it is what crosses the strait. Without the
 * entity layer the terrain is four disconnected zoom levels; with it, the
 * terrain has routes.
 */
export interface Entity extends NodeBase {
  kind: 'entity';
  /** Entities float above the spine and have no single parent. */
  parent_id: null;
  /** Canonical name. Aliases live in `aliases`. */
  label: string;
  /** Coarse type: `organization`, `facility`, `person`, `instrument`, ... */
  entity_type: string;
  /** Surface forms that resolve to this entity. Drives `term_resolved` passages. */
  aliases: string[];
  /** Passage ids where this entity is mentioned. The evidence for its existence. */
  mentions: string[];
  /** Assets containing at least one mention. Derived from `mentions`. */
  asset_ids: string[];
  /**
   * Islands containing at least one mentioning asset. Derived from `asset_ids`.
   * When `length > 1` this entity spans a strait.
   */
  island_ids: string[];
  /**
   * TRUE IFF `island_ids.length > 1`. Not an opinion — a derived fact, and the
   * generator must keep it consistent with `island_ids` or the constellation
   * renderer will draw a crossing that the data does not support.
   */
  is_bridge: boolean;
  /** One-line gloss shown at lod-1. */
  summary: string;
}

/* =============================================================================
 * 7. EDGE — a typed relation instance
 * ========================================================================== */

/**
 * One instance of a typed relation between two nodes.
 *
 * Edges carry BOTH `family` and `sigma` denormalised, because the renderer
 * colours and bundles by sigma on the hot path and must not do a table lookup
 * per edge per frame.
 */
export interface Edge {
  /** Stable edge id. */
  id: string;
  /** Source node id (the subject). */
  from_id: string;
  /** Target node id (the object). */
  to_id: string;
  /** The relation family token. Look up its definition in `byFamily`. */
  family: RelationFamily;
  /** Denormalised `byFamily[family].sigma`. Drives colour and bundling. */
  sigma: SigmaClass;
  /**
   * The inverse family, denormalised from the vocabulary. `null` when the
   * relation has no meaningful reversal. Present so a traversal can walk
   * backwards without re-deriving the vocabulary.
   */
  inverse_family: RelationFamily | null;
  /** Layout/bundling weight, 0..1. Higher = shorter rest length, drawn earlier. */
  weight: number;
  /** Extraction confidence, 0..1. Below the gate threshold the edge is quarantined. */
  confidence: number;
  /** Passage ids that evidence this edge. An edge with none cannot be cited. */
  evidence_passage_ids: string[];
  /**
   * TRUST GUARANTEE. True when the truth gate REJECTED this edge. Quarantined
   * edges are still shipped in the payload — they render as `latent` so the
   * terrain shows what was rejected rather than hiding it. They may never be
   * admitted to an answer.
   */
  quarantined: boolean;
  /**
   * TRUST GUARANTEE. Why the gate rejected it, in engine terms
   * (`low_confidence`, `no_evidence_passage`, `contradicts_higher_confidence`,
   * `dangling_endpoint`, ...). `null` iff `quarantined === false`. Never a
   * generic string — this is what `/integrity` groups by.
   */
  quarantine_reason: string | null;
  /** When the edge was extracted. */
  created_at: IsoTimestamp;
  /** True when both endpoints sit on different islands: this edge crosses a strait. */
  crosses_strait: boolean;
}

/**
 * A rendered bundle of edges that share a corridor between two regions.
 * Bundling is how the terrain stays legible: at continent and island rungs the
 * renderer draws corridors, not individual relations.
 */
export interface EdgeBundle {
  id: string;
  /** Region node id the corridor leaves. */
  from_id: string;
  /** Region node id the corridor enters. */
  to_id: string;
  /** Edge ids collapsed into this corridor. */
  edge_ids: string[];
  /** Dominant sigma-class in the bundle. Drives the corridor colour. */
  sigma: SigmaClass;
  /** `edge_ids.length`, denormalised for the readout. */
  count: number;
  /** True when the corridor is a strait: its endpoints are on different islands. */
  is_strait: boolean;
}

/** The discriminated union of everything drawable. Switch on `kind`. */
export type GraphNode = Continent | Island | Asset | Passage | Entity | Source;

/* =============================================================================
 * 8. LAYOUT / GEOMETRY
 * ========================================================================== */

/** A 2D point. Immutable by contract — never mutate a position in place. */
export type Vec2 = readonly [number, number];

/** Axis-aligned world bounds of a view, in layout units. */
export interface Bounds {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

/** A node's baked position in layout space. */
export interface NodePosition {
  /** The node this position belongs to. */
  id: string;
  x: number;
  y: number;
  /** Radius in layout units, derived from centrality. */
  r: number;
  /** Denormalised for hue lookup without a node join on the hot path. */
  community_id: string;
  /** Denormalised node kind, so the renderer can pick a glyph without a join. */
  kind: NodeKind;
  /**
   * The LOD the BAKE suggests at default zoom. A hint, not a decision — the
   * live LOD is chosen per frame by the render budget and by selection. It
   * exists so the first frame after a bake is already correctly ramped.
   */
  lod_hint: LodState;
}

/**
 * The result of re-projecting a new bake onto the previous one.
 *
 * THE ANCHORED RE-PROJECTION. When the corpus changes, a naive re-layout moves
 * everything and destroys the user's spatial memory — the thing that makes a
 * terrain worth having. Instead the new embedding is aligned to the old one by
 * a rigid similarity transform (Procrustes over shared anchor nodes), so
 * "the orange island is up and to the left" stays true across re-bakes.
 * `mean_drift` is the honest readout of how much the world moved anyway.
 */
export interface AnchorAlignment {
  /** Rotation applied to the new embedding, radians. */
  rotation: number;
  /** Uniform scale applied to the new embedding. */
  scale: number;
  /** Translation applied to the new embedding, layout units. */
  translate: Vec2;
  /**
   * Mean displacement of anchor nodes AFTER alignment, in layout units.
   * The instrument's confession: a high value means spatial memory did break,
   * and the UI must say so rather than pretending the map is unchanged.
   */
  mean_drift: number;
}

/** A frozen layout: the positions everything renders against until the next bake. */
export interface LayoutBake {
  /** Identifies this bake. Every `GraphViewResponse` echoes it so stale frames are detectable. */
  bake_id: string;
  /**
   * TRUST GUARANTEE. Hash over the corpus content the bake was computed from.
   * If this does not match the current corpus, the positions on screen are
   * stale and the UI must say so.
   */
  content_hash: ContentHash;
  /** The layout algorithm. Fixed for this build. */
  algo: 'umap-pca-hybrid';
  created_at: IsoTimestamp;
  /** World bounds covering every position in this bake. */
  bounds: Bounds;
  /** Every baked position, keyed off `NodePosition.id`. */
  positions: NodePosition[];
  /** `null` for a first bake — there was nothing to anchor to. */
  anchor_alignment: AnchorAlignment | null;
  corpus_provenance: CorpusProvenance;
}

/* =============================================================================
 * 9. API RESPONSE ENVELOPES
 * -----------------------------------------------------------------------------
 * Shaped as REAL API responses. Swapping the synthetic corpus for a live engine
 * must be a base-URL change, not a rewrite.
 * ========================================================================== */

/**
 * WHY these edges and not others. The visual demo never draws the whole edge set —
 * it draws one of three legible subsets, and it always says which:
 *   trade-route-skeleton  - the high-weight corridors that define the terrain
 *   hover-neighborhood    - the k-hop neighbourhood of the pointer target
 *   query-constellation   - exactly the edges on/adjacent to the answer path
 */
export type DrawnReason = 'trade-route-skeleton' | 'hover-neighborhood' | 'query-constellation';

/** Counts for the view readout. Every field is monospaced in the UI. */
export interface GraphViewStats {
  /** Nodes in the payload, including `latent` ones. */
  node_count: number;
  /** Edges in the payload, including quarantined ones. */
  edge_count: number;
  /** Edges the renderer actually strokes this frame. Always <= `edge_count`. */
  edges_drawn: number;
  /** The rule that chose `edges_drawn`. Shown verbatim in the HUD. */
  drawn_reason: DrawnReason;
}

/** `GET /graph/view/{rung}?parent_id=...` — one rung of the spine, in place. */
export interface GraphViewResponse {
  /** Which VIEW this is — the three rungs plus `passage`. See `ViewKey`. */
  rung: ViewKey;
  /** The containing node. `null` at the continent rung — the world has no parent. */
  parent_id: string | null;
  nodes: GraphNode[];
  edges: Edge[];
  /** Corridors, used instead of raw edges at the coarse rungs. */
  bundles: EdgeBundle[];
  bounds: Bounds;
  /** The bake these coordinates came from. Mismatch = stale frame. */
  bake_id: string;
  stats: GraphViewStats;
  corpus_provenance: CorpusProvenance;
}

/** What the user was actually trying to do. Drives constellation shape and copy. */
export type QueryIntent = 'bridge' | 'lookup' | 'compare' | 'timeline' | 'summarize';

/**
 * How the answer was produced.
 *   deterministic  - graph traversal only. Reproducible; the demo's default.
 *   llm_augmented  - a model participated. Must be disclosed in the UI.
 */
export type QueryMode = 'deterministic' | 'llm_augmented';

/** One hop of the answer path. The chain the user is shown, edge by edge. */
export interface PathStep {
  /** 0-based hop index. */
  index: number;
  from_id: string;
  to_id: string;
  edge_id: string;
  family: RelationFamily;
  sigma: SigmaClass;
  /** True when this hop leaves one island for another — the strait crossing. */
  crosses_strait: boolean;
  /** Passage ids evidencing this hop. Every hop must have at least one. */
  evidence_passage_ids: string[];
}

/** How many families of each class the answer leaned on. Legend + audit. */
export interface FamilyUsage {
  family: RelationFamily;
  sigma: SigmaClass;
  count: number;
}

/**
 * THE RENDER BUDGET READOUT. The centrepiece instrument: it shows that the
 * engine RENDERED an answer at chosen resolutions rather than retrieving a
 * pile of chunks, and it shows the cost of doing so.
 */
export interface RenderStats {
  /** Tokens the renderer was allowed to spend. */
  token_budget: number;
  /** Tokens actually spent. Monospaced. Never round it in the UI. */
  tokens_rendered: number;
  /**
   * What a naive full-context retrieval would have cost for the same question.
   * The honest counterfactual — the number `savings_pct` is measured against.
   */
  counterfactual_tokens: number;
  /** `1 - tokens_rendered / counterfactual_tokens`, as a percentage. */
  savings_pct: number;
  /** Passages rendered at full verbatim resolution. */
  lod0_passages: number;
  /** Nodes rendered as summaries. */
  lod1_context_nodes: number;
  /** Nodes rendered as labels only. */
  lod2_pointer_nodes: number;
  /**
   * Render confidence L, 0..1. The engine's own estimate that the rendering it
   * chose is sufficient for the question. Displayed as a gauge, never as a
   * verdict — a high L with a thin composite is exactly the case the user
   * needs to see.
   */
  render_confidence_L: number;
  /** The four signals L decomposes into. Each 0..1. Shown as a small radar. */
  composite: {
    /** Embedding-space fit between question and admitted passages. */
    semantic: number;
    /** How well-connected the admitted subgraph is. */
    topology: number;
    /** Recency/validity fit of the admitted temporal claims. */
    temporal: number;
    /** Authority and provenance density of the admitted evidence. */
    authorial: number;
  };
  /** Which relation families carried the answer, and how often. */
  families_used: FamilyUsage[];
  /** Cache hits during this render. Monospaced. */
  cache_hits: number;
  /** Cache lookups attempted. `cache_hits / cache_lookups` is the hit rate. */
  cache_lookups: number;
}

/** `POST /query/render` — the answer, plus everything needed to distrust it. */
export interface QueryRenderResponse {
  query_id: string;
  /** The question as asked, verbatim. */
  query: string;
  intent: QueryIntent;
  mode: QueryMode;
  /** The rendered answer text. */
  answer: string;
  /**
   * The known-correct answer, present only for staged demo queries. Its
   * presence is itself a disclosure: this question was set up in advance.
   */
  gold?: string;
  /** Wall-clock latency in ms. Monospaced. Never animate this number. */
  latency_ms: number;
  render_stats: RenderStats;
  /** The subgraph the answer was rendered from — what lights up in the terrain. */
  constellation: {
    /** Every node in the constellation, at any LOD. */
    node_ids: string[];
    /** The ordered chain from question to answer. */
    path: PathStep[];
    /**
     * The entity whose cross-island mentions made the path possible.
     * `null` for intents that do not bridge.
     */
    bridge_entity_id: string | null;
  };
  /** Links this response to its `RenderTraceV1`. Same value on both. */
  trace_id: string;
  corpus_provenance: CorpusProvenance;
}

/* =============================================================================
 * 10. THE RENDER TRACE — the receipt
 * ========================================================================== */

/**
 * One citation. TRUST OBJECT: everything needed for a third party to go back to
 * the original document and check the quote without trusting this application.
 */
export interface Citation {
  citation_id: string;
  /** The passage quoted. */
  passage_id: string;
  /** Its containing asset (the molecule). */
  asset_id: string;
  /** The ingested document behind it. */
  source_id: string;
  /**
   * TRUST GUARANTEE. SHA-256 over the verbatim source bytes for this span.
   * Chains to `Source.content_hash`. If it does not match, the quote is stale
   * or tampered with and the UI must fail loud.
   */
  content_hash: ContentHash;
  /** Reading-order index of the passage inside its asset. */
  seq: number;
  /**
   * TRUST GUARANTEE. The resolution disclosure for `quote`. If this is not
   * `verbatim`, the quote has been transformed and MUST be labelled as such
   * next to the text. Silently presenting resolved text as verbatim is the
   * exact failure this whole schema exists to prevent.
   */
  resolution: PassageResolution;
  /** The quoted text, at the stated `resolution`. */
  quote: string;
  /** Tokens this citation cost the budget. */
  tokens: number;
  /** Why the renderer admitted it, in engine terms. Shown on the citation row. */
  why_admitted: string;
  /** The LOD it was rendered at. Citations are normally `lod-0`. */
  lod: LodState;
}

/** One node the renderer admitted to the context, and what it cost. */
export interface AdmissionRecord {
  node_id: string;
  kind: NodeKind;
  /** The resolution it was admitted at. */
  lod: LodState;
  /** Engine-terms justification, e.g. `on_answer_path`, `bridge_neighbor`. */
  reason: string;
  /** Tokens spent on it. */
  tokens: number;
  /** The admission score that beat the threshold, 0..1. */
  score: number;
}

/**
 * A node that was CONNECTED to the answer but not admitted.
 *
 * This array is the honesty mechanism of the whole product. It is what turns
 * "here is your answer" into "here is your answer, and here is what I chose not
 * to spend on, and how far away it was". Rendered as `latent` in the terrain so
 * the omission is visible as topology rather than as a hole.
 */
export interface Pointer {
  node_id: string;
  kind: NodeKind;
  /** Engine-terms justification, e.g. `budget_exhausted`, `below_threshold`. */
  why_omitted: string;
  /** Hops from the nearest admitted node. 1 = it was one step away. */
  hop_distance: number;
}

/**
 * THE RECEIPT. Version-locked so a trace archived today still verifies later.
 *
 * A render trace is signed over `payload_hash`, which covers the answer, the
 * citations and the admissions. Verification is `VerifyResult`. This object is
 * designed to be exportable and checkable OUTSIDE this application — that is
 * the entire point of signing it.
 */
export interface RenderTraceV1 {
  /** Format discriminant. Bump the literal, never redefine it in place. */
  version: 'visual-demo-trace-v1';
  /** Same value as `QueryRenderResponse.trace_id`. */
  trace_id: string;
  query_id: string;
  /** The question, verbatim. */
  query: string;
  /** Identifier of whatever produced the answer, including `deterministic-traversal`. */
  model: string;
  created_at: IsoTimestamp;
  /**
   * TRUST GUARANTEE. SHA-256 over the canonicalised trace payload (answer +
   * citations + admitted + omitted). This is the thing the signature signs.
   */
  payload_hash: ContentHash;
  /** Every quote used, each independently checkable. */
  citations: Citation[];
  /** Every node admitted to the render, with cost and reason. */
  admitted: AdmissionRecord[];
  /** Everything connected but not spent on. See `Pointer`. */
  omitted_but_connected: Pointer[];
  /**
   * TRUST GUARANTEE. Detached Ed25519 signature over `payload_hash`.
   * `did` identifies the signer, `key_id` the specific key so rotation is
   * possible without invalidating archived traces.
   */
  signature: {
    alg: 'Ed25519';
    /** Decentralised identifier of the signing engine instance. */
    did: string;
    /** Hex- or base64-encoded detached signature. Monospaced in the UI. */
    sig: string;
    /** Which key of the DID signed. Enables rotation. */
    key_id: string;
  };
  corpus_provenance: CorpusProvenance;
}

/** One grouped reason in the integrity report, with examples to click through to. */
export interface IntegrityReason {
  /** Engine-terms reason code, matching `Edge.quarantine_reason`. */
  reason: string;
  count: number;
  /** A few edge ids so the user can go LOOK at what was rejected. */
  example_edge_ids: string[];
}

/**
 * `GET /integrity` — the truth gate's own report card.
 * Shipped in the UI because an engine that only reports its successes is not an
 * instrument, it is an advertisement.
 */
export interface IntegrityResponse {
  /** Every edge the extractor produced, admitted or not. */
  total_edges: number;
  /** Edges that passed the gate. */
  admitted: number;
  /** Edges the gate rejected. Still present in the graph, rendered `latent`. */
  quarantined: number;
  /** Rejections grouped by reason, most common first. */
  by_reason: IntegrityReason[];
  /**
   * Structural (underscore-token) edges that were never gated, because the
   * structural sigma-class is EXEMPT. Reported separately and explicitly so the
   * exemption is visible rather than looking like an inflated pass rate.
   */
  truth_gate_exempt_structural: number;
  corpus_provenance: CorpusProvenance;
}

/** The outcome of verifying a `RenderTraceV1`. Both halves must pass. */
export interface VerifyResult {
  /** `payload_hash_matches && signature_valid`. The only field a badge may read. */
  valid: boolean;
  /** Human-readable verdict for the badge, e.g. `signature valid, payload intact`. */
  verdict: string;
  /** TRUST GUARANTEE. Recomputed payload hash equals the one in the trace. */
  payload_hash_matches: boolean;
  /** TRUST GUARANTEE. Ed25519 signature verifies against the DID's key. */
  signature_valid: boolean;
  checked_at: IsoTimestamp;
  /** The DID that was checked against. */
  did: string;
  corpus_provenance: CorpusProvenance;
}

/* =============================================================================
 * 11. APP STATE — shared across every agent's UI
 * ========================================================================== */

/**
 * The application's lifecycle states. Every screen must be designed for ALL of
 * them; there is no "and then it just works" state.
 *
 *   FIRST-RUN  - never used before; the terrain has to explain itself
 *   EMPTY      - configured, no corpus. Not an error — an invitation
 *   INGESTING  - documents arriving; the terrain is growing on screen
 *   SETTLING   - layout baking; positions still moving
 *   READY      - the normal state
 *   QUERYING   - a render is in flight; the constellation is assembling
 *   DEGRADED   - something failed and we are saying so. See `DegradedReason`
 */
export type AppState =
  | 'FIRST-RUN'
  | 'EMPTY'
  | 'INGESTING'
  | 'SETTLING'
  | 'READY'
  | 'QUERYING'
  | 'DEGRADED';

/**
 * Why the app is degraded — NEVER a generic toast.
 *
 * Three required fields, because "something went wrong" is not a message, it is
 * an apology. The user must be told what broke and exactly what to do, in the
 * same breath. If you cannot write `exact_remedy`, you have not finished
 * diagnosing the failure.
 */
export interface DegradedReason {
  /** Stable machine code, e.g. `BAKE_STALE`, `SIGNATURE_INVALID`, `WEBGL_LOST`. */
  code: string;
  /** What failed, in concrete terms. Name the component and the operation. */
  what_failed: string;
  /**
   * The exact remedy. An action the user can actually take, phrased as an
   * imperative: "Re-run the bake from the Integrity panel", not "try again
   * later". Displayed in `--alarm` — the only place red is permitted.
   */
  exact_remedy: string;
}

/**
 * UI density. Changes spacing and hit targets ONLY — never colour, never
 * meaning. Set on `<html data-density>`; call `invalidateTokens()` after.
 */
export type DensityMode = 'comfortable' | 'compact' | 'touch';

/** The three density modes. */
export const DENSITY_MODES = Object.freeze(['comfortable', 'compact', 'touch'] as const);

/* =============================================================================
 * 12. DEMO GROUND TRUTH
 * -----------------------------------------------------------------------------
 * BY CONSTRUCTION. These facts must be LITERALLY TRUE in the generated graph,
 * not narrated over it. The corpus generator builds to this; the query engine
 * traverses to it; the UI verifies against it. If the graph and this constant
 * disagree, the graph is wrong.
 * ========================================================================== */

/**
 * The staged bridge query and its by-construction answer.
 *
 * The chain:
 *   Tollstrand Battery --operates--> Bruntorp Facility     (factual)
 *   Rimsdal Group  --acquired--> Tollstrand Battery   (episodic)
 *
 * `Tollstrand Battery` MUST be mentioned in assets on TWO DIFFERENT ISLANDS
 * (`is_bridge === true`, `island_ids.length === 2`) so that the answer path
 * physically crosses a strait on screen. `Bruntorp Facility` and
 * `Rimsdal Group` must sit on those two different islands respectively.
 */
export const DEMO_GROUND_TRUTH = Object.freeze({
  query: 'Which group acquired the operator that runs Bruntorp Facility?',
  intent: 'bridge' as QueryIntent,
  /** The correct answer. Surfaced as `QueryRenderResponse.gold`. */
  gold: 'Rimsdal Group',
  /** The cross-island entity the path routes through. */
  bridge_entity_label: 'Tollstrand Battery',
  /** The two hops, in traversal order, as `[subject, family, object]`. */
  chain: Object.freeze([
    Object.freeze(['Tollstrand Battery', 'operates', 'Bruntorp Facility'] as const),
    Object.freeze(['Rimsdal Group', 'acquired', 'Tollstrand Battery'] as const),
  ] as const),
  corpus_provenance: CORPUS_PROVENANCE,
});

/* =============================================================================
 * 13. DEV-TIME SELF-CHECK
 * ========================================================================== */

const __DEV__ = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);

if (__DEV__) {
  const violations = assertInverseConsistency();
  if (violations.length > 0) {
    // FAIL LOUD. A broken inverse table silently produces one-way traversals.
    // eslint-disable-next-line no-console
    console.error('[engine/types] relation inverse table is inconsistent:\n' + violations.join('\n'));
  }
}
