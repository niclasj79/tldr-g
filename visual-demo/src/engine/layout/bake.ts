/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — DETERMINISTIC SEMANTIC LAYOUT (THE BAKE)
 * =============================================================================
 *
 * THE LOAD-BEARING RULE
 * ---------------------
 * Position is a BAKED, DETERMINISTIC, SEMANTIC property. It is computed once, at
 * bake time, content-addressed by the graph state, and then frozen. Read paths
 * never compute layout. There is no live force-directed simulation anywhere in
 * this product — no tick loop, no `requestAnimationFrame` settling, no "it
 * stabilises after a second". A map that moves while you are reading it is not a
 * map; it is a lava lamp, and it destroys the one thing a terrain is for:
 * spatial memory.
 *
 * Everything below runs ONCE, with a FIXED iteration count and a SEEDED init,
 * and returns a frozen `LayoutBake`. The relaxation passes in §7 are bake-time
 * numerical work in exactly the sense that a JPEG encoder does numerical work:
 * bounded, offline, and finished before anybody sees a pixel.
 *
 * HOW THE TERRAIN IS MADE (and why it looks like geography rather than a plot)
 * ---------------------------------------------------------------------------
 *   §4  SEMANTIC FEATURES  Every node gets a deterministic D-dimensional vector
 *                          synthesised from its community, its kind and its id,
 *                          then diffused over the graph for a fixed number of
 *                          rounds. Diffusion is what makes "your neighbours in
 *                          the graph are your neighbours in feature space" true
 *                          rather than aspirational. Bridge nodes end up with
 *                          genuinely mixed features — they are between two
 *                          communities in feature space before they are between
 *                          them on screen.
 *   §5  PCA PROJECTION     Two power-iteration passes over the D×D covariance
 *                          give the global axes. Cheap, exact, deterministic,
 *                          sign-canonicalised so a re-bake does not mirror the
 *                          world by accident.
 *   §6  MACRO LAYOUT       Communities are laid out as MASSES, not points:
 *                          radius ∝ √|community|, separated by a repulsion pass
 *                          with a minimum-separation floor. That floor IS the
 *                          strait — two heavily-connected communities are pulled
 *                          together until they nearly touch and then stopped, so
 *                          the gap between them is narrow and legible instead of
 *                          being either a merge or a void.
 *   §6  COASTLINES         Inside a community, radius is modulated by a seeded
 *                          harmonic lobe function. That is the whole trick for
 *                          peninsulas: a circle plus four cosines is a coast.
 *                          Radial placement biased by centrality gives dense
 *                          cores and sparse margins for free (uniform radial
 *                          density ⇒ areal density ∝ 1/r).
 *   §7  RELAXATION         A bounded number of attract/repel passes on a uniform
 *                          grid, with each community rigidly re-centred every
 *                          pass so local refinement can never dissolve the
 *                          global geography.
 *   §8  SPINE RECONCILIATION  Bottom-up: an asset is placed AT the centroid of
 *                          its passages, an island at the centroid of its
 *                          assets, a continent at the centroid of its islands.
 *                          Not approximately — exactly. Otherwise descending a
 *                          rung feels like the camera lied to you.
 *                          Entities are pulled onto the centroid of the assets
 *                          that mention them, which is why a bridge entity
 *                          lands in the strait by construction rather than by
 *                          luck.
 *
 * PERFORMANCE
 * -----------
 * Typed arrays throughout (`Float32Array` / `Int32Array`), CSR adjacency, a
 * uniform grid for the O(n) neighbourhood work. No arrays of objects until the
 * final `NodePosition[]` the contract asks for.
 *
 * DETERMINISM
 * -----------
 * Every random number comes from `splitmix32` seeded by `fnv1a32` of a string.
 * Nodes are processed in sorted-id order and edges in a canonical order, so the
 * input arrays may arrive in any order and the output is unchanged, bit for bit.
 *
 * =============================================================================
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import {
  CORPUS_PROVENANCE,
  type AnchorAlignment,
  type Bounds,
  type ContentHash,
  type Edge,
  type GraphNode,
  type IsoTimestamp,
  type LayoutBake,
  type LodState,
  type NodeKind,
  type NodePosition,
  type Rung,
  type Vec2,
} from '@/engine/types';

/* =============================================================================
 * 1. PUBLIC SHAPES
 *
 * `World` is the only new noun in this file. It is deliberately structural and
 * minimal: anything that can produce a node list and an edge list — the
 * synthetic corpus generator today, a live TLDR-G engine tomorrow — is a World.
 * Every other type here comes from `@/engine/types`; nothing is redeclared.
 * ========================================================================== */

/**
 * The graph state a bake is computed from. Nodes and edges, nothing else.
 *
 * Deliberately structural and deliberately minimal: the layout engine must not
 * depend on the corpus generator, or on any particular engine client. The richer
 * `World` produced by `@/engine/corpus/world` is a superset and satisfies this
 * as-is — verified by compilation, not by comment.
 */
export interface World {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly Edge[];
}

/**
 * Bake tuning. Every field has a documented default; changing any of them
 * changes `positions` but NOT `content_hash` (the hash addresses the CORPUS,
 * not the knobs), so pin your options per build the way you pin a seed.
 */
export interface BakeOpts {
  /**
   * Target length of the layout's longer axis, in layout units. Default 1000.
   * A target, not a bound: it is fitted to the 0.5–99.5 percentile span, so
   * peninsulas reach past it and `bounds` (which also covers node radii) is
   * larger still.
   */
  extent?: number;
  /** Dimensionality of the synthesised semantic feature space. Default 16. */
  featureDims?: number;
  /** Feature-diffusion rounds over the graph. Default 3. More = smoother. */
  propagationRounds?: number;
  /** Diffusion mixing per round, 0..1. Default 0.45. */
  propagationAlpha?: number;
  /** Bounded relaxation passes. Default: 24 under 20k nodes, 14 above. */
  relaxIterations?: number;
  /**
   * Minimum gap between two community masses, as a fraction of their combined
   * radii. THIS IS THE STRAIT WIDTH. Default 0.18 — narrow enough to read as a
   * channel, wide enough that the two coasts stay distinct.
   */
  straitGap?: number;
  /** Coastline harmonic amplitude, 0..0.5. Default 0.34. 0 = circles. */
  coastRoughness?: number;
  /** How hard a cross-community node is pulled toward the far coast. Default 0.45. */
  bridgePull?: number;
  /** How hard an entity is snapped onto its mentioning assets' centroid. Default 0.8. */
  entityToAssetPull?: number;
  /** Layout weight multiplier for quarantined edges. Default 0.35 — rejected topology still shapes the land, just less. */
  quarantinedWeight?: number;
  /**
   * Motion budget, 0..1, given to a node that survived from the previous bake
   * during an anchored re-bake. Default 0.2. Lower = the old map is more rigid
   * and new content has to fit around it; higher = a better-relaxed layout that
   * costs the user more spatial memory. Ignored by a first bake.
   */
  anchoredMobility?: number;
  /** Extra salt mixed into every seed. Same world + same salt = same map. Default ''. */
  seed?: string;
  /** Injected clock, so a test can assert byte-identical bakes. Default `new Date().toISOString()`. */
  now?: IsoTimestamp;
}

/** Options for `rebakeAnchored`, on top of the ordinary bake options. */
export interface RebakeOpts extends BakeOpts {
  /**
   * Floor on an anchor's Procrustes weight so that a zero-centrality node still
   * counts a little. Default 0.25. Weight = floor + centrality.
   */
  anchorWeightFloor?: number;
}

/** One rung of the spine, positioned. What `GET /graph/view/{rung}` renders. */
export interface RungLayout {
  rung: Rung;
  /** The containing node, or `null` at the continent rung. */
  parent_id: string | null;
  /** Positions of the nodes on this rung under that parent, sorted by id. */
  positions: NodePosition[];
  /** Bounds covering `positions`, radii included. */
  bounds: Bounds;
}

/**
 * A uniform-grid spatial index over a set of baked positions.
 *
 * Uniform grid rather than a quadtree on purpose: the bake already guarantees a
 * bounded density (the relaxation pass in §7 enforces a minimum separation), so
 * a grid sized to ~1 node per cell gives O(1) EXPECTED queries — strictly better
 * than the O(log n) the interaction layer asked for — with a flat typed-array
 * layout, no pointer chasing and no rebalancing. Nothing here ever scans the
 * full node list.
 */
export interface SpatialIndex {
  /** Number of indexed positions. */
  readonly count: number;
  /** The region the grid covers. Queries outside it are clamped, never linear. */
  readonly bounds: Bounds;
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  /** Node ids, parallel to `xs`/`ys`/`rs`. Query results are indices into this. */
  readonly ids: readonly string[];
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly rs: Float32Array;
  /** CSR bucket offsets, length `cols * rows + 1`. */
  readonly cellStart: Int32Array;
  /** CSR bucket payload: position indices, grouped by cell. Keyed by CENTRE. */
  readonly cellItems: Int32Array;
  /** Largest radius in the whole set. */
  readonly maxRadius: number;
  /**
   * The HIT structure: a hierarchical spatial hash used by `pickAt`.
   *
   * Region rungs break every flat grid, and they break it twice. A continent's
   * disc covers its whole landmass, so a centre-keyed grid has to widen each
   * query by the largest radius in the set and sweep tens of thousands of cells
   * (measured: 962 µs/pick at 100k — a linear scan wearing a hat). Registering
   * every disc in every cell it overlaps fixes the query range but piles 13k
   * asset discs into the same buckets (measured: 29 µs/pick).
   *
   * So the discs are bucketed BY SIZE first: level L holds discs whose diameter
   * fits a cell of `hitBase · 2ᴸ`, which means each disc is registered in at most
   * 2×2 cells of its own level. A point query reads one cell per level — about
   * nine of them for a 100k world — and every level is O(1) occupancy.
   */
  readonly hitLevels: number;
  readonly hitBase: number;
  readonly hitCols: Int32Array;
  readonly hitRows: Int32Array;
  /** Per-level CSR offsets. `hitStart[L]` has `hitCols[L] * hitRows[L] + 1` entries. */
  readonly hitStart: Int32Array[];
  /** Per-level CSR payload: position indices. */
  readonly hitItems: Int32Array[];
}

/** Options for the EMPTY state's latent lattice. */
export interface LatentGridOpts {
  /** Region to fill. Default a square of side `extent` centred on the origin. */
  bounds?: Bounds;
  /** Lattice pitch in layout units. Default: derived from `count` and `bounds`. */
  spacing?: number;
  /** Deterministic per-cell jitter as a fraction of `spacing`, 0..0.5. Default 0.18. */
  jitter?: number;
  /** Seed salt. Default 'latent'. */
  seed?: string;
  /** Node kind stamped on every produced position. Default 'asset'. */
  kind?: NodeKind;
  /** Community id stamped on every produced position. Default 'latent'. */
  communityId?: string;
  /** Square of side `extent` when `bounds` is omitted. Default 1000. */
  extent?: number;
}

/* =============================================================================
 * 2. DETERMINISM PRIMITIVES
 * -----------------------------------------------------------------------------
 * There is exactly one source of "randomness" in this file and it is a pure
 * function of a string. `fnv1a32` is duplicated in `@/styles/tokens.ts` for the
 * DOM side; it is repeated here rather than imported because the layout engine
 * must not depend on a module that reaches for `document`, and because a hash
 * that quietly changed would silently repaint AND relocate the world.
 * ========================================================================== */

/** FNV-1a, 32-bit, unsigned. Stable across engines and platforms. */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i) & 0xff;
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** splitmix32. Integer-only state, so every consumer gets the same stream. */
function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

/** A single stable value in [0,1) for a string key. */
function hash01(key: string): number {
  return fnv1a32(key) / 4294967296;
}

/** Lexicographic, locale-independent. `localeCompare` is not reproducible. */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* =============================================================================
 * 3. TOPOLOGY — the world, flattened into typed arrays
 * ========================================================================== */

const KIND_NAMES: readonly NodeKind[] = ['continent', 'island', 'asset', 'entity', 'passage', 'source'];
const KIND_CODE: Readonly<Record<NodeKind, number>> = {
  continent: 0,
  island: 1,
  asset: 2,
  entity: 3,
  passage: 4,
  source: 5,
};

const NO_IDS: readonly string[] = Object.freeze([]);

/** The containment-spine children of a node, downward. Empty for off-spine kinds. */
function spineChildIds(node: GraphNode): readonly string[] {
  switch (node.kind) {
    case 'continent':
      return node.island_ids;
    case 'island':
      return node.asset_ids;
    case 'asset':
      return node.passage_ids;
    case 'entity':
    case 'passage':
    case 'source':
      return NO_IDS;
  }
}

/**
 * The assets a cross-cutting node hangs off. Entities and sources are NOT on the
 * spine — they are attached to it, and this is the attachment.
 */
function attachmentAssetIds(node: GraphNode): readonly string[] {
  if (node.kind === 'entity') return node.asset_ids;
  if (node.kind === 'source') return node.asset_ids;
  return NO_IDS;
}

/** The passages a node is evidenced in. Only entities have these. */
function mentionPassageIds(node: GraphNode): readonly string[] {
  return node.kind === 'entity' ? node.mentions : NO_IDS;
}

/** Layout link weights for the synthetic (non-`Edge`) fibres. */
const W_SPINE = 1.0; // parent ↔ child containment
const W_SIBLING = 0.9; // reading-order cohesion between adjacent children
const W_MENTION = 0.75; // entity ↔ the passage that evidences it
const W_ATTACH = 0.55; // entity/source ↔ the asset it hangs off

