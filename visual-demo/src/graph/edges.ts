/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE EDGE LAYER
 * =============================================================================
 *
 * Instanced ribbons, one draw call for every relation and every corridor on
 * screen, plus the provenance-trace pings at the tail of the same buffer.
 *
 * -----------------------------------------------------------------------------
 * UNBUNDLING IS A STATE TRANSITION, NOT AN EFFECT
 * -----------------------------------------------------------------------------
 * A bundled corridor is a claim about aggregate traffic: "these 214 relations
 * run between these two islands". The moment the user selects a PATH, that
 * aggregate is no longer what they are looking at — they are looking at two
 * specific hops, and a channel shared with 212 other relations is now actively
 * misleading about where those two hops go.
 *
 * So the selected routes RELAX toward their true straight chords over
 * `--t-scene`, and everything else stays bundled. The motion is not decoration:
 * it depicts the renderer switching from an aggregate view of those edges to a
 * literal one, and when the selection clears they bundle back. Every frame of
 * it corresponds to a real interpolation between two real geometries.
 * ========================================================================== */

import * as THREE from 'three';

import { EDGE_FLAG, EDGE_FRAG, EDGE_VERT, PING_CODE, SIGMA_CODE } from '@/graph/shaders/edges';
import type { BundledRoute } from '@/graph/bundles';
import type { Palette } from '@/graph/palette';

export { EDGE_FLAG, SIGMA_CODE };

/** Concurrent provenance traces. More than this on screen at once is noise. */
const MAX_PINGS = 16;

/** One drawable relation or corridor. */
export interface RouteSpec {
  /** The polyline to stroke. Two points for a straight relation. */
  route: BundledRoute;
  /** Stroke width in CSS px. */
  width: number;
  /** `SIGMA_CODE` value. Drives the treatment, never the colour. */
  sigma: number;
  /** Base alpha, before σ-class and policy adjustments in the shader. */
  alpha: number;
  /** `EDGE_FLAG` bitfield. */
  flags: number;
  /** Identity, so a caller can relax exactly the routes it means. */
  key: string;
}

interface RouteRecord {
  start: number;
  count: number;
  pts: Float32Array;
  arc: Float32Array;
  relaxCur: number;
  relaxTarget: number;
  key: string;
}

interface Ping {
  slot: number;
  start: number;
  duration: number;
  resolve: () => void;
}

function segmentQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // prettier-ignore
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, -1, 0,
    1, -1, 0,
    1,  1, 0,
    0,  1, 0,
  ]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

