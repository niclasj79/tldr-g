/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE FIXTURE CORPUS (memoised singleton)
 * =============================================================================
 *
 * Build the world ONCE. Validate it ONCE. Bake the layout ONCE. Count the truth
 * gate's work ONCE. Then hand the same frozen artefacts to everybody, forever.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS A SINGLETON AND NOT A HOOK
 * -----------------------------------------------------------------------------
 * `buildWorld()` is ~500ms of real generation and `bakeLayout()` is ~100ms of
 * real optimisation. Doing either of them on a render path would make the map
 * move when the data did not — which is the exact anti-thesis of the product,
 * because it destroys the spatial memory that is the only reason to draw a
 * terrain instead of a list. So the work happens exactly once, lazily, behind a
 * module-level memo, and every consumer gets the identical object graph.
 *
 * Import this from anywhere. Call `getFixtures()` as often as you like. After
 * the first call it is a pointer dereference.
 *
 * -----------------------------------------------------------------------------
 * THE TIMINGS ARE REAL
 * -----------------------------------------------------------------------------
 * `FixtureTimings` holds WALL-CLOCK MILLISECONDS measured around the four
 * phases, taken from `performance.now()` on the machine that is running the
 * demo. They exist so the HUD can print `bake 104 ms` and have that be a
 * measurement rather than a decoration. An invented latency number on an
 * instrument panel is a small lie that makes every other number on the panel
 * unbelievable, so this module measures instead of asserting.
 *
 * -----------------------------------------------------------------------------
 * VALIDATION IS LOUD ON PURPOSE
 * -----------------------------------------------------------------------------
 * `validateWorld()` throws. It is called here, deeply, and NOTHING catches it.
 * A corpus that quietly fails an invariant is the first lie in the chain: the
 * spine would resolve to a missing node, a `content_hash` would stop matching
 * the bytes it claims to cover, and the receipt panel would keep rendering a
 * confident green badge over it. Better a white screen with a stack trace.
 * =============================================================================
 */

import { buildWorld, validateWorld } from '@/engine/corpus/world';
import type { StagedQuery, World } from '@/engine/corpus/world';

import { bakeLayout, boundsOf, buildSpatialIndex, positionsById } from '@/engine/layout/bake';
import type { SpatialIndex } from '@/engine/layout/bake';

import { computeIntegrity } from '@/engine/trust/integrity';

import { CORPUS_PROVENANCE } from '@/engine/types';
import type {
  Bounds,
  CorpusProvenance,
  Edge,
  EdgeBundle,
  GraphNode,
  IntegrityResponse,
  IsoTimestamp,
  LayoutBake,
  NodePosition,
  Rung,
  SigmaClass,
} from '@/engine/types';

/* =============================================================================
 * 1. TIMEBASE
 * ========================================================================== */

/**
 * Monotonic milliseconds. `performance.now()` where it exists (browser, and
 * node >= 16 globally), `Date.now()` as the floor. Never `new Date()` in a hot
 * path — the timings must be a measurement of the work, not of the clock read.
 */
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Round to two decimals. A sub-microsecond digit on a millisecond gauge is noise dressed as precision. */
function ms2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* =============================================================================
 * 2. SHAPES
 * ========================================================================== */

/**
 * Measured build cost, in milliseconds, of the four phases. These are what the
 * HUD prints. Every one of them is a `performance.now()` delta around real work.
 */
export interface FixtureTimings {
  /** `buildWorld()` — corpus generation, including its own internal validation pass. */
  build_ms: number;
  /** `validateWorld(world, { deep: true })` — every passage hash re-checked against source bytes. */
  validate_ms: number;
  /** `bakeLayout()` — the semantic layout. */
  bake_ms: number;
  /** `computeIntegrity()` — the truth gate's report card. */
  integrity_ms: number;
  /** Position map, spatial index and the precomputed corridor sets. */
  index_ms: number;
  /** Sum of the five phases. What "the demo took N ms to become a place" means. */
  total_ms: number;
  /** When the fixtures finished materialising, on the host clock. */
  built_at: IsoTimestamp;
}