interface Topology {
  n: number;
  ids: string[]; // sorted
  index: Map<string, number>;
  kind: Uint8Array;
  centrality: Float32Array;
  /** Community index per node. */
  community: Int32Array;
  /** Sorted unique community ids; `community[i]` indexes this. */
  communityIds: string[];
  /** `true` when the node has no spine children and must be placed, not derived. */
  free: Uint8Array;

  /** CSR adjacency over ALL nodes: graph edges + spine + sibling + mention fibres. */
  adjStart: Int32Array;
  adjTarget: Int32Array;
  adjWeight: Float32Array;

  /** CSR spine children (indices), for the bottom-up centroid pass. */
  childStart: Int32Array;
  childItems: Int32Array;
  /** Spine parent index, or -1. The inverse of `childItems`. */
  parentIdx: Int32Array;

  /** CSR attachment assets (indices), for entity/source placement. */
  attachStart: Int32Array;
  attachItems: Int32Array;

  /** Canonically-ordered, resolved graph edges (both endpoints known). */
  edgeFrom: Int32Array;
  edgeTo: Int32Array;
  edgeWeight: Float32Array;

  /** The world's own edge array, in canonical order, for hashing. */
  edgeOrder: Uint32Array;
  edges: readonly Edge[];
}

function buildTopology(world: World, opts: BakeOpts): Topology {
  const quarantinedWeight = opts.quarantinedWeight ?? 0.35;

  /* --- node table, sorted by id so input order cannot leak into the map ---- */
  const nodesById = new Map<string, GraphNode>();
  for (const node of world.nodes) nodesById.set(node.id, node);
  const ids = [...nodesById.keys()].sort(cmpStr);
  const n = ids.length;

  const index = new Map<string, number>();
  for (let i = 0; i < n; i++) index.set(ids[i], i);

  const kind = new Uint8Array(n);
  const centrality = new Float32Array(n);
  const community = new Int32Array(n);
  const free = new Uint8Array(n);

  const communitySet = new Set<string>();
  for (const id of ids) communitySet.add(nodesById.get(id)!.community_id);
  const communityIds = [...communitySet].sort(cmpStr);
  const communityIndex = new Map<string, number>();
  for (let c = 0; c < communityIds.length; c++) communityIndex.set(communityIds[c], c);

  /* --- spine children + attachments, as CSR ------------------------------- */
  const childCount = new Int32Array(n + 1);
  const attachCount = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const node = nodesById.get(ids[i])!;
    kind[i] = KIND_CODE[node.kind];
    centrality[i] = clamp(Number.isFinite(node.centrality) ? node.centrality : 0, 0, 1);
    community[i] = communityIndex.get(node.community_id)!;
    for (const childId of spineChildIds(node)) if (index.has(childId)) childCount[i]++;
    for (const assetId of attachmentAssetIds(node)) if (index.has(assetId)) attachCount[i]++;
    free[i] = childCount[i] === 0 ? 1 : 0;
  }

  const childStart = prefixSum(childCount, n);
  const childItems = new Int32Array(childStart[n]);
  const parentIdx = new Int32Array(n).fill(-1);
  const attachStart = prefixSum(attachCount, n);
  const attachItems = new Int32Array(attachStart[n]);
  {
    const cCursor = childStart.slice(0, n);
    const aCursor = attachStart.slice(0, n);
    for (let i = 0; i < n; i++) {
      const node = nodesById.get(ids[i])!;
      for (const childId of spineChildIds(node)) {
        const j = index.get(childId);
        if (j !== undefined) {
          childItems[cCursor[i]++] = j;
          parentIdx[j] = i;
        }
      }
      for (const assetId of attachmentAssetIds(node)) {
        const j = index.get(assetId);
        if (j !== undefined) attachItems[aCursor[i]++] = j;
      }
    }
  }

  /* --- canonical edge order ----------------------------------------------
   * Sorted by (fromIdx, toIdx) with unresolved endpoints bucketed last and a
   * string tie-break. Two purposes, one sort: the content hash is computed over
   * this order, and the adjacency is built from it, so neither the hash nor the
   * floating-point accumulation order can depend on how the caller happened to
   * order its array.
   * ---------------------------------------------------------------------- */
  const edges = world.edges;
  const m = edges.length;
  const key = new Float64Array(m);
  const span = n + 1;
  for (let e = 0; e < m; e++) {
    const a = index.get(edges[e].from_id);
    const b = index.get(edges[e].to_id);
    key[e] = (a === undefined ? n : a) * span + (b === undefined ? n : b);
  }
  const edgeOrder = new Uint32Array(m);
  for (let e = 0; e < m; e++) edgeOrder[e] = e;
  edgeOrder.sort((ea, eb) => {
    const d = key[ea] - key[eb];
    if (d !== 0) return d;
    const A = edges[ea];
    const B = edges[eb];
    return (
      cmpStr(A.from_id, B.from_id) || cmpStr(A.to_id, B.to_id) || cmpStr(A.family, B.family) || cmpStr(A.id, B.id)
    );
  });

  /* --- resolved edges + all layout fibres, as one CSR adjacency ----------- */
  const linkA: number[] = [];
  const linkB: number[] = [];
  const linkW: number[] = [];

  const edgeFromList: number[] = [];
  const edgeToList: number[] = [];
  const edgeWList: number[] = [];

  for (let k = 0; k < m; k++) {
    const edge = edges[edgeOrder[k]];
    const a = index.get(edge.from_id);
    const b = index.get(edge.to_id);
    if (a === undefined || b === undefined || a === b) continue;
    const w =
      clamp(Number.isFinite(edge.weight) ? edge.weight : 0.5, 0.02, 1) *
      (edge.quarantined ? quarantinedWeight : 1) *
      (edge.sigma === 'structural' ? 1.15 : 1);
    edgeFromList.push(a);
    edgeToList.push(b);
    edgeWList.push(w);
    linkA.push(a);
    linkB.push(b);
    linkW.push(w);
  }

  // Spine + reading-order + mention fibres, generated in sorted-id order.
  for (let i = 0; i < n; i++) {
    const s = childStart[i];
    const e = childStart[i + 1];
    for (let k = s; k < e; k++) {
      linkA.push(i);
      linkB.push(childItems[k]);
      linkW.push(W_SPINE);
      if (k + 1 < e) {
        linkA.push(childItems[k]);
        linkB.push(childItems[k + 1]);
        linkW.push(W_SIBLING);
      }
    }
    const node = nodesById.get(ids[i])!;
    for (const passageId of mentionPassageIds(node)) {
      const j = index.get(passageId);
      if (j !== undefined && j !== i) {
        linkA.push(i);
        linkB.push(j);
        linkW.push(W_MENTION);
      }
    }
    for (let k = attachStart[i]; k < attachStart[i + 1]; k++) {
      const j = attachItems[k];
      if (j !== i) {
        linkA.push(i);
        linkB.push(j);
        linkW.push(W_ATTACH);
      }
    }
  }

  const linkCount = linkA.length;
  const degree = new Int32Array(n + 1);
  for (let k = 0; k < linkCount; k++) {
    degree[linkA[k]]++;
    degree[linkB[k]]++;
  }
  const adjStart = prefixSum(degree, n);
  const adjTarget = new Int32Array(adjStart[n]);
  const adjWeight = new Float32Array(adjStart[n]);
  {
    const cursor = adjStart.slice(0, n);
    for (let k = 0; k < linkCount; k++) {
      const a = linkA[k];
      const b = linkB[k];
      const w = linkW[k];
      adjTarget[cursor[a]] = b;
      adjWeight[cursor[a]] = w;
      cursor[a]++;
      adjTarget[cursor[b]] = a;
      adjWeight[cursor[b]] = w;
      cursor[b]++;
    }
  }

  return {
    n,
    ids,
    index,
    kind,
    centrality,
    community,
    communityIds,
    free,
    adjStart,
    adjTarget,
    adjWeight,
    childStart,
    childItems,
    parentIdx,
    attachStart,
    attachItems,
    edgeFrom: Int32Array.from(edgeFromList),
    edgeTo: Int32Array.from(edgeToList),
    edgeWeight: Float32Array.from(edgeWList),
    edgeOrder,
    edges,
  };
}

/** Turn a count array of length n+1 into exclusive prefix offsets in place. */
function prefixSum(counts: Int32Array, n: number): Int32Array {
  const start = new Int32Array(n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    start[i] = acc;
    acc += counts[i];
  }
  start[n] = acc;
  return start;
}

/* =============================================================================
 * 3b. CONTENT ADDRESSING
 * -----------------------------------------------------------------------------
 * The bake is a pure function of the corpus, so it can be cached forever and
 * invalidated exactly. `LayoutBake.content_hash` is a TRUST GUARANTEE in the
 * schema: if it does not match the corpus on screen, the positions are stale and
 * the UI is required to say so. It is streamed, not built as one giant string,
 * so a 100k-node world does not allocate a 10 MB buffer to be hashed.
 * ========================================================================== */

function contentHashOf(t: Topology): ContentHash {
  const h = sha256.create();
  // `tldrg-atlas/...` is a DOMAIN-SEPARATION TAG, not a name. Its literal value is
  // irrelevant; its STABILITY is not. It feeds the content hash the schema calls a
  // trust guarantee, so editing this string re-hashes every bake and invalidates
  // every recorded bake_id. It kept its original spelling through the rename to
  // /visual-demo/ on purpose. Do not "tidy" it.
  h.update(utf8ToBytes(`tldrg-atlas/layout-bake/v1\nnodes=${t.n}\nedges=${t.edges.length}\n`));

  let chunk = '';
  const flush = (force: boolean): void => {
    if (force || chunk.length > 65536) {
      h.update(utf8ToBytes(chunk));
      chunk = '';
    }
  };

  for (let i = 0; i < t.n; i++) {
    chunk += `${t.ids[i]}|${KIND_NAMES[t.kind[i]]}|${t.communityIds[t.community[i]]}|${t.centrality[i].toFixed(6)}|`;
    for (let k = t.childStart[i]; k < t.childStart[i + 1]; k++) chunk += `${t.ids[t.childItems[k]]},`;
    chunk += '|';
    for (let k = t.attachStart[i]; k < t.attachStart[i + 1]; k++) chunk += `${t.ids[t.attachItems[k]]},`;
    chunk += '\n';
    flush(false);
  }
  chunk += '--edges--\n';
  for (let k = 0; k < t.edgeOrder.length; k++) {
    const e = t.edges[t.edgeOrder[k]];
    chunk += `${e.from_id}>${e.to_id}|${e.family}|${e.weight.toFixed(4)}|${e.quarantined ? 'q' : '.'}\n`;
    flush(false);
  }
  flush(true);
  return bytesToHex(h.digest());
}

/* =============================================================================
 * 4. SEMANTIC FEATURE SYNTHESIS
 * -----------------------------------------------------------------------------
 * A node's embedding is not decorative noise; it is a restatement of what the
 * node MEANS in the only terms this engine has: which community it belongs to,
 * what kind of thing it is, and who it is connected to. Diffusion over the graph
 * does the rest — after three rounds a node's vector is dominated by its
 * neighbourhood, which is precisely the property "graph neighbours land near
 * each other" requires.
 * ========================================================================== */

function synthesiseFeatures(t: Topology, dims: number, rounds: number, alpha: number, salt: string): Float32Array {
  const n = t.n;
  const f = new Float32Array(n * dims);

  // One unit vector per community — the continental signature.
  const cCount = t.communityIds.length;
  const cvec = new Float32Array(cCount * dims);
  for (let c = 0; c < cCount; c++) {
    const rnd = splitmix32(fnv1a32(`${salt}|community|${t.communityIds[c]}`));
    let norm = 0;
    for (let d = 0; d < dims; d++) {
      const v = rnd() * 2 - 1;
      cvec[c * dims + d] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims; d++) cvec[c * dims + d] /= norm;
  }

  // One small vector per node kind — keeps passages from sitting on assets.
  const kvec = new Float32Array(KIND_NAMES.length * dims);
  for (let k = 0; k < KIND_NAMES.length; k++) {
    const rnd = splitmix32(fnv1a32(`${salt}|kind|${KIND_NAMES[k]}`));
    let norm = 0;
    for (let d = 0; d < dims; d++) {
      const v = rnd() * 2 - 1;
      kvec[k * dims + d] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims; d++) kvec[k * dims + d] /= norm;
  }

  for (let i = 0; i < n; i++) {
    const base = i * dims;
    const c = t.community[i] * dims;
    const k = t.kind[i] * dims;
    const rnd = splitmix32(fnv1a32(`${salt}|node|${t.ids[i]}`));
    // Central nodes sit closer to the community mean: that is the dense core.
    const spread = 0.5 * (1 - 0.7 * t.centrality[i]);
    for (let d = 0; d < dims; d++) {
      f[base + d] = cvec[c + d] + 0.25 * kvec[k + d] + spread * (rnd() * 2 - 1);
    }
  }

  // Diffusion. Fixed round count; no convergence test, because a convergence
  // test is a loop whose length depends on the data and therefore on nothing
  // reproducible.
  if (rounds > 0) {
    const next = new Float32Array(n * dims);
    const acc = new Float64Array(dims);
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < n; i++) {
        acc.fill(0);
        let wsum = 0;
        for (let k = t.adjStart[i]; k < t.adjStart[i + 1]; k++) {
          const j = t.adjTarget[k] * dims;
          const w = t.adjWeight[k];
          wsum += w;
          for (let d = 0; d < dims; d++) acc[d] += w * f[j + d];
        }
        const base = i * dims;
        if (wsum > 0) {
          const inv = 1 / wsum;
          for (let d = 0; d < dims; d++) next[base + d] = (1 - alpha) * f[base + d] + alpha * acc[d] * inv;
        } else {
          for (let d = 0; d < dims; d++) next[base + d] = f[base + d];
        }
      }
      f.set(next);
    }
  }
  return f;
}