export class EdgeLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.InstancedBufferGeometry;

  private capacity = 0;
  private segmentCount = 0;

  private aA!: THREE.InstancedBufferAttribute;
  private aB!: THREE.InstancedBufferAttribute;
  private aPath!: THREE.InstancedBufferAttribute;
  private aStyle!: THREE.InstancedBufferAttribute;

  /**
   * How many of the held routes are RELATIONS a person could count on screen —
   * corridors and hops, excluding the casings drawn underneath the answer path,
   * excluding the ping slots, and excluding everything flagged `MARK` (the
   * reading axis, its end caps, the banks of a strait crossing). Those are
   * strokes, but none of them is a claim between two nodes.
   *
   * The HUD is allowed to claim "STROKED n" only if n is a number the eye can
   * verify against the frame, so the renderer reports what it actually drew
   * rather than what it was handed.
   */
  strokes = 0;

  private routes: RouteRecord[] = [];
  private routeByKey = new Map<string, number>();
  private relaxing: number[] = [];
  private relaxStart = 0;
  private relaxDuration = 0;

  private pings: Ping[] = [];
  private pingBase = 0;

  constructor(
    private palette: Palette,
    sharedUniforms: Record<string, THREE.IUniform>,
  ) {
    this.geometry = new THREE.InstancedBufferGeometry();
    const quad = segmentQuad();
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setIndex(quad.getIndex());
    quad.dispose();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...sharedUniforms,
        uRender: { value: new THREE.Vector3() },
        uRenderDeep: { value: new THREE.Vector3() },
        uEvidence: { value: new THREE.Vector3() },
        uAlarm: { value: new THREE.Vector3() },
        uInk: { value: new THREE.Vector3() },
        uDashPx: { value: 7 },
        uFogEdge: { value: 0.1 },
        uTrimPx: { value: 6 },
        uHorizonPx: { value: 108 },
      },
      vertexShader: EDGE_VERT,
      fragmentShader: EDGE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      premultipliedAlpha: true,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.applyPalette(palette);
    this.allocate(1024);
  }

  applyPalette(p: Palette): void {
    this.palette = p;
    const u = this.material.uniforms;
    (u.uRender.value as THREE.Vector3).fromArray(p.srgb.render);
    (u.uRenderDeep.value as THREE.Vector3).fromArray(p.srgb['render-deep']);
    (u.uEvidence.value as THREE.Vector3).fromArray(p.srgb.evidence);
    (u.uAlarm.value as THREE.Vector3).fromArray(p.srgb.alarm);
    (u.uInk.value as THREE.Vector3).fromArray(p.srgb.ink);
  }

  setDashPx(px: number): void {
    this.material.uniforms.uDashPx.value = px;
  }

  /**
   * How many display pixels of margin a stroke fades out over at the frame edge.
   *
   * A relation whose far endpoint is off-camera has to LEAVE the picture, not be
   * cut off in it. Without this the asset and passage rungs read as a bundle of
   * severed wires running to nowhere, which is the map claiming a connection it
   * is showing only one end of.
   */
  setHorizonPx(px: number): void {
    this.material.uniforms.uHorizonPx.value = Math.max(1, px);
  }

  /** How far a route stops short of the nodes it joins, in CSS px. */
  setTrimPx(px: number): void {
    this.material.uniforms.uTrimPx.value = px;
  }

  /** What an unattended relation keeps once an answer has been rendered. */
  setFog(edge: number): void {
    this.material.uniforms.uFogEdge.value = edge;
  }

  private allocate(capacity: number): void {
    this.capacity = capacity;
    /* Same instance-ceiling invalidation as the point layer, and it bit just as
     * hard here: three caches `_maxInstanceCount` on first bind, this layer
     * starts at 1,024 segments, and a bundled skeleton is ~18 segments per
     * corridor — so past about sixty corridors every further segment was
     * dropped. The HUD counted routes the frame never contained. */
    (this.geometry as unknown as { _maxInstanceCount?: number })._maxInstanceCount = undefined;
    const mk = (size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aA = mk(2);
    this.aB = mk(2);
    this.aPath = mk(4);
    this.aStyle = mk(4);
    this.geometry.setAttribute('aA', this.aA);
    this.geometry.setAttribute('aB', this.aB);
    this.geometry.setAttribute('aPath', this.aPath);
    this.geometry.setAttribute('aStyle', this.aStyle);
  }

  /** Total instances currently drawn, pings included. For the frame readout. */
  get instances(): number {
    return this.geometry.instanceCount;
  }

  /** Routes currently held (corridors or relations), pings excluded. */
  get routeCount(): number {
    return this.routes.length;
  }

  /**
   * Replace the whole edge set. Called on a view change, never per frame.
   * The instance buffer is reused when it is already big enough.
   */
  setRoutes(specs: readonly RouteSpec[]): void {
    let segments = 0;
    for (const s of specs) segments += Math.max(1, s.route.pts.length / 2 - 1);
    const needed = segments + MAX_PINGS;
    if (needed > this.capacity) this.allocate(Math.ceil(needed * 1.3));

    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    const P = this.aPath.array as Float32Array;
    const S = this.aStyle.array as Float32Array;

    this.routes.length = 0;
    this.routeByKey.clear();
    this.relaxing.length = 0;
    this.strokes = 0;

    let idx = 0;
    for (const spec of specs) {
      if ((spec.flags & (EDGE_FLAG.CASING | EDGE_FLAG.MARK)) === 0) this.strokes++;
      const pts = spec.route.pts;
      const arc = spec.route.arc;
      const m = pts.length / 2;
      const total = arc[m - 1] || 1;
      const start = idx;
      for (let k = 0; k < m - 1; k++) {
        A[idx * 2] = pts[k * 2];
        A[idx * 2 + 1] = pts[k * 2 + 1];
        B[idx * 2] = pts[(k + 1) * 2];
        B[idx * 2 + 1] = pts[(k + 1) * 2 + 1];
        P[idx * 4] = arc[k];
        P[idx * 4 + 1] = arc[k + 1];
        P[idx * 4 + 2] = arc[k] / total;
        P[idx * 4 + 3] = arc[k + 1] / total;
        S[idx * 4] = spec.width;
        S[idx * 4 + 1] = spec.sigma;
        S[idx * 4 + 2] = spec.alpha;
        S[idx * 4 + 3] = spec.flags;
        idx++;
      }
      this.routeByKey.set(spec.key, this.routes.length);
      this.routes.push({
        start,
        count: idx - start,
        pts,
        arc,
        relaxCur: 0,
        relaxTarget: 0,
        key: spec.key,
      });
    }

    this.segmentCount = idx;
    this.pingBase = idx;
    // Park the ping slots off the buffer's live geometry until one is fired.
    for (let i = 0; i < MAX_PINGS; i++) {
      const p = this.pingBase + i;
      S[p * 4 + 2] = 0;
      S[p * 4 + 1] = PING_CODE;
      A[p * 2] = 0;
      A[p * 2 + 1] = 0;
      B[p * 2] = 0;
      B[p * 2 + 1] = 0;
    }
    for (const ping of this.pings) ping.resolve();
    this.pings.length = 0;

    this.geometry.instanceCount = this.segmentCount + MAX_PINGS;
    for (const a of [this.aA, this.aB, this.aPath, this.aStyle]) {
      a.clearUpdateRanges();
      a.needsUpdate = true;
    }
  }

  /**
   * Relax the named routes toward their true straight chords, and re-bundle
   * everything else. `keys` empty means "everything back to the corridor view".
   */
  setRelaxed(keys: Iterable<string>): void {
    const wanted = new Set(keys);
    this.relaxing.length = 0;
    for (let i = 0; i < this.routes.length; i++) {
      const target = wanted.has(this.routes[i].key) ? 1 : 0;
      if (this.routes[i].relaxTarget === target && this.routes[i].relaxCur === target) continue;
      this.routes[i].relaxTarget = target;
      this.relaxing.push(i);
    }
    if (this.relaxing.length === 0) return;
    this.relaxDuration = this.palette.reducedMotion ? this.palette.ms.fast : this.palette.ms.scene;
    this.relaxStart = performance.now();
    if (this.relaxDuration <= 0) this.applyRelax(1);
  }

  /**
   * Fire a provenance trace: old light travelling from one node to another.
   * Resolves when the comet arrives. A trace is drawn as a DIRECT chord, because
   * a citation is a direct claim about a source, not a route through traffic.
   */
  ping(ax: number, ay: number, bx: number, by: number, durationMs?: number): Promise<void> {
    if (this.pings.length >= MAX_PINGS) return Promise.resolve();
    const used = new Set(this.pings.map((p) => p.slot));
    let slot = -1;
    for (let i = 0; i < MAX_PINGS; i++) {
      if (!used.has(i)) {
        slot = i;
        break;
      }
    }
    if (slot < 0) return Promise.resolve();

    const i = this.pingBase + slot;
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    const P = this.aPath.array as Float32Array;
    const S = this.aStyle.array as Float32Array;
    A[i * 2] = ax;
    A[i * 2 + 1] = ay;
    B[i * 2] = bx;
    B[i * 2 + 1] = by;
    P[i * 4] = 0;
    P[i * 4 + 1] = Math.hypot(bx - ax, by - ay);
    P[i * 4 + 2] = 0; // head position, animated
    P[i * 4 + 3] = 0.22; // comet length as a fraction of the chord
    S[i * 4] = this.palette.lodStroke[0] * 1.4;
    S[i * 4 + 1] = PING_CODE;
    S[i * 4 + 2] = 0.95;
    S[i * 4 + 3] = 0;
    this.markPing(i);

    const duration = this.palette.reducedMotion
      ? this.palette.ms.fast
      : (durationMs ?? this.palette.ms.scene);
    return new Promise<void>((resolve) => {
      this.pings.push({ slot, start: performance.now(), duration, resolve });
    });
  }

  /** Advance relax and ping animations. Returns true while anything is live. */
  tick(now: number): boolean {
    let live = false;

    if (this.relaxing.length > 0) {
      const p = this.relaxDuration <= 0 ? 1 : Math.min(1, (now - this.relaxStart) / this.relaxDuration);
      this.applyRelax(p * p * (3 - 2 * p));
      if (p >= 1) this.relaxing.length = 0;
      live = true;
    }

    if (this.pings.length > 0) {
      const P = this.aPath.array as Float32Array;
      const S = this.aStyle.array as Float32Array;
      for (let n = this.pings.length - 1; n >= 0; n--) {
        const ping = this.pings[n];
        const i = this.pingBase + ping.slot;
        const p = ping.duration <= 0 ? 1 : Math.min(1, (now - ping.start) / ping.duration);
        // The head runs past 1 so the tail clears the target before it stops.
        P[i * 4 + 2] = p * (1 + P[i * 4 + 3]);
        S[i * 4 + 2] = 0.95 * (1 - Math.max(0, p - 0.85) / 0.15);
        this.markPing(i);
        if (p >= 1) {
          S[i * 4 + 2] = 0;
          this.markPing(i);
          this.pings.splice(n, 1);
          ping.resolve();
        }
      }
      live = true;
    }

    return live;
  }

  private markPing(i: number): void {
    this.aPath.addUpdateRange(i, 1);
    this.aPath.needsUpdate = true;
    this.aStyle.addUpdateRange(i, 1);
    this.aStyle.needsUpdate = true;
  }

  /** Interpolate the animating routes between their bundled and straight forms. */
  private applyRelax(e: number): void {
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    for (const ri of this.relaxing) {
      const r = this.routes[ri];
      // `e` is transition progress; `t` is how straight this particular route
      // should be right now — routes relaxing out and routes bundling back run
      // on the same clock in opposite directions.
      const t = Math.min(1, Math.max(0, r.relaxTarget === 1 ? e : 1 - e));
      const m = r.pts.length / 2;
      const x0 = r.pts[0];
      const y0 = r.pts[1];
      const x1 = r.pts[(m - 1) * 2];
      const y1 = r.pts[(m - 1) * 2 + 1];
      for (let k = 0; k < m - 1; k++) {
        const i = r.start + k;
        const fa = k / (m - 1);
        const fb = (k + 1) / (m - 1);
        A[i * 2] = r.pts[k * 2] + (x0 + (x1 - x0) * fa - r.pts[k * 2]) * t;
        A[i * 2 + 1] = r.pts[k * 2 + 1] + (y0 + (y1 - y0) * fa - r.pts[k * 2 + 1]) * t;
        B[i * 2] = r.pts[(k + 1) * 2] + (x0 + (x1 - x0) * fb - r.pts[(k + 1) * 2]) * t;
        B[i * 2 + 1] = r.pts[(k + 1) * 2 + 1] + (y0 + (y1 - y0) * fb - r.pts[(k + 1) * 2 + 1]) * t;
      }
      r.relaxCur = t;
      this.aA.addUpdateRange(r.start, r.count);
      this.aB.addUpdateRange(r.start, r.count);
    }
    this.aA.needsUpdate = true;
    this.aB.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
