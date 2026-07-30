/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE POINT CLOUD
 * =============================================================================
 *
 * ONE instanced draw for the ENTIRE terrain. Not one per rung, not one per
 * community, not one per LOD tier — one. Everything that varies per node is an
 * instanced attribute in a typed array that is allocated once, written in place,
 * and uploaded as PARTIAL RANGES. Nothing in this file allocates during a frame.
 *
 * -----------------------------------------------------------------------------
 * WHY THE WHOLE BAKE IS ALWAYS RESIDENT
 * -----------------------------------------------------------------------------
 * The point cloud is built from `LayoutBake.positions` — every node in the
 * world, at every rung, at all times — and not from the current view's node
 * list. That is the load-bearing decision behind `latent`: descending from the
 * island rung to one asset must not DELETE the rest of the world, it must
 * demote it. The terrain never has holes, "omitted" is a rendering decision
 * rather than a deletion, and the user's spatial memory survives the descent
 * because everything they memorised is still on screen, just quieter.
 *
 * At 6,000 nodes this costs 6,000 instances. At 100,000 it costs 100,000, which
 * is 400,000 vertex invocations and one draw call — the reason the buffer is
 * built this way in the first place.
 *
 * -----------------------------------------------------------------------------
 * THE LOD ATTRIBUTE IS ANIMATED, THE LOD DECISION IS NOT
 * -----------------------------------------------------------------------------
 * `setLod()` records a TARGET per node. The attribute the GPU reads slides from
 * the previous value to that target over `--t-ui` so the node crossfades through
 * the resolution ramp. The engine's decision is instantaneous and honest; only
 * its depiction is eased. No instrument readout is animated anywhere near this.
 * ========================================================================== */

import * as THREE from 'three';

import { LOD_INDEX, hueIndexOf, type Palette } from '@/graph/palette';
import { NODE_FLAG, POINT_FRAG, POINT_VERT } from '@/graph/shaders/points';
import type { LodState, NodePosition } from '@/engine';

export { NODE_FLAG };

/** Region kinds render as a boundary + capital rather than as a filled disc. */
const REGION_KINDS = new Set(['continent', 'island', 'asset']);

/** Above this many touched instances, a full re-upload beats a range list. */
const RANGE_LIST_LIMIT = 48;

/** The quad every instance expands, corners in [-1, 1]. */
function unitQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // prettier-ignore
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0,
     1, -1, 0,
     1,  1, 0,
    -1,  1, 0,
  ]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