/* =============================================================================
 * 5. PCA PROJECTION — global structure in two passes
 * -----------------------------------------------------------------------------
 * Power iteration on the D×D covariance, then deflation, then a second pass.
 * D is 16, so the eigen-work is 16×16 arithmetic repeated a fixed 64 times —
 * microseconds, regardless of n. The only O(n·D²) step is accumulating the
 * covariance itself.
 *
 * Sign canonicalisation matters more than it looks: an unconstrained eigenvector
 * has an arbitrary sign, and a flipped sign MIRRORS THE WORLD. A user who has
 * memorised "the amber island is west" would find it east after a re-bake, for
 * no reason at all. Both axes are pinned to a deterministic convention here, and
 * `rebakeAnchored` additionally orients them against the previous bake.
 * ========================================================================== */

interface Projection {
  px: Float32Array;
  py: Float32Array;
}

function projectPca(t: Topology, f: Float32Array, dims: number, orient: AnchorFrame | null): Projection {
  const n = t.n;
  const mean = new Float64Array(dims);
  for (let i = 0; i < n; i++) {
    const base = i * dims;
    for (let d = 0; d < dims; d++) mean[d] += f[base + d];
  }
  if (n > 0) for (let d = 0; d < dims; d++) mean[d] /= n;

  const cov = new Float64Array(dims * dims);
  const row = new Float64Array(dims);
  for (let i = 0; i < n; i++) {
    const base = i * dims;
    for (let d = 0; d < dims; d++) row[d] = f[base + d] - mean[d];
    for (let a = 0; a < dims; a++) {
      const ra = row[a];
      if (ra === 0) continue;
      for (let b = a; b < dims; b++) cov[a * dims + b] += ra * row[b];
    }
  }
  for (let a = 0; a < dims; a++) for (let b = a + 1; b < dims; b++) cov[b * dims + a] = cov[a * dims + b];

  const v1 = dominantEigenvector(cov, dims, 'axis-1');
  const lambda1 = rayleigh(cov, dims, v1);
  for (let a = 0; a < dims; a++) for (let b = 0; b < dims; b++) cov[a * dims + b] -= lambda1 * v1[a] * v1[b];
  const v2raw = dominantEigenvector(cov, dims, 'axis-2');
  // Gram–Schmidt against v1 so the two axes are genuinely orthogonal after
  // deflation rounding.
  let dot = 0;
  for (let d = 0; d < dims; d++) dot += v2raw[d] * v1[d];
  let norm = 0;
  const v2 = new Float64Array(dims);
  for (let d = 0; d < dims; d++) {
    v2[d] = v2raw[d] - dot * v1[d];
    norm += v2[d] * v2[d];
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-9) {
    v2.fill(0);
    v2[dims > 1 ? 1 : 0] = 1;
  } else {
    for (let d = 0; d < dims; d++) v2[d] /= norm;
  }

  canonicaliseSign(v1, dims);
  canonicaliseSign(v2, dims);

  const px = new Float32Array(n);
  const py = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const base = i * dims;
    let a = 0;
    let b = 0;
    for (let d = 0; d < dims; d++) {
      const c = f[base + d] - mean[d];
      a += c * v1[d];
      b += c * v2[d];
    }
    px[i] = a;
    py[i] = b;
  }

  if (orient) orientAgainstPrevious(t, px, py, orient);
  return { px, py };
}

function dominantEigenvector(cov: Float64Array, dims: number, tag: string): Float64Array {
  // Same rule as `contentHashOf`: this is a SEED, not a name. It initialises the
  // power iteration, so changing the string changes the eigenvector it converges
  // to, which moves every node on the map and rewrites the screenshot the social
  // card ships. Deliberately unchanged by the /visual-demo/ rename.
  const rnd = splitmix32(fnv1a32(`tldrg-atlas|pca|${tag}`));
  const v = new Float64Array(dims);
  const tmp = new Float64Array(dims);
  for (let d = 0; d < dims; d++) v[d] = rnd() * 2 - 1;
  normalise(v, dims);
  for (let it = 0; it < 64; it++) {
    tmp.fill(0);
    for (let a = 0; a < dims; a++) {
      let s = 0;
      for (let b = 0; b < dims; b++) s += cov[a * dims + b] * v[b];
      tmp[a] = s;
    }
    let mag = 0;
    for (let d = 0; d < dims; d++) mag += tmp[d] * tmp[d];
    if (mag < 1e-18) break;
    mag = Math.sqrt(mag);
    for (let d = 0; d < dims; d++) v[d] = tmp[d] / mag;
  }
  return v;
}

function rayleigh(cov: Float64Array, dims: number, v: Float64Array): number {
  let s = 0;
  for (let a = 0; a < dims; a++) {
    let r = 0;
    for (let b = 0; b < dims; b++) r += cov[a * dims + b] * v[b];
    s += v[a] * r;
  }
  return s;
}

function normalise(v: Float64Array, dims: number): void {
  let mag = 0;
  for (let d = 0; d < dims; d++) mag += v[d] * v[d];
  mag = Math.sqrt(mag) || 1;
  for (let d = 0; d < dims; d++) v[d] /= mag;
}

/** Pin the arbitrary eigenvector sign: largest-magnitude component is positive. */
function canonicaliseSign(v: Float64Array, dims: number): void {
  let best = 0;
  let bestAbs = -1;
  for (let d = 0; d < dims; d++) {
    const a = Math.abs(v[d]);
    if (a > bestAbs + 1e-12) {
      bestAbs = a;
      best = d;
    }
  }
  if (v[best] < 0) for (let d = 0; d < dims; d++) v[d] = -v[d];
}

/**
 * The previous bake, in the form the new bake needs it: per-node positions and
 * per-community centroids. Everything anchoring does reads from this.
 */
interface AnchorFrame {
  prevX: Map<string, number>;
  prevY: Map<string, number>;
  /** Previous centroid of each community id, over placed (non-region) nodes. */
  prevCx: Map<string, number>;
  prevCy: Map<string, number>;
  /**
   * Previous RMS radius of each community about its own centroid.
   *
   * This is what carries the previous bake's DENSITY, and it is load-bearing.
   * Fitting the frame on centroids alone gets the archipelago right and the
   * interiors wrong: survivors land packed into a disc of the wrong size, the
   * relaxation pass then has to blow them apart to make room, and the drift the
   * anchoring was supposed to prevent comes back through the side door
   * (measured: seeded 2.85× too tight).
   */
  prevSpread: Map<string, number>;
  weightFloor: number;
}

/** A proper (or reflected) 2D similarity: q ↦ s·R·q + t. */
interface Similarity {
  rotation: number;
  scale: number;
  tx: number;
  ty: number;
  /** True when the fit required mirroring the source's y before rotating. */
  mirror: boolean;
  /** Weighted sum of squared residuals at the optimum. */
  sse: number;
}

/**
 * Weighted Procrustes in closed form: the similarity taking `src` onto `dst`
 * that minimises Σ wᵢ‖s·R·qᵢ + t − pᵢ‖².
 *
 * In 2D this is two dot products and an `atan2`; there is no iteration and no
 * failure mode. `allowMirror` additionally evaluates the reflected solution and
 * returns whichever has the lower residual.
 */
function solveSimilarity(
  srcX: Float64Array,
  srcY: Float64Array,
  dstX: Float64Array,
  dstY: Float64Array,
  w: Float64Array,
  k: number,
  allowMirror: boolean,
  /** Pin the scale instead of solving for it. Rotation is unaffected by scale. */
  fixedScale: number | null = null,
): Similarity {
  const fit = (mirror: boolean): Similarity => {
    const sgn = mirror ? -1 : 1;
    let wsum = 0;
    let qxBar = 0;
    let qyBar = 0;
    let pxBar = 0;
    let pyBar = 0;
    for (let i = 0; i < k; i++) {
      const wi = w[i];
      wsum += wi;
      qxBar += wi * srcX[i];
      qyBar += wi * sgn * srcY[i];
      pxBar += wi * dstX[i];
      pyBar += wi * dstY[i];
    }
    if (wsum <= 0) return { rotation: 0, scale: 1, tx: 0, ty: 0, mirror, sse: Infinity };
    qxBar /= wsum;
    qyBar /= wsum;
    pxBar /= wsum;
    pyBar /= wsum;

    let dot = 0;
    let cross = 0;
    let qNorm = 0;
    for (let i = 0; i < k; i++) {
      const wi = w[i];
      const qx = srcX[i] - qxBar;
      const qy = sgn * srcY[i] - qyBar;
      const px = dstX[i] - pxBar;
      const py = dstY[i] - pyBar;
      dot += wi * (qx * px + qy * py);
      cross += wi * (qx * py - qy * px);
      qNorm += wi * (qx * qx + qy * qy);
    }
    const rotation = Math.atan2(cross, dot);
    const scale = fixedScale ?? (qNorm > 1e-12 ? Math.hypot(dot, cross) / qNorm : 1);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const tx = pxBar - scale * (cos * qxBar - sin * qyBar);
    const ty = pyBar - scale * (sin * qxBar + cos * qyBar);

    let sse = 0;
    for (let i = 0; i < k; i++) {
      const qy = sgn * srcY[i];
      const ax = scale * (cos * srcX[i] - sin * qy) + tx;
      const ay = scale * (sin * srcX[i] + cos * qy) + ty;
      const ex = ax - dstX[i];
      const ey = ay - dstY[i];
      sse += w[i] * (ex * ex + ey * ey);
    }
    return { rotation, scale, tx, ty, mirror, sse };
  };

  const proper = fit(false);
  if (!allowMirror) return proper;
  const mirrored = fit(true);
  return mirrored.sse < proper.sse * 0.999 ? mirrored : proper;
}

/** Apply a `Similarity` to a point, writing into `out`. */
function applySimilarity(s: Similarity, x: number, y: number, out: [number, number]): void {
  const qy = s.mirror ? -y : y;
  const cos = Math.cos(s.rotation);
  const sin = Math.sin(s.rotation);
  out[0] = s.scale * (cos * x - sin * qy) + s.tx;
  out[1] = s.scale * (sin * x + cos * qy) + s.ty;
}

/**
 * Choose the sign of the SECOND principal axis by asking the previous bake.
 *
 * A mirrored map is the worst possible re-bake outcome — every position is
 * "wrong" in a way the user cannot correct by looking harder. Detecting the flip
 * here, before any placement work happens, means the similarity transform solved
 * later in `rebakeAnchored` is a PROPER rotation+scale+translation and the three
 * numbers reported in `AnchorAlignment` describe it exactly.
 */
function orientAgainstPrevious(t: Topology, px: Float32Array, py: Float32Array, hint: AnchorFrame): void {
  let mx = 0;
  let my = 0;
  let qx = 0;
  let qy = 0;
  let wsum = 0;
  for (let i = 0; i < t.n; i++) {
    const prev = hint.prevX.get(t.ids[i]);
    if (prev === undefined) continue;
    const w = hint.weightFloor + t.centrality[i];
    wsum += w;
    mx += w * prev;
    my += w * hint.prevY.get(t.ids[i])!;
    qx += w * px[i];
    qy += w * py[i];
  }
  if (wsum <= 0) return;
  mx /= wsum;
  my /= wsum;
  qx /= wsum;
  qy /= wsum;

  // 2×2 cross-covariance; a negative determinant means the two frames differ by
  // a reflection.
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  for (let i = 0; i < t.n; i++) {
    const prev = hint.prevX.get(t.ids[i]);
    if (prev === undefined) continue;
    const w = hint.weightFloor + t.centrality[i];
    const ux = px[i] - qx;
    const uy = py[i] - qy;
    const vx = prev - mx;
    const vy = hint.prevY.get(t.ids[i])! - my;
    a += w * ux * vx;
    b += w * ux * vy;
    c += w * uy * vx;
    d += w * uy * vy;
  }
  if (a * d - b * c < 0) {
    for (let i = 0; i < t.n; i++) py[i] = -py[i];
  }
}

/* =============================================================================
 * 6. MACRO LAYOUT + COASTLINES
 * -----------------------------------------------------------------------------
 * This is where the picture stops being a scatter plot.
 *
 * Communities become MASSES with an area proportional to their population and a
 * hard minimum separation. Two communities that share a lot of edges are pulled
 * together until they are `straitGap` apart and then held there: the result is a
 * narrow channel between two coasts, which is exactly what a strait is. Nodes
 * with cross-community neighbours are then pulled toward the far coast, so the
 * bridge entities end up standing IN the channel — the visual claim the demo
 * makes about bridging is made true by the geometry, not by a highlight colour.
 * ========================================================================== */

interface MacroLayout {
  /** Mass centre in LAYOUT space, after separation. */
  cx: Float64Array;
  cy: Float64Array;
  /** Mass centre in PCA space, before any of it — the frame residuals are taken against. */
  pcx: Float64Array;
  pcy: Float64Array;
  radius: Float64Array;
  count: Int32Array;
  /**
   * The similarity that carries PREVIOUS-bake coordinates into this bake's
   * internal frame, or `null` on a first bake. Node placement uses it to seed
   * every surviving node exactly where it already was.
   */
  fromPrev: Similarity | null;
}