/**
 * The precomputed trade-route corridors, one set per REGION rung.
 *
 * Bundling is not decoration and it is not a performance trick — it is the only
 * honest thing to draw at a rung whose nodes are regions. A continent has no
 * relations of its own; what runs between two continents is a corridor carrying
 * some number of relations between the leaf nodes underneath them. Drawing the
 * leaves at that zoom is the hairball; drawing nothing is a lie of omission.
 *
 * Computed once because it is a pure function of the edge set, and the edge set
 * does not change between renders.
 */
export interface RegionBundles {
  /** Corridors between continents. `is_strait` is always true: their leaves are on different islands. */
  readonly continent: readonly EdgeBundle[];
  /** Corridors between islands — the straits. This is the set the demo's answer path crosses. */
  readonly island: readonly EdgeBundle[];
}

/** Everything the engine serves, materialised once. Treat every field as immutable. */
export interface Fixtures {
  /** The generated corpus: spine, entity layer, edges, staged queries, measured stats. */
  readonly world: World;
  /** The frozen layout every coordinate in the app is expressed against. */
  readonly bake: LayoutBake;
  /** The truth gate's report card over `world.edges`. */
  readonly integrity: IntegrityResponse;
  /** O(1) position lookup. Same objects as `bake.positions`. */
  readonly positions: Map<string, NodePosition>;
  /** Hover picking / radius / rect queries over every baked position. */
  readonly spatial: SpatialIndex;
  /** Precomputed corridors for the two region rungs. */
  readonly bundles: RegionBundles;
  /** node id -> the continent it lives under. Continents map to themselves. */
  readonly continentOf: Map<string, string>;
  /** node id -> the island it primarily belongs to. Islands map to themselves; continents are absent. */
  readonly islandOf: Map<string, string>;
  /** node id -> the asset (molecule) it lives inside. Assets map to themselves; entities are absent. */
  readonly assetOf: Map<string, string>;
  /** The staged questions with by-construction answers. The command bar's real menu. */
  readonly stagedQueries: readonly StagedQuery[];
  /** Measured, not asserted. */
  readonly timings: FixtureTimings;
  /** Always `'synthetic-design-concept'`, and the UI is required to surface it. */
  readonly corpus_provenance: CorpusProvenance;
}

/* =============================================================================
 * 3. DERIVED INDICES
 * ========================================================================== */

/**
 * Walk the spine upward once and record, for every node, which continent /
 * island / asset it sits under.
 *
 * `world.island_of` already answers the island question, but it is
 * `Map<string, string | null>` (continents legitimately have no island), and a
 * nullable map in a hot filter is a `?? ''` waiting to happen. These are total
 * over the nodes they apply to and absent otherwise, which is the shape callers
 * actually want.
 */
function buildRegionIndex(world: World): {
  continentOf: Map<string, string>;
  islandOf: Map<string, string>;
  assetOf: Map<string, string>;
} {
  const continentOf = new Map<string, string>();
  const islandOf = new Map<string, string>();
  const assetOf = new Map<string, string>();

  const continentOfIsland = new Map<string, string>();
  for (const island of world.islands) {
    continentOfIsland.set(island.id, island.parent_id);
    islandOf.set(island.id, island.id);
    continentOf.set(island.id, island.parent_id);
  }
  for (const continent of world.continents) continentOf.set(continent.id, continent.id);

  for (const [nodeId, islandId] of world.island_of) {
    if (islandId === null) continue;
    islandOf.set(nodeId, islandId);
    const cid = continentOfIsland.get(islandId);
    if (cid !== undefined) continentOf.set(nodeId, cid);
  }

  for (const asset of world.assets) assetOf.set(asset.id, asset.id);
  for (const passage of world.passages) assetOf.set(passage.id, passage.asset_id);
  for (const source of world.sources) {
    const first = source.asset_ids[0];
    if (first !== undefined) assetOf.set(source.id, first);
  }
  // Entities are deliberately absent: an entity that lives in eleven assets has
  // no containing molecule, and inventing one would flatten the cross-cutting
  // layer into the spine. That flattening is the single most common way to
  // break the grain, so this map simply does not answer for entities.

  return { continentOf, islandOf, assetOf };
}

/** Sorted, stable corridor key so `A|B` and `B|A` are one corridor, not two. */
function corridorKey(a: string, b: string): [string, string, string] {
  return a < b ? [`${a}|${b}`, a, b] : [`${b}|${a}`, b, a];
}

