/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE TERRAIN
 * =============================================================================
 *
 * A top-down 2D knowledge terrain on an orthographic camera. Four layers, four
 * draw calls, one continuous camera:
 *
 *   0  the community WASH  — the land: a density field with soft coasts, straits
 *                            between the masses, and open void where there is no
 *                            data at all.
 *   1  EDGES               — earned, never all-on. Bundled corridors at the
 *                            region rungs, real relations below them, and the
 *                            answer constellation over the top.
 *   2  POINTS              — every node in the bake, always, at its admitted
 *                            resolution. One instanced draw.
 *   3  LABELS              — DOM, altitude-gated, centrality-ranked, collision-
 *                            culled, hard-capped. Zero WebGL draw calls.
 *
 * -----------------------------------------------------------------------------
 * THE THREE STRUCTURAL DEFENCES AGAINST THE HAIRBALL
 * -----------------------------------------------------------------------------
 * 1. EDGES ARE EARNED, AND THE RENDERER SPENDS LESS THAN IT IS GIVEN. The engine
 *    chooses a drawable CANDIDATE subset and says which rule it used
 *    (`stats.drawn_reason`). This renderer never strokes an edge the payload did
 *    not ship — and it does not stroke every edge the payload did ship either.
 *    A skeleton that draws 254 of its 262 candidates is not a skeleton, it is
 *    the hairball with extra steps: long straight chords crossing the middle of
 *    the map in every direction. So each rung has a STROKE BUDGET
 *    (`--edge-budget-*`), the heaviest candidates win it, and the survivors are
 *    bundled hard enough to share trunk channels. What is left reads as trade
 *    routes between regions, which is the only honest picture at an altitude
 *    where the nodes are places rather than claims.
 * 2. POSITION IS BAKED. Every coordinate here comes from `LayoutBake`. There is
 *    no force tick, no settling loop, and nothing in this file moves a node.
 *    A map that moves while you read it is a lava lamp.
 * 3. LABELS ARE GATED AND RANKED. See `@/graph/labels.ts`.
 *
 * -----------------------------------------------------------------------------
 * RENDER ON DEMAND
 * -----------------------------------------------------------------------------
 * There is no idle animation in this product, so there is no reason to burn a
 * frame drawing an identical picture. The loop schedules a frame when something
 * actually changed — a camera flight, a ramp crossfade, an unbundling, a
 * provenance ping, a hover, a resize — and STOPS when everything has settled. It
 * also stops entirely while `document.hidden`. A terrain sitting still costs
 * zero GPU and zero battery, which is what an instrument at rest should cost.
 * ========================================================================== */

import * as THREE from 'three';

import { EdgeLayer, EDGE_FLAG, SIGMA_CODE, type RouteSpec } from '@/graph/edges';
import { LabelLayer, glyphForKind, type LabelCandidate } from '@/graph/labels';
import { NODE_FLAG, PointLayer } from '@/graph/points';
import { PickIndex } from '@/graph/picking';
import { RegionLayer, buildRegionField, type RegionField } from '@/graph/regions';
import { TerrainCameraImpl, type TerrainCamera } from '@/graph/camera';
import { bundleRoutes, type BundledRoute } from '@/graph/bundles';
import { LOD_INDEX, readPalette, type Palette } from '@/graph/palette';
import { RUNG_DEPTH, RUNG_GLYPH } from '@/engine';
import type {
  DrawnReason,
  Edge,
  GraphNode,
  GraphViewResponse,
  LayoutBake,
  LodState,
  NodePosition,
  PathStep,
  Rung,
  SigmaClass,
  Vec2,
} from '@/engine';

/* =============================================================================
 * PUBLIC SHAPES
 * ========================================================================== */

/** What the renderer measured last frame. Every field is a real count. */
export interface FrameStats {
  fps: number;
  frameMs: number;
  points: number;
  edges: number;
  drawCalls: number;
  labels: number;
}

export interface TerrainOpts {
  /** Device pixel ratio cap. Default 2 — beyond that the fill rate buys nothing. */
  maxDpr?: number;
  /** Ceiling on labels on screen. Default `--label-max`. */
  maxLabels?: number;
  /**
   * Fly the camera to frame the new rung when the scene's parent changes.
   * Default true: descending a rung is a place change and the travel is what
   * keeps the user oriented. Set false when the shell drives the camera itself.
   */
  autoFrame?: boolean;
}

export interface SceneInput {
  view: GraphViewResponse;
  bake: LayoutBake;
  rung: Rung;
  parentId: string | null;
}

export interface ConstellationInput {
  node_ids: string[];
  path: PathStep[];
  bridge_entity_id: string | null;
}

export interface Terrain {
  setScene(input: SceneInput): void;
  setLod(lod: Record<string, LodState>): void;
  setHover(id: string | null): void;
  setSelection(ids: string[]): void;
  setConstellation(c: ConstellationInput | null): void;
  setFilters(f: { sigma: SigmaClass[]; showQuarantined: boolean }): void;
  setEdgePolicy(reason: DrawnReason | null): void;
  setDimmed(dimmed: boolean): void;
  camera: TerrainCamera;
  pick(clientX: number, clientY: number): string | null;
  pickRect(a: Vec2, b: Vec2): string[];
  labels: { setDensity(n: number): void };
  tracePing(fromId: string, toId: string, delayMs?: number): Promise<void>;
  settleIngest(ids: string[]): Promise<void>;
  onFrame(cb: (stats: FrameStats) => void): () => void;
  perf(): FrameStats;
  resize(): void;
  dispose(): void;
}

/* =============================================================================
 * THE RESOLUTION POLICY
 * -----------------------------------------------------------------------------
 * The store's `lod` map is authoritative wherever it has an opinion. These are
 * the defaults for everything else, and they exist so the terrain is correctly
 * ramped on the very first frame after a bake rather than flashing at full
 * resolution and then dimming.
 *
 * Distances are measured on the containment spine. Entities and sources are not
 * rungs, so they sit at fractional depths — an entity is a hair below the asset
 * that is its extraction context, which is exactly where it belongs on the ramp.
 * ========================================================================== */
const KIND_DEPTH: Readonly<Record<string, number>> = {
  continent: 0,
  island: 1,
  asset: 2,
  entity: 2.4,
  passage: 3,
  source: 3.4,
};

function ambientLod(kindDepth: number, rungDepth: number): LodState {
  const delta = kindDepth - rungDepth;
  // Above you on the spine: the context you descended through, kept legible.
  if (delta < 0) return 'lod-2';
  // Your own rung elsewhere, and the rung just below: present as ghosts.
  if (delta <= 1) return 'ghost';
  // Everything further down is topology. Visible, unspent, never a hole.
  return 'latent';
}

/** Sharpest wins. A rule may RAISE a node's resolution, never quietly lower it. */
function sharper(a: LodState, b: LodState): LodState {
  return LOD_INDEX[a] <= LOD_INDEX[b] ? a : b;
}

/* =============================================================================
 * THE TERRAIN
 * ========================================================================== */

class TerrainImpl implements Terrain {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly threeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  private palette: Palette;
  private readonly shared: Record<string, THREE.IUniform>;

  private readonly regions: RegionLayer;
  private readonly edges: EdgeLayer;
  private readonly points: PointLayer;
  private readonly labelLayer: LabelLayer;
  private readonly picker = new PickIndex();
  private readonly cameraImpl: TerrainCameraImpl;

  private bake: LayoutBake | null = null;
  private positionById = new Map<string, NodePosition>();
  private view: GraphViewResponse | null = null;
  private rung: Rung = 'continent';
  private parentId: string | null = null;
  private inView = new Set<string>();

  private lodOverride: Record<string, LodState> = {};
  private hover: string | null = null;
  private selection = new Set<string>();
  private constellation: ConstellationInput | null = null;
  private constellationNodes = new Set<string>();
  /** Path endpoints + the bridge. The part of a constellation that is the answer. */
  private pathCore = new Set<string>();
  /** The terminal of the answer path — what the question asked to be named. */
  private answerNode: string | null = null;
  private filters: { sigma: SigmaClass[]; showQuarantined: boolean } = {
    sigma: [],
    showQuarantined: true,
  };
  private edgePolicy: DrawnReason | null = null;

  /**
   * FOG OF WAR HAS TWO SOURCES AND THEY ARE OR'd.
   *
   * `dimExplicit` is the shell saying "a query is in flight". `dimRendered` is
   * the terrain's own conclusion that an answer is on screen. The second one has
   * to exist here: the shell drops its dim the moment the render RESOLVES, which
   * is the exact frame the fog is supposed to arrive. Without it, 'home' and
   * 'receipt' are the same luminance and "render, don't retrieve" is a caption
   * over an unchanged picture.
   */
  private dimExplicit = false;
  private dimRendered = false;
  private dimTarget = 0;
  private dimCurrent = 0;
  private dimStart = 0;

  /** Keys the constellation was last framed for. A re-set must not re-fly. */
  private framedConstellation = '';

  private settleRank: Float32Array = new Float32Array(0);
  private settleActive = false;
  private settleStart = 0;
  private settleDuration = 0;
  private settleResolve: (() => void) | null = null;