function macroLayout(t: Topology, proj: Projection, opts: BakeOpts, anchor: AnchorFrame | null): MacroLayout {
  const cCount = t.communityIds.length;
  const cx = new Float64Array(cCount);
  const cy = new Float64Array(cCount);
  const pcx = new Float64Array(cCount);
  const pcy = new Float64Array(cCount);
  const radius = new Float64Array(cCount);
  const count = new Int32Array(cCount);
  const straitGap = opts.straitGap ?? 0.18;

  // Community centroids and populations, over PLACED (free) nodes only —
  // derived nodes sit at their children's centroid and must not vote twice.
  for (let i = 0; i < t.n; i++) {
    if (!t.free[i]) continue;
    const c = t.community[i];
    count[c]++;
    cx[c] += proj.px[i];
    cy[c] += proj.py[i];
  }
  let placed = 0;
  for (let c = 0; c < cCount; c++) {
    if (count[c] > 0) {
      cx[c] /= count[c];
      cy[c] /= count[c];
      placed += count[c];
    }
    pcx[c] = cx[c];
    pcy[c] = cy[c];
    // Area ∝ population. `1.0` is one node's personal space; the whole layout is
    // normalised to `extent` at the very end, so no magic scale constant is
    // needed anywhere in between.
    radius[c] = Math.sqrt(Math.max(count[c], 1)) * 1.0;
  }
  if (cCount === 0 || placed === 0) return { cx, cy, pcx, pcy, radius, count, fromPrev: null };

  // Scale the PCA centroids so the initial spread is comparable to the total
  // mass, then let repulsion do the separating.
  let maxR = 0;
  for (let c = 0; c < cCount; c++) maxR = Math.max(maxR, Math.hypot(cx[c], cy[c]));
  const target = Math.sqrt(placed) * 1.35;
  const s = maxR > 1e-9 ? target / maxR : 0;
  for (let c = 0; c < cCount; c++) {
    if (s > 0) {
      cx[c] *= s;
      cy[c] *= s;
    } else {
      // Degenerate projection (one community, or all features identical):
      // fall back to a seeded phyllotaxis so masses still separate.
      const ang = c * 2.399963229728653;
      const rad = target * Math.sqrt((c + 0.5) / cCount);
      cx[c] = Math.cos(ang) * rad;
      cy[c] = Math.sin(ang) * rad;
    }
  }

  // Inter-community coupling: how much traffic wants these two masses adjacent.
  const coupling = new Map<number, number>();
  for (let i = 0; i < t.n; i++) {
    const ci = t.community[i];
    for (let k = t.adjStart[i]; k < t.adjStart[i + 1]; k++) {
      const j = t.adjTarget[k];
      if (j <= i) continue;
      const cj = t.community[j];
      if (ci === cj) continue;
      const lo = Math.min(ci, cj);
      const hi = Math.max(ci, cj);
      const key = lo * cCount + hi;
      coupling.set(key, (coupling.get(key) ?? 0) + t.adjWeight[k]);
    }
  }

  const iters = cCount <= 256 ? 220 : cCount <= 1024 ? 70 : 24;
  const dx = new Float64Array(cCount);
  const dy = new Float64Array(cCount);
  for (let it = 0; it < iters; it++) {
    dx.fill(0);
    dy.fill(0);
    const cool = 1 - it / iters;

    // Separation floor. This is the strait.
    for (let a = 0; a < cCount; a++) {
      if (count[a] === 0) continue;
      for (let b = a + 1; b < cCount; b++) {
        if (count[b] === 0) continue;
        let ux = cx[a] - cx[b];
        let uy = cy[a] - cy[b];
        let d2 = ux * ux + uy * uy;
        if (d2 < 1e-12) {
          const jitter = hash01(`macro|${a}|${b}`) * Math.PI * 2;
          ux = Math.cos(jitter) * 1e-3;
          uy = Math.sin(jitter) * 1e-3;
          d2 = 1e-6;
        }
        const d = Math.sqrt(d2);
        const minSep = (radius[a] + radius[b]) * (1 + (opts.straitGap ?? straitGap));
        if (d < minSep) {
          const push = ((minSep - d) / d) * 0.5;
          dx[a] += ux * push;
          dy[a] += uy * push;
          dx[b] -= ux * push;
          dy[b] -= uy * push;
        }
      }
    }
    // Coupling attraction, capped so a well-connected pair approaches the floor
    // and stops rather than merging.
    for (const [pairKey, w] of coupling) {
      const a = Math.floor(pairKey / cCount);
      const b = pairKey % cCount;
      const ux = cx[b] - cx[a];
      const uy = cy[b] - cy[a];
      const d = Math.hypot(ux, uy);
      if (d < 1e-9) continue;
      const minSep = (radius[a] + radius[b]) * (1 + (opts.straitGap ?? straitGap));
      if (d <= minSep) continue;
      const pull = Math.min(0.25, 0.02 * Math.log1p(w)) * ((d - minSep) / d);
      dx[a] += ux * pull;
      dy[a] += uy * pull;
      dx[b] -= ux * pull;
      dy[b] -= uy * pull;
    }
    for (let c = 0; c < cCount; c++) {
      if (count[c] === 0) continue;
      // Weak centring keeps the archipelago compact instead of drifting apart.
      cx[c] += dx[c] * cool - cx[c] * 0.004;
      cy[c] += dy[c] * cool - cy[c] * 0.004;
    }
  }

  /* ---------------------------------------------------------------------------
   * ANCHORING, STAGE 1: THE ARRANGEMENT OF THE MASSES
   * ---------------------------------------------------------------------------
   * A single global similarity — which is all `AnchorAlignment` can express —
   * cannot repair a map whose continents rearranged relative to each other. And
   * they will: adding documents changes community populations, which changes
   * radii, which changes what the separation pass does, and the archipelago
   * re-shuffles. Measured on a +10%/−3% corpus change, post-hoc Procrustes alone
   * bought nothing at all — 1.0× less movement than no alignment.
   *
   * So the arrangement is INHERITED rather than recomputed. Solve the similarity
   * taking the previous community centroids onto the freshly-computed ones, then
   * put every surviving community back where it was. The fresh macro layout's
   * only remaining job is to place communities that did not exist before — which
   * is exactly the job it should have.
   * ------------------------------------------------------------------------ */
  let fromPrev: Similarity | null = null;
  if (anchor) {
    const shared: number[] = [];
    for (let c = 0; c < cCount; c++) {
      if (count[c] > 0 && anchor.prevCx.has(t.communityIds[c])) shared.push(c);
    }
    if (shared.length >= 2) {
      const k = shared.length;
      const sx = new Float64Array(k);
      const sy = new Float64Array(k);
      const tx = new Float64Array(k);
      const ty = new Float64Array(k);
      const w = new Float64Array(k);
      for (let i = 0; i < k; i++) {
        const c = shared[i];
        const id = t.communityIds[c];
        sx[i] = anchor.prevCx.get(id)!;
        sy[i] = anchor.prevCy.get(id)!;
        tx[i] = cx[c];
        ty[i] = cy[c];
        w[i] = count[c];
      }
      /* The scale is set by DENSITY, not by the arrangement.
       *
       * `radius[c] · rmsU` is the RMS radius this bake intends community `c` to
       * have in internal units (`rmsU` is the actual second moment of the radial
       * placement distribution, computed rather than assumed). Dividing by the
       * community's previous RMS radius gives the prev→internal scale that
       * preserves personal space. The median over communities is robust to a
       * community that grew tenfold; the centroid fit below then supplies the
       * rotation and translation, which scale does not affect. */
      let sumU2 = 0;
      let nU = 0;
      const salt = opts.seed ?? '';
      for (let i = 0; i < t.n; i++) {
        if (!t.free[i]) continue;
        const u0 = Math.pow(hash01(`${salt}|rho|${t.ids[i]}`), 0.85) * (1 - 0.55 * t.centrality[i]) + 0.06;
        const u = clamp(u0, 0, 1.05);
        sumU2 += u * u;
        nU++;
      }
      const rmsUEff = nU > 0 ? Math.sqrt(sumU2 / nU) : 0.6;
      const ratios: number[] = [];
      for (let i = 0; i < k; i++) {
        const c = shared[i];
        if (count[c] < 4) continue;
        const spread = anchor.prevSpread.get(t.communityIds[c]);
        if (spread === undefined || spread < 1e-9) continue;
        ratios.push((radius[c] * rmsUEff) / spread);
      }
      ratios.sort((p, q) => p - q);
      const densityScale = ratios.length > 0 ? ratios[Math.floor(ratios.length / 2)] : null;

      fromPrev = solveSimilarity(sx, sy, tx, ty, w, k, true, densityScale);
      const out: [number, number] = [0, 0];
      for (let i = 0; i < k; i++) {
        const c = shared[i];
        applySimilarity(fromPrev, sx[i], sy[i], out);
        cx[c] = out[0];
        cy[c] = out[1];
      }

      // Relieve any overlap the inherited arrangement genuinely has because a
      // community grew. Separation only, gently: growth is allowed to push its
      // neighbours a little, and `mean_drift` will report that honestly.
      for (let it = 0; it < 40; it++) {
        dx.fill(0);
        dy.fill(0);
        for (let a = 0; a < cCount; a++) {
          if (count[a] === 0) continue;
          for (let b = a + 1; b < cCount; b++) {
            if (count[b] === 0) continue;
            const ux = cx[a] - cx[b];
            const uy = cy[a] - cy[b];
            const d = Math.hypot(ux, uy);
            if (d < 1e-9) continue;
            const minSep = (radius[a] + radius[b]) * (1 + (opts.straitGap ?? straitGap));
            if (d >= minSep) continue;
            const push = ((minSep - d) / d) * 0.25;
            dx[a] += ux * push;
            dy[a] += uy * push;
            dx[b] -= ux * push;
            dy[b] -= uy * push;
          }
        }
        for (let c = 0; c < cCount; c++) {
          if (count[c] === 0) continue;
          cx[c] += dx[c];
          cy[c] += dy[c];
        }
      }
    }
  }

  return { cx, cy, pcx, pcy, radius, count, fromPrev };
}

/**
 * Place the world inside its community masses, TOP DOWN ALONG THE SPINE.
 *
 * Two tiers, because the grain has two tiers:
 *
 *   MOLECULES IN THE MASS. Assets (and the off-spine entities and sources) get
 *   the coastline treatment: angle from the node's PCA residual, so local
 *   semantic structure survives into the shape of the coast; radius from
 *   centrality, so hubs sit in the core and the margin thins out; both modulated
 *   by a seeded four-harmonic lobe function, which is the cheapest honest
 *   coastline there is.
 *
 *   ATOMS IN THE MOLECULE. A passage is placed in a tight golden-angle disc
 *   around ITS OWN ASSET, not independently in the community. This is not a
 *   detail. Placing passages independently and trusting relaxation to reunite
 *   them does not work at scale — measured on 100k nodes it left assets with a
 *   p99 radius of 129 layout units, discs so large they swallowed a third of
 *   their island, which is wrong on screen and wrong in the spatial index. An
 *   asset is a molecule with a declared boundary; it has to look like one.
 */
