/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE SYNTHETIC WORLD
 * =============================================================================
 *
 * Builds the demo corpus: a Nordic energy-infrastructure intelligence archive
 * with a fully populated containment spine (continent > island > asset >
 * passage), the cross-cutting entity layer above it, and typed relations
 * joining both.
 *
 * -----------------------------------------------------------------------------
 * DETERMINISM IS A HARD REQUIREMENT
 * -----------------------------------------------------------------------------
 * There is no `Math.random()`, no `Date.now()` and no `new Date()` anywhere in
 * this module or the ones it imports. Every value derives from the seed and
 * from `EPOCH_MS`, a fixed constant. Two runs produce a byte-identical corpus.
 *
 * That is not tidiness. A `content_hash` over bytes that change between runs is
 * theatre, and a detached signature over a payload nobody can reproduce is
 * worse than no signature at all. The trust guarantees in `@/engine/types` are
 * only guarantees if the corpus is reproducible.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS BUILT BY CONSTRUCTION, NOT NARRATED
 * -----------------------------------------------------------------------------
 *   - Passage `char_start`/`char_end` really do index the source's `seq === 0`
 *     segment. Slice it and you get the passage back.
 *   - `content_hash` is a real SHA-256 over those exact verbatim bytes.
 *   - Every non-quarantined entity-to-entity edge has at least one evidence
 *     passage whose verbatim text literally contains the claim.
 *   - The gold chain of `DEMO_GROUND_TRUTH` exists as edges, crosses a strait,
 *     and is checked by `validateWorld()`, which throws on any violation.
 * =============================================================================
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import {
  CORPUS_PROVENANCE,
  DEMO_GROUND_TRUTH,
  RUNGS,
  SIGMA_CLASSES,
  VIEW_KEYS,
} from '@/engine/types';
import type {
  Asset,
  BoundaryKind,
  Continent,
  ContentHash,
  CorpusProvenance,
  Edge,
  Entity,
  GraphNode,
  Island,
  IsoTimestamp,
  NodeKind,
  Passage,
  PassageResolution,
  QueryIntent,
  QueryMode,
  RelationFamily,
  SigmaClass,
  Source,
  SourceSegment,
} from '@/engine/types';

import {
  CONFIDENCE_FLOOR,
  QUARANTINE_REASONS,
  auditVocabulary,
  byFamily,
  isStructural,
  labelOf,
  pickFamily,
  pickSigma,
  sigmaOf,
} from '@/engine/corpus/relations';
import type { QuarantineReason } from '@/engine/corpus/relations';

import {
  ABBREVIATIONS,
  BOUNDARY_KINDS_BY_DOMAIN,
  CONTINENT_PROFILES,
  ENTITY_TYPES,
  ENTITY_TYPE_WEIGHTS,
  assetSummary,
  assetTitle,
  claimSentence,
  documentClaim,
  documentCode,
  makeEntitySpec,
  mediaTypeFor,
  paragraphFor,
  pick,
  pickInt,
  regionSummary,
  selfReference,
  shuffled,
  skewInt,
  slug,
  sourceHeader,
  sourceLocator,
  tokenCount,
} from '@/engine/corpus/text';
import type { Domain, EntitySpec, EntityType, FocusEntity, Rng } from '@/engine/corpus/text';

import { HUE_COUNT, fnv1a32 } from '@/styles/tokens';

/* =============================================================================
 * 1. SEEDED PRNG
 * -----------------------------------------------------------------------------
 * sfc32, seeded through splitmix32. Chosen over `Math.random()` for the only
 * reason that matters here: it is reproducible, and reproducibility is what
 * makes every hash downstream checkable.
 * ========================================================================== */

/** The default corpus seed. Changing it changes every hash in the build. */
export const DEFAULT_SEED = 0x7c1d26;