/**
 * Aggregate every edge into corridors between the region nodes that contain its
 * endpoints. Only edges whose endpoints land in DIFFERENT regions produce a
 * corridor — an edge inside one region is that region's internal business and is
 * drawn when you descend into it, not smeared across the region's own disc.
 */
function bundleByRegion(
  edges: readonly Edge[],
  regionOf: Map<string, string>,
  rung: Rung,
): EdgeBundle[] {
  interface Acc {
    from: string;
    to: string;
    edge_ids: string[];
    sigma: Record<string, number>;
    weight: number;
  }
  const acc = new Map<string, Acc>();

  for (const edge of edges) {
    const a = regionOf.get(edge.from_id);
    const b = regionOf.get(edge.to_id);
    if (a === undefined || b === undefined || a === b) continue;
    const [key, from, to] = corridorKey(a, b);
    let bucket = acc.get(key);
    if (bucket === undefined) {
      bucket = { from, to, edge_ids: [], sigma: {}, weight: 0 };
      acc.set(key, bucket);
    }
    bucket.edge_ids.push(edge.id);
    bucket.sigma[edge.sigma] = (bucket.sigma[edge.sigma] ?? 0) + 1;
    // Quarantined relations still shape the corridor, at a discount: the gate
    // rejected the claim, it did not un-write the document.
    bucket.weight += edge.quarantined ? edge.weight * 0.35 : edge.weight;
  }

  const out: EdgeBundle[] = [];
  for (const [key, bucket] of acc) {
    let sigma: SigmaClass = 'structural';
    let best = -1;
    for (const [name, count] of Object.entries(bucket.sigma)) {
      if (count > best) {
        best = count;
        sigma = name as SigmaClass;
      }
    }
    out.push({
      id: `bundle:${rung}:${key}`,
      from_id: bucket.from,
      to_id: bucket.to,
      edge_ids: bucket.edge_ids,
      sigma,
      count: bucket.edge_ids.length,
      // Every corridor produced here joins two DIFFERENT regions, and every
      // region rung sits at or above the island, so both endpoints are on
      // different islands by construction. This is a strait.
      is_strait: true,
    });
  }

  // Heaviest corridor first, ties broken on id so the order is reproducible.
  out.sort((x, y) => y.count - x.count || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return out;
}

/* =============================================================================
 * 4. THE MEMO
 * ========================================================================== */

let cached: Fixtures | null = null;
let building = false;

/**
 * The demo corpus, built on first call and cached forever after.
 *
 * SAFE TO CALL FROM ANYWHERE, including a component body, a store initialiser
 * or a worker bootstrap: after the first call it is a map lookup. It is NOT safe
 * to call inside a frame loop the first time — that first call is ~700ms of real
 * generation. Call `prepareFixtures()` from the app shell while the SETTLING
 * state is on screen, then this becomes free everywhere else.
 *
 * Throws — loudly, uncaught — if the generated world violates an invariant.
 */
export function getFixtures(): Fixtures {
  if (cached !== null) return cached;
  if (building) {
    throw new Error(
      '[engine/fixtures] getFixtures() re-entered while the corpus was still building. ' +
        'Something called it from inside buildWorld/bakeLayout, which would build the world twice.',
    );
  }
  building = true;
  try {
    cached = materialise();
    return cached;
  } finally {
    building = false;
  }
}

/**
 * Build the fixtures off the current task, so a boot screen gets one frame to
 * paint before the main thread is taken for ~700ms.
 *
 * This is not a progress bar and it does not pretend to be one — there is no
 * meaningful intermediate state to report, so it reports nothing and simply
 * yields once. Idempotent: concurrent callers share one build.
 */
let pending: Promise<Fixtures> | null = null;
export function prepareFixtures(): Promise<Fixtures> {
  if (cached !== null) return Promise.resolve(cached);
  if (pending !== null) return pending;
  pending = new Promise<Fixtures>((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(getFixtures());
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      } finally {
        pending = null;
      }
    }, 0);
  });
  return pending;
}

/** True once the corpus is materialised. Lets a shell choose SETTLING vs READY without forcing a build. */
export function fixturesReady(): boolean {
  return cached !== null;
}

/** The measured build cost, or `null` if nothing has been built yet. Never forces a build. */
export function getFixtureTimings(): FixtureTimings | null {
  return cached === null ? null : cached.timings;
}