function placeFreeNodes(
  t: Topology,
  proj: Projection,
  macro: MacroLayout,
  opts: BakeOpts,
  anchor: AnchorFrame | null,
): { x: Float32Array; y: Float32Array; seeded: Uint8Array } {
  const n = t.n;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const cCount = t.communityIds.length;
  const rough = clamp(opts.coastRoughness ?? 0.34, 0, 0.5);
  const salt = opts.seed ?? '';
  const bridgePull = clamp(opts.bridgePull ?? 0.45, 0, 1);

  // Per-community coastline harmonics.
  const HARMONICS = 4;
  const amp = new Float64Array(cCount * HARMONICS);
  const phase = new Float64Array(cCount * HARMONICS);
  for (let c = 0; c < cCount; c++) {
    const rnd = splitmix32(fnv1a32(`${salt}|coast|${t.communityIds[c]}`));
    let total = 0;
    for (let k = 0; k < HARMONICS; k++) {
      const a = rnd();
      amp[c * HARMONICS + k] = a;
      total += a;
      phase[c * HARMONICS + k] = rnd() * Math.PI * 2;
    }
    if (total > 0) for (let k = 0; k < HARMONICS; k++) amp[c * HARMONICS + k] = (amp[c * HARMONICS + k] / total) * rough;
  }

  /* ---------------------------------------------------------------------------
   * ANCHORING, STAGE 2: THE NODES THEMSELVES
   * ---------------------------------------------------------------------------
   * A node that already had a position keeps it. Re-deriving a survivor's
   * coordinates from a fresh projection is how a re-bake shuffles the interior
   * of an island even when the island itself did not move — the community is in
   * the right place and everything inside it is somewhere else, which is arguably
   * worse than moving the island, because it looks like nothing changed.
   * New nodes get the ordinary shaped placement below and then the relaxation
   * pass makes room for them.
   * ------------------------------------------------------------------------ */
  const seeded = new Uint8Array(n);
  if (anchor && macro.fromPrev) {
    const out: [number, number] = [0, 0];
    for (let i = 0; i < n; i++) {
      const p = anchor.prevX.get(t.ids[i]);
      if (p === undefined) continue;
      applySimilarity(macro.fromPrev, p, anchor.prevY.get(t.ids[i])!, out);
      x[i] = out[0];
      y[i] = out[1];
      seeded[i] = 1;
    }
  }

  /* --- tier 1: who gets the coastline treatment --------------------------
   * Everything whose spine parent is a REGION rung (or which has no spine
   * parent at all). Regions are derived from their children's centroid and are
   * never placed directly, so their children are the top of the placed world.
   * ---------------------------------------------------------------------- */
  const shaped = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (t.kind[i] === KIND_CODE.continent || t.kind[i] === KIND_CODE.island) continue;
    const p = t.parentIdx[i];
    if (p === -1 || t.kind[p] === KIND_CODE.continent || t.kind[p] === KIND_CODE.island) shaped[i] = 1;
  }

  for (let i = 0; i < n; i++) {
    if (!shaped[i] || seeded[i]) continue;
    const c = t.community[i];
    const R = macro.radius[c];

    // Angle: the direction of this node's PCA residual from its own community's
    // PCA centroid. Semantic neighbours share a bearing, so local structure
    // survives into the coastline instead of being replaced by hash noise.
    let ux = proj.px[i] - macro.pcx[c];
    let uy = proj.py[i] - macro.pcy[c];
    if (Math.hypot(ux, uy) < 1e-9) {
      const a = hash01(`${salt}|theta|${t.ids[i]}`) * Math.PI * 2;
      ux = Math.cos(a);
      uy = Math.sin(a);
    }
    const theta = Math.atan2(uy, ux);

    // Radial position: hash-stable, biased inward by centrality. Uniform `u`
    // over radius gives areal density ∝ 1/r — a dense core and a thin margin.
    const u0 = hash01(`${salt}|rho|${t.ids[i]}`);
    const u = clamp(Math.pow(u0, 0.85) * (1 - 0.55 * t.centrality[i]) + 0.06, 0, 1.05);

    let lobe = 1;
    for (let k = 0; k < HARMONICS; k++) {
      lobe += amp[c * HARMONICS + k] * Math.cos((k + 2) * theta + phase[c * HARMONICS + k]);
    }
    const rad = R * u * lobe;
    let nx = macro.cx[c] + Math.cos(theta) * rad;
    let ny = macro.cy[c] + Math.sin(theta) * rad;

    // Bridge pull: toward the mass on the other side of the water.
    let bx = 0;
    let by = 0;
    let bw = 0;
    let ow = 0;
    for (let k = t.adjStart[i]; k < t.adjStart[i + 1]; k++) {
      const j = t.adjTarget[k];
      const cj = t.community[j];
      const w = t.adjWeight[k];
      if (cj === c) {
        ow += w;
      } else {
        bw += w;
        bx += w * macro.cx[cj];
        by += w * macro.cy[cj];
      }
    }
    if (bw > 0) {
      bx /= bw;
      by /= bw;
      const share = bw / (bw + ow);
      const tPull = clamp(share, 0, 1) * bridgePull;
      nx += (bx - nx) * tPull * 0.5;
      ny += (by - ny) * tPull * 0.5;
    }

    x[i] = nx;
    y[i] = ny;
  }

  /* --- tier 2: atoms inside their molecule -------------------------------
   * Depth-ordered so a grandchild is never placed before its parent. Positions
   * are a golden-angle (sunflower) packing, which fills a disc uniformly, has no
   * axis to read structure into that is not there, and orders outward by reading
   * sequence. Radius is `√k` in the same "one node's personal space" units the
   * community masses use, so an asset packs at the same density as everything
   * else.
   * ---------------------------------------------------------------------- */
  const depth = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (shaped[i]) depth[i] = 0;
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (depth[i] !== -1) continue;
      const p = t.parentIdx[i];
      if (p !== -1 && depth[p] !== -1) {
        depth[i] = depth[p] + 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  let maxDepth = 0;
  for (let i = 0; i < n; i++) if (depth[i] > maxDepth) maxDepth = depth[i];
  // Sibling ordinal, precomputed in one pass — `childItems` is already in
  // reading order, so this is the passage's `seq` without trusting the field.
  const ordinal = new Int32Array(n);
  for (let p = 0; p < n; p++) {
    const s = t.childStart[p];
    for (let q = s; q < t.childStart[p + 1]; q++) ordinal[t.childItems[q]] = q - s;
  }

  const GOLDEN = 2.399963229728653;
  for (let d = 1; d <= maxDepth; d++) {
    for (let i = 0; i < n; i++) {
      if (depth[i] !== d) continue;
      // Anchored survivors keep their own coordinates; only genuinely new atoms
      // are packed into the molecule.
      if (seeded[i]) continue;
      const p = t.parentIdx[i];
      const k = Math.max(t.childStart[p + 1] - t.childStart[p], 1);
      const seq = ordinal[i];
      const localR = Math.sqrt(k) * 0.9;
      const phase = hash01(`${salt}|mol|${t.ids[p]}`) * Math.PI * 2;
      const ang = seq * GOLDEN + phase;
      const rad = localR * Math.sqrt((seq + 0.5) / k);
      x[i] = x[p] + Math.cos(ang) * rad;
      y[i] = y[p] + Math.sin(ang) * rad;
    }
  }

  return { x, y, seeded };
}

/* =============================================================================
 * 7. BOUNDED RELAXATION — bake-time only
 * -----------------------------------------------------------------------------
 * READ THIS BEFORE YOU CALL IT A SIMULATION.
 *
 * A fixed number of passes. No convergence test, no timer, no animation frame,
 * no caller can observe an intermediate state. Every pass ends with each
 * community rigidly re-centred on its macro position, which means local
 * refinement can improve the neighbourhood detail but can NEVER dissolve the
 * continents. That constraint is why this can be run to a fixed budget and
 * still be trusted.
 * ========================================================================== */

function relax(
  t: Topology,
  x: Float32Array,
  y: Float32Array,
  macro: MacroLayout,
  iterations: number,
  /**
   * Per-node motion budget, 0..1, or `null` for "everyone moves freely".
   *
   * On an anchored re-bake this is how the map keeps its promise: a node that
   * already had a home barely moves, and the relaxation spends its budget making
   * room for the new arrivals instead of jiggling everything the user has already
   * memorised. New content finds a place; existing content stays put.
   */
  mobility: Float32Array | null,
): void {
  const n = t.n;
  const freeIdx: number[] = [];
  for (let i = 0; i < n; i++) if (t.free[i]) freeIdx.push(i);
  const nf = freeIdx.length;
  if (nf < 2 || iterations <= 0) return;

  const isFree = t.free;
  const dx = new Float32Array(n);
  const dy = new Float32Array(n);

  // Grid geometry, from the initial extent. Rebuilt each pass; the cell size is
  // fixed so the force scales do not wander between passes.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of freeIdx) {
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i];
    if (y[i] > maxY) maxY = y[i];
  }
  const area = Math.max((maxX - minX) * (maxY - minY), 1e-6);
  const cellSize = Math.max(Math.sqrt(area / nf), 1e-4);
  const sep = cellSize * 0.85;
  const rest = cellSize * 0.9;
  const maxStep = cellSize * 0.35;

  const eFrom = t.edgeFrom;
  const eTo = t.edgeTo;
  const eW = t.edgeWeight;
  const eCount = eFrom.length;

  const cCount = t.communityIds.length;
  const sumX = new Float64Array(cCount);
  const sumY = new Float64Array(cCount);
  const cnt = new Int32Array(cCount);

  // Grid scratch, allocated once and reused across every pass. Allocating inside
  // the loop would make the bake's cost a garbage-collection question.
  let cols = 1;
  let rows = 1;
  let start = new Int32Array(2);
  let counts = new Int32Array(2);
  let cursor = new Int32Array(1);
  const cellOf = new Int32Array(nf);
  const items = new Int32Array(nf);
  let cool = 1;
  const sep2 = sep * sep;

  const repel = (j: number, i: number): void => {
    let ux = x[i] - x[j];
    let uy = y[i] - y[j];
    let d2 = ux * ux + uy * uy;
    if (d2 >= sep2) return;
    if (d2 < 1e-12) {
      const a = hash01(`sep|${i}|${j}`) * Math.PI * 2;
      ux = Math.cos(a) * 1e-3;
      uy = Math.sin(a) * 1e-3;
      d2 = 1e-6;
    }
    const d = Math.sqrt(d2);
    const f = ((sep - d) / d) * 0.35 * cool;
    dx[i] += ux * f;
    dy[i] += uy * f;
    dx[j] -= ux * f;
    dy[j] -= uy * f;
  };

  const scanCell = (gx: number, gy: number, i: number): void => {
    if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) return;
    const c = gy * cols + gx;
    for (let q = start[c]; q < start[c + 1]; q++) repel(items[q], i);
  };

  for (let it = 0; it < iterations; it++) {
    dx.fill(0);
    dy.fill(0);
    cool = 0.55 + 0.45 * (1 - it / iterations);

    /* --- attraction along real topology ---------------------------------- */
    for (let e = 0; e < eCount; e++) {
      const a = eFrom[e];
      const b = eTo[e];
      if (!isFree[a] || !isFree[b]) continue;
      const ux = x[b] - x[a];
      const uy = y[b] - y[a];
      const d = Math.hypot(ux, uy);
      if (d < 1e-9) continue;
      // Cross-community springs are damped: the macro layout already decided
      // how far apart the masses are, and one chatty bridge must not drag a
      // continent across the strait.
      const cross = t.community[a] !== t.community[b] ? 0.3 : 1;
      const f = 0.1 * eW[e] * cross * ((d - rest) / d) * cool;
      dx[a] += ux * f;
      dy[a] += uy * f;
      dx[b] -= ux * f;
      dy[b] -= uy * f;
    }

    /* --- local repulsion on a uniform grid (each pair visited once) ------- */
    minX = Infinity;
    minY = Infinity;
    maxX = -Infinity;
    maxY = -Infinity;
    for (let q = 0; q < nf; q++) {
      const i = freeIdx[q];
      if (x[i] < minX) minX = x[i];
      if (x[i] > maxX) maxX = x[i];
      if (y[i] < minY) minY = y[i];
      if (y[i] > maxY) maxY = y[i];
    }
    cols = Math.max(1, Math.min(4096, Math.ceil((maxX - minX) / cellSize) + 1));
    rows = Math.max(1, Math.min(4096, Math.ceil((maxY - minY) / cellSize) + 1));
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const cells = cols * rows;
    if (counts.length < cells + 1) {
      counts = new Int32Array(cells + 1);
      start = new Int32Array(cells + 1);
      cursor = new Int32Array(cells);
    } else {
      counts.fill(0, 0, cells + 1);
    }
    for (let q = 0; q < nf; q++) {
      const i = freeIdx[q];
      const gx = Math.min(cols - 1, Math.max(0, Math.floor(((x[i] - minX) / spanX) * cols)));
      const gy = Math.min(rows - 1, Math.max(0, Math.floor(((y[i] - minY) / spanY) * rows)));
      const c = gy * cols + gx;
      cellOf[q] = c;
      counts[c]++;
    }
    let acc = 0;
    for (let c = 0; c < cells; c++) {
      start[c] = acc;
      cursor[c] = acc;
      acc += counts[c];
    }
    start[cells] = acc;
    for (let q = 0; q < nf; q++) items[cursor[cellOf[q]]++] = freeIdx[q];

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const c = gy * cols + gx;
        const s0 = start[c];
        const e0 = start[c + 1];
        for (let p = s0; p < e0; p++) {
          const i = items[p];
          // same cell, forward pairs only
          for (let q = p + 1; q < e0; q++) repel(items[q], i);
          // four forward neighbours: E, NE, N, NW — every unordered pair once.
          scanCell(gx + 1, gy, i);
          scanCell(gx + 1, gy + 1, i);
          scanCell(gx, gy + 1, i);
          scanCell(gx - 1, gy + 1, i);
        }
      }
    }

    /* --- apply, clamped -------------------------------------------------- */
    for (let q = 0; q < nf; q++) {
      const i = freeIdx[q];
      let mx = dx[i];
      let my = dy[i];
      const mag = Math.hypot(mx, my);
      if (mag > maxStep) {
        const k = maxStep / mag;
        mx *= k;
        my *= k;
      }
      if (mobility) {
        mx *= mobility[i];
        my *= mobility[i];
      }
      x[i] += mx;
      y[i] += my;
    }

    /* --- rigid community re-centring: global geography is not negotiable -- */
    sumX.fill(0);
    sumY.fill(0);
    cnt.fill(0);
    for (let q = 0; q < nf; q++) {
      const i = freeIdx[q];
      const c = t.community[i];
      sumX[c] += x[i];
      sumY[c] += y[i];
      cnt[c]++;
    }
    for (let c = 0; c < cCount; c++) {
      if (cnt[c] === 0) continue;
      sumX[c] = macro.cx[c] - sumX[c] / cnt[c];
      sumY[c] = macro.cy[c] - sumY[c] / cnt[c];
    }
    for (let q = 0; q < nf; q++) {
      const i = freeIdx[q];
      const c = t.community[i];
      x[i] += sumX[c];
      y[i] += sumY[c];
    }
  }
}

/* =============================================================================
 * 8. SPINE RECONCILIATION
 * -----------------------------------------------------------------------------
 * The rung invariant, stated as code: a parent IS the centroid of its children.
 * If it is not, the camera flight from island to asset lands somewhere the user
 * was not looking at, and the descent stops feeling like travel.
 * ========================================================================== */