  private routeCache = new Map<string, BundledRoute[]>();
  /** The density field, kept so corridors can be routed through the water. */
  private regionField: RegionField | null = null;
  /** Which document the reading spine is currently laid out for. `''` = none. */
  private spineKey = '';
  /** The reading axis of the current document, in world units. `null` off-rung. */
  private spineAxis: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** The regions the rendered answer stands on. Empty at rest. */
  private landfall: { id: string; x: number; y: number; r: number }[] = [];

  private rafId = 0;
  private dirty = true;
  private lastCameraVersion = -1;
  private lastFrameAt = 0;
  private stats: FrameStats = { fps: 0, frameMs: 0, points: 0, edges: 0, drawCalls: 0, labels: 0 };
  private frameSubs = new Set<(s: FrameStats) => void>();
  private disposed = false;

  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;

  private readonly geometryTokens: GeometryTokens;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: TerrainOpts,
  ) {
    this.palette = readPalette();
    this.geometryTokens = readGeometryTokens();

    // A fully manual sRGB pipeline. See `@/graph/palette.ts` for why: the
    // terrain has to composite the way the DOM composites, or one token
    // produces two colours a pixel apart.
    THREE.ColorManagement.enabled = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // the visual-QA pass screenshots this canvas
    });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = true;
    const v = this.palette.srgb.void;
    this.renderer.setClearColor(new THREE.Color(v[0], v[1], v[2]), 1);

    this.shared = {
      uCam: { value: new THREE.Vector3(0, 0, 1) },
      uViewport: { value: new THREE.Vector2(1, 1) },
      uDpr: { value: 1 },
      uDim: { value: 0 },
    };

    this.regions = new RegionLayer(this.palette, this.shared);
    this.edges = new EdgeLayer(this.palette, this.shared);
    this.points = new PointLayer(this.palette, this.shared);

    const tk = this.geometryTokens;
    this.regions.setCoast(tk.coastOuter, tk.coastInner);
    this.regions.setGrain(tk.grain);
    this.regions.setResolution(tk.coastPx, tk.texelMaxPx, tk.texelFade);
    this.regions.setMerge(tk.mergeLift, tk.seam);
    this.regions.setOutOfScope(tk.outOfScope);
    this.regions.setFog(tk.fogSea, tk.fogCoast, tk.fogLandfall);
    this.edges.setDashPx(tk.dash);
    this.edges.setFog(tk.fogEdge);
    this.edges.setTrimPx(tk.trim);
    this.edges.setHorizonPx(tk.horizon);
    this.points.setFog(tk.fogDemote);
    this.points.setGeometryTokens(
      tk.dotMin,
      tk.dotMax,
      tk.capital,
      tk.bodyMin,
      tk.bodyMax,
      tk.answerDot,
      tk.pathDot,
    );

    this.scene.add(this.regions.mesh);
    this.scene.add(this.edges.mesh);
    this.scene.add(this.points.mesh);

    const host = canvas.parentElement ?? canvas.ownerDocument.body;
    this.labelLayer = new LabelLayer(host, this.palette, {
      max: opts.maxLabels ?? this.geometryTokens.labelMax,
      cell: this.geometryTokens.labelCell,
      offset: this.geometryTokens.labelOffset,
      maxWidth: this.geometryTokens.labelMaxWidth,
      answerMark: this.geometryTokens.answerDot,
      pathMark: this.geometryTokens.pathDot,
    });

    this.cameraImpl = new TerrainCameraImpl(
      (id) => this.positionById.get(id),
      this.palette,
    );
    // The camera can start a flight from anywhere — a keyboard shortcut, a
    // breadcrumb, the scene hook. It has to be able to wake the loop that ticks
    // it, or the promise it hands back is never settled by anybody.
    this.cameraImpl.setWake(() => this.invalidate());

    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
  }

  get camera(): TerrainCamera {
    return this.cameraImpl;
  }

  get labels(): { setDensity(n: number): void } {
    return { setDensity: (n: number) => this.labelLayer.setDensity(n) };
  }

  /* -------------------------------------------------------------------------
   * SCENE
   * ---------------------------------------------------------------------- */

  setScene(input: SceneInput): void {
    const bakeChanged = this.bake === null || this.bake.bake_id !== input.bake.bake_id;
    const placeChanged = this.rung !== input.rung || this.parentId !== input.parentId;
    const first = this.bake === null;

    this.bake = input.bake;
    this.view = input.view;
    this.rung = input.rung;
    this.parentId = input.parentId;

    if (bakeChanged) {
      this.regionField = buildRegionField(input.bake.positions, input.bake.bounds, this.palette, {
        merge: this.geometryTokens.merge,
        cut: this.geometryTokens.shelfCut,
        lift: this.geometryTokens.mergeLift,
        sea: this.geometryTokens.coastOuter,
      });
      this.regions.setField(this.regionField);
      this.cameraImpl.setWorldBounds(input.bake.bounds);
      this.routeCache.clear();
    }

    /* THE PROJECTION IS A PROPERTY OF THE RUNG, and the passage rung has one of
     * its own. See `readingSpine`. Everywhere else this is the identity and the
     * baked coordinates are used verbatim. */
    const spineKey = spineKeyOf(input);
    if (bakeChanged || spineKey !== this.spineKey) {
      this.spineKey = spineKey;
      this.spineAxis = null;
      const positions = spineKey === '' ? input.bake.positions : this.readingSpine(input);
      this.positionById = new Map();
      for (const p of positions) this.positionById.set(p.id, p);
      this.points.setPositions(positions);
      this.routeCache.clear();
    }

    this.inView = new Set(input.view.nodes.map((n) => n.id));

    // Pickable = what this altitude can actually address.
    const pickable: NodePosition[] = [];
    for (const node of input.view.nodes) {
      const p = this.positionById.get(node.id);
      if (p !== undefined) pickable.push(p);
    }
    this.picker.rebuild(pickable);

    this.rebuildLabels(input.view);
    this.rebuildEdges();
    this.applyLod(bakeChanged);
    this.applyFlags();

    /* THE RUNGS BELOW THIS ONE PULL BACK, HARDER THE HIGHER YOU STAND.
     *
     * The whole bake is always resident — that is what makes `latent` honest.
     * But from the continent rung the 2,207 passages of the world are TEXTURE,
     * and from the passage rung they are the subject. Drawing them at one weight
     * from every altitude is what made 'atlas-continent' and 'atlas-island' the
     * same photograph with different labels. */
    this.points.setRecede(1 - RUNG_DEPTH[input.rung] * 0.26);

    // The peer set for body size is THIS RUNG'S bodies. See `setBodyNorm`.
    let bodyNorm = 0;
    for (const node of input.view.nodes) {
      if (node.kind !== input.rung) continue;
      const p = this.positionById.get(node.id);
      if (p !== undefined) bodyNorm = Math.max(bodyNorm, p.r);
    }
    this.points.setBodyNorm(bodyNorm > 0 ? bodyNorm : 1);

    /* "YOU ARE HERE" IS THE UNION OF THE RUNG'S OWN BODIES, not one disc around
     * the parent. A continent's containment radius covers two-thirds of the
     * terrain, so boosting inside it boosted almost everything and the descent
     * had no locus at all. The five islands you descended into are small, exact
     * and exactly where you are. */
    this.regions.setFocusRegions(this.scopeRegions(input));

    if ((this.opts.autoFrame ?? true) && (first || placeChanged || bakeChanged)) {
      /* COMPOSE THE EMPTINESS. Fitting the whole view at the passage rung was
       * fitting five spans PLUS every entity they mention — and one of those
       * mentions is a bridge entity four hundred and seventy world units away,
       * so the frame that was supposed to be about one document was a void with
       * five specks in the middle of it and long wires leaving in all
       * directions. A rung with five things to show frames the five things and
       * the boundary they sit in; what they point at leaves over the horizon,
       * which is the honest picture of a mention that lives somewhere else. */
      if (this.spineKey !== '' && input.parentId !== null) {
        // The document, whole, boundary included. `discs: true` is the only
        // place in the product that frames a containment radius rather than a
        // set of positions — see `FitFrame.discs`.
        void this.cameraImpl.fitTo([input.parentId], 88, undefined, { discs: true });
      } else {
        const ids = input.view.nodes.map((n) => n.id);
        void this.cameraImpl.fitTo(ids.length > 0 ? ids : [...this.positionById.keys()], 72);
      }
    }

    this.invalidate();
  }

  /**
   * ===========================================================================
   * THE READING SPINE — the passage rung's own projection
   * ===========================================================================
   *
   * THE RUNG'S LEGEND SAYS "spans inside one document, IN READING ORDER". The
   * bake cannot say that. It packs a document's passages into a golden-angle
   * disc around their asset, which is the right answer for keeping a molecule
   * compact inside its island and is a scatter with no order in it once the
   * molecule is the entire screen — span 4 top, span 1 right, span 2 centre,
   * span 5 left, span 3 bottom, while the rail beside it prints 264–949,
   * 951–1572, 1574–2435, 2437–3130, 3132–3504. The map contradicted the rail,
   * and the legend contradicted them both.
   *
   * So at the passage rung, and ONLY there, the spans are laid out on the axis
   * they actually have: the document's own byte order. Position along the axis
   * is `(char_start + char_end) / 2` normalised over the document's full extent,
   * so span 1 precedes span 2 precedes span 3 by construction, the gaps between
   * spans are the gaps in the source, and the mark sizes are the span lengths.
   * Nothing is invented — every coordinate is a linear function of two integers
   * the payload ships.
   *
   * THIS IS NOT A LAYOUT ON A READ PATH. There is no force, no tick, no
   * convergence and no state: the same document always produces the same axis,
   * and the axis is recomputed only when you descend into a different document.
   * It is a PROJECTION, and which projection is honest is a property of the rung
   * — the same reason the region rungs draw corridors and this one draws spans.
   * Zoom changes meaning, not scale.
   *
   * The axis is inscribed in the document's own containment radius, so the
   * boundary the asset declared encloses its spans on screen exactly as it
   * encloses them in the bake.
   */
  private readingSpine(input: SceneInput): NodePosition[] {
    const out = input.bake.positions.slice();
    const parentId = input.parentId;
    if (parentId === null) return out;
    const parent = out.find((p) => p.id === parentId);
    if (parent === undefined) return out;

    // The spans of THIS document that the payload actually admitted.
    const spans: { start: number; end: number; seq: number; index: number }[] = [];
    const indexById = new Map<string, number>();
    for (let i = 0; i < out.length; i++) indexById.set(out[i].id, i);
    for (const node of input.view.nodes) {
      if (node.kind !== 'passage' || node.parent_id !== parentId) continue;
      const index = indexById.get(node.id);
      if (index === undefined) continue;
      spans.push({ start: node.char_start, end: node.char_end, seq: node.seq, index });
    }
    if (spans.length === 0) return out;
    spans.sort((a, b) => a.start - b.start || a.seq - b.seq);

    // The document's extent, in characters. Real offsets, not ordinals: a long
    // span occupies more of the axis than a short one, and the gap between
    // 949 and 951 is a gap on the axis too.
    let lo = Infinity;
    let hi = -Infinity;
    let widest = 1;
    for (const s of spans) {
      lo = Math.min(lo, s.start);
      hi = Math.max(hi, s.end);
      widest = Math.max(widest, s.end - s.start);
    }
    const extent = Math.max(1, hi - lo);

    const half = parent.r * this.geometryTokens.spineSpan;
    this.spineAxis = {
      x0: parent.x - half,
      y0: parent.y,
      x1: parent.x + half,
      y1: parent.y,
    };

    for (const s of spans) {
      const t = ((s.start + s.end) / 2 - lo) / extent;
      const p = out[s.index];
      out[s.index] = {
        ...p,
        x: parent.x + (t - 0.5) * 2 * half,
        y: parent.y,
        // The mark carries the SPAN LENGTH, which is the same fact the rail
        // prints as a token count. One fact, stated once, in two places.
        r: Math.max(parent.r * 0.06, (parent.r * 0.18 * (s.end - s.start)) / widest),
      };
    }
    return out;
  }

  /**
   * The discs that are IN SCOPE at this scene — the bodies of the current rung.
   *
   * `[]` at the top of the world, where everything is in scope by definition and
   * a "you are here" mask would be a claim about nothing.
   */
  private scopeRegions(input: SceneInput): { x: number; y: number; r: number }[] {
    if (input.parentId === null) return [];
    const out: { x: number; y: number; r: number }[] = [];
    for (const node of input.view.nodes) {
      if (node.kind !== input.rung) continue;
      const p = this.positionById.get(node.id);
      if (p === undefined) continue;
      out.push({ x: p.x, y: p.y, r: p.r });
    }
    if (out.length > 0) return out;
    const parent = this.positionById.get(input.parentId);
    return parent === undefined ? [] : [{ x: parent.x, y: parent.y, r: parent.r }];
  }

  setLod(lod: Record<string, LodState>): void {
    this.lodOverride = lod;
    this.applyLod(false);
    this.invalidate();
  }

  setHover(id: string | null): void {
    if (this.hover === id) return;
    this.hover = id;
    this.applyFlags();
    this.invalidate();
  }

  setSelection(ids: string[]): void {
    this.selection = new Set(ids);
    this.applyFlags();
    this.applyLod(false);
    this.invalidate();
  }

  /**
   * An answer arrived. THIS IS THE RENDER EVENT, and three things depend on it.
   *
   * 1. FOG. The sea, the peripheral nodes and their relations drop to
   *    `--fog-*`. Nothing is hidden; the constellation simply becomes the
   *    brightest thing on screen, which is the only way "the engine chose where
   *    to spend" is a claim the picture makes rather than one the rail asserts.
   * 2. THE CAMERA. A render that leaves the frame identical is a decal on
   *    wallpaper. The camera eases to the answer path plus its context so the
   *    reframing IS the arrival — and the flight lands the bridge entity near
   *    the optical centre, not in the rail's occlusion zone.
   * 3. RANK. The answer terminal, the bridge and the path endpoints are the
   *    marks and the names that win; the other 22 constellation members are
   *    context and stop competing for the same corner of the map.
   */
  setConstellation(c: ConstellationInput | null): void {
    this.constellation = c;
    this.constellationNodes = new Set(c?.node_ids ?? []);
    if (c?.bridge_entity_id) this.constellationNodes.add(c.bridge_entity_id);
    this.pathCore = corePathNodes(c);
    this.answerNode = answerNodeOf(c);
    this.labelLayer.setRank(this.pathCore, this.answerNode, this.geometryTokens.labelConstellationMax);

    this.dimRendered = c !== null && this.constellationNodes.size > 0;
    /* WHICH GROUND THE ANSWER STANDS ON. Under fog these regions keep their fill
     * while the rest of the world becomes a coastline drawing, and they are
     * NAMED, so the frame answers "which islands does this span" and "what did
     * it cross" without a caption — which is the entire argument of a bridge
     * question and the one thing the flagship frame was not saying. */
    this.landfall = this.dimRendered ? this.landfallRegions() : [];
    this.regions.setLandfall(this.landfall);
    this.labelLayer.setLandfall(this.landfall.map((r) => r.id));
    this.retargetDim();

    this.rebuildEdges();
    this.applyFlags();
    this.applyLod(false);

    /* THE FRAMING RULE, SET ONCE, OBEYED BY EVERY CALLER.
     *
     * The shell frames a selection that arrives as a set, and the selection that
     * arrives with an answer IS the answer path — so two modules were calling
     * `fitTo` with the same three ids a few milliseconds apart and the later one
     * decided the picture. Putting the rule on the camera instead of at one call
     * site means both produce the same frame: room around the path so the
     * coastlines it crosses are in shot, and a right gutter so the answer never
     * lands under the rail that names it. */
    this.cameraImpl.setDefaultFrame(
      this.dimRendered ? { scale: 2.1, right: 32, bottom: 104 } : null,
    );

    const key = c === null ? '' : [...this.constellationNodes].sort().join(',');
    if (key !== this.framedConstellation) {
      this.framedConstellation = key;
      if (key !== '') this.frameConstellation(c as ConstellationInput);
    }
    this.invalidate();
  }

  /**
   * THE REGIONS THE ANSWER PATH ACTUALLY STANDS ON.
   *
   * Derived, never guessed: an entity on the path carries `island_ids` — the
   * islands its mentions fall in — and that is exactly the claim "this answer
   * spans two islands" is made of. A bridge entity contributes both banks of the
   * strait by construction, which is why the crossing becomes visible AS a
   * crossing rather than as a line over an even wash.
   *
   * Ordered by how much of the path each region carries, so when there are more
   * than the mask can hold the ones that survive are the ones the answer is
   * mostly standing on.
   */
  private landfallRegions(): { id: string; x: number; y: number; r: number }[] {
    const view = this.view;
    if (view === null) return [];
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    const weight = new Map<string, number>();
    const bump = (id: string, w: number): void => {
      weight.set(id, (weight.get(id) ?? 0) + w);
    };

    for (const id of this.pathCore) {
      const node = byId.get(id);
      if (node === undefined) continue;
      if (node.kind === 'entity') {
        for (const islandId of node.island_ids) bump(islandId, 1);
      } else if (node.kind === 'island' || node.kind === 'continent') {
        bump(node.id, 2);
      } else if (node.kind === 'asset' || node.kind === 'passage') {
        if (node.parent_id !== null) bump(node.parent_id, 1);
      }
    }

    return [...weight.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([id]) => this.positionById.get(id))
      .filter((p): p is NodePosition => p !== undefined)
      .map((p) => ({ id: p.id, x: p.x, y: p.y, r: p.r }));
  }

  /**
   * Fly to the answer.
   *
   * Framed on the PATH plus the bridge — not on all 26 constellation members,
   * because the members are entities and entities are spread across the world by
   * construction. Fitting them all lands you back at the same whole-world
   * altitude the query started from, which is what made twelve of twenty-one
   * captures the same picture.
   *
   * The right inset is the rail's occlusion zone: an answer whose terminal lands
   * under the panel that names it is worse than no move at all.
   */
  private frameConstellation(c: ConstellationInput): void {
    const ids: string[] = [];
    for (const step of c.path) {
      ids.push(step.from_id, step.to_id);
    }
    if (c.bridge_entity_id !== null) ids.push(c.bridge_entity_id);
    if (ids.length === 0) return;
    const known = ids.filter((id) => this.positionById.has(id));
    if (known.length === 0) return;
    // The frame itself comes from `setDefaultFrame` above, so a shell that also
    // frames this selection lands on exactly the same picture.
    void this.cameraImpl.fitTo(known, 96);
  }

  setFilters(f: { sigma: SigmaClass[]; showQuarantined: boolean }): void {
    this.filters = f;
    this.rebuildEdges();
    this.invalidate();
  }

  setEdgePolicy(reason: DrawnReason | null): void {
    if (this.edgePolicy === reason) return;
    this.edgePolicy = reason;
    this.rebuildEdges();
    this.invalidate();
  }

  setDimmed(dimmed: boolean): void {
    this.dimExplicit = dimmed;
    this.retargetDim();
  }

  private retargetDim(): void {
    const target = this.dimExplicit || this.dimRendered ? 1 : 0;
    if (this.dimTarget === target) return;
    this.dimTarget = target;
    this.dimStart = performance.now();
    this.invalidate();
  }

  /* -------------------------------------------------------------------------
   * PICKING
   * ---------------------------------------------------------------------- */

  pick(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    const [wx, wy] = this.cameraImpl.screenToWorld(clientX - rect.left, clientY - rect.top);
    const slop = this.palette.hitSlop / this.cameraImpl.get().zoom;
    return this.picker.pick(wx, wy, slop);
  }

  pickRect(a: Vec2, b: Vec2): string[] {
    return this.picker.rect(a, b);
  }

  /* -------------------------------------------------------------------------
   * CHOREOGRAPHY — every one of these depicts a real state transition
   * ---------------------------------------------------------------------- */

  /**
   * A provenance trace: OLD LIGHT running from one node to another along the
   * direct chord. Resolves when it arrives, so a caller can chain a chain.
   *
   * IT TRAVELS FOR `--t-ui`, NOT FOR `--t-scene`. A trace is not a scene: the
   * camera does not move, the ontology does not change, and nothing about where
   * you are standing is different afterwards. It is one instrument event — the
   * same duration class as a panel opening — and at 700ms it read as a slow
   * flourish over a fetch rather than as a claim being checked. `--t-ui` is also
   * the number `@/ui/provenance/CitationList.tsx` has documented as this
   * animation's duration since it was written, and the two now agree.
   */
  async tracePing(fromId: string, toId: string, delayMs = 0): Promise<void> {
    const a = this.positionById.get(fromId);
    const b = this.positionById.get(toId);
    if (a === undefined || b === undefined) return;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    if (this.disposed) return;
    this.invalidate();
    await this.edges.ping(a.x, a.y, b.x, b.y, this.palette.ms.ui);
  }

  /**
   * INGESTING: the named nodes resolve out of `latent` in the order they were
   * given, over `--t-scene`. Nothing moves — position is baked — so what you
   * watch is topology GAINING RESOLUTION, which is exactly what ingestion does.
   */
  settleIngest(ids: string[]): Promise<void> {
    if (this.points.count === 0 || ids.length === 0) return Promise.resolve();
    this.settleRank = new Float32Array(this.points.count).fill(-1);
    for (let k = 0; k < ids.length; k++) {
      const i = this.points.index.get(ids[k]);
      if (i !== undefined) this.settleRank[i] = ids.length <= 1 ? 0 : k / (ids.length - 1);
    }
    this.settleActive = true;
    this.settleStart = performance.now();
    this.settleDuration = this.palette.reducedMotion
      ? this.palette.ms.fast
      : this.palette.ms.scene * 1.6;
    this.applyLod(true);
    this.invalidate();
    return new Promise<void>((resolve) => {
      this.settleResolve?.();
      this.settleResolve = resolve;
    });
  }

  /* -------------------------------------------------------------------------
   * FRAME
   * ---------------------------------------------------------------------- */

  onFrame(cb: (stats: FrameStats) => void): () => void {
    this.frameSubs.add(cb);
    return () => this.frameSubs.delete(cb);
  }

  perf(): FrameStats {
    return this.stats;
  }

  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth || this.canvas.width);
    const h = Math.max(1, this.canvas.clientHeight || this.canvas.height);
    const dpr = Math.min(this.opts.maxDpr ?? 2, window.devicePixelRatio || 1);
    if (w === this.cssWidth && h === this.cssHeight && dpr === this.dpr) return;
    this.cssWidth = w;
    this.cssHeight = h;
    this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.cameraImpl.setViewport(w, h);
    if (this.bake) this.cameraImpl.setWorldBounds(this.bake.bounds);
    (this.shared.uViewport.value as THREE.Vector2).set(w * dpr, h * dpr);
    this.shared.uDpr.value = dpr;
    this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.frameSubs.clear();
    this.labelLayer.dispose();
    this.regions.dispose();
    this.edges.dispose();
    this.points.dispose();
    this.renderer.dispose();
  }

  /** Ask for a frame. Idempotent; the loop stops itself when nothing is live. */
  private invalidate(): void {
    this.dirty = true;
    if (this.rafId === 0 && !this.disposed && !document.hidden) {
      this.rafId = requestAnimationFrame(this.frame);
    }
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    } else {
      this.invalidate();
    }
  };

  private frame = (now: number): void => {
    this.rafId = 0;
    if (this.disposed) return;
    const t0 = performance.now();

    let live = false;
    live = this.cameraImpl.tick(now) || live;
    live = this.points.tickLod(now) || live;
    live = this.edges.tick(now) || live;
    live = this.tickDim(now) || live;
    live = this.tickSettle(now) || live;

    const cameraMoved = this.cameraImpl.version !== this.lastCameraVersion;
    const drew = live || this.dirty || cameraMoved;
    if (drew) {
      this.draw();
      this.dirty = false;
    }

    const frameMs = performance.now() - t0;
    const delta = now - this.lastFrameAt;
    if (!drew) {
      // Nothing was drawn, so there is nothing to time. A gauge that reports a
      // frame budget for a frame that never happened is a broken gauge.
      if (live) this.rafId = requestAnimationFrame(this.frame);
      return;
    }
    // Only fold a delta into the FPS estimate when the previous frame was part
    // of the same continuous run. A render-on-demand loop that has been asleep
    // for two seconds must not report 0.5fps — it reported nothing, because it
    // drew nothing, and a gauge that invents a number is a broken gauge.
    if (delta > 0 && delta < 200 && this.lastFrameAt > 0) {
      const instant = 1000 / delta;
      this.stats.fps = this.stats.fps === 0 ? instant : this.stats.fps * 0.82 + instant * 0.18;
    }
    this.lastFrameAt = now;
    this.stats.frameMs = Math.round(frameMs * 100) / 100;

    for (const cb of this.frameSubs) cb(this.stats);
    if (live) this.rafId = requestAnimationFrame(this.frame);
  };

  private draw(): void {
    const cam = this.cameraImpl.get();
    (this.shared.uCam.value as THREE.Vector3).set(cam.x, cam.y, cam.zoom * this.dpr);
    this.points.flushFlags();

    this.labelLayer.update(this.cameraImpl, this.cssWidth, this.cssHeight, {
      hover: this.hover,
      selected: this.selection,
      constellation: this.constellationNodes,
      focus: null,
    });

    this.renderer.render(this.scene, this.threeCamera);

    this.lastCameraVersion = this.cameraImpl.version;
    this.stats.points = this.points.count;
    // WHAT A PERSON COULD COUNT. This used to report the instance count, which
    // is segments plus sixteen parked ping slots — a number that matched nothing
    // on screen and nothing in the payload.
    this.stats.edges = this.edges.strokes;
    this.stats.drawCalls = this.renderer.info.render.calls;
    this.stats.labels = this.labelLayer.visible;
  }

  private tickDim(now: number): boolean {
    if (this.dimCurrent === this.dimTarget) return false;
    const duration = this.palette.reducedMotion ? this.palette.ms.fast : this.palette.ms.ui;
    const p = duration <= 0 ? 1 : Math.min(1, (now - this.dimStart) / duration);
    const from = this.dimTarget === 1 ? 0 : 1;
    this.dimCurrent = from + (this.dimTarget - from) * (p * p * (3 - 2 * p));
    this.shared.uDim.value = this.dimCurrent;
    if (p >= 1) this.dimCurrent = this.dimTarget;
    return true;
  }

  private tickSettle(now: number): boolean {
    if (!this.settleActive) return false;
    const p = this.settleDuration <= 0 ? 1 : Math.min(1, (now - this.settleStart) / this.settleDuration);
    this.applyLod(true, p);
    if (p >= 1) {
      this.settleActive = false;
      const done = this.settleResolve;
      this.settleResolve = null;
      done?.();
    }
    return true;
  }

  /* -------------------------------------------------------------------------
   * DERIVED STATE
   * ---------------------------------------------------------------------- */

  private applyLod(immediate: boolean, settleProgress = 1): void {
    if (this.points.count === 0) return;
    const rungDepth = RUNG_DEPTH[this.rung];
    const override = this.lodOverride;
    const inView = this.inView;
    const selection = this.selection;
    const constellation = this.constellationNodes;
    const settling = this.settleActive;
    const rank = this.settleRank;
    const positions = this.positionById;
    const core = this.pathCore;

    this.points.retargetLod((i, id) => {
      // A node that has not arrived yet is topology and nothing more.
      if (settling && rank.length > i && rank[i] >= 0 && rank[i] > settleProgress) return 'latent';

      const explicit = override[id];

      if (selection.has(id)) return 'lod-0';
      /* THE CONSTELLATION RAISES RESOLUTION AND IS NEVER LOWERED BY THE AMBIENT
       * MAP. This used to sit BELOW the explicit override, and the consequence
       * was the single worst defect in the flagship frame: the store's resting
       * map put the answer entity at `ghost`, the override won, and the terminal
       * of the answer path was drawn as a peripheral dot with the gold path
       * running into it and stopping in apparent empty space.
       *
       * A rule may raise a node's resolution; only the engine's own admission
       * decision may lower it. */
      if (core.has(id)) return 'lod-0';
      /* A CONSTELLATION MEMBER THAT IS NOT ON THE PATH KEEPS THE RESOLUTION THE
       * ENGINE ADMITTED IT AT. Forcing every member to a legible tier lit
       * twenty-three entities that the receipt says were spent almost nothing
       * on, each with no drawn reason for its membership — which is the RAG
       * failure mode this product exists to replace, committed by the renderer
       * rather than by the retriever. */
      if (constellation.has(id)) return explicit ?? 'lod-2';

      if (explicit !== undefined) return explicit;
      if (inView.has(id)) {
        const p = positions.get(id);
        const depth = p === undefined ? rungDepth : (KIND_DEPTH[p.kind] ?? rungDepth);
        // The rung you are standing on gets the summary tier; the cross-cutting
        // entity layer drawn over it gets labels only, because at this altitude
        // an entity is a pointer, not a place.
        return depth <= rungDepth ? 'lod-1' : 'lod-2';
      }
      const p = positions.get(id);
      return ambientLod(p === undefined ? rungDepth + 2 : (KIND_DEPTH[p.kind] ?? rungDepth + 2), rungDepth);
    }, immediate);
  }

  private applyFlags(): void {
    if (this.points.count === 0) return;
    this.points.clearFlags();
    const set = (id: string, bit: number): void => {
      const i = this.points.index.get(id);
      if (i === undefined) return;
      this.points.setFlags(i, this.points.flagsAt(i) | bit);
    };
    /* THE RUNG'S OWN BODIES. Set before anything else, because it is the flag
     * that decides whether an altitude is a different KIND OF PLACE or the same
     * point cloud with a different label set. */
    if (this.view !== null) {
      for (const node of this.view.nodes) {
        if (node.kind === this.rung) set(node.id, NODE_FLAG.PRIMARY);
      }
    }

    for (const id of this.constellationNodes) set(id, NODE_FLAG.CONSTELLATION);
    for (const id of this.selection) set(id, NODE_FLAG.SELECTED | NODE_FLAG.RING);
    if (this.hover !== null) set(this.hover, NODE_FLAG.HOVERED | NODE_FLAG.RING);
    if (this.constellation?.bridge_entity_id) set(this.constellation.bridge_entity_id, NODE_FLAG.BRIDGE);
    // RANK ALONG THE PATH. The hop endpoints and the bridge outrank the twenty-odd
    // context entities; the answer terminal outranks them. Applied last so
    // nothing downgrades it.
    for (const id of this.pathCore) set(id, NODE_FLAG.PATH);
    if (this.answerNode !== null) set(this.answerNode, NODE_FLAG.ANSWER);

    /* BOUNDARIES ARE EARNED, exactly like edges are.
     *
     * Every region node drawing its containment boundary at rest produced a
     * Spirograph: thirty-six island discs that legitimately overlap, plus six
     * continent discs three screens wide, and the terrain underneath became
     * unreadable. Measured against the brief, that is the hairball with circles
     * instead of lines.
     *
     * So a boundary appears where the question "what exactly does this contain"
     * is actually being asked: the region you are standing INSIDE, whatever the
     * pointer is on, and whatever is selected. At the asset rung every asset in
     * view draws its boundary, because at that altitude the declared boundary of
     * the molecule IS the subject of the screen and the discs no longer overlap
     * into noise. */
    if (this.parentId !== null) set(this.parentId, NODE_FLAG.RING);
    /* AT THE PASSAGE RUNG THE PARENT IS THE PAGE, NOT A PLACE ON IT.
     *
     * The document you descended into stops being one more mark competing with
     * its own spans and becomes the bounded body they lie inside: boundary
     * drawn, capital suppressed, and the "a boundary wider than the viewport is
     * not a boundary" ceiling lifted, because this one is meant to contain the
     * subject of the frame rather than to sit inside it. Without it the rung is
     * five dots on a void; with it, it is five spans inside one document, which
     * is what the legend has always claimed. */
    if (this.rung === 'passage' && this.parentId !== null) set(this.parentId, NODE_FLAG.ENCLOSURE);
    /* AND NOT AT THE ASSET RUNG ANY MORE. Twenty-four containment radii of
     * comparable size, all drawn at once, overlapped into a moiré of soap
     * bubbles that swallowed the documents they were supposed to enclose — the
     * Spirograph this flag exists to prevent, one rung further down. At that
     * altitude the asset IS the body (NODE_FLAG.PRIMARY), and its declared
     * boundary is shown for the one you point at or select, which is when the
     * question "what exactly does this contain" is actually being asked. */

    // Bridge entities in the payload are a derived FACT (`island_ids.length > 1`),
    // not an opinion, so they carry their second boundary whether or not an
    // answer happens to be routed through them right now.
    if (this.view) {
      for (const node of this.view.nodes) {
        if (node.kind === 'entity' && node.is_bridge) set(node.id, NODE_FLAG.BRIDGE);
      }
    }

    // Nodes whose only incident relations were rejected by the truth gate are
    // marked so their boundary draws BROKEN. The gate's work has to be visible.
    if (this.view) {
      const admitted = new Set<string>();
      const rejected = new Set<string>();
      for (const e of this.view.edges) {
        const target = e.quarantined ? rejected : admitted;
        target.add(e.from_id);
        target.add(e.to_id);
      }
      for (const id of rejected) if (!admitted.has(id)) set(id, NODE_FLAG.QUARANTINED);
    }
    this.points.flushFlags();
  }

  private rebuildLabels(view: GraphViewResponse): void {
    const candidates: LabelCandidate[] = [];
    let maxCentrality = 0;
    for (const node of view.nodes) maxCentrality = Math.max(maxCentrality, node.centrality);
    const norm = maxCentrality > 0 ? 1 / maxCentrality : 0;

    /* HOW BIG THE MARK UNDER EACH NAME IS DRAWN. The same three rules the point
     * layer uses, evaluated here because this is where the label layer is told
     * what it has to write around: a body of the current rung is sized across
     * --node-body-min..max against its peers, any other region gets a capital
     * scaled the same way, and a leaf gets the dot ceiling. See
     * `LabelCandidate.mark`. */
    const tk = this.geometryTokens;
    let peer = 0;
    for (const node of view.nodes) {
      if (node.kind !== this.rung) continue;
      const p = this.positionById.get(node.id);
      if (p !== undefined) peer = Math.max(peer, p.r);
    }
    const peerInv = peer > 0 ? 1 / peer : 0;

    for (const node of view.nodes) {
      const p = this.positionById.get(node.id);
      if (p === undefined) continue;
      const rel = Math.min(1, Math.max(0, p.r * peerInv));
      const isPlace =
        node.kind === 'continent' || node.kind === 'island' || node.kind === 'asset';
      const mark =
        node.kind === this.rung
          ? // A drawn body carries a halo of 0.62 of its own radius; the name has
            // to clear what the eye sees, not the disc alone.
            (tk.bodyMin + (tk.bodyMax - tk.bodyMin) * rel) * 1.2
          : isPlace
            ? tk.capital * (0.7 + 0.9 * rel)
            : tk.dotMin;
      candidates.push({
        id: node.id,
        text: node.label,
        glyph: glyphForKind(node.kind, RUNG_GLYPH),
        x: p.x,
        y: p.y,
        r: p.r,
        mark,
        centrality: node.centrality * norm,
        /* "region" here means PLACE — a thing whose name orients you, whose
         * label hangs off a body rather than off a floating atom. The spine
         * kinds always qualify, and so does whatever kind the current rung is:
         * at the passage rung a span IS the place, and suppressing its name as
         * though it were a stray entity leaves the provenance floor unlabelled. */
        region:
          node.kind === 'continent' ||
          node.kind === 'island' ||
          node.kind === 'asset' ||
          node.kind === this.rung,
      });
    }
    this.labelLayer.setCandidates(candidates);
  }

  /**
   * WHERE A STRAIT HOP LEAVES ONE ISLAND AND REACHES THE OTHER.
   *
   * The two banks of the crossing, derived: the point at which the segment exits
   * the containment disc of the region its origin belongs to, and the point at
   * which it enters the containment disc of the region its target belongs to.
   * Returns `[]` when the crossing is not between two known landfall regions —
   * a mark the geometry cannot justify is not drawn.
   */
  private crossingBanks(
    step: PathStep,
    a: NodePosition,
    z: NodePosition,
  ): { x: number; y: number; side: string }[] {
    if (this.landfall.length < 2) return [];
    const view = this.view;
    if (view === null) return [];
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    const homeOf = (id: string): { x: number; y: number; r: number } | null => {
      const node = byId.get(id);
      const ids = new Set<string>(node?.kind === 'entity' ? node.island_ids : []);
      let best: { x: number; y: number; r: number } | null = null;
      let bestD = Infinity;
      const p = this.positionById.get(id);
      if (p === undefined) return null;
      for (const disc of this.landfall) {
        if (ids.size > 0 && !ids.has(disc.id)) continue;
        const d = Math.hypot(p.x - disc.x, p.y - disc.y);
        if (d < bestD) {
          bestD = d;
          best = disc;
        }
      }
      return best;
    };

    const from = homeOf(step.from_id);
    const to = homeOf(step.to_id);
    if (from === null || to === null || from === to) return [];

    const out: { x: number; y: number; side: string }[] = [];
    const exit = crossingT(a, z, from);
    const enter = crossingT(a, z, to);
    if (exit !== null) out.push({ x: a.x + (z.x - a.x) * exit, y: a.y + (z.y - a.y) * exit, side: 'a' });
    if (enter !== null) out.push({ x: a.x + (z.x - a.x) * enter, y: a.y + (z.y - a.y) * enter, side: 'z' });
    // One bank is a tick on a line; two banks are a crossing. Both or neither.
    return out.length === 2 ? out : [];
  }

  /**
   * ===========================================================================
   * SEA LANES — push a bundled channel off the land it does not serve
   * ===========================================================================
   *
   * The last complaint about the resting map was that its corridors were still
   * straight chords converging on the centre, so the middle of the terrain — the
   * part with the most land on it — was also the part with the most traffic
   * drawn across it. That is backwards on any map: a route between two coasts
   * runs through the water between them.
   *
   * So each routed channel takes a bounded number of gradient steps DOWNHILL on
   * the same density field the wash is drawn from, with a light Laplacian
   * smoothing between passes and its endpoints pinned at the coasts they left.
   * What comes out leaves a region at its coast, bends into the open water
   * between the land masses, and arrives at another coast — and the places where
   * several channels are squeezed through the same gap are the straits.
   *
   * NOT A SIMULATION, for the same reasons the bundler is not one: a fixed
   * iteration count, no convergence test, no timer, no observable intermediate
   * state, endpoints that cannot move, and a result cached against the view. It
   * decides the shape of a curve between two fixed points and touches nothing
   * else. `--corridor-sea: 0` restores straight chords exactly.
   */
  private throughOpenWater(routes: readonly BundledRoute[]): BundledRoute[] {
    const field = this.regionField;
    const strength = this.geometryTokens.corridorSea;
    if (field === null || strength <= 0) return routes as BundledRoute[];

    const h = field.texelWorld;
    const step = h * 3.2 * strength;
    const PASSES = 14;
    const SMOOTH = 0.16;
    const out: BundledRoute[] = [];

    for (const route of routes) {
      const m = route.pts.length / 2;
      if (m < 4) {
        out.push(route);
        continue;
      }
      const pts = Float32Array.from(route.pts);
      for (let pass = 0; pass < PASSES; pass++) {
        for (let k = 1; k < m - 1; k++) {
          const x = pts[k * 2];
          const y = pts[k * 2 + 1];
          const here = field.land(x, y);
          // Already at sea: a channel in open water has nowhere better to be.
          if (here <= 0.02) continue;
          const gx = field.land(x + h, y) - field.land(x - h, y);
          const gy = field.land(x, y + h) - field.land(x, y - h);
          const g = Math.hypot(gx, gy);
          if (g < 1e-6) continue;
          // Downhill, scaled by how much land is actually here: deep interior
          // moves hard, a shoreline barely moves, open water not at all. The
          // taper keeps the ends near the coasts they were pinned to.
          const taper = Math.sin((Math.PI * k) / (m - 1));
          const d = step * here * taper;
          pts[k * 2] = x - (gx / g) * d;
          pts[k * 2 + 1] = y - (gy / g) * d;
        }
        // A channel, not a scribble: the descent finds the water, this keeps the
        // curve smooth enough that neighbouring corridors still share a spine.
        for (let k = 1; k < m - 1; k++) {
          pts[k * 2] += ((pts[(k - 1) * 2] + pts[(k + 1) * 2]) / 2 - pts[k * 2]) * SMOOTH;
          pts[k * 2 + 1] +=
            ((pts[(k - 1) * 2 + 1] + pts[(k + 1) * 2 + 1]) / 2 - pts[k * 2 + 1]) * SMOOTH;
        }
      }
      const arc = new Float32Array(m);
      let acc = 0;
      for (let k = 1; k < m; k++) {
        acc += Math.hypot(pts[k * 2] - pts[(k - 1) * 2], pts[k * 2 + 1] - pts[(k - 1) * 2 + 1]);
        arc[k] = acc;
      }
      out.push({ pts, arc, chord: route.chord });
    }
    return out;
  }

  /**
   * Turn the payload's chosen edge subset into strokes — FEWER OF THEM THAN IT
   * WAS HANDED.
   *
   * The engine's subset is a CANDIDATE set. At the island rung it is 262
   * relations collapsed into 170 corridors, and stroking all 170 produced
   * exactly the picture the brief bans by name: straight teal chords crossing
   * the centre of the map in every direction, most of them carrying a single
   * claim. A corridor with one relation in it is not a trade route, it is a
   * footpath, and a map that draws every footpath has told you nothing about
   * where the traffic is.
   *
   * So the corridors are ranked by real traffic, the rung's `--edge-budget-*`
   * decides how many survive, and only the survivors are bundled — bundling the
   * whole candidate set and then drawing it all is how you get a knot. The
   * survivors share channels, so what is left reads as a few trunk routes with
   * capillaries between the big landmasses.
   *
   * The answer path is always laid over the top, unbundled, with a casing: a
   * path is a specific claim and must not be smeared into an aggregate channel.
   */
  private rebuildEdges(): void {
    const view = this.view;
    if (view === null) {
      this.edges.setRoutes([]);
      return;
    }
    const policy = this.edgePolicy ?? view.stats.drawn_reason;
    const specs: RouteSpec[] = [];
    const pathEdgeIds = new Set((this.constellation?.path ?? []).map((s) => s.edge_id));
    const sigmaFilter = this.filters.sigma.length > 0 ? new Set(this.filters.sigma) : null;
    const tk = this.geometryTokens;
    const budget = Math.max(0, Math.round(tk.budget[this.rung] ?? 60));

    const passes = (e: Edge): boolean => {
      if (sigmaFilter !== null && !sigmaFilter.has(e.sigma)) return false;
      if (e.quarantined && !this.filters.showQuarantined) return false;
      return true;
    };

    /* THE READING AXIS, FIRST AND UNDERNEATH. Not a relation: it is the document
     * itself, so it is stroked in ink, carries no σ-class, earns no light and
     * never fogs. The spans sit on it at their true char offsets, and the gaps
     * between them are the gaps in the source. */
    if (this.spineAxis !== null) {
      const s = this.spineAxis;
      specs.push({
        route: straight(s.x0, s.y0, s.x1, s.y1),
        width: tk.hairline * 1.4,
        sigma: SIGMA_CODE.factual,
        alpha: tk.spineAlpha,
        flags: EDGE_FLAG.SPINE | EDGE_FLAG.MARK,
        key: 'spine',
      });
      /* THE FIRST BYTE AND THE LAST. The axis is a diameter of the document's
       * declared boundary, so its two ends are where the page starts and stops —
       * and unlike the boundary arc, which at this altitude runs off the top and
       * bottom of the frame, these are always in shot. A bounded body needs a
       * visible bound. */
      const dx = s.x1 - s.x0;
      const dy = s.y1 - s.y0;
      const len = Math.max(1e-6, Math.hypot(dx, dy));
      const arm = 9 / Math.max(this.cameraImpl.get().zoom, 1e-6);
      for (const [ex, ey, side] of [
        [s.x0, s.y0, 'start'],
        [s.x1, s.y1, 'end'],
      ] as [number, number, string][]) {
        specs.push({
          route: straight(
            ex + (dy / len) * arm,
            ey - (dx / len) * arm,
            ex - (dy / len) * arm,
            ey + (dx / len) * arm,
          ),
          width: tk.hairline * 1.4,
          sigma: SIGMA_CODE.factual,
          alpha: tk.spineAlpha * 1.6,
          flags: EDGE_FLAG.SPINE | EDGE_FLAG.MARK,
          key: `spine-cap:${side}`,
        });
      }
    }

    if (policy === 'trade-route-skeleton' && view.bundles.length > 0) {
      // Rank by traffic, break ties by id so the same view always yields the
      // same skeleton — a map whose trunk routes shuffle between two identical
      // frames is not a map.
      const kept = view.bundles
        .filter((b) => sigmaFilter === null || sigmaFilter.has(b.sigma))
        .filter((b) => this.positionById.has(b.from_id) && this.positionById.has(b.to_id))
        .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1))
        .slice(0, budget);

      const key = `${view.bake_id}|${view.rung}|${view.parent_id ?? ''}|${budget}|${kept.length}|${kept[0]?.id ?? ''}`;
      let routes = this.routeCache.get(key);
      if (routes === undefined) {
        /* A TRADE ROUTE LEAVES AT A COAST.
         *
         * Centroid-to-centroid chords are what made the middle of the terrain
         * the busiest region: every corridor started in the interior of a
         * landmass, crossed the interiors of everything between, and converged
         * on the optical centre because that is where the centroids are. A route
         * between two places starts where the land stops. `--corridor-coast` is
         * how far along the region's own containment radius that is, capped so a
         * pair of near neighbours still has a route between them rather than two
         * overlapping stubs. */
        const coast = this.geometryTokens.corridorCoast;
        const inputs: { ax: number; ay: number; bx: number; by: number; weight: number }[] = [];
        for (const b of kept) {
          const a = this.positionById.get(b.from_id) as NodePosition;
          const z = this.positionById.get(b.to_id) as NodePosition;
          const dx = z.x - a.x;
          const dy = z.y - a.y;
          const chord = Math.max(1e-6, Math.hypot(dx, dy));
          const ux = dx / chord;
          const uy = dy / chord;
          const ha = Math.min(a.r * coast, chord * 0.3);
          const hz = Math.min(z.r * coast, chord * 0.3);
          inputs.push({
            ax: a.x + ux * ha,
            ay: a.y + uy * ha,
            bx: z.x - ux * hz,
            by: z.y - uy * hz,
            weight: b.count,
          });
        }
        // BUNDLED HARDER THAN THE DEFAULT, on purpose. With sixty corridors
        // instead of a hundred and seventy, a permissive compatibility threshold
        // is affordable and it is what makes neighbouring routes share a spine
        // rather than run as parallel chords a few pixels apart. The result reads
        // as a road network with junctions, which is the claim being made.
        routes = bundleRoutes(inputs, { threshold: 0.28, stiffness: 0.2, cycles: 6, iterations: 62 });
        routes = this.throughOpenWater(routes);
        this.routeCache.set(key, routes);
      }

      let maxCount = 1;
      for (const b of kept) maxCount = Math.max(maxCount, b.count);
      const denom = Math.log1p(maxCount);
      for (let r = 0; r < kept.length; r++) {
        const b = kept[r];
        const route = routes[r];
        if (route === undefined) continue;
        // Corridor weight is real traffic: log-scaled so one huge corridor does
        // not squash every other one into a hairline. The tail that used to be
        // suppressed with an alpha curve is simply not drawn any more, so the
        // survivors can be legible instead of apologetic.
        const t = denom > 0 ? Math.log1p(b.count) / denom : 0;
        specs.push({
          route,
          width: tk.hairline + (tk.routeMax - tk.hairline) * t,
          sigma: SIGMA_CODE[b.sigma],
          alpha: 0.12 + 0.34 * t,
          flags: b.is_strait ? EDGE_FLAG.STRAIT : 0,
          key: b.id,
        });
      }

      /* WHAT THE GATE REFUSED IS DRAWN EVEN AT A CORRIDOR RUNG.
       *
       * A corridor is an aggregate of admitted traffic, so a skeleton built only
       * from bundles has nowhere to show a rejection — and "the engine refuses to
       * admit what it cannot substantiate" became a number in a table instead of
       * a thing you can see. The payload ships the quarantined relations too, so
       * they are stroked individually as BROKEN STUBS in --alarm: they leave
       * their endpoint, they do not arrive, and there are eight of them rather
       * than a corridor's worth. Off the corridors, off the budget, and gone the
       * moment the user filters them out. */
      if (this.filters.showQuarantined) {
        for (const e of view.edges) {
          if (!e.quarantined) continue;
          if (sigmaFilter !== null && !sigmaFilter.has(e.sigma)) continue;
          const a = this.positionById.get(e.from_id);
          const z = this.positionById.get(e.to_id);
          if (a === undefined || z === undefined) continue;
          specs.push({
            route: straight(a.x, a.y, z.x, z.y),
            width: tk.hairline * 1.4,
            sigma: SIGMA_CODE[e.sigma],
            alpha: 0.5,
            flags: EDGE_FLAG.QUARANTINED | (e.crosses_strait ? EDGE_FLAG.STRAIT : 0),
            key: `q:${e.id}`,
          });
        }
      }
    } else {
      /* A CONSTELLATION IS DRAWN, NOT IMPLIED. The engine says which relations
       * it traversed; every one of them gets a stroke a person can count, so the
       * HUD's "STROKED n" is checkable against the frame. Lighting a node with
       * no drawn reason for its membership is the RAG failure mode this product
       * exists to replace. */
      const constellationPolicy = policy === 'query-constellation';
      const base = policy === 'hover-neighborhood' ? 0.5 : constellationPolicy ? 0.46 : 0.24;
      const ranked = view.edges
        .filter(passes)
        .filter((e) => this.positionById.has(e.from_id) && this.positionById.has(e.to_id))
        .sort((a, b) => rankEdge(b, pathEdgeIds) - rankEdge(a, pathEdgeIds) || (a.id < b.id ? -1 : 1))
        .slice(0, Math.max(budget, pathEdgeIds.size));

      for (const e of ranked) {
        const a = this.positionById.get(e.from_id) as NodePosition;
        const z = this.positionById.get(e.to_id) as NodePosition;
        const onPath = pathEdgeIds.has(e.id);
        specs.push({
          route: straight(a.x, a.y, z.x, z.y),
          width: tk.hairline + (tk.routeMax - tk.hairline) * 0.22 * e.weight,
          sigma: SIGMA_CODE[e.sigma],
          alpha: base * (0.55 + 0.45 * e.confidence),
          flags:
            (e.quarantined ? EDGE_FLAG.QUARANTINED : 0) |
            (onPath || constellationPolicy ? EDGE_FLAG.CONSTELLATION : 0) |
            (e.crosses_strait ? EDGE_FLAG.STRAIT : 0),
          key: e.id,
        });
      }
    }

    /* THE ANSWER PATH — last, over the top, never bundled, and drawn as a ROAD.
     *
     * A casing in --render-deep underneath a bright --render core. That is not
     * decoration: a single 2.25px hairline crossing a lit landmass is the
     * weakest line in a frame whose entire subject it is, which is exactly what
     * the captures showed. A casing gives the core an edge to sit against, so
     * the hop reads at thumbnail size and the strait crossing reads as a
     * crossing.
     *
     * Both are clipped to the node radii, so a hop STOPS at the thing it
     * reaches instead of trailing dots past its own endpoint into empty black. */
    for (const step of this.constellation?.path ?? []) {
      const a = this.positionById.get(step.from_id);
      const z = this.positionById.get(step.to_id);
      if (a === undefined || z === undefined) continue;
      const route = straight(a.x, a.y, z.x, z.y);
      const strait = step.crosses_strait ? EDGE_FLAG.STRAIT : 0;
      // A strait hop is the heaviest thing on the map: it is the claim the whole
      // bridge question was asked to test.
      const width = tk.answerWidth * (step.crosses_strait ? 1.18 : 1);

      /* THE CROSSING, DRAWN AS A CROSSING.
       *
       * "The answer path physically crosses a strait" is the strongest sentence
       * this product says, and the frame that said it was a straight line over an
       * even wash — the crossing was a word in the rail and nothing at all in the
       * picture.
       *
       * The two banks are not decoration and they are not guessed: they are the
       * points where the hop leaves the containment radius of the island its
       * origin belongs to and enters the containment radius of the island its
       * target belongs to. Between them the hop is over open water, and that
       * stretch gets a wider casing under it — a deck, with an abutment at each
       * end. How long the deck is, is how wide the strait is. */
      const banks = step.crosses_strait ? this.crossingBanks(step, a, z) : [];
      if (banks.length === 2) {
        specs.push({
          route: straight(banks[0].x, banks[0].y, banks[1].x, banks[1].y),
          width: width + tk.answerCasing * 2.1,
          sigma: SIGMA_CODE.factual,
          alpha: 0.5,
          flags: EDGE_FLAG.ANSWER | EDGE_FLAG.CASING | EDGE_FLAG.STRAIT | EDGE_FLAG.MARK,
          key: `crossing:${step.edge_id}:${step.index}`,
        });
      }

      specs.push({
        route,
        width: width + tk.answerCasing,
        sigma: SIGMA_CODE.factual,
        alpha: 0.62,
        flags: EDGE_FLAG.ANSWER | EDGE_FLAG.CASING | strait,
        key: `path-casing:${step.edge_id}:${step.index}`,
      });
      specs.push({
        route,
        width,
        sigma: SIGMA_CODE[step.sigma],
        alpha: 1,
        flags: EDGE_FLAG.ANSWER | EDGE_FLAG.CONSTELLATION | strait,
        key: `path:${step.edge_id}:${step.index}`,
      });

      for (const bank of banks) {
        const nx = -(z.y - a.y);
        const ny = z.x - a.x;
        const len = Math.max(1e-6, Math.hypot(nx, ny));
        const arm = (tk.answerWidth * 2.4) / Math.max(this.cameraImpl.get().zoom, 1e-6);
        specs.push({
          route: straight(
            bank.x - (nx / len) * arm,
            bank.y - (ny / len) * arm,
            bank.x + (nx / len) * arm,
            bank.y + (ny / len) * arm,
          ),
          width: tk.answerWidth * 0.7,
          sigma: SIGMA_CODE.factual,
          alpha: 0.95,
          flags: EDGE_FLAG.ANSWER | EDGE_FLAG.CONSTELLATION | EDGE_FLAG.STRAIT | EDGE_FLAG.MARK,
          key: `bank:${step.edge_id}:${step.index}:${bank.side}`,
        });
      }
    }

    this.edges.setRoutes(specs);

    // A selected path relaxes its corridors out of the bundle so the user sees
    // the literal relations rather than the aggregate they were folded into.
    if (this.constellation !== null && policy === 'trade-route-skeleton') {
      const relax = new Set<string>();
      for (const b of view.bundles) {
        if (b.edge_ids.some((id) => pathEdgeIds.has(id))) relax.add(b.id);
      }
      this.edges.setRelaxed(relax);
    } else {
      this.edges.setRelaxed([]);
    }
  }
}