/**
 * Drop the memo. TESTS AND HOT-RELOAD ONLY.
 *
 * Calling this in application code re-runs ~700ms of generation and, worse,
 * mints a new object graph while the old one is still on screen — every
 * `node.id` still resolves, but the identity checks a renderer uses to decide
 * "did this actually change" all fire at once.
 */
export function resetFixtures(): void {
  cached = null;
  pending = null;
}

/* =============================================================================
 * 5. THE BUILD
 * ========================================================================== */

function materialise(): Fixtures {
  const t0 = nowMs();
  const world = buildWorld();

  const t1 = nowMs();
  // `buildWorld()` validates before it returns; this second, explicit, DEEP pass
  // is not redundant ceremony. It is the seam re-checking its own input rather
  // than trusting the module that produced it, and it is the call site named in
  // the stack trace when a hash stops matching its bytes.
  validateWorld(world, { deep: true });

  const t2 = nowMs();
  const bake = bakeLayout(world);

  const t3 = nowMs();
  const integrity = computeIntegrity(world);

  const t4 = nowMs();
  const positions = positionsById(bake);
  const spatial = buildSpatialIndex(bake.positions);
  const { continentOf, islandOf, assetOf } = buildRegionIndex(world);
  const bundles: RegionBundles = Object.freeze({
    continent: Object.freeze(bundleByRegion(world.edges, continentOf, 'continent')),
    island: Object.freeze(bundleByRegion(world.edges, islandOf, 'island')),
  });
  const t5 = nowMs();

  const timings: FixtureTimings = {
    build_ms: ms2(t1 - t0),
    validate_ms: ms2(t2 - t1),
    bake_ms: ms2(t3 - t2),
    integrity_ms: ms2(t4 - t3),
    index_ms: ms2(t5 - t4),
    total_ms: ms2(t5 - t0),
    built_at: new Date().toISOString(),
  };

  /* The bake addresses the corpus by content. If those two ever disagree, every
     coordinate on screen belongs to a different world than every label, and the
     UI must be told rather than left to render a plausible-looking lie. */
  if (bake.corpus_provenance !== CORPUS_PROVENANCE) {
    throw new Error(
      `[engine/fixtures] the bake claims corpus_provenance "${String(bake.corpus_provenance)}"; ` +
        `this build only serves "${CORPUS_PROVENANCE}".`,
    );
  }
  if (positions.size !== world.nodes.length) {
    throw new Error(
      `[engine/fixtures] the bake positioned ${positions.size} nodes but the world has ` +
        `${world.nodes.length}. A node without a position renders as a hole, and the terrain ` +
        `is not allowed to have holes.`,
    );
  }

  return Object.freeze({
    world,
    bake,
    integrity,
    positions,
    spatial,
    bundles,
    continentOf,
    islandOf,
    assetOf,
    stagedQueries: world.staged_queries,
    timings,
    corpus_provenance: CORPUS_PROVENANCE,
  });
}

/* =============================================================================
 * 6. SMALL READ HELPERS
 * -----------------------------------------------------------------------------
 * Used by `@/engine/api`; exported because a renderer wants them too and
 * re-deriving them per call site is how two panels start disagreeing.
 * ========================================================================== */

/** Bounds covering the baked discs of a node set. Empty set -> a zero rect, never NaN. */
export function boundsOfNodes(fx: Fixtures, nodeIds: Iterable<string>): Bounds {
  const picked: NodePosition[] = [];
  for (const id of nodeIds) {
    const p = fx.positions.get(id);
    if (p !== undefined) picked.push(p);
  }
  return boundsOf(picked);
}

/** Resolve node ids to nodes, dropping ids the world does not know. Order is preserved. */
export function nodesById(fx: Fixtures, nodeIds: Iterable<string>): GraphNode[] {
  const out: GraphNode[] = [];
  for (const id of nodeIds) {
    const node = fx.world.node_by_id.get(id);
    if (node !== undefined) out.push(node);
  }
  return out;
}

/** Resolve edge ids to edges, dropping ids the world does not know. Order is preserved. */
export function edgesById(fx: Fixtures, edgeIds: Iterable<string>): Edge[] {
  const out: Edge[] = [];
  for (const id of edgeIds) {
    const edge = fx.world.edge_by_id.get(id);
    if (edge !== undefined) out.push(edge);
  }
  return out;
}