function reconcileSpine(t: Topology, x: Float32Array, y: Float32Array, opts: BakeOpts): void {
  const n = t.n;
  const entityPull = clamp(opts.entityToAssetPull ?? 0.8, 0, 1);

  // Assets first (from passages), then islands (from assets), then continents.
  derive(KIND_CODE.asset);

  // Entities and sources are attached, not contained: they land on the centroid
  // of the assets that mention them. A bridge entity's assets are on two
  // different islands, so its centroid is in the water between them. That is the
  // whole demo, and it is geometry, not decoration.
  for (let i = 0; i < n; i++) {
    if (t.kind[i] !== KIND_CODE.entity && t.kind[i] !== KIND_CODE.source) continue;
    const s = t.attachStart[i];
    const e = t.attachStart[i + 1];
    if (e <= s) continue;
    let ax = 0;
    let ay = 0;
    for (let k = s; k < e; k++) {
      ax += x[t.attachItems[k]];
      ay += y[t.attachItems[k]];
    }
    ax /= e - s;
    ay /= e - s;
    const pull = t.kind[i] === KIND_CODE.entity ? entityPull : 0.92;
    x[i] += (ax - x[i]) * pull;
    y[i] += (ay - y[i]) * pull;
  }

  derive(KIND_CODE.island);
  derive(KIND_CODE.continent);

  function derive(kindCode: number): void {
    for (let i = 0; i < n; i++) {
      if (t.kind[i] !== kindCode) continue;
      const s = t.childStart[i];
      const e = t.childStart[i + 1];
      if (e <= s) continue;
      let sx = 0;
      let sy = 0;
      for (let k = s; k < e; k++) {
        sx += x[t.childItems[k]];
        sy += y[t.childItems[k]];
      }
      x[i] = sx / (e - s);
      y[i] = sy / (e - s);
    }
  }
}

/**
 * Final overlap relief. A few grid passes that push coincident nodes apart
 * without moving anything far — the Lloyd-relaxation-shaped step that stops two
 * entities that share an asset from occupying the same pixel.
 */
function deoverlap(t: Topology, x: Float32Array, y: Float32Array, passes: number): void {
  const n = t.n;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (t.kind[i] === KIND_CODE.entity || t.kind[i] === KIND_CODE.source) idx.push(i);
  if (idx.length < 2) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of idx) {
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i];
    if (y[i] > maxY) maxY = y[i];
  }
  const area = Math.max((maxX - minX) * (maxY - minY), 1e-6);
  const sep = Math.max(Math.sqrt(area / idx.length) * 0.55, 1e-5);
  const sep2 = sep * sep;

  for (let pass = 0; pass < passes; pass++) {
    const cols = Math.max(1, Math.min(2048, Math.ceil((maxX - minX) / sep) + 1));
    const rows = Math.max(1, Math.min(2048, Math.ceil((maxY - minY) / sep) + 1));
    const spanX = (maxX - minX) || 1;
    const spanY = (maxY - minY) || 1;
    const cells = cols * rows;
    const counts = new Int32Array(cells + 1);
    const cellOf = new Int32Array(idx.length);
    for (let q = 0; q < idx.length; q++) {
      const i = idx[q];
      const gx = Math.min(cols - 1, Math.max(0, Math.floor(((x[i] - minX) / spanX) * cols)));
      const gy = Math.min(rows - 1, Math.max(0, Math.floor(((y[i] - minY) / spanY) * rows)));
      const c = gy * cols + gx;
      cellOf[q] = c;
      counts[c]++;
    }
    const start = new Int32Array(cells + 1);
    let acc = 0;
    for (let c = 0; c < cells; c++) {
      start[c] = acc;
      acc += counts[c];
    }
    start[cells] = acc;
    const cursor = start.slice(0, cells);
    const items = new Int32Array(idx.length);
    for (let q = 0; q < idx.length; q++) items[cursor[cellOf[q]]++] = idx[q];

    for (let c = 0; c < cells; c++) {
      for (let p = start[c]; p < start[c + 1]; p++) {
        const i = items[p];
        for (let q = p + 1; q < start[c + 1]; q++) {
          const j = items[q];
          let ux = x[i] - x[j];
          let uy = y[i] - y[j];
          let d2 = ux * ux + uy * uy;
          if (d2 >= sep2) continue;
          if (d2 < 1e-12) {
            const a = hash01(`ov|${i}|${j}`) * Math.PI * 2;
            ux = Math.cos(a) * 1e-3;
            uy = Math.sin(a) * 1e-3;
            d2 = 1e-6;
          }
          const d = Math.sqrt(d2);
          const push = ((sep - d) / d) * 0.5;
          x[i] += ux * push;
          y[i] += uy * push;
          x[j] -= ux * push;
          y[j] -= uy * push;
        }
      }
    }
  }
}

/* =============================================================================
 * 9. EMITTING THE BAKE — radii, LOD hints, bounds
 * ========================================================================== */

/**
 * Base radius per kind as a fraction of `extent`. Region kinds are floors only:
 * a continent's real radius is whatever it takes to actually cover its islands,
 * because a region wash that does not cover its own contents is a lie about
 * containment.
 */
const KIND_RADIUS: Readonly<Record<NodeKind, number>> = {
  continent: 0.055,
  island: 0.026,
  asset: 0.0075,
  entity: 0.006,
  passage: 0.0038,
  source: 0.0055,
};

/**
 * The LOD the bake SUGGESTS at default (whole-world) zoom. A hint, never a
 * decision: the live ramp is chosen per frame by the render budget and by
 * selection. `lod-0` is deliberately never suggested here — the fovea is earned
 * by the engine attending to something, not by being big.
 */
function lodHintFor(kind: NodeKind, centrality: number, isBridge: boolean): LodState {
  let base: LodState;
  switch (kind) {
    case 'continent':
      base = 'lod-1';
      break;
    case 'island':
      base = 'lod-2';
      break;
    case 'asset':
      base = 'ghost';
      break;
    case 'entity':
      base = isBridge ? 'lod-2' : 'ghost';
      break;
    case 'passage':
    case 'source':
      base = 'latent';
      break;
  }
  if (centrality >= 0.8) {
    if (base === 'latent') return 'ghost';
    if (base === 'ghost') return 'lod-2';
    if (base === 'lod-2') return 'lod-1';
  }
  return base;
}

/**
 * Normalise the layout to roughly `extent` on the longer axis, centred on the
 * origin.
 *
 * Deliberately fitted to the 0.5–99.5 percentile span rather than to the true
 * min/max. A coastline lobe or a bridge pull can legitimately fling one node
 * half again as far out as everything else, and letting that ONE node set the
 * world scale is how a re-bake ends up needing a 1.56× correction it should
 * never have needed (measured, before this change). A percentile fit means the
 * scale is a property of the terrain, not of its furthest outlier; a handful of
 * peninsulas simply extend past `extent`, which is what peninsulas do.
 */
function normaliseExtent(x: Float32Array, y: Float32Array, n: number, extent: number): void {
  if (n === 0) return;
  const stride = Math.max(1, Math.floor(n / 16384));
  const k = Math.floor((n + stride - 1) / stride);
  const sx = new Float32Array(k);
  const sy = new Float32Array(k);
  for (let i = 0, j = 0; j < k; i += stride, j++) {
    sx[j] = x[i];
    sy[j] = y[i];
  }
  sx.sort();
  sy.sort();
  const lo = Math.floor(0.005 * (k - 1));
  const hi = Math.ceil(0.995 * (k - 1));
  const w = sx[hi] - sx[lo];
  const h = sy[hi] - sy[lo];
  const s = Math.max(w, h) > 1e-9 ? extent / Math.max(w, h) : 1;
  const cx = (sx[lo] + sx[hi]) / 2;
  const cy = (sy[lo] + sy[hi]) / 2;
  for (let i = 0; i < n; i++) {
    x[i] = (x[i] - cx) * s;
    y[i] = (y[i] - cy) * s;
  }
}

function computeRadii(t: Topology, x: Float32Array, y: Float32Array, extent: number): Float32Array {
  const n = t.n;
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const kind = KIND_NAMES[t.kind[i]];
    r[i] = extent * KIND_RADIUS[kind] * (0.55 + 0.9 * t.centrality[i]);
  }
  // Region kinds grow to cover their children, innermost first.
  for (const code of [KIND_CODE.asset, KIND_CODE.island, KIND_CODE.continent]) {
    for (let i = 0; i < n; i++) {
      if (t.kind[i] !== code) continue;
      const s = t.childStart[i];
      const e = t.childStart[i + 1];
      if (e <= s) continue;
      let cover = 0;
      for (let k = s; k < e; k++) {
        const j = t.childItems[k];
        cover = Math.max(cover, Math.hypot(x[j] - x[i], y[j] - y[i]) + r[j]);
      }
      r[i] = Math.max(r[i], cover * 1.03);
    }
  }
  return r;
}

/* =============================================================================
 * 10. THE PUBLIC BAKE
 * ========================================================================== */

interface RawBake {
  t: Topology;
  x: Float32Array;
  y: Float32Array;
  r: Float32Array;
  hash: ContentHash;
}

function bakeRaw(world: World, opts: BakeOpts, anchor: AnchorFrame | null): RawBake {
  const t = buildTopology(world, opts);
  const hash = contentHashOf(t);

  const extent = opts.extent ?? 1000;
  const dims = Math.max(2, opts.featureDims ?? 16);
  const rounds = Math.max(0, opts.propagationRounds ?? 3);
  const alpha = clamp(opts.propagationAlpha ?? 0.45, 0, 1);
  const salt = opts.seed ?? '';
  const iterations = opts.relaxIterations ?? (t.n <= 20000 ? 24 : 14);

  if (t.n === 0) {
    return { t, x: new Float32Array(0), y: new Float32Array(0), r: new Float32Array(0), hash };
  }

  const features = synthesiseFeatures(t, dims, rounds, alpha, salt);
  const proj = projectPca(t, features, dims, anchor);
  const macro = macroLayout(t, proj, opts, anchor);
  const { x, y, seeded } = placeFreeNodes(t, proj, macro, opts, anchor);
  let mobility: Float32Array | null = null;
  if (anchor) {
    mobility = new Float32Array(t.n);
    const settled = clamp(opts.anchoredMobility ?? 0.2, 0, 1);
    for (let i = 0; i < t.n; i++) mobility[i] = seeded[i] ? settled : 1;

    /* Re-target the relaxation's per-community re-centring onto the SURVIVORS.
     *
     * `relax` ends every pass by translating each community so its mean sits on
     * the macro centroid. That translation is rigid — it moves every member —
     * so if the target disagrees with where the survivors already are by even a
     * little, every node in the community is displaced by that little, and no
     * global similarity can undo twenty different translations. The macro
     * centroid came from the previous bake's centroid over a slightly different
     * node set, so it disagreed. Measured: re-baking an UNCHANGED corpus
     * reported 44.8 units of drift — a flat lie about a map that did not move.
     *
     * Targeting the survivors' own mean makes the re-centring an exact no-op
     * when nothing changed, and keeps new arrivals from dragging a community
     * off the spot the user remembers when something did.
     */
    const cN = t.communityIds.length;
    const ax = new Float64Array(cN);
    const ay = new Float64Array(cN);
    const an = new Int32Array(cN);
    for (let i = 0; i < t.n; i++) {
      if (!t.free[i] || !seeded[i]) continue;
      const c = t.community[i];
      ax[c] += x[i];
      ay[c] += y[i];
      an[c]++;
    }
    for (let c = 0; c < cN; c++) {
      if (an[c] === 0) continue;
      macro.cx[c] = ax[c] / an[c];
      macro.cy[c] = ay[c] / an[c];
    }
  }
  relax(t, x, y, macro, iterations, mobility);
  reconcileSpine(t, x, y, opts);
  // Only entities and sources move here, and no rung derives from them, so the
  // parent-is-the-centroid-of-its-children invariant is still exact afterwards.
  deoverlap(t, x, y, 3);

  normaliseExtent(x, y, t.n, extent);
  const r = computeRadii(t, x, y, extent);
  return { t, x, y, r, hash };
}

function emitPositions(world: World, raw: RawBake): NodePosition[] {
  const byId = new Map<string, GraphNode>();
  for (const node of world.nodes) byId.set(node.id, node);
  const out: NodePosition[] = new Array(raw.t.n);
  for (let i = 0; i < raw.t.n; i++) {
    const id = raw.t.ids[i];
    const node = byId.get(id)!;
    const isBridge = node.kind === 'entity' ? node.is_bridge : false;
    out[i] = {
      id,
      x: raw.x[i],
      y: raw.y[i],
      r: raw.r[i],
      community_id: node.community_id,
      kind: node.kind,
      lod_hint: lodHintFor(node.kind, raw.t.centrality[i], isBridge),
    };
  }
  return out;
}

/**
 * Bake a deterministic semantic layout for a world.
 *
 * Same world in ⇒ byte-identical positions out, regardless of the order the
 * caller happened to put its nodes and edges in. Call this ONCE, when the corpus
 * changes; cache the result against `content_hash`; never call it from a
 * component. (`scripts/check-discipline.mjs` enforces the last part.)
 */
export function bakeLayout(world: World, opts: BakeOpts = {}): LayoutBake {
  const raw = bakeRaw(world, opts, null);
  const positions = emitPositions(world, raw);
  return {
    bake_id: `bake_${raw.hash.slice(0, 16)}`,
    content_hash: raw.hash,
    algo: 'umap-pca-hybrid',
    created_at: opts.now ?? new Date().toISOString(),
    bounds: boundsOf(positions),
    positions,
    anchor_alignment: null,
    corpus_provenance: CORPUS_PROVENANCE,
  };
}