/**
 * Where a segment crosses the boundary of a disc, as a fraction along it.
 *
 * The FIRST crossing found going from A to B, which is the exit when A is inside
 * the disc and the entry when it is not. `null` when the segment and the circle
 * do not meet inside the segment's own span — there is no bank to mark.
 */
function crossingT(
  a: { x: number; y: number },
  b: { x: number; y: number },
  disc: { x: number; y: number; r: number },
): number | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - disc.x;
  const fy = a.y - disc.y;
  const qa = dx * dx + dy * dy;
  if (qa < 1e-9) return null;
  const qb = 2 * (fx * dx + fy * dy);
  const qc = fx * fx + fy * fy - disc.r * disc.r;
  const disc2 = qb * qb - 4 * qa * qc;
  if (disc2 < 0) return null;
  const root = Math.sqrt(disc2);
  const t0 = (-qb - root) / (2 * qa);
  const t1 = (-qb + root) / (2 * qa);
  for (const t of [t0, t1]) {
    if (t > 0.02 && t < 0.98) return t;
  }
  return null;
}

/**
 * Which document the reading spine applies to, or `''` for every other rung.
 *
 * The passage rung is the only altitude whose subject is ONE bounded document,
 * and therefore the only one whose honest projection is that document's own
 * byte order. See `TerrainImpl.readingSpine`.
 */