export class PointLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.InstancedBufferGeometry;

  private capacity = 0;
  /** Live instance count. Equals the number of baked positions. */
  count = 0;

  private aPos!: THREE.InstancedBufferAttribute;
  private aRadius!: THREE.InstancedBufferAttribute;
  private aLod!: THREE.InstancedBufferAttribute;
  private aFlags!: THREE.InstancedBufferAttribute;
  private aMeta!: THREE.InstancedBufferAttribute;

  /** Where the ramp is heading, per instance. Set by `setLod`. */
  private lodTarget = new Float32Array(0);
  /** Where the ramp was when the current transition started. */
  private lodFrom = new Float32Array(0);
  /**
   * Instances still crossfading.
   *
   * PERSISTENT, and that is load-bearing. A view change fires several
   * retargets in a row — scene, then selection, then constellation — and an
   * earlier version of this class rebuilt the list from scratch each time. A
   * retarget that changed nothing therefore emptied the list while a transition
   * was still in flight, and four thousand nodes froze half way between `ghost`
   * and `latent`: the whole terrain sat two ramp steps too bright, permanently,
   * and the interface was lying about what the engine had spent on.
   */
  private lodChanged: number[] = [];
  private lodPending = new Set<number>();
  private lodStart = 0;
  private lodDuration = 0;
  private lodAnimating = false;

  private flagDirty: number[] = [];
  private flagDirtyAll = false;

  /** node id -> instance index. The only lookup the hot paths need. */
  readonly index = new Map<string, number>();
  /** Instance index -> node id, for picking and labels. */
  ids: string[] = [];

  constructor(
    private palette: Palette,
    sharedUniforms: Record<string, THREE.IUniform>,
  ) {
    this.geometry = new THREE.InstancedBufferGeometry();
    const quad = unitQuad();
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setIndex(quad.getIndex());
    quad.dispose();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...sharedUniforms,
        uInk: { value: new THREE.Vector3() },
        uRender: { value: new THREE.Vector3() },
        uAlarm: { value: new THREE.Vector3() },
        uHue: { value: [] as THREE.Vector3[] },
        uLodOpacity: { value: new Float32Array(5) },
        uLodStroke: { value: new Float32Array(5) },
        uLodGlow: { value: new Float32Array(5) },
        uDotMin: { value: 1 },
        uDotMax: { value: 9 },
        uCapital: { value: 2.2 },
        uBody: { value: new THREE.Vector2(5, 14) },
        uAnswer: { value: 16 },
        uPath: { value: 11 },
        uBodyNorm: { value: 1 },
        uGlowCeiling: { value: 6 },
        uGhostBlur: { value: 1 },
        uFogDemote: { value: 1.35 },
        uRecede: { value: 0 },
      },
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      premultipliedAlpha: true,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.applyPalette(palette);
    // Allocate up front so an EMPTY corpus — zero positions, which is a real
    // state and not an error — has somewhere to write nothing.
    this.allocate(1024);
  }

  applyPalette(p: Palette): void {
    this.palette = p;
    const u = this.material.uniforms;
    (u.uInk.value as THREE.Vector3).fromArray(p.srgb.ink);
    (u.uRender.value as THREE.Vector3).fromArray(p.srgb.render);
    (u.uAlarm.value as THREE.Vector3).fromArray(p.srgb.alarm);
    u.uHue.value = p.hue.map((h) => new THREE.Vector3(h[0], h[1], h[2]));
    (u.uLodOpacity.value as Float32Array).set(p.lodOpacity);
    (u.uLodStroke.value as Float32Array).set(p.lodStroke);
    (u.uLodGlow.value as Float32Array).set(p.lodGlow);
    u.uGlowCeiling.value = p.lodGlow[0];
    u.uGhostBlur.value = p.ghostBlur;
  }

  /** Terrain geometry tokens, read once by the terrain and pushed down here. */
  setGeometryTokens(
    dotMin: number,
    dotMax: number,
    capital: number,
    bodyMin: number,
    bodyMax: number,
    answer: number,
    path: number,
  ): void {
    this.material.uniforms.uDotMin.value = dotMin;
    this.material.uniforms.uDotMax.value = dotMax;
    this.material.uniforms.uCapital.value = capital;
    (this.material.uniforms.uBody.value as THREE.Vector2).set(bodyMin, bodyMax);
    this.material.uniforms.uAnswer.value = answer;
    this.material.uniforms.uPath.value = path;
  }

  /**
   * How far along the RESOLUTION RAMP an unattended node drops once an answer
   * has been rendered.
   *
   * Steps, not a multiplier. A fogged node is drawn exactly like a node the
   * engine admitted one tier lower, and `latent` is the floor — which is how
   * "peripheral nodes remain as ghost context" becomes something the renderer
   * enforces rather than something the caption claims.
   */
  setFog(demoteSteps: number): void {
    this.material.uniforms.uFogDemote.value = Math.max(0, demoteSteps);
  }

  /**
   * The world radius of the LARGEST BODY AT THE CURRENT RUNG.
   *
   * Body size is relative to peers, and who the peers are is a property of the
   * rung you are standing on rather than of the bake: an island compared against
   * the continent that contains it is always tiny, and normalising that way put
   * every island in the bottom quarter of the size range at the one altitude
   * where islands are the subject.
   */
  setBodyNorm(r: number): void {
    this.material.uniforms.uBodyNorm.value = Math.max(r, 1e-3);
  }

  /**
   * How hard the rungs BELOW the current one pull back, 0..1.
   *
   * The whole bake is always resident — that is what makes `latent` honest and
   * what stops the terrain having holes. But "present" and "equally loud" are
   * different claims, and drawing 4,406 leaves at the same weight from the
   * continent rung as from the asset rung is what made two of the four altitudes
   * the same photograph.
   */
  setRecede(v: number): void {
    this.material.uniforms.uRecede.value = Math.max(0, Math.min(1, v));
  }

  /**
   * Rebuild the cloud from a bake. Reallocates only when the world grew — a
   * re-bake of the same corpus writes in place.
   */
  setPositions(positions: readonly NodePosition[]): void {
    const n = positions.length;
    if (n > this.capacity) this.allocate(Math.max(n, Math.ceil(n * 1.25)));

    const pos = this.aPos.array as Float32Array;
    const rad = this.aRadius.array as Float32Array;
    const meta = this.aMeta.array as Float32Array;
    const lod = this.aLod.array as Float32Array;
    const flags = this.aFlags.array as Float32Array;

    this.index.clear();
    this.ids.length = n;

    for (let i = 0; i < n; i++) {
      const p = positions[i];
      pos[i * 2] = p.x;
      pos[i * 2 + 1] = p.y;
      rad[i] = p.r;
      meta[i * 2] = hueIndexOf(p.community_id);
      // Centrality is not on `NodePosition`; the bake already folded it into the
      // radius, so the capital size is derived from the radius rather than
      // re-deriving a value the payload does not carry.
      meta[i * 2 + 1] = 0;
      lod[i] = LOD_INDEX[p.lod_hint];
      flags[i] = REGION_KINDS.has(p.kind) ? NODE_FLAG.REGION : 0;
      this.index.set(p.id, i);
      this.ids[i] = p.id;
    }

    /* Body size scales with how big a region is RELATIVE TO ITS OWN SIBLINGS —
     * a real proxy for how much the bake thinks it contains.
     *
     * Per kind, not globally, and that is the difference between a rung that
     * reads and one that does not: a continent's containment radius is four
     * times an island's, so a single global maximum put every island in the
     * bottom quarter of the size range and every asset at the floor. Each rung
     * gets the full range among its peers, which is what the reader is
     * comparing anyway — islands against islands, never against continents. */
    const maxByKind = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const kind = positions[i].kind;
      if (!REGION_KINDS.has(kind)) continue;
      maxByKind.set(kind, Math.max(maxByKind.get(kind) ?? 0, rad[i]));
    }
    for (let i = 0; i < n; i++) {
      const kind = positions[i].kind;
      if (!REGION_KINDS.has(kind)) continue;
      const max = maxByKind.get(kind) ?? 0;
      meta[i * 2 + 1] = max > 0 ? Math.min(1, rad[i] / max) : 0;
    }

    this.count = n;
    this.geometry.instanceCount = n;

    this.lodTarget.set(lod.subarray(0, n));
    this.lodFrom.set(lod.subarray(0, n));
    this.lodChanged.length = 0;
    this.lodPending.clear();
    this.lodAnimating = false;

    for (const a of [this.aPos, this.aRadius, this.aLod, this.aFlags, this.aMeta]) {
      a.clearUpdateRanges();
      a.needsUpdate = true;
    }
    this.flagDirty.length = 0;
    this.flagDirtyAll = false;
  }

  private allocate(capacity: number): void {
    this.capacity = capacity;
    /* THE INSTANCE CEILING HAS TO BE INVALIDATED WHEN THE BUFFERS GROW.
     *
     * three caches `_maxInstanceCount` on the geometry the FIRST time it binds
     * instanced attributes — `if (geometry._maxInstanceCount === undefined)` —
     * and then draws `min(instanceCount, _maxInstanceCount)` forever. This class
     * pre-allocates 1,024 instances in its constructor so that an EMPTY corpus
     * has somewhere to write nothing, then grows to fit the real bake.
     *
     * The consequence, until now, was that THE TERRAIN ONLY EVER DREW ITS FIRST
     * 1,024 NODES. Everything from instance 1,024 on — which on the demo corpus
     * is every continent, every island, most entities and the answer entity
     * itself — was silently absent from every frame. The map looked plausible
     * because 1,024 leaves still make a texture, and because the DOM label layer
     * draws its own glyph next to each name: every "island dot" a reader has
     * ever seen in this product was a text character, not a node.
     *
     * Clearing the cached ceiling is the whole fix. It is one line, and it is
     * the difference between a renderer and a decoration. */
    (this.geometry as unknown as { _maxInstanceCount?: number })._maxInstanceCount = undefined;
    const mk = (size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = mk(2);
    this.aRadius = mk(1);
    this.aLod = mk(1);
    this.aFlags = mk(1);
    this.aMeta = mk(2);
    this.geometry.setAttribute('aPos', this.aPos);
    this.geometry.setAttribute('aRadius', this.aRadius);
    this.geometry.setAttribute('aLod', this.aLod);
    this.geometry.setAttribute('aFlags', this.aFlags);
    this.geometry.setAttribute('aMeta', this.aMeta);
    this.lodTarget = new Float32Array(capacity);
    this.lodFrom = new Float32Array(capacity);
  }

  /* -------------------------------------------------------------------------
   * The resolution ramp
   * ---------------------------------------------------------------------- */

  /**
   * Retarget the ramp. `resolve(i)` returns the LOD the engine admitted this
   * node at; returning the same value it already has costs nothing.
   */
  retargetLod(resolve: (index: number, id: string) => LodState, immediate = false): void {
    const cur = this.aLod.array as Float32Array;
    let changed = false;
    for (let i = 0; i < this.count; i++) {
      const next = LOD_INDEX[resolve(i, this.ids[i])];
      if (this.lodTarget[i] === next) continue;
      this.lodTarget[i] = next;
      this.lodPending.add(i);
      changed = true;
    }
    // Nothing to retarget. Leave any transition already in flight alone — it is
    // still carrying nodes toward a decision this call agrees with.
    if (!changed) return;

    // Everything still in flight restarts from where it actually is, so a second
    // retarget bends the crossfade instead of snapping it back.
    this.lodChanged.length = 0;
    for (const i of this.lodPending) {
      this.lodFrom[i] = cur[i];
      this.lodChanged.push(i);
    }

    this.lodDuration = immediate || this.palette.reducedMotion ? 0 : this.palette.ms.ui;
    if (this.lodDuration <= 0) {
      for (const i of this.lodChanged) cur[i] = this.lodTarget[i];
      this.uploadLod();
      this.lodChanged.length = 0;
      this.lodPending.clear();
      this.lodAnimating = false;
      return;
    }
    this.lodStart = performance.now();
    this.lodAnimating = true;
  }

  /** Advance the ramp crossfade. Returns true while the transition is live. */
  tickLod(now: number): boolean {
    if (!this.lodAnimating) return false;
    const p = this.lodDuration <= 0 ? 1 : Math.min(1, (now - this.lodStart) / this.lodDuration);
    // Smoothstep, not an easing token: this is not choreography, it is a
    // crossfade between two values of one attribute, and it must be symmetric.
    const e = p * p * (3 - 2 * p);
    const cur = this.aLod.array as Float32Array;
    for (const i of this.lodChanged) {
      cur[i] = this.lodFrom[i] + (this.lodTarget[i] - this.lodFrom[i]) * e;
    }
    this.uploadLod();
    if (p >= 1) {
      this.lodAnimating = false;
      this.lodChanged.length = 0;
      this.lodPending.clear();
    }
    return true;
  }

  private uploadLod(): void {
    this.aLod.clearUpdateRanges();
    if (this.lodChanged.length > RANGE_LIST_LIMIT) {
      this.aLod.addUpdateRange(0, this.count);
    } else {
      for (const i of this.lodChanged) this.aLod.addUpdateRange(i, 1);
    }
    this.aLod.needsUpdate = true;
  }

  /* -------------------------------------------------------------------------
   * Flags
   * ---------------------------------------------------------------------- */

  /** Read the current flag word of one instance. */
  flagsAt(i: number): number {
    return (this.aFlags.array as Float32Array)[i];
  }

  /** Overwrite the mutable half of an instance's flags, keeping REGION intact. */
  setFlags(i: number, flags: number): void {
    const arr = this.aFlags.array as Float32Array;
    const region = arr[i] & NODE_FLAG.REGION;
    const next = (flags & ~NODE_FLAG.REGION) | region;
    if (arr[i] === next) return;
    arr[i] = next;
    if (this.flagDirty.length >= RANGE_LIST_LIMIT) this.flagDirtyAll = true;
    else this.flagDirty.push(i);
  }

  /** Clear every mutable flag on every instance. One pass, no allocation. */
  clearFlags(): void {
    const arr = this.aFlags.array as Float32Array;
    for (let i = 0; i < this.count; i++) arr[i] &= NODE_FLAG.REGION;
    this.flagDirtyAll = true;
  }

  /** Push pending flag writes to the GPU. Cheap and idempotent. */
  flushFlags(): void {
    if (!this.flagDirtyAll && this.flagDirty.length === 0) return;
    this.aFlags.clearUpdateRanges();
    if (this.flagDirtyAll) this.aFlags.addUpdateRange(0, this.count);
    else for (const i of this.flagDirty) this.aFlags.addUpdateRange(i, 1);
    this.aFlags.needsUpdate = true;
    this.flagDirty.length = 0;
    this.flagDirtyAll = false;
  }

  worldPosition(i: number, out: [number, number]): [number, number] {
    const p = this.aPos.array as Float32Array;
    out[0] = p[i * 2];
    out[1] = p[i * 2 + 1];
    return out;
  }

  radiusAt(i: number): number {
    return (this.aRadius.array as Float32Array)[i];
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