/* =============================================================================
 * 11. RE-BAKE LAYOUT STABILITY
 * =============================================================================
 *
 * THE PROBLEM (named, because it is the one that quietly ruins map products)
 * -------------------------------------------------------------------------
 * A projection has no absolute frame. Rotate it, mirror it, scale it, translate
 * it, and the loss is unchanged — every one of those is an equally good answer
 * to "project this graph into 2D". So when the corpus grows by a handful of
 * documents and the layout is recomputed, the honest optimiser is free to hand
 * back a map that is 40° rotated, mirrored and 1.2× larger. Semantically it is
 * the same map. To the user it is a different world: the amber island is no
 * longer up and to the left, the route they had memorised is gone, and the
 * terrain has silently stopped being a place. Every scrap of spatial memory —
 * the entire reason for drawing a map instead of a list — is destroyed by a
 * transform that the maths considers a no-op.
 *
 * Worse, it is invisible. Nothing errors. The map just quietly betrays you, and
 * you conclude that you were wrong about where things were.
 *
 * THE SOLUTION: ANCHORED RE-PROJECTION
 * ------------------------------------
 * Do not try to make the projection stable — it cannot be. Make the FRAME
 * stable instead, and then report exactly how much moved anyway.
 *
 *   1. CHIRALITY FIRST. The sign of a principal axis is arbitrary, and a flipped
 *      sign mirrors the world. Before any placement work, the new embedding's
 *      second axis is oriented against the previous bake (`orientAgainstPrevious`,
 *      §5) by the sign of the 2×2 cross-covariance determinant over surviving
 *      nodes. Fixing the reflection here rather than afterwards is what lets the
 *      reported transform be a PROPER similarity, which is all the three numbers
 *      in `AnchorAlignment` can honestly describe.
 *
 *   2. ANCHOR SET. Every node id present in BOTH bakes is an anchor. Nodes that
 *      were added have no opinion about where the world used to be; nodes that
 *      were removed no longer get a vote.
 *
 *   3. WEIGHTED PROCRUSTES. Solve the similarity transform — rotation θ, uniform
 *      scale s, translation t — minimising Σ wᵢ‖s·R·qᵢ + t − pᵢ‖² over the
 *      anchors, where p is the old position, q is the new one and
 *      wᵢ = floor + centralityᵢ. Weighting by centrality is the judgement call
 *      that makes this feel right: the landmarks a user actually navigates by are
 *      the high-degree hubs, so the alignment is fitted to THEM and lets the
 *      periphery move. In 2D the closed form is two dot products —
 *      θ = atan2(Σw(qₓpᵧ − qᵧpₓ), Σw(qₓpₓ + qᵧpᵧ)) — so there is no iteration and
 *      no failure mode.
 *
 *   4. REFLECTION CHECK, KEPT. Step 1 usually removes the mirror, but a corpus
 *      that changed enough can still flip. Both the proper and the mirrored
 *      solution are evaluated and the lower-residual one wins. If the mirror wins
 *      it is folded into the new geometry BEFORE the reported rotation/scale/
 *      translation is solved, so `AnchorAlignment` never has to describe an
 *      improper transform it has no field for.
 *
 *   5. CONFESS. `mean_drift` is the mean residual displacement of the anchors
 *      AFTER alignment, in layout units. It is not a diagnostic hidden in a log:
 *      the UI is expected to surface it, because a re-bake that moved the world
 *      3% should say "3%" rather than pretending nothing happened. Use
 *      `meanDriftPercent()` to express it against the world's own diagonal.
 *
 * WHAT THIS DOES NOT CLAIM
 * ------------------------
 * Alignment cannot undo real change. If half the corpus is replaced, the terrain
 * genuinely IS different and `mean_drift` will be large — which is the correct
 * outcome, honestly reported, rather than a forced stability that would put the
 * new documents in the wrong place to preserve an illusion.
 * ========================================================================== */

/**
 * Re-bake a changed world, aligned to the previous bake so spatial memory
 * survives. See the block comment above for the full argument.
 */
export function rebakeAnchored(previous: LayoutBake, world: World, opts: RebakeOpts = {}): LayoutBake {
  const weightFloor = opts.anchorWeightFloor ?? 0.25;

  const prevX = new Map<string, number>();
  const prevY = new Map<string, number>();
  const sumX = new Map<string, number>();
  const sumY = new Map<string, number>();
  const cnt = new Map<string, number>();
  for (const p of previous.positions) {
    prevX.set(p.id, p.x);
    prevY.set(p.id, p.y);
    // Region rungs are centroids of their own children, so counting them would
    // weight a community by its depth rather than its population.
    if (p.kind === 'continent' || p.kind === 'island') continue;
    sumX.set(p.community_id, (sumX.get(p.community_id) ?? 0) + p.x);
    sumY.set(p.community_id, (sumY.get(p.community_id) ?? 0) + p.y);
    cnt.set(p.community_id, (cnt.get(p.community_id) ?? 0) + 1);
  }
  const prevCx = new Map<string, number>();
  const prevCy = new Map<string, number>();
  for (const [id, k] of cnt) {
    prevCx.set(id, sumX.get(id)! / k);
    prevCy.set(id, sumY.get(id)! / k);
  }
  const sumSq = new Map<string, number>();
  for (const p of previous.positions) {
    if (p.kind === 'continent' || p.kind === 'island') continue;
    const dx = p.x - prevCx.get(p.community_id)!;
    const dy = p.y - prevCy.get(p.community_id)!;
    sumSq.set(p.community_id, (sumSq.get(p.community_id) ?? 0) + dx * dx + dy * dy);
  }
  const prevSpread = new Map<string, number>();
  for (const [id, k] of cnt) prevSpread.set(id, Math.sqrt(sumSq.get(id)! / k));

  const raw = bakeRaw(world, opts, { prevX, prevY, prevCx, prevCy, prevSpread, weightFloor });
  const t = raw.t;

  /* --- anchors ------------------------------------------------------------ */
  const anchors: number[] = [];
  for (let i = 0; i < t.n; i++) if (prevX.has(t.ids[i])) anchors.push(i);

  if (anchors.length < 2) {
    // Nothing survived to anchor to. Say so with an identity transform and an
    // honest drift of 0 rather than inventing an alignment.
    const positions = emitPositions(world, raw);
    return {
      bake_id: `bake_${raw.hash.slice(0, 16)}`,
      content_hash: raw.hash,
      algo: 'umap-pca-hybrid',
      created_at: opts.now ?? new Date().toISOString(),
      bounds: boundsOf(positions),
      positions,
      anchor_alignment: { rotation: 0, scale: 1, translate: [0, 0], mean_drift: 0 },
      corpus_provenance: CORPUS_PROVENANCE,
    };
  }

  const k = anchors.length;
  const srcX = new Float64Array(k);
  const srcY = new Float64Array(k);
  const dstX = new Float64Array(k);
  const dstY = new Float64Array(k);
  const w = new Float64Array(k);
  for (let a = 0; a < k; a++) {
    const i = anchors[a];
    srcX[a] = raw.x[i];
    srcY[a] = raw.y[i];
    dstX[a] = prevX.get(t.ids[i])!;
    dstY[a] = prevY.get(t.ids[i])!;
    // Weighting by centrality is the judgement call: a user navigates by hubs,
    // so the alignment is fitted to the hubs and the periphery is allowed to
    // move around them.
    w[a] = weightFloor + t.centrality[i];
  }
  const fit = solveSimilarity(srcX, srcY, dstX, dstY, w, k, true);

  // Fold any reflection into the geometry so the reported transform stays a
  // proper similarity (see step 4 of the block comment above).
  if (fit.mirror) for (let i = 0; i < t.n; i++) raw.y[i] = -raw.y[i];

  const cos = Math.cos(fit.rotation);
  const sin = Math.sin(fit.rotation);
  for (let i = 0; i < t.n; i++) {
    const nx = fit.scale * (cos * raw.x[i] - sin * raw.y[i]) + fit.tx;
    const ny = fit.scale * (sin * raw.x[i] + cos * raw.y[i]) + fit.ty;
    raw.x[i] = nx;
    raw.y[i] = ny;
    raw.r[i] *= fit.scale;
  }

  let drift = 0;
  for (const i of anchors) {
    drift += Math.hypot(raw.x[i] - prevX.get(t.ids[i])!, raw.y[i] - prevY.get(t.ids[i])!);
  }
  drift /= anchors.length;

  const positions = emitPositions(world, raw);
  const alignment: AnchorAlignment = {
    rotation: fit.rotation,
    scale: fit.scale,
    translate: [fit.tx, fit.ty] as Vec2,
    mean_drift: drift,
  };

  return {
    bake_id: `bake_${raw.hash.slice(0, 16)}`,
    content_hash: raw.hash,
    algo: 'umap-pca-hybrid',
    created_at: opts.now ?? new Date().toISOString(),
    bounds: boundsOf(positions),
    positions,
    anchor_alignment: alignment,
    corpus_provenance: CORPUS_PROVENANCE,
  };
}

/**
 * `mean_drift` expressed against the world's own diagonal, 0..1.
 *
 * The contract stores drift in layout units because that is the honest unit;
 * this is the number the HUD should print as a percentage, so "the map moved 3%"
 * means something to a reader who has never heard of a layout unit.
 */
export function meanDriftPercent(alignment: AnchorAlignment | null, bounds: Bounds): number {
  if (!alignment) return 0;
  const diag = Math.hypot(bounds.max_x - bounds.min_x, bounds.max_y - bounds.min_y);
  if (diag < 1e-9) return 0;
  return (alignment.mean_drift / diag) * 100;
}

/* =============================================================================
 * 12. PER-RUNG VIEWS
 * ========================================================================== */

/** The spine parent of a node, or `null` for the kinds that float above it. */
function parentOf(node: GraphNode): string | null {
  switch (node.kind) {
    case 'island':
    case 'asset':
    case 'passage':
      return node.parent_id;
    case 'continent':
    case 'entity':
    case 'source':
      return null;
  }
}

/** O(1) position lookup for a bake. Build once, keep it next to the bake. */
export function positionsById(bake: LayoutBake): Map<string, NodePosition> {
  const map = new Map<string, NodePosition>();
  for (const p of bake.positions) map.set(p.id, p);
  return map;
}

/**
 * The positioned nodes of one rung, under one parent — what a
 * `GraphViewResponse` renders.
 *
 * Pass an existing `bake`. The default argument bakes on demand purely so the
 * signature is usable in a test; doing that per view would be exactly the
 * read-path layout computation this whole file exists to forbid.
 */
export function bakeRung(
  world: World,
  rung: Rung,
  parentId: string | null = null,
  bake: LayoutBake = bakeLayout(world),
  opts: { includeEntities?: boolean } = {},
): RungLayout {
  const pos = positionsById(bake);
  const wanted: NodePosition[] = [];
  const kept = new Set<string>();

  for (const node of world.nodes) {
    if (node.kind !== rung) continue;
    if (parentId !== null && parentOf(node) !== parentId) continue;
    const p = pos.get(node.id);
    if (p) {
      wanted.push(p);
      kept.add(node.id);
    }
  }

  if (opts.includeEntities) {
    // Entities are not a rung; they are the cross-cutting layer drawn over one.
    // Include the ones that are actually mentioned in the returned scope.
    for (const node of world.nodes) {
      if (node.kind !== 'entity') continue;
      const relevant =
        node.asset_ids.some((a) => kept.has(a)) ||
        node.mentions.some((m) => kept.has(m)) ||
        node.island_ids.some((i) => kept.has(i));
      if (!relevant) continue;
      const p = pos.get(node.id);
      if (p) wanted.push(p);
    }
  }

  wanted.sort((a, b) => cmpStr(a.id, b.id));
  return { rung, parent_id: parentId, positions: wanted, bounds: boundsOf(wanted) };
}

/* =============================================================================
 * 13. BOUNDS
 * ========================================================================== */

/**
 * World bounds covering every position, radii included.
 *
 * Radii are included deliberately: the camera has to frame the DISCS, not their
 * centres, or a continent's wash gets clipped at the edge of the viewport at
 * exactly the zoom level where it matters most.
 */
export function boundsOf(positions: readonly NodePosition[], pad = 0): Bounds {
  if (positions.length === 0) return { min_x: 0, min_y: 0, max_x: 0, max_y: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of positions) {
    const r = p.r || 0;
    if (p.x - r < minX) minX = p.x - r;
    if (p.x + r > maxX) maxX = p.x + r;
    if (p.y - r < minY) minY = p.y - r;
    if (p.y + r > maxY) maxY = p.y + r;
  }
  return { min_x: minX - pad, min_y: minY - pad, max_x: maxX + pad, max_y: maxY + pad };
}

/* =============================================================================
 * 14. THE LATENT GRID (the EMPTY state)
 * -----------------------------------------------------------------------------
 * EMPTY is not an error and it is not a blank canvas — it is an invitation, and
 * the way this product extends one is by showing the SHAPE of a terrain that
 * does not exist yet: a hexagonal lattice of outline-only nodes at
 * `--latent-opacity`. Same idea as `latent` everywhere else in the resolution
 * ramp — the terrain never has holes, so before there is anything to draw, the
 * absence itself is drawn as topology.
 *
 * Deterministic, so the empty state does not shimmer between renders.
 * ========================================================================== */

/** Snap an arbitrary point onto the latent lattice. */
export function snapToLatentGrid(x: number, y: number, spacing: number): Vec2 {
  const rowH = spacing * 0.8660254037844386; // √3/2
  const row = Math.round(y / rowH);
  const offset = (row & 1) === 1 ? spacing / 2 : 0;
  const col = Math.round((x - offset) / spacing);
  return [col * spacing + offset, row * rowH] as Vec2;
}