function spineKeyOf(input: SceneInput): string {
  if (input.rung !== 'passage' || input.parentId === null) return '';
  return `spine:${input.parentId}`;
}

/**
 * A two-point route. What an unbundled relation is.
 *
 * Full centre-to-centre: the trim that stops a stroke short of the discs it
 * joins is applied in SCREEN space by the edge shader (`--edge-trim`), because
 * the disc it has to clear is clamped in screen pixels. Trimming here, in world
 * units, was right at exactly one altitude and wrong everywhere else.
 */
function straight(ax: number, ay: number, bx: number, by: number): BundledRoute {
  const chord = Math.hypot(bx - ax, by - ay);
  return {
    pts: Float32Array.from([ax, ay, bx, by]),
    arc: Float32Array.from([0, chord]),
    chord,
  };
}

/**
 * How much a relation deserves one of the rung's strokes.
 *
 * The answer path outranks everything by construction; after that it is the
 * engine's own weight and confidence. Nothing here invents a score — both fields
 * are on the payload and both are what the engine says the relation is worth.
 */
function rankEdge(e: Edge, pathEdgeIds: ReadonlySet<string>): number {
  if (pathEdgeIds.has(e.id)) return 1e6;
  return e.weight * 2 + e.confidence + (e.crosses_strait ? 0.35 : 0) - (e.quarantined ? 1.5 : 0);
}