/** mulberry32 — kept because it is the cheapest way to derive a sub-stream. */
export function mulberry32(a: number): Rng {
  let t = a >>> 0;
  return function next(): number {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** sfc32 — the main corpus stream. Long period, no observable structure. */
export function sfc32(a: number, b: number, c: number, d: number): Rng {
  let s0 = a >>> 0;
  let s1 = b >>> 0;
  let s2 = c >>> 0;
  let s3 = d >>> 0;
  return function next(): number {
    s0 >>>= 0;
    s1 >>>= 0;
    s2 >>>= 0;
    s3 >>>= 0;
    const t = (((s0 + s1) >>> 0) + s3) >>> 0;
    s3 = (s3 + 1) >>> 0;
    s0 = s1 ^ (s1 >>> 9);
    s1 = (s2 + (s2 << 3)) >>> 0;
    s2 = (s2 << 21) | (s2 >>> 11);
    s2 = (s2 + t) >>> 0;
    return t / 4294967296;
  };
}

function splitmix32(seed: number): () => number {
  let z = seed >>> 0;
  return function next(): number {
    z = (z + 0x9e3779b9) >>> 0;
    let x = z;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
    x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
    return (x ^ (x >>> 15)) >>> 0;
  };
}

/** Build the corpus stream for a seed, warmed so early draws are not correlated. */
export function seededRng(seed: number): Rng {
  const sm = splitmix32(seed);
  const rng = sfc32(sm(), sm(), sm(), sm());
  for (let i = 0; i < 24; i++) rng();
  return rng;
}

/** A named sub-stream. Used by the scale padder so it cannot disturb the base. */
export function subStream(seed: number, label: string): Rng {
  return seededRng((seed ^ fnv1a32(label)) >>> 0);
}

/* =============================================================================
 * 2. TIME — pure arithmetic, no `Date`
 * ========================================================================== */

const MS_PER_DAY = 86_400_000;

/** Howard Hinnant's days-from-civil. Proleptic Gregorian, no Date involved. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z0: number): [number, number, number] {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** Epoch-ms to an ISO-8601 timestamp, computed rather than formatted by `Date`. */
export function isoFromMs(ms: number): IsoTimestamp {
  const days = Math.floor(ms / MS_PER_DAY);
  const rem = ms - days * MS_PER_DAY;
  const [y, m, d] = civilFromDays(days);
  const hh = Math.floor(rem / 3_600_000);
  const mm = Math.floor((rem % 3_600_000) / 60_000);
  const ss = Math.floor((rem % 60_000) / 1000);
  const mmm = rem % 1000;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}.${pad(mmm, 3)}Z`;
}

/** Epoch-ms to a human date the prose can carry, e.g. `14 March 2025`. */
export function dateLabelFromMs(ms: number): string {
  const [y, m, d] = civilFromDays(Math.floor(ms / MS_PER_DAY));
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

/** The corpus clock starts here. Fixed forever; never read from the host. */
export const EPOCH_MS = daysFromCivil(2023, 1, 1) * MS_PER_DAY;
/** The instant every node claims it was materialised by the engine. */
export const BAKE_MS = daysFromCivil(2026, 7, 20) * MS_PER_DAY + 8 * 3_600_000 + 41 * 60_000;
const BAKE_ISO = isoFromMs(BAKE_MS);
const CORPUS_SPAN_MS = BAKE_MS - EPOCH_MS - 30 * MS_PER_DAY;

/* =============================================================================
 * 3. HASHING
 * ========================================================================== */

/** Prefix carried by every hash in this build so a bare hex string is never mistaken for one. */
export const HASH_PREFIX = 'sha256:';

/**
 * TRUST GUARANTEE. SHA-256 over the UTF-8 bytes of `text`, rendered as the
 * first 16 bytes of the digest in lowercase hex behind a `sha256:` prefix.
 *
 * The truncation is a display decision, not a security one: 128 bits is far
 * past collision-by-accident for a corpus of this size, and a hash you can read
 * off the screen and compare by eye is a hash people actually check. Recompute
 * it with `contentHash(sliceOfSourceSegmentZero)` and it must match.
 */
export function contentHash(text: string): ContentHash {
  return HASH_PREFIX + bytesToHex(sha256(utf8ToBytes(text))).slice(0, 32);
}

/* =============================================================================
 * 4. COMMUNITY IDS
 * -----------------------------------------------------------------------------
 * Community ids are STABLE STRINGS and the hue is `fnv1a32(id) % 8`, so colour
 * survives a re-bake. Two properties have to hold at once:
 *   1. every island is its own community (the clustering pass is real), and
 *   2. the hue is CONSTANT down the containment spine — continent wash, island
 *      at mid strength, assets at full, all the same family.
 * They are reconciled by minting each island a distinct id that happens to hash
 * into its continent's hue bucket. Deterministic search, no lookup table.
 * ========================================================================== */

function mintCommunityId(base: string, wantHue: number, taken: Set<string>): string {
  for (let k = 0; k < 8192; k++) {
    const id = k === 0 ? base : `${base}~${k}`;
    if (taken.has(id)) continue;
    if (fnv1a32(id) % HUE_COUNT === wantHue) {
      taken.add(id);
      return id;
    }
  }
  throw new Error(`[corpus/world] could not mint a community id for "${base}" in hue bucket ${wantHue}`);
}

/* =============================================================================
 * 5. RELATION SHAPES — which entity types a family may join
 * -----------------------------------------------------------------------------
 * Without this, `made_of` fires between two people and the corpus reads like a
 * random walk over a thesaurus. The vocabulary is the contract's; the domain
 * plausibility is the generator's job.
 * ========================================================================== */

const T_ORG: readonly EntityType[] = ['organization'];
const T_PERSON: readonly EntityType[] = ['person'];
const T_PLANT: readonly EntityType[] = ['facility', 'site'];
const T_FAC: readonly EntityType[] = ['facility'];
const T_SITE: readonly EntityType[] = ['site'];
const T_MAT: readonly EntityType[] = ['material'];
const T_TECH: readonly EntityType[] = ['technology'];
const T_REG: readonly EntityType[] = ['regulation'];
const T_MKT: readonly EntityType[] = ['market_instrument'];
const T_TIME: readonly EntityType[] = ['period'];
const T_ACTOR: readonly EntityType[] = ['organization', 'person'];
const T_PHYS: readonly EntityType[] = ['facility', 'site', 'material', 'technology'];
const T_ORGPLANT: readonly EntityType[] = ['organization', 'facility', 'site'];
const T_CAUSE: readonly EntityType[] = ['facility', 'technology', 'market_instrument', 'regulation'];
const T_TEMPORAL_SUBJ: readonly EntityType[] = ['facility', 'market_instrument', 'regulation', 'organization'];
/** Things that can be ordered against a window without reading as nonsense. */
const T_ORDERABLE: readonly EntityType[] = ['facility', 'market_instrument', 'regulation'];
/** Things a temporal relation can point AT. A period, or a dated product. */
const T_WINDOW: readonly EntityType[] = ['period', 'market_instrument'];

interface Shape {
  readonly from: readonly EntityType[];
  readonly to: readonly EntityType[];
}

const DEFAULT_SHAPE: Shape = { from: T_ORGPLANT, to: T_PHYS };

/**
 * Entity-to-entity shapes for the four non-authorial semantic classes.
 * Authorial relations mostly join documents to people and are generated in
 * their own pass, where the endpoints are assets and persons rather than two
 * entities — see `emitAuthorial`.
 */
const FAMILY_SHAPE: Partial<Record<RelationFamily, Shape>> = {
  /* factual */
  part_of: { from: T_PHYS, to: T_ORGPLANT },
  has_part: { from: T_ORGPLANT, to: T_PHYS },
  contains: { from: T_PLANT, to: T_PHYS },
  contained_in: { from: T_PHYS, to: T_PLANT },
  is_a: { from: T_PHYS, to: T_TECH },
  has_subtype: { from: T_TECH, to: T_MAT },
  instance_of: { from: T_FAC, to: T_TECH },
  has_instance: { from: T_TECH, to: T_FAC },
  made_of: { from: T_PLANT, to: T_MAT },
  material_in: { from: T_MAT, to: T_PLANT },
  has_attribute: { from: T_ORGPLANT, to: T_TECH },
  attribute_of: { from: T_TECH, to: T_ORGPLANT },
  owns: { from: T_ORG, to: T_ORGPLANT },
  owned_by: { from: T_ORGPLANT, to: T_ORG },
  operates: { from: T_ORG, to: T_FAC },
  operated_by: { from: T_FAC, to: T_ORG },
  located_in: { from: T_ORGPLANT, to: T_SITE },
  location_of: { from: T_SITE, to: T_FAC },
  member_of: { from: T_ACTOR, to: T_ORG },
  has_member: { from: T_ORG, to: T_ACTOR },
  subsidiary_of: { from: T_ORG, to: T_ORG },
  has_subsidiary: { from: T_ORG, to: T_ORG },
  supplies: { from: T_ORG, to: T_ORGPLANT },
  supplied_by: { from: T_ORGPLANT, to: T_ORG },
  regulates: { from: T_REG, to: T_ORGPLANT },
  regulated_by: { from: T_ORGPLANT, to: T_REG },
  identifies: { from: T_REG, to: T_ORGPLANT },
  identified_by: { from: T_ORGPLANT, to: T_MKT },
  has_role: { from: T_ACTOR, to: T_MKT },
  role_of: { from: T_MKT, to: T_ACTOR },
  same_as: { from: T_ORG, to: T_ORG },
  differs_from: { from: T_FAC, to: T_FAC },
  adjacent_to: { from: T_PLANT, to: T_PLANT },
  denominated_in: { from: T_MKT, to: T_MKT },

  /* temporal */
  occurred_at: { from: T_TEMPORAL_SUBJ, to: T_TIME },
  started_at: { from: T_TEMPORAL_SUBJ, to: T_TIME },
  ended_at: { from: T_ORDERABLE, to: T_TIME },
  valid_from: { from: T_MKT, to: T_TIME },
  valid_until: { from: T_MKT, to: T_TIME },
  scheduled_for: { from: T_FAC, to: T_TIME },
  before: { from: T_ORDERABLE, to: T_WINDOW },
  after: { from: T_ORDERABLE, to: T_WINDOW },
  during: { from: T_ORDERABLE, to: T_WINDOW },
  spans: { from: T_WINDOW, to: T_WINDOW },
  supersedes: { from: T_REG, to: T_REG },
  superseded_by: { from: T_REG, to: T_REG },
  overlaps: { from: T_WINDOW, to: T_WINDOW },
  concurrent_with: { from: T_WINDOW, to: T_WINDOW },

  /* causal */
  causes: { from: T_CAUSE, to: T_CAUSE },
  caused_by: { from: T_CAUSE, to: T_CAUSE },
  enables: { from: T_TECH, to: T_CAUSE },
  enabled_by: { from: T_CAUSE, to: T_TECH },
  prevents: { from: T_TECH, to: T_CAUSE },
  prevented_by: { from: T_CAUSE, to: T_TECH },
  triggers: { from: T_CAUSE, to: T_CAUSE },
  triggered_by: { from: T_CAUSE, to: T_CAUSE },
  contributes_to: { from: T_CAUSE, to: T_CAUSE },
  has_contributor: { from: T_CAUSE, to: T_CAUSE },
  depends_on: { from: T_FAC, to: T_PHYS },
  required_by: { from: T_PHYS, to: T_FAC },

  /* episodic */
  acquired: { from: T_ORG, to: T_ORGPLANT },
  acquired_by: { from: T_ORGPLANT, to: T_ORG },
  divested: { from: T_ORG, to: T_ORGPLANT },
  divested_by: { from: T_ORGPLANT, to: T_ORG },
  participated_in: { from: T_ACTOR, to: T_MKT },
  had_participant: { from: T_MKT, to: T_ACTOR },
  attended: { from: T_PERSON, to: T_TIME },
  filed: { from: T_ACTOR, to: T_REG },
  announced: { from: T_ORG, to: T_MKT },
  commissioned: { from: T_ORG, to: T_FAC },
  decommissioned: { from: T_ORG, to: T_FAC },

  /* the one authorial family that is genuinely entity-to-entity */
  attributed_to: { from: T_PHYS, to: T_ACTOR },
};

/** Sigma mix for the entity-layer pass. Authorial arrives from the doc pass. */
const ENTITY_SIGMA_WEIGHTS: Readonly<Partial<Record<SigmaClass, number>>> = Object.freeze({
  factual: 0.46,
  temporal: 0.18,
  causal: 0.15,
  episodic: 0.21,
});

/* =============================================================================
 * 6. THE WORLD
 * ========================================================================== */

/** A staged query with a by-construction answer the query engine can be scored against. */
export interface StagedQuery {
  id: string;
  query: string;
  intent: QueryIntent;
  mode: QueryMode;
  /** The known-correct answer. Surfaced as `QueryRenderResponse.gold`. */
  gold: string;
  /** Nodes that must appear in a correct constellation. */
  gold_node_ids: string[];
  /** Edges a correct traversal must use. */
  gold_edge_ids: string[];
  /** The cross-island entity the path routes through, when the intent bridges. */
  bridge_entity_id: string | null;
  /** The chain as `[subject, family, object]` labels, in traversal order. */
  chain: readonly (readonly [string, RelationFamily, string])[];
  /** Why this query is here, in one line. Shown in the command bar. */
  why: string;
  corpus_provenance: CorpusProvenance;
}

/** Measured counts. Every number here is computed from the arrays, never asserted. */
export interface WorldStats {
  nodes_total: number;
  nodes_by_kind: Record<NodeKind, number>;
  edges_total: number;
  edges_by_sigma: Record<SigmaClass, number>;
  edges_semantic: number;
  edges_structural: number;
  quarantined: number;
  /** Quarantined / truth-gated edges. The number the integrity panel reports. */
  quarantine_rate: number;
  quarantine_by_reason: Record<string, number>;
  bridge_entities: number;
  bridge_entity_rate: number;
  strait_edges: number;
  resolved_passages: number;
  resolution_rate: number;
  distinct_families_used: number;
  communities: number;
  tokens_total: number;
  source_characters: number;
}

export interface World {
  seed: number;
  built_at: IsoTimestamp;
  corpus_provenance: CorpusProvenance;

  continents: Continent[];
  islands: Island[];
  assets: Asset[];
  passages: Passage[];
  sources: Source[];
  entities: Entity[];

  /** Every drawable node, one array, discriminated on `kind`. */
  nodes: GraphNode[];
  edges: Edge[];

  node_by_id: Map<string, GraphNode>;
  edge_by_id: Map<string, Edge>;
  /** node id -> edge ids touching it, both directions. */
  adjacency: Map<string, string[]>;
  /** node id -> the island it primarily belongs to. `null` for continents. */
  island_of: Map<string, string | null>;

  community_ids: string[];
  ground_truth: typeof DEMO_GROUND_TRUTH;
  staged_queries: StagedQuery[];
  stats: WorldStats;
}

/* -------------------------------------------------------------------------
 * Internal generation records — never leave this module.
 * ---------------------------------------------------------------------- */

interface EntityRecord {
  id: string;
  spec: EntitySpec;
  homeIslandId: string;
  secondaryIslandId: string | null;
  communityId: string;
  mentions: string[];
  assetIds: Set<string>;
  islandIds: Set<string>;
}

interface IslandBuild {
  island: Island;
  profile: { key: string; name: string; domain: Domain; summary: string };
  continentId: string;
  continentKey: string;
  communityId: string;
  cast: EntityRecord[];
  inbound: EntityRecord[];
}

/* =============================================================================
 * 7. buildWorld
 * ========================================================================== */

export function buildWorld(seed: number = DEFAULT_SEED): World {
  const vocabViolations = auditVocabulary();
  if (vocabViolations.length > 0) {
    throw new Error('[corpus/world] relation vocabulary is unsound:\n' + vocabViolations.join('\n'));
  }

  const rng = seededRng(seed);

  const continents: Continent[] = [];
  const islands: Island[] = [];
  const assets: Asset[] = [];
  const passages: Passage[] = [];
  const sources: Source[] = [];
  const edges: Edge[] = [];
  const entityRecords: EntityRecord[] = [];

  const islandOf = new Map<string, string | null>();
  const takenCommunityIds = new Set<string>();
  const takenLabels = new Set<string>();
  const communityIds: string[] = [];

  let edgeSeq = 0;
  const mkEdgeId = (): string => `x:${pad(edgeSeq++, 6)}`;

  /* ---------------------------------------------------------------------
   * 7.1 Spine skeleton: continents, islands, community ids.
   * ------------------------------------------------------------------ */

  const islandBuilds: IslandBuild[] = [];

  CONTINENT_PROFILES.forEach((cp, ci) => {
    const continentId = `c:${cp.key}`;
    const continentCommunity = mintCommunityId(`com:${cp.key}`, ci % HUE_COUNT, takenCommunityIds);
    communityIds.push(continentCommunity);

    const islandCount = pickInt(rng, 5, 7);
    const continent: Continent = {
      id: continentId,
      kind: 'continent',
      label: cp.name,
      community_id: continentCommunity,
      centrality: 0,
      degree: 0,
      created_at: BAKE_ISO,
      parent_id: null,
      island_ids: [],
      asset_count: 0,
      passage_count: 0,
      summary: cp.summary,
    };
    continents.push(continent);
    islandOf.set(continentId, null);

    for (let ii = 0; ii < islandCount; ii++) {
      const ip = cp.islands[ii];
      const islandId = `i:${cp.key}.${ip.key}`;
      const islandCommunity = mintCommunityId(
        `com:${cp.key}/${ip.key}`,
        ci % HUE_COUNT,
        takenCommunityIds,
      );
      communityIds.push(islandCommunity);

      const island: Island = {
        id: islandId,
        kind: 'island',
        label: ip.name,
        community_id: islandCommunity,
        centrality: 0,
        degree: 0,
        created_at: BAKE_ISO,
        parent_id: continentId,
        asset_ids: [],
        bridge_entity_ids: [],
        passage_count: 0,
        summary: ip.summary,
      };
      islands.push(island);
      continent.island_ids.push(islandId);
      islandOf.set(islandId, islandId);

      islandBuilds.push({
        island,
        profile: ip,
        continentId,
        continentKey: cp.key,
        communityId: islandCommunity,
        cast: [],
        inbound: [],
      });
    }
  });

  const islandBuildById = new Map(islandBuilds.map((b) => [b.island.id, b]));

  /* ---------------------------------------------------------------------
   * 7.2 The entity layer's cast, island by island.
   * ------------------------------------------------------------------ */

  const takenEntityIds = new Set<string>();

  const mintEntity = (spec: EntitySpec, homeIslandId: string, communityId: string): EntityRecord => {
    let id = `e:${slug(spec.label)}`;
    let k = 2;
    while (takenEntityIds.has(id)) id = `e:${slug(spec.label)}-${k++}`;
    takenEntityIds.add(id);
    const rec: EntityRecord = {
      id,
      spec,
      homeIslandId,
      secondaryIslandId: null,
      communityId,
      mentions: [],
      assetIds: new Set(),
      islandIds: new Set(),
    };
    entityRecords.push(rec);
    /* An entity's place is known the moment it is minted. Registering it here
       rather than after generation is what lets every edge decide, at the point
       it is created, whether it crosses a strait. */
    islandOf.set(id, homeIslandId);
    return rec;
  };

  const drawEntityType = (r: Rng): EntityType => {
    let total = 0;
    for (const t of ENTITY_TYPES) total += ENTITY_TYPE_WEIGHTS[t];
    let x = r() * total;
    for (const t of ENTITY_TYPES) {
      x -= ENTITY_TYPE_WEIGHTS[t];
      if (x <= 0) return t;
    }
    return 'organization';
  };

  /* The three planted entities of the staged bridge query. They are minted
     first so their ids and island homes are fixed regardless of draw order. */
  const islandA = islandBuildById.get('i:storage.tollstrand-cluster');
  const islandB = islandBuildById.get('i:capital.rimsdal-holdings');
  if (!islandA || !islandB) {
    throw new Error('[corpus/world] the two staged islands were not generated');
  }

  const goldOperator = mintEntity(
    {
      label: 'Tollstrand Battery',
      entity_type: 'organization',
      aliases: ['Tollstrand BESS', 'the Tollstrand operator'],
      summary:
        'Storage operator holding the operations and maintenance mandate over the Tollstrand sites; acquired into a larger group during the corpus period.',
    },
    islandA.island.id,
    islandA.communityId,
  );
  takenLabels.add('Tollstrand Battery');
  goldOperator.secondaryIslandId = islandB.island.id;

  const goldFacility = mintEntity(
    {
      label: 'Bruntorp Facility',
      entity_type: 'facility',
      aliases: ['Bruntorp'],
      summary:
        'Connected storage installation operated under mandate; the anchor asset of the Tollstrand cluster.',
    },
    islandA.island.id,
    islandA.communityId,
  );
  takenLabels.add('Bruntorp Facility');

  const goldAcquirer = mintEntity(
    {
      label: 'Rimsdal Group',
      entity_type: 'organization',
      aliases: ['Rimsdal'],
      summary:
        'Holding company; consolidates storage and network operators acquired across the Nordic market.',
    },
    islandB.island.id,
    islandB.communityId,
  );
  takenLabels.add('Rimsdal Group');

  islandA.cast.push(goldOperator, goldFacility);
  islandB.cast.push(goldAcquirer);
  islandB.inbound.push(goldOperator);

  /*
   * Every island needs a minimum cast: authors to sign its documents,
   * organizations to hold things and installations to be held. Drawing purely
   * by weight left one island with no person on it at all, and three of its
   * assets ended up with no relations of any kind — molecules floating free of
   * the graph. The floor is enforced, then the rest is drawn by weight.
   */
  const CAST_FLOOR: readonly EntityType[] = [
    'person', 'person', 'person',
    'organization', 'organization', 'organization',
    'facility', 'facility',
    'period', 'regulation',
  ];
  for (const build of islandBuilds) {
    const castSize = pickInt(rng, 30, 38) - build.cast.length;
    for (let k = 0; k < castSize; k++) {
      const type = k < CAST_FLOOR.length ? CAST_FLOOR[k] : drawEntityType(rng);
      const spec = makeEntitySpec(rng, type, takenLabels);
      build.cast.push(mintEntity(spec, build.island.id, build.communityId));
    }
  }

  /* Bridge assignment: ~9% of entities are mentioned on a second island. This
     is what makes an answer constellation able to cross a strait at all. */
  const BRIDGE_RATE = 0.09;
  const bridgeCandidates = entityRecords.filter(
    (e) => e.id !== goldOperator.id && e.id !== goldFacility.id && e.id !== goldAcquirer.id,
  );
  const wantBridges = Math.max(1, Math.round(entityRecords.length * BRIDGE_RATE) - 1);
  const shuffledCandidates = shuffled(rng, bridgeCandidates);
  for (let k = 0; k < wantBridges && k < shuffledCandidates.length; k++) {
    const ent = shuffledCandidates[k];
    let target = islandBuilds[Math.floor(rng() * islandBuilds.length)];
    if (target.island.id === ent.homeIslandId) {
      target = islandBuilds[(islandBuilds.indexOf(target) + 1) % islandBuilds.length];
    }
    if (target.island.id === ent.homeIslandId) continue;
    ent.secondaryIslandId = target.island.id;
    target.inbound.push(ent);
  }

  /* ---------------------------------------------------------------------
   * 7.3 Assets, sources, passages and the edges extracted from them.
   * ------------------------------------------------------------------ */

  interface ForcedClaim {
    family: RelationFamily;
    subject: EntityRecord;
    object: EntityRecord;
    collect: string[];
  }

  const goldOperatesEvidence: string[] = [];
  const goldAcquiredEvidence: string[] = [];

  const forcedByIslandAsset = new Map<string, ForcedClaim>();
  for (const ordinal of [0, 3, 7]) {
    forcedByIslandAsset.set(`${islandA.island.id}:${ordinal}`, {
      family: 'operates',
      subject: goldOperator,
      object: goldFacility,
      collect: goldOperatesEvidence,
    });
  }
  for (const ordinal of [1, 4, 8]) {
    forcedByIslandAsset.set(`${islandB.island.id}:${ordinal}`, {
      family: 'acquired',
      subject: goldAcquirer,
      object: goldOperator,
      collect: goldAcquiredEvidence,
    });
  }

  /**
   * The two gold assertions, reserved. The random pass may not re-assert them:
   * a second `operates` edge with weaker evidence would let a traversal reach
   * the right answer down the wrong path, and the demo would be scoring itself
   * on an accident.
   */
  const reservedClaims = new Set<string>([
    `${goldOperator.id}|operates|${goldFacility.id}`,
    `${goldAcquirer.id}|acquired|${goldOperator.id}`,
  ]);

  /** Assets already built, in creation order. Citations only point backwards. */
  const priorAssets: Asset[] = [];
  const assetShortTitle = new Map<string, string>();
  const assetPassages = new Map<string, Passage[]>();

  let assetCounter = 0;

  for (const build of islandBuilds) {
    const { island, profile } = build;
    const kinds = BOUNDARY_KINDS_BY_DOMAIN[profile.domain];
    const assetCount = 12 + skewInt(rng, 0, 12);
    const islandStart = EPOCH_MS + Math.floor(rng() * CORPUS_SPAN_MS * 0.25);
    const step = Math.floor((CORPUS_SPAN_MS * 0.7) / Math.max(1, assetCount));

    const castQueue = shuffled(rng, build.cast);
    let cursor = 0;

    /* Inbound bridge entities are spread evenly across this island's assets and
       placed at the FRONT of the cast, where the focus rotation is guaranteed
       to reach them. A bridge that is never actually mentioned on its second
       island would leave `is_bridge` asserting a crossing the data cannot
       support — the constellation renderer would draw a line through nothing. */
    const inboundByAssetIndex = new Map<number, EntityRecord[]>();
    build.inbound.forEach((ent, j) => {
      const idx = Math.min(assetCount - 1, Math.floor((j * assetCount) / build.inbound.length));
      const list = inboundByAssetIndex.get(idx);
      if (list) list.push(ent);
      else inboundByAssetIndex.set(idx, [ent]);
    });

    for (let ai = 0; ai < assetCount; ai++) {
      const boundaryMs = islandStart + ai * step + Math.floor(rng() * step * 0.6);
      const dateLabel = dateLabelFromMs(boundaryMs);
      const [year] = civilFromDays(Math.floor(boundaryMs / MS_PER_DAY));
      const boundaryKind: BoundaryKind = pick(rng, kinds);

      const nPassages = 3 + skewInt(rng, 0, 4);
      const castSize = Math.min(9, Math.max(4, 2 * nPassages));

      const cast: EntityRecord[] = [];
      const seen = new Set<string>();
      const addToCast = (e: EntityRecord): void => {
        if (seen.has(e.id)) return;
        seen.add(e.id);
        cast.push(e);
      };
      const forced = forcedByIslandAsset.get(`${island.id}:${ai}`);
      const ensureAuthor = (): void => {
        if (cast.some((e) => e.spec.entity_type === 'person')) return;
        const candidate = build.cast.find(
          (e) => e.spec.entity_type === 'person' && !seen.has(e.id),
        );
        if (!candidate) return;
        /* Appended, not swapped: swapping would drop whichever entity the
           queue had just placed here, and on the island's last asset that was
           its only chance to be mentioned at all. The appended author is
           guaranteed to reach the bytes through the authorship line below,
           so it does not need a slot in the focus rotation. */
        addToCast(candidate);
      };
      if (forced) {
        addToCast(forced.subject);
        addToCast(forced.object);
      }
      for (const inb of inboundByAssetIndex.get(ai) ?? []) addToCast(inb);
      /* Fill the rest from the island's own cast. The cursor persists across
         assets, so every entity on the island is drawn into several molecules
         and none is left without a single mention. */
      for (let guard = 0; cast.length < castSize && guard < castQueue.length * 3; guard++) {
        addToCast(castQueue[cursor++ % castQueue.length]);
      }
      ensureAuthor();

      const code = documentCode(profile.key, assetCounter);
      const assetId = `a:${build.continentKey}.${profile.key}.${pad(ai, 3)}`;
      const sourceId = `src:${build.continentKey}.${profile.key}.${pad(ai, 3)}`;
      assetCounter += 1;

      /* A document is titled after its principal subject. "Operations and
         maintenance agreement - Elin Sundstrom" reads as a mistake; the lead
         has to be an organization or an installation when the cast has one. */
      const titleWorthy = cast.filter(
        (e) => e.spec.entity_type === 'organization' || e.spec.entity_type === 'facility',
      );
      const leadRec = titleWorthy[0] ?? cast[0];
      const secondRec = titleWorthy[1] ?? cast.find((e) => e !== leadRec) ?? leadRec;
      const lead = leadRec.spec.label;
      const second = secondRec.spec.label;
      const title = assetTitle({
        rng,
        kind: boundaryKind,
        domain: profile.domain,
        islandName: profile.name,
        code,
        dateLabel,
        lead,
        second,
      });
      const shortTitle = title.replace(` (${code})`, '');
      const selfRef = selfReference(boundaryKind);
      const openerOffset = pickInt(rng, 0, 7);
      const usedTemplates = new Set<string>();

      /* ---- plan the entity-layer edges this asset extracts ------------- */
      interface PlannedEdge {
        family: RelationFamily;
        from: EntityRecord;
        to: EntityRecord;
        sentence: string;
        passageIndex: number;
        confidence: number;
        quarantineReason: QuarantineReason | null;
      }

      const byType = new Map<EntityType, EntityRecord[]>();
      for (const e of cast) {
        const list = byType.get(e.spec.entity_type);
        if (list) list.push(e);
        else byType.set(e.spec.entity_type, [e]);
      }
      const candidatesFor = (types: readonly EntityType[]): EntityRecord[] => {
        const out: EntityRecord[] = [];
        for (const t of types) {
          const list = byType.get(t);
          if (list) out.push(...list);
        }
        return out;
      };

      const planned: PlannedEdge[] = [];
      const plannedKeys = new Set<string>();
      /* `grain-oriented electrical steel, lot G5 triggers grain-oriented
         electrical steel, grade T3` is two lots of one material asserting
         something about each other. Reject pairs that share a base name. */
      const sameBase = (a: EntityRecord, b: EntityRecord): boolean =>
        baseName(a.spec.label) === baseName(b.spec.label);
      const nSemantic = pickInt(rng, 9, 16);

      const planOne = (family: RelationFamily, from: EntityRecord, to: EntityRecord, passageIndex: number, forceClean: boolean): PlannedEdge => {
        let confidence = 0.62 + rng() * 0.36;
        let quarantineReason: QuarantineReason | null = null;
        if (!forceClean && rng() < 0.032) {
          quarantineReason = QUARANTINE_REASONS[Math.floor(rng() * QUARANTINE_REASONS.length)];
          if (quarantineReason === 'confidence_below_floor') {
            confidence = 0.18 + rng() * (CONFIDENCE_FLOOR - 0.19);
          }
        }
        if (forceClean) confidence = 0.94 + rng() * 0.05;
        return {
          family,
          from,
          to,
          sentence: claimSentence(rng, family, from.spec.label, to.spec.label, labelOf(family)),
          passageIndex,
          confidence,
          quarantineReason,
        };
      };

      if (forced) {
        planned.push(
          planOne(forced.family, forced.subject, forced.object, pickInt(rng, 0, nPassages - 1), true),
        );
        plannedKeys.add(`${forced.subject.id}|${forced.family}|${forced.object.id}`);
      }

      for (let k = 0; k < nSemantic; k++) {
        const sigma = pickSigma(rng, ENTITY_SIGMA_WEIGHTS);
        let chosen: PlannedEdge | null = null;
        for (let attempt = 0; attempt < 8 && !chosen; attempt++) {
          const family = pickFamily(rng, sigma);
          const shape = FAMILY_SHAPE[family] ?? DEFAULT_SHAPE;
          const froms = candidatesFor(shape.from);
          const tos = candidatesFor(shape.to);
          if (froms.length === 0 || tos.length === 0) continue;
          const from = pick(rng, froms);
          const candidateTos = tos.filter((t) => t.id !== from.id);
          if (candidateTos.length === 0) continue;
          const to = pick(rng, candidateTos);
          if (sameBase(from, to)) continue;
          const key = `${from.id}|${family}|${to.id}`;
          if (reservedClaims.has(key) || plannedKeys.has(key)) continue;
          plannedKeys.add(key);
          chosen = planOne(family, from, to, pickInt(rng, 0, nPassages - 1), false);
        }
        if (chosen) planned.push(chosen);
      }

      /* `attributed_to` is an authorial family that genuinely joins two
         entities rather than a document and a person, so the entity pass — which
         draws only from the four non-authorial classes — would never reach it.
         It is emitted here, before the claims are laid out, so it flows through
         the same rendering path as everything else. */
      const attributable = cast.filter((e) => T_PHYS.includes(e.spec.entity_type));
      const attributees = cast.filter((e) => T_ACTOR.includes(e.spec.entity_type));
      if (attributable.length > 0 && attributees.length > 0 && rng() < 0.16) {
        const subj = pick(rng, attributable);
        const obj = pick(rng, attributees);
        if (subj.id !== obj.id && !sameBase(subj, obj)) {
          planned.push({
            family: 'attributed_to',
            from: subj,
            to: obj,
            sentence: claimSentence(
              rng,
              'attributed_to',
              subj.spec.label,
              obj.spec.label,
              labelOf('attributed_to'),
            ),
            passageIndex: pickInt(rng, 0, nPassages - 1),
            confidence: 0.66 + rng() * 0.3,
            quarantineReason: null,
          });
        }
      }

      /* ---- render the passages ---------------------------------------- */
      const claimsByPassage: string[][] = Array.from({ length: nPassages }, () => []);
      for (const p of planned) claimsByPassage[p.passageIndex].push(p.sentence);

      /* Document-level authorial edges. Their endpoints are an asset and a
         person, not two entities, which is why they are generated here rather
         than in the entity-layer pass above. */
      interface DocEdgePlan {
        family: RelationFamily;
        fromId: string;
        toId: string;
        passageIndex: number;
        /** Set on the authorship line, which the gate never rejects. */
        alwaysAdmit?: boolean;
      }
      const docEdges: DocEdgePlan[] = [];

      /* One authorial claim about the document itself, rendered into the
         opening passage the way a real cover page carries its author. */
      const people = cast.filter((e) => e.spec.entity_type === 'person');
      const author = people.length > 0 ? pick(rng, people) : null;
      if (author) {
        const forward = rng() < 0.5;
        const family: RelationFamily = forward ? 'authored' : 'authored_by';
        const sentence = forward
          ? documentClaim(rng, 'authored', author.spec.label, selfRef, labelOf('authored'))
          : documentClaim(rng, 'authored_by', capitalise(selfRef), author.spec.label, labelOf('authored_by'));
        claimsByPassage[0].push(sentence);
        docEdges.push({
          family,
          fromId: forward ? author.id : assetId,
          toId: forward ? assetId : author.id,
          passageIndex: 0,
          alwaysAdmit: true,
        });
      }

      /* Backward citations. Only ever to assets that already exist, which is
         both realistic and the only way the cited title can be in the bytes. */
      if (priorAssets.length > 4) {
        const nCites = rng() < 0.45 ? (rng() < 0.3 ? 2 : 1) : 0;
        for (let k = 0; k < nCites; k++) {
          const sameIsland = priorAssets.filter((a) => a.parent_id === island.id);
          const poolLocal = sameIsland.length > 0 && rng() < 0.68 ? sameIsland : priorAssets;
          const target = pick(rng, poolLocal);
          const targetShort = assetShortTitle.get(target.id) ?? target.label;
          const family: RelationFamily = pick(rng, [
            'cites', 'cites', 'cites', 'summarizes', 'derived_from', 'quotes',
            'cited_by', 'quoted_by', 'has_derivative', 'summarized_by', 'edited_by', 'edited',
          ] as const);
          const pi = pickInt(rng, 0, nPassages - 1);
          let sentence: string;
          let fromId: string;
          let toId: string;
          if (family === 'cited_by' || family === 'quoted_by' || family === 'summarized_by' || family === 'has_derivative') {
            sentence = documentClaim(rng, family, targetShort, selfRef, labelOf(family));
            fromId = target.id;
            toId = assetId;
          } else if (family === 'edited_by' || family === 'edited') {
            if (!author) continue;
            if (family === 'edited_by') {
              sentence = documentClaim(rng, 'edited_by', capitalise(selfRef), author.spec.label, labelOf('edited_by'));
              fromId = assetId;
              toId = author.id;
            } else {
              sentence = documentClaim(rng, 'edited', author.spec.label, targetShort, labelOf('edited'));
              fromId = author.id;
              toId = target.id;
            }
          } else {
            sentence = documentClaim(rng, family, capitalise(selfRef), targetShort, labelOf(family));
            fromId = assetId;
            toId = target.id;
          }
          claimsByPassage[pi].push(sentence);
          docEdges.push({ family, fromId, toId, passageIndex: pi });
        }
      }

      const header = sourceHeader({
        title,
        code,
        locator: sourceLocator({
          continentKey: build.continentKey,
          islandKey: profile.key,
          year,
          code,
          kind: boundaryKind,
        }),
        kind: boundaryKind,
        dateLabel,
      });

      const drafts: { verbatim: string; rendered: string; resolution: PassageResolution }[] = [];
      for (let t = 0; t < nPassages; t++) {
        /* Stride two, window two: over `nPassages` spans this covers every
           cast member exactly, so no entity is drawn into a molecule and then
           left out of its bytes. */
        const start = (t * 2) % cast.length;
        const focusRecords = [cast[start], cast[(start + 1) % cast.length]].filter(
          (e, i, arr) => arr.indexOf(e) === i,
        );
        const focus: FocusEntity[] = focusRecords.map((e) => ({
          label: e.spec.label,
          type: e.spec.entity_type,
        }));

        /* Resolution disclosure. About 18% of passages are NOT verbatim, and
           they say so — while keeping the span offsets that recover the
           original bytes. Planted evidence passages stay verbatim so the gold
           chain can be checked against the source without a caveat. */
        const isForcedEvidence = forced ? claimsByPassage[t].includes(planned[0]?.sentence ?? '') : false;
        /* The anaphor's referent has to be an organization, and it has to be
           named somewhere in this document — otherwise the "resolved" text
           asserts a referent the reader cannot recover. */
        const corefTarget =
          focusRecords.find((e) => e.spec.entity_type === 'organization') ??
          cast.find((e) => e.spec.entity_type === 'organization');
        const roll = rng();
        let want: 'none' | 'coref' | 'term' = 'none';
        if (!isForcedEvidence) {
          if (roll < 0.09) want = corefTarget ? 'coref' : 'term';
          else if (roll < 0.175) want = 'term';
        }

        drafts.push(
          paragraphFor({
            rng,
            domain: profile.domain,
            seq: t,
            dateLabel,
            focus,
            claims: claimsByPassage[t],
            want,
            corefTarget: corefTarget ? corefTarget.spec.label : focus[0].label,
            openerOffset,
            usedTemplates,
          }),
        );
      }

      const verbatimText = header + drafts.map((d) => d.verbatim).join('\n\n');

      /* Offsets computed from the assembled bytes, not asserted about them. */
      const offsets: Array<[number, number]> = [];
      let cursorChar = header.length;
      for (let t = 0; t < drafts.length; t++) {
        const start = cursorChar;
        const end = start + drafts[t].verbatim.length;
        offsets.push([start, end]);
        cursorChar = end + 2; // the '\n\n' separator
      }

      const segments: SourceSegment[] = [
        {
          seq: 0,
          kind: 'verbatim',
          text: verbatimText,
          content_hash: contentHash(verbatimText),
        },
      ];
      if (rng() < 0.3) {
        const normalized = verbatimText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
        segments.push({
          seq: 1,
          kind: 'normalized',
          text: normalized,
          content_hash: contentHash(normalized),
        });
      }

      const source: Source = {
        id: sourceId,
        kind: 'source',
        label: `${code} · ${boundaryKind}`,
        community_id: build.communityId,
        centrality: 0,
        degree: 0,
        created_at: BAKE_ISO,
        parent_id: null,
        locator: sourceLocator({
          continentKey: build.continentKey,
          islandKey: profile.key,
          year,
          code,
          kind: boundaryKind,
        }),
        media_type: mediaTypeFor(boundaryKind),
        segments,
        content_hash: segments[0].content_hash,
        ingested_at: isoFromMs(boundaryMs + pickInt(rng, 3, 90) * MS_PER_DAY),
        asset_ids: [assetId],
      };
      sources.push(source);
      islandOf.set(sourceId, island.id);

      const asset: Asset = {
        id: assetId,
        kind: 'asset',
        label: title,
        community_id: build.communityId,
        centrality: 0,
        degree: 0,
        created_at: BAKE_ISO,
        parent_id: island.id,
        continent_id: build.continentId,
        boundary_kind: boundaryKind,
        boundary_declared_at: isoFromMs(boundaryMs),
        source_id: sourceId,
        passage_ids: [],
        entity_ids: [],
        token_count: 0,
        summary: assetSummary({ rng, kind: boundaryKind, domain: profile.domain, lead, second, dateLabel }),
      };
      assets.push(asset);
      island.asset_ids.push(assetId);
      islandOf.set(assetId, island.id);
      assetShortTitle.set(assetId, shortTitle);

      const built: Passage[] = [];
      for (let t = 0; t < drafts.length; t++) {
        const [cs, ce] = offsets[t];
        const passageId = `p:${build.continentKey}.${profile.key}.${pad(ai, 3)}.${t}`;
        const draft = drafts[t];
        /* Mentions are DETECTED in the bytes, not assumed from the cast. An
           entity listed on a passage that does not name it is a lie the
           passage-rung drilldown would expose on the first click. */
        const hits = detectMentions(
          `${draft.verbatim}\n${draft.rendered}`,
          cast.map((e) => e.spec.label),
        );
        const mentioned = cast.filter((_e, i) => hits[i]);
        const passage: Passage = {
          id: passageId,
          kind: 'passage',
          label: `${code} · span ${t + 1}`,
          community_id: build.communityId,
          centrality: 0,
          degree: 0,
          created_at: BAKE_ISO,
          parent_id: assetId,
          asset_id: assetId,
          source_id: sourceId,
          seq: t,
          char_start: cs,
          char_end: ce,
          content_hash: contentHash(verbatimText.slice(cs, ce)),
          text: draft.rendered,
          resolution: draft.resolution,
          token_count: tokenCount(draft.rendered),
          entity_ids: mentioned.map((e) => e.id),
        };
        passages.push(passage);
        built.push(passage);
        asset.passage_ids.push(passageId);
        asset.token_count += passage.token_count;
        islandOf.set(passageId, island.id);

        for (const e of mentioned) {
          e.mentions.push(passageId);
          e.assetIds.add(assetId);
          e.islandIds.add(island.id);
        }
      }
      assetPassages.set(assetId, built);
      asset.entity_ids = Array.from(new Set(built.flatMap((p) => p.entity_ids)));

      /* ---- materialise the planned entity edges ------------------------ */
      for (const p of planned) {
        const primary = built[p.passageIndex];
        const isGold = forced !== undefined && p === planned[0];
        if (isGold) {
          /* The gold hops are emitted once, later, carrying every planted span
             at once — so a single edge holds all of its supporting evidence
             rather than three near-duplicate edges holding one each. */
          forced?.collect.push(primary.id);
          continue;
        }

        const evidence = [primary.id];
        const extra = built.filter(
          (b, i) =>
            i !== p.passageIndex &&
            b.entity_ids.includes(p.from.id) &&
            b.entity_ids.includes(p.to.id),
        );
        if (extra.length > 0) evidence.push(extra[0].id);

        edges.push(
          makeEdge({
            id: mkEdgeId(),
            fromId: p.from.id,
            toId: p.to.id,
            family: p.family,
            weight: 0.35 + p.confidence * 0.5,
            confidence: p.confidence,
            evidence,
            quarantineReason: p.quarantineReason,
            createdAt: source.ingested_at,
            islandOf,
          }),
        );
      }

      for (const de of docEdges) {
        edges.push(
          makeEdge({
            id: mkEdgeId(),
            fromId: de.fromId,
            toId: de.toId,
            family: de.family,
            weight: 0.4 + rng() * 0.3,
            confidence: 0.7 + rng() * 0.28,
            evidence: [built[de.passageIndex].id],
            quarantineReason:
              de.alwaysAdmit === true || rng() >= 0.02
                ? null
                : 'duplicate_assertion_divergent_object',
            createdAt: source.ingested_at,
            islandOf,
          }),
        );
      }

      /* ---- the reading-order fiber ------------------------------------- */
      for (let t = 0; t < built.length; t++) {
        if (t > 0) {
          edges.push(
            makeEdge({
              id: mkEdgeId(),
              fromId: built[t].id,
              toId: built[t - 1].id,
              family: '_follows',
              weight: 0.5,
              confidence: 1,
              evidence: [built[t].id],
              quarantineReason: null,
              createdAt: source.ingested_at,
              islandOf,
            }),
          );
        }
        if (t < built.length - 1) {
          edges.push(
            makeEdge({
              id: mkEdgeId(),
              fromId: built[t].id,
              toId: built[t + 1].id,
              family: '_precedes',
              weight: 0.5,
              confidence: 1,
              evidence: [built[t].id],
              quarantineReason: null,
              createdAt: source.ingested_at,
              islandOf,
            }),
          );
        }
        if (t + 2 < built.length) {
          edges.push(
            makeEdge({
              id: mkEdgeId(),
              fromId: built[t].id,
              toId: built[t + 2].id,
              family: '_co_doc',
              weight: 0.34,
              confidence: 1,
              evidence: [built[t].id],
              quarantineReason: null,
              createdAt: source.ingested_at,
              islandOf,
            }),
          );
        }
      }

      /* `_mentioned_before`: an entity first named in an earlier span points at
         one first named later. A fact about the document, never about the world. */
      const firstSeen = new Map<string, number>();
      for (const b of built) {
        for (const eid of b.entity_ids) if (!firstSeen.has(eid)) firstSeen.set(eid, b.seq);
      }
      const ordered = Array.from(firstSeen.entries()).sort((x, y) => x[1] - y[1]);
      let fiberDrawn = 0;
      for (let k = 0; k < ordered.length && fiberDrawn < 3; k++) {
        const [earlier, es] = ordered[k];
        /* Most of an asset's cast is introduced in the opening span, so pairing
           adjacent entries by index yields mostly equal seqs and no fiber at
           all. Reach forward to the first entity that really is introduced
           later. */
        const nextIdx = ordered.findIndex(([, seq], i) => i > k && seq > es);
        if (nextIdx < 0) break;
        const [later, ls] = ordered[nextIdx];
        fiberDrawn += 1;
        edges.push(
          makeEdge({
            id: mkEdgeId(),
            fromId: earlier,
            toId: later,
            family: '_mentioned_before',
            weight: 0.3,
            confidence: 1,
            evidence: [built[ls].id],
            quarantineReason: null,
            createdAt: source.ingested_at,
            islandOf,
          }),
        );
      }

      /* `_covers_period`: the document points at the window it reports on. */
      const periods = cast.filter((e) => e.spec.entity_type === 'period' && e.assetIds.has(assetId));
      if (periods.length > 0) {
        edges.push(
          makeEdge({
            id: mkEdgeId(),
            fromId: assetId,
            toId: periods[0].id,
            family: '_covers_period',
            weight: 0.36,
            confidence: 1,
            evidence: [built[0].id],
            quarantineReason: null,
            createdAt: source.ingested_at,
            islandOf,
          }),
        );
      }

      priorAssets.push(asset);
    }
  }

  /* ---------------------------------------------------------------------
   * 7.4 The gold chain, emitted once with every supporting span attached.
   * ------------------------------------------------------------------ */

  if (goldOperatesEvidence.length < 2) {
    throw new Error('[corpus/world] the operates claim was not planted in at least two passages');
  }
  if (goldAcquiredEvidence.length < 2) {
    throw new Error('[corpus/world] the acquired claim was not planted in at least two passages');
  }

  const goldOperatesEdge = makeEdge({
    id: mkEdgeId(),
    fromId: goldOperator.id,
    toId: goldFacility.id,
    family: 'operates',
    weight: 0.94,
    confidence: 0.97,
    evidence: Array.from(new Set(goldOperatesEvidence)),
    quarantineReason: null,
    createdAt: BAKE_ISO,
    islandOf,
  });
  const goldAcquiredEdge = makeEdge({
    id: mkEdgeId(),
    fromId: goldAcquirer.id,
    toId: goldOperator.id,
    family: 'acquired',
    weight: 0.94,
    confidence: 0.96,
    evidence: Array.from(new Set(goldAcquiredEvidence)),
    quarantineReason: null,
    createdAt: BAKE_ISO,
    islandOf,
  });
  edges.push(goldOperatesEdge, goldAcquiredEdge);

  /* ---------------------------------------------------------------------
   * 7.5 The session fiber, between dated sessions on the same island.
   * ------------------------------------------------------------------ */

  for (const build of islandBuilds) {
    const sessions = build.island.asset_ids
      .map((id) => assets.find((a) => a.id === id))
      .filter((a): a is Asset => a !== undefined && a.boundary_kind === 'session')
      .sort((a, b) => (a.boundary_declared_at < b.boundary_declared_at ? -1 : 1));
    for (let k = 1; k < sessions.length; k++) {
      const prev = sessions[k - 1];
      const cur = sessions[k];
      const ev = assetPassages.get(cur.id)?.[0]?.id;
      const evPrev = assetPassages.get(prev.id)?.[0]?.id;
      if (!ev || !evPrev) continue;
      edges.push(
        makeEdge({
          id: mkEdgeId(), fromId: cur.id, toId: prev.id, family: '_session_follows',
          weight: 0.44, confidence: 1, evidence: [ev], quarantineReason: null,
          createdAt: cur.boundary_declared_at, islandOf,
        }),
        makeEdge({
          id: mkEdgeId(), fromId: prev.id, toId: cur.id, family: '_session_precedes',
          weight: 0.44, confidence: 1, evidence: [evPrev], quarantineReason: null,
          createdAt: cur.boundary_declared_at, islandOf,
        }),
      );
    }
  }

  /* ---------------------------------------------------------------------
   * 7.6 Materialise entities from the generation records.
   * ------------------------------------------------------------------ */

  const entities: Entity[] = entityRecords.map((rec) => {
    const ids = Array.from(rec.islandIds);
    /* Home island first: `island_ids[0]` is the entity's primary place, and the
       strait test reads it. */
    ids.sort((a, b) => (a === rec.homeIslandId ? -1 : b === rec.homeIslandId ? 1 : a < b ? -1 : 1));
    return {
      id: rec.id,
      kind: 'entity',
      label: rec.spec.label,
      community_id: rec.communityId,
      centrality: 0,
      degree: 0,
      created_at: BAKE_ISO,
      parent_id: null,
      entity_type: rec.spec.entity_type,
      aliases: rec.spec.aliases,
      mentions: rec.mentions,
      asset_ids: Array.from(rec.assetIds),
      island_ids: ids,
      is_bridge: ids.length > 1,
      summary: rec.spec.summary,
    } satisfies Entity;
  });

  const entityByIdOut = new Map(entities.map((e) => [e.id, e]));
  for (const build of islandBuilds) {
    build.island.bridge_entity_ids = entities
      .filter((e) => e.is_bridge && e.island_ids.includes(build.island.id))
      .map((e) => e.id);
  }

  /* ---------------------------------------------------------------------
   * 7.7 Rollups, degree and centrality.
   * ------------------------------------------------------------------ */

  const nodes: GraphNode[] = [
    ...continents,
    ...islands,
    ...assets,
    ...passages,
    ...sources,
    ...entities,
  ];
  const nodeById = new Map<string, GraphNode>(nodes.map((n) => [n.id, n]));

  /* Drop any edge whose endpoints did not survive. There should be none; the
     check is here because a dangling endpoint renders as a line into nowhere. */
  const liveEdges = edges.filter((e) => nodeById.has(e.from_id) && nodeById.has(e.to_id));

  const adjacency = new Map<string, string[]>();
  for (const e of liveEdges) {
    const a = adjacency.get(e.from_id);
    if (a) a.push(e.id); else adjacency.set(e.from_id, [e.id]);
    const b = adjacency.get(e.to_id);
    if (b) b.push(e.id); else adjacency.set(e.to_id, [e.id]);
  }
  for (const n of nodes) n.degree = adjacency.get(n.id)?.length ?? 0;

  applyCentrality(nodes, liveEdges);
  inheritSourceCentrality(sources, nodeById);

  for (const island of islands) {
    island.passage_count = island.asset_ids.reduce(
      (sum, id) => sum + ((nodeById.get(id) as Asset | undefined)?.passage_ids.length ?? 0),
      0,
    );
  }
  for (const continent of continents) {
    let assetCount = 0;
    let passageCount = 0;
    for (const iid of continent.island_ids) {
      const isl = nodeById.get(iid) as Island | undefined;
      if (!isl) continue;
      assetCount += isl.asset_ids.length;
      passageCount += isl.passage_count;
    }
    continent.asset_count = assetCount;
    continent.passage_count = passageCount;
    continent.summary = regionSummary(
      continent.summary,
      assetCount,
      new Set(
        continent.island_ids.flatMap(
          (iid) => (nodeById.get(iid) as Island | undefined)?.bridge_entity_ids ?? [],
        ),
      ).size,
    );
  }
  for (const island of islands) {
    island.summary = regionSummary(island.summary, island.asset_ids.length, island.bridge_entity_ids.length);
  }

  /* Region degree and centrality: a continent has no edges of its own, so it
     inherits what is under it rather than rendering as a dot. */
  rollUpRegions(continents, islands, nodeById, liveEdges, islandOf);

  /* ---------------------------------------------------------------------
   * 7.8 Assemble.
   * ------------------------------------------------------------------ */

  const world: World = {
    seed,
    built_at: BAKE_ISO,
    corpus_provenance: CORPUS_PROVENANCE,
    continents,
    islands,
    assets,
    passages,
    sources,
    entities,
    nodes,
    edges: liveEdges,
    node_by_id: nodeById,
    edge_by_id: new Map(liveEdges.map((e) => [e.id, e])),
    adjacency,
    island_of: islandOf,
    community_ids: communityIds,
    ground_truth: DEMO_GROUND_TRUTH,
    staged_queries: [],
    stats: computeStats([], [], []),
  };

  world.staged_queries = buildStagedQueries(world, {
    goldOperatesEdge,
    goldAcquiredEdge,
    goldOperator: entityByIdOut.get(goldOperator.id)!,
    goldFacility: entityByIdOut.get(goldFacility.id)!,
    goldAcquirer: entityByIdOut.get(goldAcquirer.id)!,
    rng,
  });
  world.stats = computeStats(nodes, liveEdges, entities);

  validateWorld(world);
  return world;
}

/* =============================================================================
 * 8. MENTION DETECTION
 * -----------------------------------------------------------------------------
 * `"Rödvik Substation"` is a substring of `"Rödvik Substation II"`. A naive
 * `includes()` would attribute a mention of the second to the first, and the
 * entity layer would quietly grow edges nobody wrote. Longest labels are
 * matched first and their characters are consumed, so a superset can never
 * donate a mention to the label it contains.
 * ========================================================================== */

const WORDY = /[A-Za-z0-9À-ɏ]/;

function findAtBoundary(haystack: string, needle: string): number {
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    const before = i === 0 ? '' : haystack.charAt(i - 1);
    const after = haystack.charAt(i + needle.length);
    if (!WORDY.test(before) && !WORDY.test(after)) return i;
    i = haystack.indexOf(needle, i + 1);
  }
  return -1;
}

function detectMentions(text: string, labels: readonly string[]): boolean[] {
  const found = new Array<boolean>(labels.length).fill(false);
  const order = labels
    .map((label, index) => ({ label, index }))
    .sort((a, b) => b.label.length - a.label.length);
  let work = text;
  for (const { label, index } of order) {
    if (label.length === 0) continue;
    const at = findAtBoundary(work, label);
    if (at < 0) continue;
    found[index] = true;
    work = work.slice(0, at) + ' '.repeat(label.length) + work.slice(at + label.length);
  }
  return found;
}

/* =============================================================================
 * 9. EDGE CONSTRUCTION
 * ========================================================================== */

/** The label with any lot, revision or roman-numeral qualifier stripped. */
function baseName(label: string): string {
  return label.split(',')[0].split(' (')[0].replace(/ (?:II|III|IV|V|VI|VII|VIII|IX|X)$/, '');
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function makeEdge(input: {
  id: string;
  fromId: string;
  toId: string;
  family: RelationFamily;
  weight: number;
  confidence: number;
  evidence: string[];
  quarantineReason: QuarantineReason | null;
  createdAt: IsoTimestamp;
  islandOf: Map<string, string | null>;
}): Edge {
  const def = byFamily[input.family];
  /* Structural edges are truth-gate EXEMPT. Quarantining the graph's own
     skeleton would disconnect the terrain, so the exemption is enforced here
     rather than trusted to the caller. */
  const quarantined = def.truthGated && input.quarantineReason !== null;
  const fromIsland = input.islandOf.get(input.fromId) ?? null;
  const toIsland = input.islandOf.get(input.toId) ?? null;
  return {
    id: input.id,
    from_id: input.fromId,
    to_id: input.toId,
    family: input.family,
    sigma: def.sigma,
    inverse_family: def.inverse,
    weight: Math.min(1, Math.max(0, input.weight)),
    confidence: Math.min(1, Math.max(0, input.confidence)),
    evidence_passage_ids: input.evidence,
    quarantined,
    quarantine_reason: quarantined ? input.quarantineReason : null,
    created_at: input.createdAt,
    crosses_strait: fromIsland !== null && toIsland !== null && fromIsland !== toIsland,
  };
}

/* =============================================================================
 * 10. CENTRALITY
 * -----------------------------------------------------------------------------
 * Weighted degree seeded, then power-iterated towards the dominant eigenvector.
 * Label ranking downstream is centrality-ranked, so this number has to mean
 * something. Quarantined edges are excluded: a rejected claim must not buy a
 * node a bigger radius.
 * ========================================================================== */

function applyCentrality(nodes: GraphNode[], edges: Edge[]): void {
  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n.id, i));
  const n = nodes.length;
  const src: number[] = [];
  const dst: number[] = [];
  const w: number[] = [];
  for (const e of edges) {
    if (e.quarantined) continue;
    const a = index.get(e.from_id);
    const b = index.get(e.to_id);
    if (a === undefined || b === undefined) continue;
    src.push(a);
    dst.push(b);
    w.push(e.weight);
  }

  let v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = 1 / Math.sqrt(n);
  const next = new Float64Array(n);

  for (let iter = 0; iter < 16; iter++) {
    next.fill(0);
    for (let k = 0; k < src.length; k++) {
      next[src[k]] += w[k] * v[dst[k]];
      next[dst[k]] += w[k] * v[src[k]];
    }
    let norm = 0;
    for (let i = 0; i < n; i++) norm += next[i] * next[i];
    norm = Math.sqrt(norm);
    if (norm === 0) break;
    for (let i = 0; i < n; i++) next[i] /= norm;
    v = Float64Array.from(next);
  }

  let max = 0;
  for (let i = 0; i < n; i++) if (v[i] > max) max = v[i];
  if (max <= 0) max = 1;

  /* A pure eigenvector collapses almost everything to zero on a sparse graph,
     which would make every label rank identical. Blend it with normalised
     weighted degree so the number stays discriminative at the tail. */
  const degreeWeight = new Float64Array(n);
  for (let k = 0; k < src.length; k++) {
    degreeWeight[src[k]] += w[k];
    degreeWeight[dst[k]] += w[k];
  }
  let maxDeg = 0;
  for (let i = 0; i < n; i++) if (degreeWeight[i] > maxDeg) maxDeg = degreeWeight[i];
  if (maxDeg <= 0) maxDeg = 1;

  nodes.forEach((node, i) => {
    const eig = v[i] / max;
    const deg = degreeWeight[i] / maxDeg;
    node.centrality = Math.min(1, Math.max(0, 0.55 * eig + 0.45 * deg));
  });
}

/**
 * A source carries no relations of its own — nothing in the vocabulary joins a
 * document to the graph, because the join is the `source_id` field. Left alone
 * it would score zero and render as a hole. It inherits the prominence of the
 * asset extracted from it, which is exactly what its prominence is.
 */
function inheritSourceCentrality(sources: Source[], nodeById: Map<string, GraphNode>): void {
  for (const src of sources) {
    let best = 0;
    for (const aid of src.asset_ids) {
      const asset = nodeById.get(aid);
      if (asset && asset.kind === 'asset') best = Math.max(best, asset.centrality);
    }
    src.centrality = best;
  }
}

function rollUpRegions(
  continents: Continent[],
  islands: Island[],
  nodeById: Map<string, GraphNode>,
  edges: Edge[],
  islandOf: Map<string, string | null>,
): void {
  const islandDegree = new Map<string, number>();
  for (const e of edges) {
    const a = islandOf.get(e.from_id) ?? null;
    const b = islandOf.get(e.to_id) ?? null;
    if (a) islandDegree.set(a, (islandDegree.get(a) ?? 0) + 1);
    if (b && b !== a) islandDegree.set(b, (islandDegree.get(b) ?? 0) + 1);
  }

  const islandMass = new Map<string, number>();
  for (const island of islands) {
    let mass = 0;
    for (const aid of island.asset_ids) {
      const asset = nodeById.get(aid) as Asset | undefined;
      if (!asset) continue;
      mass += asset.centrality;
      for (const pid of asset.passage_ids) {
        mass += (nodeById.get(pid) as Passage | undefined)?.centrality ?? 0;
      }
    }
    islandMass.set(island.id, mass);
  }
  const maxIslandMass = Math.max(1e-9, ...islandMass.values());
  for (const island of islands) {
    island.degree = islandDegree.get(island.id) ?? 0;
    island.centrality = Math.min(1, (islandMass.get(island.id) ?? 0) / maxIslandMass);
  }

  const continentMass = new Map<string, number>();
  for (const continent of continents) {
    let mass = 0;
    let degree = 0;
    for (const iid of continent.island_ids) {
      mass += islandMass.get(iid) ?? 0;
      degree += islandDegree.get(iid) ?? 0;
    }
    continentMass.set(continent.id, mass);
    continent.degree = degree;
  }
  const maxContinentMass = Math.max(1e-9, ...continentMass.values());
  for (const continent of continents) {
    continent.centrality = Math.min(1, (continentMass.get(continent.id) ?? 0) / maxContinentMass);
  }
}

/* =============================================================================
 * 11. STATS
 * ========================================================================== */

function computeStats(nodes: GraphNode[], edges: Edge[], entities: Entity[]): WorldStats {
  const byKind = {
    continent: 0, island: 0, asset: 0, entity: 0, passage: 0, source: 0,
  } as Record<NodeKind, number>;
  for (const n of nodes) byKind[n.kind] += 1;

  const bySigma = SIGMA_CLASSES.reduce(
    (acc, s) => { acc[s] = 0; return acc; },
    {} as Record<SigmaClass, number>,
  );
  const byReason: Record<string, number> = {};
  const families = new Set<RelationFamily>();
  let structural = 0;
  let quarantined = 0;
  let strait = 0;
  for (const e of edges) {
    bySigma[e.sigma] += 1;
    families.add(e.family);
    if (isStructural(e.family)) structural += 1;
    if (e.quarantined) {
      quarantined += 1;
      const key = e.quarantine_reason ?? 'unspecified';
      byReason[key] = (byReason[key] ?? 0) + 1;
    }
    if (e.crosses_strait) strait += 1;
  }

  const semantic = edges.length - structural;
  const resolved = nodes.filter(
    (n) => n.kind === 'passage' && (n as Passage).resolution !== 'verbatim',
  ).length;
  const passageCount = byKind.passage || 1;
  const bridges = entities.filter((e) => e.is_bridge).length;
  const tokens = nodes.reduce(
    (sum, n) => sum + (n.kind === 'passage' ? (n as Passage).token_count : 0),
    0,
  );
  const chars = nodes.reduce(
    (sum, n) => sum + (n.kind === 'source' ? (n as Source).segments[0].text.length : 0),
    0,
  );

  return {
    nodes_total: nodes.length,
    nodes_by_kind: byKind,
    edges_total: edges.length,
    edges_by_sigma: bySigma,
    edges_semantic: semantic,
    edges_structural: structural,
    quarantined,
    quarantine_rate: semantic > 0 ? quarantined / semantic : 0,
    quarantine_by_reason: byReason,
    bridge_entities: bridges,
    bridge_entity_rate: entities.length > 0 ? bridges / entities.length : 0,
    strait_edges: strait,
    resolved_passages: resolved,
    resolution_rate: resolved / passageCount,
    distinct_families_used: families.size,
    communities: new Set(nodes.map((n) => n.community_id)).size,
    tokens_total: tokens,
    source_characters: chars,
  };
}

/* =============================================================================
 * 12. STAGED QUERIES
 * -----------------------------------------------------------------------------
 * Five real questions with by-construction answers. They are DISCOVERED in the
 * generated graph rather than written next to it — a staged query whose gold
 * answer is a string literal proves nothing about the engine.
 * ========================================================================== */

function buildStagedQueries(
  world: World,
  ctx: {
    goldOperatesEdge: Edge;
    goldAcquiredEdge: Edge;
    goldOperator: Entity;
    goldFacility: Entity;
    goldAcquirer: Entity;
    rng: Rng;
  },
): StagedQuery[] {
  const out: StagedQuery[] = [];
  const { goldOperatesEdge, goldAcquiredEdge, goldOperator, goldFacility, goldAcquirer } = ctx;

  out.push({
    id: 'q:bridge:tollstrand',
    query: DEMO_GROUND_TRUTH.query,
    intent: 'bridge',
    mode: 'deterministic',
    gold: DEMO_GROUND_TRUTH.gold,
    gold_node_ids: [
      goldFacility.id,
      goldOperator.id,
      goldAcquirer.id,
      ...goldOperatesEdge.evidence_passage_ids,
      ...goldAcquiredEdge.evidence_passage_ids,
    ],
    gold_edge_ids: [goldOperatesEdge.id, goldAcquiredEdge.id],
    bridge_entity_id: goldOperator.id,
    chain: DEMO_GROUND_TRUTH.chain as readonly (readonly [string, RelationFamily, string])[],
    why: 'Two hops through a bridge entity mentioned on two islands. The answer path physically crosses a strait.',
    corpus_provenance: CORPUS_PROVENANCE,
  });

  const nonGold = (e: Edge): boolean =>
    !e.quarantined && e.id !== goldOperatesEdge.id && e.id !== goldAcquiredEdge.id;

  /* lookup — a single high-confidence factual hop. */
  const lookupEdge = world.edges
    .filter((e) => e.family === 'operated_by' && nonGold(e) && e.evidence_passage_ids.length > 0)
    .sort((a, b) => b.confidence - a.confidence)[0]
    ?? world.edges.filter((e) => e.family === 'operates' && nonGold(e))[0];
  if (lookupEdge) {
    const subject = world.node_by_id.get(lookupEdge.from_id);
    const object = world.node_by_id.get(lookupEdge.to_id);
    if (subject && object) {
      const isOperatedBy = lookupEdge.family === 'operated_by';
      out.push({
        id: 'q:lookup:operator',
        query: `Who operates ${isOperatedBy ? subject.label : object.label}?`,
        intent: 'lookup',
        mode: 'deterministic',
        gold: isOperatedBy ? object.label : subject.label,
        gold_node_ids: [subject.id, object.id, ...lookupEdge.evidence_passage_ids],
        gold_edge_ids: [lookupEdge.id],
        bridge_entity_id: null,
        chain: [[subject.label, lookupEdge.family, object.label]],
        why: 'One hop, one citation. The floor case: the engine should spend almost nothing to answer it.',
        corpus_provenance: CORPUS_PROVENANCE,
      });
    }
  }

  /* compare — two facilities regulated by the same instrument. */
  const regEdges = world.edges.filter((e) => e.family === 'regulated_by' && nonGold(e));
  const byRegulator = new Map<string, Edge[]>();
  for (const e of regEdges) {
    const list = byRegulator.get(e.to_id);
    if (list) list.push(e); else byRegulator.set(e.to_id, [e]);
  }
  const comparePair = Array.from(byRegulator.entries()).find(([, list]) => {
    const distinct = new Set(list.map((e) => e.from_id));
    return distinct.size >= 2;
  });
  if (comparePair) {
    const [regulatorId, list] = comparePair;
    const distinct = Array.from(new Set(list.map((e) => e.from_id))).slice(0, 2);
    const a = world.node_by_id.get(distinct[0]);
    const b = world.node_by_id.get(distinct[1]);
    const reg = world.node_by_id.get(regulatorId);
    if (a && b && reg) {
      const used = list.filter((e) => distinct.includes(e.from_id));
      out.push({
        id: 'q:compare:regulated',
        query: `Compare how ${a.label} and ${b.label} are treated under ${reg.label}.`,
        intent: 'compare',
        mode: 'deterministic',
        gold: `${a.label} and ${b.label} are both regulated by ${reg.label}`,
        gold_node_ids: [a.id, b.id, reg.id, ...used.flatMap((e) => e.evidence_passage_ids)],
        gold_edge_ids: used.map((e) => e.id),
        bridge_entity_id: null,
        chain: [
          [a.label, 'regulated_by', reg.label],
          [b.label, 'regulated_by', reg.label],
        ],
        why: 'Two subjects joined by one shared object. The constellation should be a fork, not a chain.',
        corpus_provenance: CORPUS_PROVENANCE,
      });
    }
  }

  /* timeline — the dated session fiber on the busiest island. */
  const sessionIsland = world.islands
    .map((isl) => ({
      isl,
      sessions: isl.asset_ids
        .map((id) => world.node_by_id.get(id) as Asset | undefined)
        .filter((a): a is Asset => a !== undefined && a.boundary_kind === 'session')
        .sort((x, y) => (x.boundary_declared_at < y.boundary_declared_at ? -1 : 1)),
    }))
    .sort((x, y) => y.sessions.length - x.sessions.length)[0];
  if (sessionIsland && sessionIsland.sessions.length >= 3) {
    const chosen = sessionIsland.sessions.slice(0, 4);
    const fiber = world.edges.filter(
      (e) =>
        e.family === '_session_follows' &&
        chosen.some((a) => a.id === e.from_id) &&
        chosen.some((a) => a.id === e.to_id),
    );
    out.push({
      id: 'q:timeline:sessions',
      query: `Put the dated sessions on ${sessionIsland.isl.label} in order and say what changed between them.`,
      intent: 'timeline',
      mode: 'deterministic',
      gold: chosen.map((a) => a.boundary_declared_at.slice(0, 10)).join(' -> '),
      gold_node_ids: [sessionIsland.isl.id, ...chosen.map((a) => a.id)],
      gold_edge_ids: fiber.map((e) => e.id),
      bridge_entity_id: null,
      chain: chosen.slice(1).map((a, i) => [a.label, '_session_follows', chosen[i].label] as const),
      why: 'Ordering carried by the structural fiber, not by a sort in the UI. Truth-gate exempt on purpose.',
      corpus_provenance: CORPUS_PROVENANCE,
    });
  }

  /* summarize — the highest-centrality entity on the largest island. */
  const busiest = world.islands.slice().sort((a, b) => b.asset_ids.length - a.asset_ids.length)[0];
  if (busiest) {
    const top = world.entities
      .filter(
        (e) =>
          e.island_ids.includes(busiest.id) &&
          (e.entity_type === 'organization' || e.entity_type === 'facility'),
      )
      .sort((a, b) => b.centrality - a.centrality)[0];
    if (top) {
      out.push({
        id: 'q:summarize:island',
        query: `Summarise what the ${busiest.label} record establishes about ${top.label}.`,
        intent: 'summarize',
        mode: 'deterministic',
        gold: top.label,
        gold_node_ids: [busiest.id, top.id, ...top.mentions.slice(0, 6)],
        gold_edge_ids: world.edges
          .filter((e) => (e.from_id === top.id || e.to_id === top.id) && !e.quarantined)
          .slice(0, 8)
          .map((e) => e.id),
        bridge_entity_id: top.is_bridge ? top.id : null,
        chain: [],
        why: 'A breadth question. The interesting number is what the renderer chose NOT to spend on.',
        corpus_provenance: CORPUS_PROVENANCE,
      });
    }
  }

  return out;
}

/* =============================================================================
 * 13. VALIDATION — fail loud
 * -----------------------------------------------------------------------------
 * Every invariant the rest of the build is allowed to assume. It throws with a
 * message naming the invariant, because the whole thesis of this project is
 * that the interface never lies about the engine, and a corpus that quietly
 * fails an invariant is the first lie in the chain.
 * ========================================================================== */

export function validateWorld(world: World, opts: { deep?: boolean } = {}): void {
  const deep = opts.deep !== false;
  const fail = (invariant: string, detail: string): never => {
    throw new Error(`[corpus/world] INVARIANT FAILED — ${invariant}: ${detail}`);
  };

  if (world.corpus_provenance !== CORPUS_PROVENANCE) {
    fail('corpus_provenance', `expected "${CORPUS_PROVENANCE}", got "${String(world.corpus_provenance)}"`);
  }
  if (RUNGS.length !== 3) fail('rung count', `expected 3 rungs, contract exposes ${RUNGS.length}`);
  if (VIEW_KEYS.length !== RUNGS.length + 1) {
    fail('view keys', `expected the three rungs plus "passage", contract exposes ${VIEW_KEYS.join(', ')}`);
  }

  /* ---- the containment spine resolves ------------------------------- */
  for (const island of world.islands) {
    if (!world.node_by_id.has(island.parent_id)) {
      fail('spine: island.parent_id resolves', `island ${island.id} points at missing continent ${island.parent_id}`);
    }
  }
  for (const asset of world.assets) {
    if (!world.node_by_id.has(asset.parent_id)) {
      fail('spine: asset.parent_id resolves', `asset ${asset.id} points at missing island ${asset.parent_id}`);
    }
    if (!world.node_by_id.has(asset.source_id)) {
      fail('spine: asset.source_id resolves', `asset ${asset.id} points at missing source ${asset.source_id}`);
    }
  }

  const sourceById = new Map(world.sources.map((s) => [s.id, s]));

  /* ---- passage spans really index the verbatim segment ---------------- */
  const sampleStep = deep ? 1 : Math.max(1, Math.floor(world.passages.length / 512));
  for (let i = 0; i < world.passages.length; i += sampleStep) {
    const p = world.passages[i];
    if (!world.node_by_id.has(p.parent_id)) {
      fail('spine: passage.parent_id resolves', `passage ${p.id} points at missing asset ${p.parent_id}`);
    }
    const src = sourceById.get(p.source_id);
    if (!src) fail('passage.source_id resolves', `passage ${p.id} points at missing source ${p.source_id}`);
    const seg0 = src!.segments[0];
    if (seg0.seq !== 0 || seg0.kind !== 'verbatim') {
      fail('source segment 0 is verbatim', `source ${src!.id} segment 0 is seq=${seg0.seq} kind=${seg0.kind}`);
    }
    if (p.char_start < 0 || p.char_end > seg0.text.length || p.char_end <= p.char_start) {
      fail(
        'passage span is inside the source',
        `passage ${p.id} span [${p.char_start},${p.char_end}) against a ${seg0.text.length}-char segment`,
      );
    }
    const slice = seg0.text.slice(p.char_start, p.char_end);
    if (contentHash(slice) !== p.content_hash) {
      fail(
        'passage.content_hash is the hash of the verbatim span',
        `passage ${p.id} hash ${p.content_hash} does not match the bytes at [${p.char_start},${p.char_end})`,
      );
    }
    if (p.resolution === 'verbatim' && p.text !== slice) {
      fail(
        'a verbatim passage renders its verbatim bytes',
        `passage ${p.id} claims verbatim but its text differs from the source span`,
      );
    }
    if (p.resolution !== 'verbatim' && p.text === slice) {
      fail(
        'a resolved passage differs from its verbatim bytes',
        `passage ${p.id} claims ${p.resolution} but is byte-identical to the span`,
      );
    }
  }

  /* ---- source hashes chain to their own verbatim bytes ---------------- */
  if (deep) {
    for (const s of world.sources) {
      if (contentHash(s.segments[0].text) !== s.content_hash) {
        fail('source.content_hash covers segment 0', `source ${s.id} hash does not match its verbatim bytes`);
      }
    }
  }

  /* ---- the entity layer ---------------------------------------------- */
  for (const e of world.entities) {
    if (e.is_bridge !== e.island_ids.length > 1) {
      fail(
        'is_bridge is derived from island_ids',
        `entity ${e.id} has is_bridge=${String(e.is_bridge)} with ${e.island_ids.length} island(s)`,
      );
    }
    if (e.mentions.length === 0) {
      fail('every entity has at least one mention', `entity ${e.id} ("${e.label}") is never mentioned`);
    }
  }

  /* ---- edges ---------------------------------------------------------- */
  let structuralQuarantined = 0;
  for (const edge of world.edges) {
    if (!world.node_by_id.has(edge.from_id) || !world.node_by_id.has(edge.to_id)) {
      fail('no dangling edge endpoints', `edge ${edge.id} joins ${edge.from_id} -> ${edge.to_id}`);
    }
    if (edge.sigma !== sigmaOf(edge.family)) {
      fail('edge.sigma matches its family', `edge ${edge.id} has sigma ${edge.sigma} for family ${edge.family}`);
    }
    if (edge.inverse_family !== byFamily[edge.family].inverse) {
      fail('edge.inverse_family matches the vocabulary', `edge ${edge.id} family ${edge.family}`);
    }
    if (isStructural(edge.family) && edge.quarantined) structuralQuarantined += 1;
    if (edge.quarantined && edge.quarantine_reason === null) {
      fail('a quarantined edge names its reason', `edge ${edge.id} is quarantined with a null reason`);
    }
    if (!edge.quarantined && edge.quarantine_reason !== null) {
      fail('an admitted edge has no reason', `edge ${edge.id} carries reason "${edge.quarantine_reason}"`);
    }
    if (edge.evidence_passage_ids.length === 0) {
      fail('every edge can be cited', `edge ${edge.id} (${edge.family}) has no evidence passage`);
    }
  }
  if (structuralQuarantined > 0) {
    fail(
      'structural edges are truth-gate exempt',
      `${structuralQuarantined} underscore-token edge(s) were quarantined`,
    );
  }

  const semanticCount = world.edges.filter((e) => !isStructural(e.family)).length;
  const quarantinedCount = world.edges.filter((e) => e.quarantined).length;
  const rate = semanticCount > 0 ? quarantinedCount / semanticCount : 0;
  if (deep && (rate < 0.02 || rate > 0.05)) {
    fail(
      'quarantine rate sits in the design band',
      `${(rate * 100).toFixed(2)}% of truth-gated edges were quarantined; the band is 2.5-4%`,
    );
  }

  /* ---- non-quarantined entity-to-entity claims are actually evidenced -- */
  if (deep) {
    const passageById = new Map(world.passages.map((p) => [p.id, p]));
    let checked = 0;
    for (const edge of world.edges) {
      if (edge.quarantined || isStructural(edge.family)) continue;
      const from = world.node_by_id.get(edge.from_id);
      const to = world.node_by_id.get(edge.to_id);
      if (!from || !to || from.kind !== 'entity' || to.kind !== 'entity') continue;
      const ok = edge.evidence_passage_ids.some((pid) => {
        const p = passageById.get(pid);
        if (!p) return false;
        const src = sourceById.get(p.source_id);
        const verbatim = src ? src.segments[0].text.slice(p.char_start, p.char_end) : '';
        const haystack = `${p.text}\n${verbatim}`;
        return haystack.includes(from.label) && haystack.includes(to.label);
      });
      if (!ok) {
        fail(
          'an admitted claim is present in its evidence',
          `edge ${edge.id} (${from.label} --${edge.family}--> ${to.label}) cites no passage naming both endpoints`,
        );
      }
      checked += 1;
    }
    if (checked === 0) fail('entity claims exist', 'no admitted entity-to-entity edge was found to check');
  }

  /* =========================================================================
   * THE GROUND TRUTH. Built, not narrated.
   * ====================================================================== */

  const byLabel = new Map<string, Entity>();
  for (const e of world.entities) byLabel.set(e.label, e);

  const bridge = byLabel.get(DEMO_GROUND_TRUTH.bridge_entity_label);
  if (!bridge) {
    fail('ground truth: bridge entity exists', `no entity labelled "${DEMO_GROUND_TRUTH.bridge_entity_label}"`);
  }
  if (!bridge!.is_bridge) {
    fail('ground truth: bridge entity is a bridge', `"${bridge!.label}" has is_bridge=false`);
  }
  if (bridge!.island_ids.length < 2) {
    fail(
      'ground truth: bridge entity spans two islands',
      `"${bridge!.label}" is on ${bridge!.island_ids.length} island(s)`,
    );
  }

  const facility = byLabel.get('Bruntorp Facility');
  const acquirer = byLabel.get(DEMO_GROUND_TRUTH.gold);
  if (!facility) fail('ground truth: Bruntorp Facility exists', 'entity not found');
  if (!acquirer) fail('ground truth: gold entity exists', `no entity labelled "${DEMO_GROUND_TRUTH.gold}"`);

  const operatesEdge = world.edges.find(
    (e) => e.from_id === bridge!.id && e.to_id === facility!.id && e.family === 'operates',
  );
  if (!operatesEdge) {
    fail(
      'ground truth: the operates hop exists',
      `no edge "${bridge!.label}" --operates--> "${facility!.label}"`,
    );
  }
  if (operatesEdge!.sigma !== 'factual') {
    fail('ground truth: the operates hop is factual', `sigma is ${operatesEdge!.sigma}`);
  }
  if (operatesEdge!.quarantined) {
    fail('ground truth: the operates hop is admitted', `it is quarantined as ${String(operatesEdge!.quarantine_reason)}`);
  }

  const acquiredEdge = world.edges.find(
    (e) => e.from_id === acquirer!.id && e.to_id === bridge!.id && e.family === 'acquired',
  );
  if (!acquiredEdge) {
    fail(
      'ground truth: the acquired hop exists',
      `no edge "${acquirer!.label}" --acquired--> "${bridge!.label}"`,
    );
  }
  if (acquiredEdge!.sigma !== 'episodic') {
    fail('ground truth: the acquired hop is episodic', `sigma is ${acquiredEdge!.sigma}`);
  }
  if (acquiredEdge!.quarantined) {
    fail('ground truth: the acquired hop is admitted', `it is quarantined as ${String(acquiredEdge!.quarantine_reason)}`);
  }

  const facilityIsland = facility!.island_ids[0];
  const acquirerIsland = acquirer!.island_ids[0];
  if (facilityIsland === acquirerIsland) {
    fail(
      'ground truth: the two ends sit on different islands',
      `both "${facility!.label}" and "${acquirer!.label}" resolve to ${facilityIsland}`,
    );
  }
  if (!bridge!.island_ids.includes(facilityIsland) || !bridge!.island_ids.includes(acquirerIsland)) {
    fail(
      'ground truth: the bridge is mentioned on both islands',
      `"${bridge!.label}" is on [${bridge!.island_ids.join(', ')}] but the ends are on ${facilityIsland} and ${acquirerIsland}`,
    );
  }
  if (!acquiredEdge!.crosses_strait) {
    fail('ground truth: the answer path crosses a strait', `edge ${acquiredEdge!.id} is not marked crosses_strait`);
  }

  /* Each of the three entities must have at least two supporting passages
     whose VERBATIM bytes contain the claim — not the rendered text, the bytes. */
  const passageById = new Map(world.passages.map((p) => [p.id, p]));
  const verbatimOf = (pid: string): string => {
    const p = passageById.get(pid);
    if (!p) return '';
    const src = sourceById.get(p.source_id);
    return src ? src.segments[0].text.slice(p.char_start, p.char_end) : '';
  };
  const operatesClaim = `${bridge!.label} operates ${facility!.label}`;
  const acquiredClaim = `${acquirer!.label} acquired ${bridge!.label}`;

  const operatesSupport = operatesEdge!.evidence_passage_ids.filter((pid) =>
    verbatimOf(pid).includes(operatesClaim),
  );
  const acquiredSupport = acquiredEdge!.evidence_passage_ids.filter((pid) =>
    verbatimOf(pid).includes(acquiredClaim),
  );

  if (operatesSupport.length < 2) {
    fail(
      'ground truth: the operates claim is in at least two verbatim spans',
      `found ${operatesSupport.length} span(s) containing "${operatesClaim}"`,
    );
  }
  if (acquiredSupport.length < 2) {
    fail(
      'ground truth: the acquired claim is in at least two verbatim spans',
      `found ${acquiredSupport.length} span(s) containing "${acquiredClaim}"`,
    );
  }
  const bridgeSupport = operatesSupport.length + acquiredSupport.length;
  if (bridgeSupport < 2) {
    fail('ground truth: the bridge entity has two supporting passages', `found ${bridgeSupport}`);
  }
  const bridgeIslandsWithMentions = new Set(
    [...operatesSupport, ...acquiredSupport].map((pid) => world.island_of.get(pid) ?? ''),
  );
  if (bridgeIslandsWithMentions.size < 2) {
    fail(
      'ground truth: the supporting passages sit on two islands',
      `all supporting spans resolve to ${Array.from(bridgeIslandsWithMentions).join(', ')}`,
    );
  }

  /* ---- staged queries point at nodes that exist ----------------------- */
  for (const q of world.staged_queries) {
    for (const nid of q.gold_node_ids) {
      if (!world.node_by_id.has(nid)) {
        fail('staged query nodes exist', `query ${q.id} references missing node ${nid}`);
      }
    }
    for (const eid of q.gold_edge_ids) {
      if (!world.edge_by_id.has(eid)) {
        fail('staged query edges exist', `query ${q.id} references missing edge ${eid}`);
      }
    }
  }
  if (world.staged_queries.length < 2) {
    fail('the command bar has more than one real thing to run', `only ${world.staged_queries.length} staged query`);
  }
}

/* =============================================================================
 * 14. SCALE PADDING — the 100K frame-budget world
 * -----------------------------------------------------------------------------
 * Pads the SAME world out to `n` nodes. Replica assets are real molecules that
 * point at the source they were replicated from, and they are joined to their
 * template by a `derived_from` edge — which is literally true of them. Reusing
 * the island and community structure means the renderer is stress-tested
 * against clustered terrain rather than against uniform noise, which is the
 * only version of the test worth passing.
 * ========================================================================== */

export function buildSynthetic(n: number, seed: number = DEFAULT_SEED): World {
  const world = buildWorld(seed);
  if (n <= world.nodes.length) return world;

  const rng = subStream(seed, `pad:${n}`);
  const templates = world.assets.filter((a) => a.passage_ids.length >= 3);
  if (templates.length === 0) throw new Error('[corpus/world] no template asset available for padding');

  const NODES_PER_REPLICA = 4; // one asset + three passages
  const wanted = Math.ceil((n - world.nodes.length) / NODES_PER_REPLICA);

  const sourceById = new Map(world.sources.map((s) => [s.id, s]));
  const entityById = new Map(world.entities.map((e) => [e.id, e]));
  const islandById = new Map(world.islands.map((i) => [i.id, i]));
  const passageById = new Map(world.passages.map((p) => [p.id, p]));

  let edgeSeq = world.edges.length;
  const mkEdgeId = (): string => `x:syn:${pad(edgeSeq++, 7)}`;

  for (let k = 0; k < wanted; k++) {
    const template = templates[k % templates.length];
    const island = islandById.get(template.parent_id);
    if (!island) continue;
    const source = sourceById.get(template.source_id);
    if (!source) continue;

    const assetId = `a:syn:${pad(k, 7)}`;
    const replicaPassages: Passage[] = [];

    const replica: Asset = {
      id: assetId,
      kind: 'asset',
      label: `${template.label} — replica ${k + 1}`,
      community_id: template.community_id,
      centrality: 0,
      degree: 0,
      created_at: template.created_at,
      parent_id: template.parent_id,
      continent_id: template.continent_id,
      boundary_kind: template.boundary_kind,
      boundary_declared_at: template.boundary_declared_at,
      source_id: template.source_id,
      passage_ids: [],
      entity_ids: [],
      token_count: 0,
      summary: template.summary,
    };

    for (let t = 0; t < 3; t++) {
      const src = passageById.get(template.passage_ids[t]);
      if (!src) continue;
      const pid = `p:syn:${pad(k, 7)}.${t}`;
      /* A faithful replica: same source, same span, same bytes, same hash.
         Nothing here claims to be new evidence — it claims to be the same
         evidence, cited again, which is exactly what it is. */
      const p: Passage = {
        ...src,
        id: pid,
        label: src.label,
        parent_id: assetId,
        asset_id: assetId,
        seq: t,
        entity_ids: src.entity_ids.slice(),
        centrality: 0,
        degree: 0,
      };
      replicaPassages.push(p);
      replica.passage_ids.push(pid);
      replica.token_count += p.token_count;
      world.passages.push(p);
      world.nodes.push(p);
      world.node_by_id.set(pid, p);
      world.island_of.set(pid, island.id);
      passageById.set(pid, p);

      for (const eid of p.entity_ids) {
        const ent = entityById.get(eid);
        if (!ent) continue;
        ent.mentions.push(pid);
        if (!ent.asset_ids.includes(assetId)) ent.asset_ids.push(assetId);
      }
    }
    if (replicaPassages.length === 0) continue;

    replica.entity_ids = Array.from(new Set(replicaPassages.flatMap((p) => p.entity_ids)));
    world.assets.push(replica);
    world.nodes.push(replica);
    world.node_by_id.set(assetId, replica);
    world.island_of.set(assetId, island.id);
    island.asset_ids.push(assetId);
    source.asset_ids.push(assetId);

    const push = (e: Edge): void => {
      world.edges.push(e);
      world.edge_by_id.set(e.id, e);
    };

    for (let t = 0; t + 1 < replicaPassages.length; t++) {
      push(makeEdge({
        id: mkEdgeId(), fromId: replicaPassages[t + 1].id, toId: replicaPassages[t].id,
        family: '_follows', weight: 0.5, confidence: 1,
        evidence: [replicaPassages[t + 1].id], quarantineReason: null,
        createdAt: replica.created_at, islandOf: world.island_of,
      }));
      push(makeEdge({
        id: mkEdgeId(), fromId: replicaPassages[t].id, toId: replicaPassages[t + 1].id,
        family: '_precedes', weight: 0.5, confidence: 1,
        evidence: [replicaPassages[t].id], quarantineReason: null,
        createdAt: replica.created_at, islandOf: world.island_of,
      }));
    }
    if (replicaPassages.length >= 3) {
      push(makeEdge({
        id: mkEdgeId(), fromId: replicaPassages[0].id, toId: replicaPassages[2].id,
        family: '_co_doc', weight: 0.34, confidence: 1,
        evidence: [replicaPassages[0].id], quarantineReason: null,
        createdAt: replica.created_at, islandOf: world.island_of,
      }));
    }
    push(makeEdge({
      id: mkEdgeId(), fromId: assetId, toId: template.id, family: 'derived_from',
      weight: 0.6, confidence: 0.9 + rng() * 0.09,
      evidence: [replicaPassages[0].id], quarantineReason: null,
      createdAt: replica.created_at, islandOf: world.island_of,
    }));
  }

  /* Recompute everything the padding invalidated. Stale derived numbers are
     exactly the kind of quiet lie this build exists to refuse. */
  world.adjacency.clear();
  for (const e of world.edges) {
    const a = world.adjacency.get(e.from_id);
    if (a) a.push(e.id); else world.adjacency.set(e.from_id, [e.id]);
    const b = world.adjacency.get(e.to_id);
    if (b) b.push(e.id); else world.adjacency.set(e.to_id, [e.id]);
  }
  for (const node of world.nodes) node.degree = world.adjacency.get(node.id)?.length ?? 0;
  applyCentrality(world.nodes, world.edges);
  inheritSourceCentrality(world.sources, world.node_by_id);
  for (const island of world.islands) {
    island.passage_count = island.asset_ids.reduce(
      (sum, id) => sum + ((world.node_by_id.get(id) as Asset | undefined)?.passage_ids.length ?? 0),
      0,
    );
  }
  for (const continent of world.continents) {
    continent.asset_count = continent.island_ids.reduce(
      (sum, iid) => sum + ((world.node_by_id.get(iid) as Island | undefined)?.asset_ids.length ?? 0),
      0,
    );
    continent.passage_count = continent.island_ids.reduce(
      (sum, iid) => sum + ((world.node_by_id.get(iid) as Island | undefined)?.passage_count ?? 0),
      0,
    );
  }
  rollUpRegions(world.continents, world.islands, world.node_by_id, world.edges, world.island_of);
  world.stats = computeStats(world.nodes, world.edges, world.entities);

  /* The base world was already deep-validated by `buildWorld`; this pass
     confirms the padding did not break the spine or the ground truth. */
  validateWorld(world, { deep: false });
  return world;
}

/* =============================================================================
 * 15. READ HELPERS
 * ========================================================================== */

/**
 * The verbatim bytes behind a passage — the `seq === 0` segment sliced at the
 * passage's own offsets. This is the ONLY legal way to satisfy a citation. A
 * derived segment (`seq > 0`) may never be used for it.
 */
export function verbatimSpan(world: World, passageId: string): string | null {
  const p = world.node_by_id.get(passageId);
  if (!p || p.kind !== 'passage') return null;
  const src = world.node_by_id.get(p.source_id);
  if (!src || src.kind !== 'source') return null;
  const seg = src.segments.find((s) => s.seq === 0);
  if (!seg) return null;
  return seg.text.slice(p.char_start, p.char_end);
}

/** Recheck a passage's hash against the source bytes. Returns true when intact. */
export function verifyPassageHash(world: World, passageId: string): boolean {
  const p = world.node_by_id.get(passageId);
  if (!p || p.kind !== 'passage') return false;
  const span = verbatimSpan(world, passageId);
  if (span === null) return false;
  return contentHash(span) === p.content_hash;
}

/** Every abbreviation a `term_resolved` passage may have expanded. */
export const RESOLUTION_ABBREVIATIONS = ABBREVIATIONS;