/**
 * A deterministic hexagonal lattice of `latent` positions for the EMPTY state.
 *
 * Hex rather than square because a square grid reads as a spreadsheet and a hex
 * lattice reads as terrain — and because hex packing has no long diagonals for
 * the eye to lock onto and mistake for structure.
 */
export function gridSnapForLatent(count: number, opts: LatentGridOpts = {}): NodePosition[] {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];
  const extent = opts.extent ?? 1000;
  const bounds =
    opts.bounds ?? ({ min_x: -extent / 2, min_y: -extent / 2, max_x: extent / 2, max_y: extent / 2 } as Bounds);
  const w = Math.max(bounds.max_x - bounds.min_x, 1e-6);
  const h = Math.max(bounds.max_y - bounds.min_y, 1e-6);
  const spacing = opts.spacing ?? Math.sqrt((w * h) / n) * 0.98;
  const jitter = clamp(opts.jitter ?? 0.18, 0, 0.5);
  const seed = opts.seed ?? 'latent';
  const kind = opts.kind ?? 'asset';
  const communityId = opts.communityId ?? 'latent';

  const rowH = spacing * 0.8660254037844386;
  const cols = Math.max(1, Math.floor(w / spacing));
  const out: NodePosition[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const offset = (row & 1) === 1 ? spacing / 2 : 0;
    const jx = (hash01(`${seed}|jx|${i}`) * 2 - 1) * jitter * spacing;
    const jy = (hash01(`${seed}|jy|${i}`) * 2 - 1) * jitter * rowH;
    out.push({
      id: `${seed}:${i}`,
      x: bounds.min_x + col * spacing + offset + spacing / 2 + jx,
      y: bounds.min_y + row * rowH + rowH / 2 + jy,
      r: spacing * 0.18,
      community_id: communityId,
      kind,
      lod_hint: 'latent',
    });
  }
  return out;
}

/* =============================================================================
 * 15. SPATIAL INDEX
 * -----------------------------------------------------------------------------
 * Hover picking at 10⁵ nodes has to be free. Everything here is typed arrays and
 * bucket arithmetic; there is no code path that touches every node.
 * ========================================================================== */

/**
 * Build a uniform-grid index over baked positions.
 *
 * @param targetPerCell tuning only — cells are sized so the average occupancy is
 *        about this. Default 2, which keeps the neighbour scan to a handful of
 *        candidates without exploding the cell count on sparse margins.
 */
export function buildSpatialIndex(
  positions: readonly NodePosition[],
  opts: { targetPerCell?: number } = {},
): SpatialIndex {
  const count = positions.length;
  const ids: string[] = new Array(count);
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  const rs = new Float32Array(count);
  let maxRadius = 0;
  for (let i = 0; i < count; i++) {
    const p = positions[i];
    ids[i] = p.id;
    xs[i] = p.x;
    ys[i] = p.y;
    rs[i] = p.r;
    if (p.r > maxRadius) maxRadius = p.r;
  }

  const bounds = boundsOf(positions);
  if (count === 0) {
    return {
      count: 0,
      bounds,
      cellSize: 1,
      cols: 1,
      rows: 1,
      ids,
      xs,
      ys,
      rs,
      cellStart: new Int32Array(2),
      cellItems: new Int32Array(0),
      maxRadius: 0,
      hitLevels: 1,
      hitBase: 1,
      hitCols: Int32Array.of(1),
      hitRows: Int32Array.of(1),
      hitStart: [new Int32Array(2)],
      hitItems: [new Int32Array(0)],
    };
  }

  const w = Math.max(bounds.max_x - bounds.min_x, 1e-6);
  const h = Math.max(bounds.max_y - bounds.min_y, 1e-6);
  const target = Math.max(1, opts.targetPerCell ?? 2);
  const cellSize = Math.max(Math.sqrt((w * h * target) / count), 1e-6);
  const cols = Math.max(1, Math.min(8192, Math.ceil(w / cellSize)));
  const rows = Math.max(1, Math.min(8192, Math.ceil(h / cellSize)));
  const cells = cols * rows;

  const counts = new Int32Array(cells + 1);
  const cellOf = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const gx = Math.min(cols - 1, Math.max(0, Math.floor(((xs[i] - bounds.min_x) / w) * cols)));
    const gy = Math.min(rows - 1, Math.max(0, Math.floor(((ys[i] - bounds.min_y) / h) * rows)));
    const c = gy * cols + gx;
    cellOf[i] = c;
    counts[c]++;
  }
  const cellStart = new Int32Array(cells + 1);
  let acc = 0;
  for (let c = 0; c < cells; c++) {
    cellStart[c] = acc;
    acc += counts[c];
  }
  cellStart[cells] = acc;
  const cursor = cellStart.slice(0, cells);
  const cellItems = new Int32Array(count);
  for (let i = 0; i < count; i++) cellItems[cursor[cellOf[i]]++] = i;

  /* --- the hierarchical hit structure (see `hitLevels`) -------------------- */
  const hitBase = Math.max(w / cols, h / rows, 1e-6);
  let hitLevels = 1;
  while (Math.ceil(w / (hitBase * 2 ** (hitLevels - 1))) > 1 || Math.ceil(h / (hitBase * 2 ** (hitLevels - 1))) > 1) {
    hitLevels++;
    if (hitLevels > 40) break;
  }
  const hitCols = new Int32Array(hitLevels);
  const hitRows = new Int32Array(hitLevels);
  for (let L = 0; L < hitLevels; L++) {
    const cs = hitBase * 2 ** L;
    hitCols[L] = Math.max(1, Math.ceil(w / cs));
    hitRows[L] = Math.max(1, Math.ceil(h / cs));
  }

  // Level of an item: the smallest whose cell fits the item's whole diameter, so
  // the item lands in at most 2×2 cells of that level.
  const levelOf = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const d = Math.max(2 * rs[i], hitBase);
    let L = Math.ceil(Math.log2(d / hitBase));
    if (!Number.isFinite(L) || L < 0) L = 0;
    if (L >= hitLevels) L = hitLevels - 1;
    levelOf[i] = L;
  }

  const hitStart: Int32Array[] = [];
  const hitItems: Int32Array[] = [];
  for (let L = 0; L < hitLevels; L++) {
    const cs = hitBase * 2 ** L;
    const lc = hitCols[L];
    const lr = hitRows[L];
    const lcells = lc * lr;
    const counts = new Int32Array(lcells + 1);
    for (let i = 0; i < count; i++) {
      if (levelOf[i] !== L) continue;
      const gx0 = Math.min(lc - 1, Math.max(0, Math.floor((xs[i] - rs[i] - bounds.min_x) / cs)));
      const gx1 = Math.min(lc - 1, Math.max(0, Math.floor((xs[i] + rs[i] - bounds.min_x) / cs)));
      const gy0 = Math.min(lr - 1, Math.max(0, Math.floor((ys[i] - rs[i] - bounds.min_y) / cs)));
      const gy1 = Math.min(lr - 1, Math.max(0, Math.floor((ys[i] + rs[i] - bounds.min_y) / cs)));
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) counts[gy * lc + gx]++;
    }
    const start = new Int32Array(lcells + 1);
    let a = 0;
    for (let c = 0; c < lcells; c++) {
      start[c] = a;
      a += counts[c];
    }
    start[lcells] = a;
    const cur = start.slice(0, lcells);
    const items = new Int32Array(a);
    for (let i = 0; i < count; i++) {
      if (levelOf[i] !== L) continue;
      const gx0 = Math.min(lc - 1, Math.max(0, Math.floor((xs[i] - rs[i] - bounds.min_x) / cs)));
      const gx1 = Math.min(lc - 1, Math.max(0, Math.floor((xs[i] + rs[i] - bounds.min_x) / cs)));
      const gy0 = Math.min(lr - 1, Math.max(0, Math.floor((ys[i] - rs[i] - bounds.min_y) / cs)));
      const gy1 = Math.min(lr - 1, Math.max(0, Math.floor((ys[i] + rs[i] - bounds.min_y) / cs)));
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) items[cur[gy * lc + gx]++] = i;
    }
    hitStart.push(start);
    hitItems.push(items);
  }

  return {
    count,
    bounds,
    cellSize: hitBase,
    cols,
    rows,
    ids,
    xs,
    ys,
    rs,
    cellStart,
    cellItems,
    maxRadius,
    hitLevels,
    hitBase,
    hitCols,
    hitRows,
    hitStart,
    hitItems,
  };
}

function colOf(index: SpatialIndex, x: number): number {
  const w = Math.max(index.bounds.max_x - index.bounds.min_x, 1e-6);
  return Math.min(index.cols - 1, Math.max(0, Math.floor(((x - index.bounds.min_x) / w) * index.cols)));
}

function rowOf(index: SpatialIndex, y: number): number {
  const h = Math.max(index.bounds.max_y - index.bounds.min_y, 1e-6);
  return Math.min(index.rows - 1, Math.max(0, Math.floor(((y - index.bounds.min_y) / h) * index.rows)));
}

/**
 * Indices of every position whose CENTRE lies within `radius` of (x, y).
 * Expected O(1) — it visits only the cells the disc actually overlaps.
 * Pass `out` to reuse an array on a hot path.
 */
export function queryRadius(
  index: SpatialIndex,
  x: number,
  y: number,
  radius: number,
  out: number[] = [],
): number[] {
  out.length = 0;
  if (index.count === 0 || radius < 0) return out;
  const c0 = colOf(index, x - radius);
  const c1 = colOf(index, x + radius);
  const r0 = rowOf(index, y - radius);
  const r1 = rowOf(index, y + radius);
  const r2 = radius * radius;
  for (let gy = r0; gy <= r1; gy++) {
    const rowBase = gy * index.cols;
    for (let gx = c0; gx <= c1; gx++) {
      const c = rowBase + gx;
      for (let k = index.cellStart[c]; k < index.cellStart[c + 1]; k++) {
        const i = index.cellItems[k];
        const dx = index.xs[i] - x;
        const dy = index.ys[i] - y;
        if (dx * dx + dy * dy <= r2) out.push(i);
      }
    }
  }
  return out;
}

/** Indices of every position whose centre lies inside `rect`. Expected O(k). */
export function queryRect(index: SpatialIndex, rect: Bounds, out: number[] = []): number[] {
  out.length = 0;
  if (index.count === 0) return out;
  const c0 = colOf(index, rect.min_x);
  const c1 = colOf(index, rect.max_x);
  const r0 = rowOf(index, rect.min_y);
  const r1 = rowOf(index, rect.max_y);
  for (let gy = r0; gy <= r1; gy++) {
    const rowBase = gy * index.cols;
    for (let gx = c0; gx <= c1; gx++) {
      const c = rowBase + gx;
      for (let k = index.cellStart[c]; k < index.cellStart[c + 1]; k++) {
        const i = index.cellItems[k];
        const px = index.xs[i];
        const py = index.ys[i];
        if (px >= rect.min_x && px <= rect.max_x && py >= rect.min_y && py <= rect.max_y) out.push(i);
      }
    }
  }
  return out;
}

/**
 * Hover pick: the index of the MOST SPECIFIC node whose disc (plus `slop`)
 * contains (x, y), or -1.
 *
 * Most specific, not nearest: a passage inside an asset inside an island inside
 * a continent means four discs contain the pointer, and the one the user is
 * pointing AT is the smallest. Ties break on distance to centre.
 *
 * `slop` is where `--hit-slop-node` belongs — the density-scaled forgiveness
 * that makes the terrain usable with a thumb.
 */
export function pickAt(index: SpatialIndex, x: number, y: number, slop = 0): number {
  if (index.count === 0) return -1;
  const xs = index.xs;
  const ys = index.ys;
  const rs = index.rs;
  let best = -1;
  let bestR = Infinity;
  let bestD2 = Infinity;

  // Every disc is registered in the cells it covers AT ITS OWN LEVEL, so the
  // only cell that can hold a hit is the one containing the pointer — widened by
  // `slop`, which is the sole reason to look at a neighbour.
  const bx = index.bounds.min_x;
  const by = index.bounds.min_y;
  for (let L = 0; L < index.hitLevels; L++) {
    const cs = index.hitBase * 2 ** L;
    const lc = index.hitCols[L];
    const lr = index.hitRows[L];
    const start = index.hitStart[L];
    const items = index.hitItems[L];
    const gx0 = Math.min(lc - 1, Math.max(0, Math.floor((x - slop - bx) / cs)));
    const gx1 = Math.min(lc - 1, Math.max(0, Math.floor((x + slop - bx) / cs)));
    const gy0 = Math.min(lr - 1, Math.max(0, Math.floor((y - slop - by) / cs)));
    const gy1 = Math.min(lr - 1, Math.max(0, Math.floor((y + slop - by) / cs)));
    for (let gy = gy0; gy <= gy1; gy++) {
      const rowBase = gy * lc;
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = rowBase + gx;
        const end = start[c + 1];
        for (let k = start[c]; k < end; k++) {
          const i = items[k];
          const dx = xs[i] - x;
          const dy = ys[i] - y;
          const d2 = dx * dx + dy * dy;
          const hit = rs[i] + slop;
          if (d2 > hit * hit) continue;
          if (rs[i] < bestR || (rs[i] === bestR && d2 < bestD2)) {
            bestR = rs[i];
            bestD2 = d2;
            best = i;
          }
        }
      }
    }
  }
  return best;
}