/**
 * The part of a constellation that IS the answer: the path's endpoints and the
 * bridge entity it crosses through.
 *
 * A constellation is twenty-six nodes. Treating all twenty-six as equally
 * important is what produced fifteen overlapping labels in one corner and two
 * irrelevant entities drawn larger than the answer.
 */
function corePathNodes(c: ConstellationInput | null): Set<string> {
  const out = new Set<string>();
  if (c === null) return out;
  for (const step of c.path) {
    out.add(step.from_id);
    out.add(step.to_id);
  }
  if (c.bridge_entity_id !== null) out.add(c.bridge_entity_id);
  return out;
}

/**
 * The terminal of the answer path — the entity the question asked to be named.
 *
 * The contract fixes `path` as "the ordered chain from question to answer", so
 * the answer is whichever endpoint of the LAST hop no earlier hop already
 * touched: the chain ends where it stops repeating itself. Derived from the
 * payload's own ordering rather than guessed, and it falls back to the last
 * hop's target for a one-hop answer where both readings agree anyway.
 */
function answerNodeOf(c: ConstellationInput | null): string | null {
  if (c === null || c.path.length === 0) return null;
  const last = c.path[c.path.length - 1];
  const earlier = new Set<string>();
  for (let i = 0; i < c.path.length - 1; i++) {
    earlier.add(c.path[i].from_id);
    earlier.add(c.path[i].to_id);
  }
  if (!earlier.has(last.from_id) && earlier.has(last.to_id)) return last.from_id;
  return last.to_id;
}

interface GeometryTokens {
  dotMin: number;
  dotMax: number;
  capital: number;
  bodyMin: number;
  bodyMax: number;
  answerDot: number;
  pathDot: number;
  hairline: number;
  routeMax: number;
  answerWidth: number;
  answerCasing: number;
  trim: number;
  dash: number;
  horizon: number;
  budget: Readonly<Record<Rung, number>>;
  corridorCoast: number;
  corridorSea: number;
  spineSpan: number;
  spineAlpha: number;
  coastOuter: number;
  coastInner: number;
  coastPx: number;
  texelMaxPx: number;
  texelFade: number;
  merge: number;
  mergeLift: number;
  shelfCut: number;
  seam: number;
  outOfScope: number;
  grain: number;
  fogSea: number;
  fogCoast: number;
  fogLandfall: number;
  fogDemote: number;
  fogEdge: number;
  labelMax: number;
  labelCell: number;
  labelOffset: number;
  labelMaxWidth: number;
  labelConstellationMax: number;
}

/** Read the terrain-geometry tokens appended to `design-tokens.css` §14. */
function readGeometryTokens(): GeometryTokens {
  const cs = getComputedStyle(document.documentElement);
  const px = (name: string, fallback: number): number => {
    const raw = cs.getPropertyValue(name).trim();
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    dotMin: px('--node-dot-min', 1.15),
    dotMax: px('--node-dot-max', 9),
    capital: px('--node-capital', 2.2),
    bodyMin: px('--node-body-min', 5),
    bodyMax: px('--node-body-max', 14),
    answerDot: px('--node-answer', 16),
    pathDot: px('--node-path', 11),
    hairline: px('--edge-hairline', 0.8),
    routeMax: px('--edge-route-max', 3),
    answerWidth: px('--edge-answer', 3.4),
    answerCasing: px('--edge-answer-casing', 3),
    trim: px('--edge-trim', 6),
    dash: px('--edge-dash', 7),
    horizon: px('--edge-horizon', 108),
    budget: Object.freeze({
      continent: px('--edge-budget-continent', 16),
      island: px('--edge-budget-island', 38),
      asset: px('--edge-budget-asset', 30),
      passage: px('--edge-budget-passage', 20),
    }),
    corridorCoast: px('--corridor-coast', 0.86),
    corridorSea: px('--corridor-sea', 0.62),
    spineSpan: px('--spine-span', 0.8),
    spineAlpha: px('--spine-alpha', 0.3),
    coastOuter: px('--coast-outer', 0.2),
    coastInner: px('--coast-inner', 0.55),
    coastPx: px('--coast-px', 1.5),
    texelMaxPx: px('--field-texel-max', 9),
    texelFade: px('--field-texel-fade', 1.7),
    merge: px('--field-merge', 0.032),
    mergeLift: px('--field-merge-lift', 0.66),
    shelfCut: px('--field-shelf-cut', 1.45),
    seam: px('--field-seam', 0.42),
    outOfScope: px('--field-out-of-scope', 0.26),
    grain: px('--field-grain', 0.55),
    fogSea: px('--fog-sea', 0.3),
    fogCoast: px('--fog-coast-gain', 2.6),
    fogLandfall: px('--fog-landfall', 1.12),
    fogDemote: px('--fog-demote', 1.35),
    fogEdge: px('--fog-edge', 0.1),
    labelMax: px('--label-max', 40),
    labelCell: px('--label-cell', 8),
    labelOffset: px('--label-offset', 7),
    labelMaxWidth: px('--label-max-width', 232),
    labelConstellationMax: px('--label-constellation-max', 8),
  };
}

/**
 * Create the terrain on a canvas.
 *
 * The canvas must have a positioned parent — the DOM label layer is appended to
 * it and absolutely positioned over the canvas. `TerrainCanvas` provides one.
 */
export function createTerrain(canvas: HTMLCanvasElement, opts: TerrainOpts = {}): Terrain {
  return new TerrainImpl(canvas, opts);
}

export type { GraphNode };
