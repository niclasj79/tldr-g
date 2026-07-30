/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE COMMUNITY WASH (making the land)
 * =============================================================================
 *
 * The single most important frame in this product is the terrain at rest, and
 * what decides whether that frame reads as GEOGRAPHY or as a scatter plot is
 * this file. Points alone give you a starfield. Hulls give you a Venn diagram.
 * A Voronoi gives you a claim that every square inch of the plane belongs to
 * somebody, which is the opposite of true — most of a knowledge terrain is
 * EMPTY, and the map has to say so.
 *
 * So the wash is a DENSITY FIELD sampled from where the corpus actually is.
 *
 *   1. Splat every asset and passage into a grid with a small Gaussian kernel,
 *      accumulating both a density and a community-hue sum.
 *   2. Blur twice, separably. Two box passes approximate a Gaussian closely
 *      enough that no coastline shows the grid it was computed on.
 *   3. Normalise against a high PERCENTILE rather than the maximum: one
 *      pathologically dense island must not decide that everywhere else is sea.
 *   4. Upload as an RGBA8 texture. RGB is the local community hue, A is the
 *      normalised density. The shader turns that into land, shore, shelf and
 *      void.
 *
 * -----------------------------------------------------------------------------
 * HOW ISLANDS BECOME A CONTINENT — the shelf pass
 * -----------------------------------------------------------------------------
 * A density field alone gives you thirty-three similarly-sized round blobs
 * evenly spaced on a black ground: a petri dish, not a map. Real geography has
 * MASSES — several centres of population sharing one coastline, joined by low
 * ground, separated from the next mass by water.
 *
 * So a SECOND, much coarser field is built per HUE FAMILY, and the hue family is
 * the region: `hueIndexOf(community_id)` is a stable hash, and the bake mints
 * every community inside one continent into the same bucket. Each family's
 * shelf is then CLOSED — dilated by `--field-merge` and eroded by the same
 * distance, with a true disc. Two communities of the same family within that
 * distance of each other fuse, because the dilation joins them and the erosion
 * cannot reopen what it joined; two communities of different families never
 * fuse however close they are, because their shelves are different channels.
 *
 * And the OUTER coast does not move, which is the half that took three attempts
 * to get right: erosion undoes dilation exactly on a convex boundary, so the
 * world's edge stays on the node cloud the bake produced instead of being puffed
 * out into a smooth envelope by the fuse. That is the difference between a map
 * with peninsulas, bays and an outlying island in it, and a disc.
 *
 * The consequences are the whole point:
 *   - neighbouring islands of one continent share a coastline, with a LOW
 *     ISTHMUS between them that the shader reads as an internal seam;
 *   - the gap between two continents stays below sea level, so it is WATER;
 *   - a STRAIT — the narrow crossing a bridge entity sits in — is a channel with
 *     a real coast on each side rather than an accidental gap between stickers.
 *
 * -----------------------------------------------------------------------------
 * WHAT MAKES LAND, AND WHAT DOES NOT
 * -----------------------------------------------------------------------------
 * Only ASSETS and PASSAGES contribute. Not islands, not continents — a region
 * node is a summary of its contents and letting it splat would paint land that
 * no document is under. And explicitly NOT entities: an entity floats above the
 * spine, and a bridge entity sits by construction IN THE STRAIT between two
 * islands. If entities made land, every bridge entity would silently build an
 * isthmus across the exact channel the demo exists to show you crossing.
 *
 * The field is a pure function of the bake, so it is computed once and cached
 * against `bake_id`. Nothing here runs per frame.
 * ========================================================================== */

import * as THREE from 'three';

import { REGION_FRAG, REGION_VERT, REGION_FOCUS_MAX, REGION_LANDFALL_MAX } from '@/graph/shaders/regions';
import { hueIndexOf, type Palette } from '@/graph/palette';
import { HUE_COUNT } from '@/engine';
import type { Bounds, NodePosition } from '@/engine';

/**
 * Long-axis resolution of the fine field.
 *
 * 512, not 320: the coastline is now derived in SCREEN space from the field's
 * own gradient, so the texel size is what limits how far you can zoom before the
 * wash admits it has run out of resolution and fades. Every texel bought here is
 * an octave of approach that still looks like a map.
 */
const FIELD_LONG_AXIS = 512;

/** Long-axis resolution of the per-family shelf. Coarse by construction. */
const SHELF_LONG_AXIS = 176;

/** What each node kind contributes to the land. See the file header. */
const LAND_WEIGHT: Readonly<Record<string, number>> = {
  passage: 1,
  asset: 1.7,
  source: 0.45,
  entity: 0,
  island: 0,
  continent: 0,
};

export interface RegionField {
  /** RGB = local community hue, A = fine normalised density. */
  texture: THREE.DataTexture;
  /** RGB = dominant hue FAMILY, A = the fused shelf that makes landmasses. */
  shelf: THREE.DataTexture;
  bounds: Bounds;
  width: number;
  height: number;
  /** World units covered by one fine texel. Drives the screen-space coastline. */
  texelWorld: number;
  /**
   * HOW MUCH LAND IS AT THIS WORLD POINT, 0..1 — the same merged height the
   * shader draws (`max(fine, shelf * lift)`), sampled on the CPU.
   *
   * This is the only reason a corridor can know where the water is. A trade
   * route that runs straight over the interior of every landmass between its two
   * regions is a wire, not a route; one that leaves at a coast and crosses open
   * water is the picture the rung is actually making. Reading the same field the
   * wash is drawn from means the route and the coastline can never disagree.
   */
  land(x: number, y: number): number;
}

export interface RegionFieldOptions {
  /** How wide the same-family fuse reaches, as a fraction of the world's long axis. */
  merge: number;
  /** `--field-shelf-cut`. Exponent that keeps a family's shelf near where it is. */
  cut: number;
  /** `--field-merge-lift`. How much of the fused shelf counts as land. */
  lift: number;
  /**
   * `--coast-outer`. WHERE THE SHADER PUTS SEA LEVEL.
   *
   * The shelf has to close its gaps at the same height the wash draws its coast,
   * or the fuse and the coastline are two different claims about where the water
   * is. So the threshold is derived from this and `lift`/`cut` rather than being
   * a number of its own — see the closing in `buildRegionField` §4.
   */
  sea: number;
}

/**
 * Build the density field for a bake.
 *
 * Cost is O(nodes x kernel): ~225k kernel taps on the 6k demo corpus and ~5M at
 * 100k, both once. Both grids are fixed-size, so the cost of the blur and the
 * normalisation does not grow with the corpus at all.
 */
export function buildRegionField(
  positions: readonly NodePosition[],
  bounds: Bounds,
  palette: Palette,
  options: RegionFieldOptions = { merge: 0.032, cut: 1.45, lift: 0.66, sea: 0.2 },
): RegionField {
  // Pad so a coastline never runs off the edge of its own texture.
  const padX = (bounds.max_x - bounds.min_x) * 0.05 + 1;
  const padY = (bounds.max_y - bounds.min_y) * 0.05 + 1;
  const b: Bounds = {
    min_x: bounds.min_x - padX,
    min_y: bounds.min_y - padY,
    max_x: bounds.max_x + padX,
    max_y: bounds.max_y + padY,
  };

  const spanX = Math.max(1e-6, b.max_x - b.min_x);
  const spanY = Math.max(1e-6, b.max_y - b.min_y);
  const longAxis = Math.max(spanX, spanY);
  const cell = longAxis / FIELD_LONG_AXIS;
  const w = Math.max(4, Math.min(FIELD_LONG_AXIS, Math.ceil(spanX / cell)));
  const h = Math.max(4, Math.min(FIELD_LONG_AXIS, Math.ceil(spanY / cell)));
  const n = w * h;

  const dens = new Float32Array(n);
  const hr = new Float32Array(n);
  const hg = new Float32Array(n);
  const hb = new Float32Array(n);

  /* The shelf grid: one density channel per hue FAMILY, at a much coarser
   * resolution because its whole job is to answer "is there more of this
   * region nearby", which is not a question with fine detail in it. */
  const shelfCell = longAxis / SHELF_LONG_AXIS;
  const sw = Math.max(4, Math.min(SHELF_LONG_AXIS, Math.ceil(spanX / shelfCell)));
  const sh = Math.max(4, Math.min(SHELF_LONG_AXIS, Math.ceil(spanY / shelfCell)));
  const sn = sw * sh;
  const family: Float32Array[] = [];
  for (let f = 0; f < HUE_COUNT; f++) family.push(new Float32Array(sn));

  /* ---- 1. splat ---------------------------------------------------------- */
  // A 7x7 Gaussian. Small enough to stay cheap, wide enough that individual
  // passages merge into a continuous surface instead of reading as blobs.
  const KR = 3;
  const sigma = 1.45;
  const kernel = new Float32Array((KR * 2 + 1) * (KR * 2 + 1));
  {
    let k = 0;
    for (let dy = -KR; dy <= KR; dy++) {
      for (let dx = -KR; dx <= KR; dx++) {
        kernel[k++] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      }
    }
  }

  for (const p of positions) {
    const weight = LAND_WEIGHT[p.kind] ?? 0;
    if (weight <= 0) continue;
    const cx = Math.floor(((p.x - b.min_x) / spanX) * w);
    const cy = Math.floor(((p.y - b.min_y) / spanY) * h);
    if (cx < -KR || cy < -KR || cx >= w + KR || cy >= h + KR) continue;

    const familyIndex = hueIndexOf(p.community_id);
    const hue = palette.hue[familyIndex];

    // The shelf takes one tap per node — it is about to be blurred by a radius
    // fifty times its own cell size, so a kernel here would be wasted work.
    {
      const fx = Math.floor(((p.x - b.min_x) / spanX) * sw);
      const fy = Math.floor(((p.y - b.min_y) / spanY) * sh);
      if (fx >= 0 && fy >= 0 && fx < sw && fy < sh) family[familyIndex][fy * sw + fx] += weight;
    }

    let k = 0;
    for (let dy = -KR; dy <= KR; dy++) {
      const gy = cy + dy;
      if (gy < 0 || gy >= h) {
        k += KR * 2 + 1;
        continue;
      }
      const row = gy * w;
      for (let dx = -KR; dx <= KR; dx++) {
        const gx = cx + dx;
        const kv = kernel[k++];
        if (gx < 0 || gx >= w) continue;
        const c = row + gx;
        const contribution = kv * weight;
        dens[c] += contribution;
        hr[c] += hue[0] * contribution;
        hg[c] += hue[1] * contribution;
        hb[c] += hue[2] * contribution;
      }
    }
  }

  /* ---- 2. blur ----------------------------------------------------------- */
  blurSeparable(dens, w, h, 2);
  blurSeparable(hr, w, h, 2);
  blurSeparable(hg, w, h, 2);
  blurSeparable(hb, w, h, 2);

  /* ---- 3. normalise against a percentile, then lift ----------------------- */
  // p92, not the maximum: one pathologically dense island must not decide that
  // everywhere else is sea. The gamma lift afterwards is not cosmetic — an 8-bit
  // alpha channel spends most of its codes on the few brightest cells otherwise,
  // and the coastline (which lives in the low mid-tones) quantises into steps.
  const norm = percentile(dens, 0.92);
  const inv = norm > 1e-9 ? 1 / norm : 0;
  const GAMMA = 0.62;

  /* ---- 4. the shelf: fuse each hue family across the merge distance -------
   *
   * =========================================================================
   * WHY THE WORLD'S OUTER COAST WAS A DISC, AND WHAT REPLACED THE HALO
   * =========================================================================
   * A wide blur cannot tell the difference between the two things it is being
   * asked about. "Is there more of this family nearby" is true in an ISTHMUS --
   * the low ground between two islands of one continent, which the shelf exists
   * to build — and it is equally true just OUTSIDE the outermost island, where
   * the shelf has nothing to join and only puffs the coast outward by its own
   * kernel width. Do that for every family and the union of the puffs is a
   * smooth convex envelope: the whole world reads as one disc, every lobe the
   * bake gave a community is sanded off, and the map goes back to being a
   * diagram of clusters with a soft edge.
   *
   * What the shelf actually wants is a MORPHOLOGICAL CLOSING — dilate by the
   * merge distance, then erode by the same distance:
   *
   *   a gap narrower than twice the merge distance   closes and stays closed,
   *                                                  because the erosion cannot
   *                                                  reopen what the dilation
   *                                                  joined;
   *   the outer coast                                returns to where it began,
   *                                                  because on a convex
   *                                                  boundary erosion undoes
   *                                                  dilation exactly.
   *
   * That is the whole operation. The isthmus survives, the halo does not, and
   * the outer coast falls back onto the node cloud the bake actually produced --
   * which is lobed, because the bake gives every community a harmonic coastline
   * of its own. The peninsulas, the bays and the outlying island are the
   * corpus's own shape finally being allowed through, not noise added on top.
   *
   * THE STRUCTURING ELEMENT IS A TRUE DISC, and that is not a detail. Two
   * earlier attempts at this used separable box passes and a centroid-balance
   * test, and both drew LANDMASSES WITH STRAIGHT COASTS AND SHARP CORNERS: a
   * square kernel leaves square corners, and a balance test between two clumps
   * leaves the straight band of their perpendicular bisector. A coastline drawn
   * with a ruler is the convolution presenting itself as geography, which is the
   * exact failure this file exists to avoid. A disc can only add circular arcs.
   *
   * The disc comes from an exact Euclidean distance transform, so the cost is
   * O(cells) per family and independent of the radius — see `sqDistance`.
   *
   * Nothing here is seeded, sampled or randomised. Two blurs, two distance
   * transforms and a threshold, all pure functions of the bake, so the coastline
   * stays deterministic and content-addressed. */
  const mergeWorld = longAxis * Math.max(0, options.merge);
  const mergeCells = Math.max(1, mergeWorld / Math.max(shelfCell, 1e-6));

  /* The coast blur. Small: its only job is to turn a family's scattered taps
   * into a contiguous body, and every cell of radius past that is a lobe of the
   * real coastline being sanded off. Three passes rather than two, because the
   * threshold below is a hard decision and a bi-quadratic kernel would hand it a
   * diamond to decide on. */
  const COAST_PASSES = 3;
  const coastR = Math.max(1, Math.round(mergeCells * 0.36));
  for (let f = 0; f < HUE_COUNT; f++) {
    for (let q = 0; q < COAST_PASSES; q++) boxBlur(family[f], sw, sh, coastR);
  }

  /* Every family is normalised against ITS OWN p92, so a small continent is a
   * real continent and not a sandbar. Varying the wash by community size is the
   * brief's ask; scaling everything against one global maximum is what made
   * thirty-three regions look like thirty-three identical amoebae. It has to
   * happen HERE, before the threshold, or the closing would be cutting each
   * family at a different height. */
  for (let f = 0; f < HUE_COUNT; f++) {
    const d = family[f];
    const p = percentile(d, 0.92);
    const s = p > 1e-9 ? 1 / p : 0;
    for (let i = 0; i < sn; i++) d[i] *= s;
  }

  /* WHERE THE SHELF THINKS THE SEA IS — derived from the two numbers the shader
   * will use on the other side of the upload, not chosen here. The wash calls a
   * point land when shelf^cut * lift clears --coast-outer, so the shelf's own sea
   * level is the value that satisfies exactly that. Deriving it means the closing
   * operates on the same coastline the eye is shown; picking a number would mean
   * the fuse and the coast could quietly disagree about where the water is. */
  const sea = Math.min(
    0.95,
    Math.max(
      0.02,
      Math.pow(options.sea / Math.max(options.lift, 1e-3), 1 / Math.max(options.cut, 1e-3)),
    ),
  );
  /* And what a filled gap is worth: just above sea level, because an isthmus is
   * LOW GROUND. It is the seam between two islands of one continent, not a
   * plateau that would hide the join the shader is about to draw across it. */
  const isthmusHeight = sea * 1.16;

  {
    const scratch = new Float64Array(sn);
    const solid = new Uint8Array(sn);
    const rr = mergeCells * mergeCells;
    for (let f = 0; f < HUE_COUNT; f++) {
      const d = family[f];
      // DILATE: every cell within the merge distance of this family's own land.
      for (let i = 0; i < sn; i++) scratch[i] = d[i] >= sea ? 0 : Infinity;
      sqDistance(scratch, sw, sh);
      for (let i = 0; i < sn; i++) solid[i] = scratch[i] <= rr ? 1 : 0;
      // ERODE: give back every cell within the merge distance of the outside.
      // What survives both is the original land plus the gaps that closed.
      for (let i = 0; i < sn; i++) scratch[i] = solid[i] === 0 ? 0 : Infinity;
      sqDistance(scratch, sw, sh);
      for (let i = 0; i < sn; i++) {
        if (scratch[i] > rr && d[i] < isthmusHeight) d[i] = isthmusHeight;
      }
      // The closing decided in whole cells; the coast is drawn in fractions of a
      // pixel. Two short passes turn the decision back into a surface.
      boxBlur(d, sw, sh, coastR);
      boxBlur(d, sw, sh, coastR);
    }
  }

  const shelfData = new Uint8Array(sn * 4);
  for (let i = 0; i < sn; i++) {
    let best = 0;
    let bestF = -1;
    for (let f = 0; f < HUE_COUNT; f++) {
      const v = family[f][i];
      if (v > best) {
        best = v;
        bestF = f;
      }
    }
    if (bestF < 0) continue;
    const hue = palette.hue[bestF];
    shelfData[i * 4] = clamp255(hue[0] * 255);
    shelfData[i * 4 + 1] = clamp255(hue[1] * 255);
    shelfData[i * 4 + 2] = clamp255(hue[2] * 255);
    // CUT, not lift. A wide blur leaves a faint halo of every family over most of
    // the world; raising it with the same gamma the fine field uses turned that
    // halo into land and fused the whole map into one continent. The exponent
    // above 1 keeps a family's shelf where the family actually is.
    shelfData[i * 4 + 3] = clamp255(Math.pow(Math.min(1, best), options.cut) * 255);
  }

  /* ---- 5. pack ------------------------------------------------------------ */
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const d = dens[i];
    if (d <= 1e-7) continue;
    const s = 1 / d;
    data[i * 4] = clamp255(hr[i] * s * 255);
    data[i * 4 + 1] = clamp255(hg[i] * s * 255);
    data[i * 4 + 2] = clamp255(hb[i] * s * 255);
    data[i * 4 + 3] = clamp255(Math.pow(Math.min(1, d * inv), GAMMA) * 255);
  }

  /* ---- 6. the CPU-side land sampler --------------------------------------
   * Bilinear on the SAME merged height the shader draws, so a routed corridor
   * and the coastline it is dodging are reading one number. Closes over the two
   * byte arrays that were about to become textures — no extra memory, no copy.
   * ---------------------------------------------------------------------- */
  const lift = Math.max(0, options.lift);
  const sample = (arr: Uint8Array, aw: number, ah: number, u: number, v: number): number => {
    const fx = Math.min(aw - 1, Math.max(0, u * aw - 0.5));
    const fy = Math.min(ah - 1, Math.max(0, v * ah - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(aw - 1, x0 + 1);
    const y1 = Math.min(ah - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const a00 = arr[(y0 * aw + x0) * 4 + 3];
    const a10 = arr[(y0 * aw + x1) * 4 + 3];
    const a01 = arr[(y1 * aw + x0) * 4 + 3];
    const a11 = arr[(y1 * aw + x1) * 4 + 3];
    return ((a00 + (a10 - a00) * tx) * (1 - ty) + (a01 + (a11 - a01) * tx) * ty) / 255;
  };

  return {
    texture: dataTexture(data, w, h),
    shelf: dataTexture(shelfData, sw, sh),
    bounds: b,
    width: w,
    height: h,
    texelWorld: Math.max(spanX / w, spanY / h),
    land(x: number, y: number): number {
      const u = (x - b.min_x) / spanX;
      const v = (y - b.min_y) / spanY;
      if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
      return Math.max(sample(data, w, h, u, v), sample(shelfData, sw, sh, u, v) * lift);
    },
  };
}

function dataTexture(data: Uint8Array<ArrayBuffer>, w: number, h: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A separable box blur of half-width `r`, by running sum.
 *
 * O(cells) regardless of the radius, which is the only reason a 20-cell kernel
 * over eight families is affordable at all. Edges clamp rather than wrap, so a
 * landmass at the border of the world does not bleed round to the far side.
 */
function boxBlur(a: Float32Array, w: number, h: number, r: number): void {
  const line = new Float32Array(Math.max(w, h));
  const inv = 1 / (r * 2 + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) line[x] = a[row + x];
    let sum = line[0] * (r + 1);
    for (let x = 1; x <= r; x++) sum += line[Math.min(x, w - 1)];
    for (let x = 0; x < w; x++) {
      a[row + x] = sum * inv;
      sum += line[Math.min(x + r + 1, w - 1)] - line[Math.max(x - r, 0)];
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = a[y * w + x];
    let sum = line[0] * (r + 1);
    for (let y = 1; y <= r; y++) sum += line[Math.min(y, h - 1)];
    for (let y = 0; y < h; y++) {
      a[y * w + x] = sum * inv;
      sum += line[Math.min(y + r + 1, h - 1)] - line[Math.max(y - r, 0)];
    }
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * EXACT SQUARED EUCLIDEAN DISTANCE TRANSFORM, in place, O(cells).
 *
 * `a` arrives as a cost grid — 0 at a seed, `Infinity` elsewhere — and leaves
 * holding the squared distance from every cell to the nearest seed. Felzenszwalb
 * and Huttenlocher's lower-envelope-of-parabolas sweep, run down the columns and
 * then along the rows, which is what makes a separable pass produce a genuinely
 * ISOTROPIC result: the answer is the same to the pixel whichever way the world
 * is rotated, and nothing about the grid survives into the shape.
 *
 * That isotropy is the whole reason it is here rather than a box max/min. The
 * shelf's structuring element is a disc because a coastline may not have corners
 * in it that the corpus did not put there, and the cost is independent of the
 * disc's radius, so widening the merge distance is free.
 */
function sqDistance(a: Float64Array, w: number, h: number): void {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  const sweep = (len: number): void => {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
    }
  };

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = a[y * w + x];
    sweep(h);
    for (let y = 0; y < h; y++) a[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = a[row + x];
    sweep(w);
    for (let x = 0; x < w; x++) a[row + x] = d[x];
  }
}

/** Two separable box passes. Allocates one scratch row per call, not per pixel. */
function blurSeparable(a: Float32Array, w: number, h: number, passes: number): void {
  const line = new Float32Array(Math.max(w, h));
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) line[x] = a[row + x];
      for (let x = 0; x < w; x++) {
        const l = line[x > 0 ? x - 1 : 0];
        const r = line[x < w - 1 ? x + 1 : w - 1];
        a[row + x] = (l + line[x] * 2 + r) * 0.25;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) line[y] = a[y * w + x];
      for (let y = 0; y < h; y++) {
        const u = line[y > 0 ? y - 1 : 0];
        const d = line[y < h - 1 ? y + 1 : h - 1];
        a[y * w + x] = (u + line[y] * 2 + d) * 0.25;
      }
    }
  }
}

/**
 * The p-th percentile of the non-zero values.
 *
 * Non-zero only, and this matters: most of the grid is legitimately empty, so
 * including the zeros would put the 98th percentile somewhere in the shallows
 * and every landmass would clip to white.
 */
function percentile(a: Float32Array, p: number): number {
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > 1e-6) count++;
  if (count === 0) return 0;
  const packed = new Float32Array(count);
  let j = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > 1e-6) packed[j++] = a[i];
  packed.sort();
  return packed[Math.min(count - 1, Math.floor(p * (count - 1)))];
}

/* =============================================================================
 * THE LAYER
 * ========================================================================== */

export class RegionLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private field: RegionField | null = null;

  constructor(palette: Palette, sharedUniforms: Record<string, THREE.IUniform>) {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    this.geometry.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2),
    );
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);

    const focus: THREE.Vector4[] = [];
    for (let i = 0; i < REGION_FOCUS_MAX; i++) focus.push(new THREE.Vector4(0, 0, 1, 0));
    const landfall: THREE.Vector4[] = [];
    for (let i = 0; i < REGION_LANDFALL_MAX; i++) landfall.push(new THREE.Vector4(0, 0, 1, 0));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...sharedUniforms,
        uField: { value: null },
        uShelf: { value: null },
        uFieldStep: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        uTexelWorld: { value: 1 },
        uCoast: { value: new THREE.Vector2(0.2, 0.55) },
        uCoastPx: { value: 1.5 },
        uTexelMaxPx: { value: 9 },
        uTexelFade: { value: 1.7 },
        uMerge: { value: new THREE.Vector2(0.72, 0.42) }, // (shelf lift, seam)
        uWash: { value: 0.1 },
        uGrain: { value: 0.55 },
        uFocus: { value: focus },
        uFocusN: { value: 0 },
        uFocusOut: { value: 0.26 },
        uLandfall: { value: landfall },
        uLandfallN: { value: 0 },
        uFogSea: { value: 0.3 },
        uFogCoast: { value: 2.6 },
        uFogLandfall: { value: 1.12 },
      },
      vertexShader: REGION_VERT,
      fragmentShader: REGION_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      premultipliedAlpha: true,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    // Beneath everything. The land is the ground the instruments sit on.
    this.mesh.renderOrder = 0;
    this.applyPalette(palette);
  }

  applyPalette(p: Palette): void {
    // The region wash is a CONTINENT-strength wash by definition: the hue family
    // at ~10%. Island and asset strength live on the nodes, not on the ground.
    this.material.uniforms.uWash.value = p.wash.continent;
  }

  setCoast(outer: number, inner: number): void {
    (this.material.uniforms.uCoast.value as THREE.Vector2).set(outer, inner);
  }

  setGrain(v: number): void {
    this.material.uniforms.uGrain.value = v;
  }

  /**
   * The two numbers that decide whether this is a map or a gradient.
   *
   * `coastPx` is the width of the land/water transition ON THE DISPLAY, and it
   * is the fix for a wash that defocused as you approached it. `texelMaxPx` is
   * the magnification past which one field texel covers so many pixels that the
   * field has stopped measuring anything, and the honest thing to do is fade out
   * rather than paint the screen a colour nobody sampled.
   */
  setResolution(coastPx: number, texelMaxPx: number, texelFade: number): void {
    this.material.uniforms.uCoastPx.value = coastPx;
    this.material.uniforms.uTexelMaxPx.value = texelMaxPx;
    this.material.uniforms.uTexelFade.value = Math.max(1.05, texelFade);
  }

  /** (how much of the fused shelf becomes land, how dark the internal seam is). */
  setMerge(lift: number, seam: number): void {
    (this.material.uniforms.uMerge.value as THREE.Vector2).set(lift, seam);
  }

  /**
   * What the land keeps once the engine has rendered an answer over it.
   *
   * TWO NUMBERS MOVING IN OPPOSITE DIRECTIONS, and that is the whole fix. `sea`
   * sinks the FILL to the ghost tier; `coast` RAISES the shoreline. A fogged
   * region stops being a filled mass and becomes a drawn outline — still there,
   * plainly unattended, and with a coast the eye can follow — so the water
   * between two land masses is legible as water and a strait crossing is legible
   * as a crossing. Scaling both together is what emptied the receipt frame.
   */
  setFog(sea: number, coast: number, landfall: number): void {
    this.material.uniforms.uFogSea.value = sea;
    this.material.uniforms.uFogCoast.value = coast;
    this.material.uniforms.uFogLandfall.value = landfall;
  }

  /**
   * The regions the rendered answer path actually STANDS ON. `[]` clears it.
   *
   * Under fog these keep their fill while the rest of the world drops to a
   * coastline drawing, so the frame answers "which islands does this span" and
   * "what did it cross" without a caption. Nothing here is invented: the discs
   * are the containment radii of the island nodes the path's own endpoints
   * belong to, straight off the payload.
   */
  setLandfall(regions: readonly { x: number; y: number; r: number }[]): void {
    const arr = this.material.uniforms.uLandfall.value as THREE.Vector4[];
    const n = Math.min(regions.length, REGION_LANDFALL_MAX);
    for (let i = 0; i < n; i++) {
      arr[i].set(regions[i].x, regions[i].y, Math.max(regions[i].r, 1e-3), 1);
    }
    for (let i = n; i < REGION_LANDFALL_MAX; i++) arr[i].set(0, 0, 1, 0);
    this.material.uniforms.uLandfallN.value = n;
  }

  /** What an out-of-scope region keeps of its hue during a descent. */
  setOutOfScope(v: number): void {
    this.material.uniforms.uFocusOut.value = v;
  }

  setField(field: RegionField): void {
    this.field?.texture.dispose();
    this.field?.shelf.dispose();
    this.field = field;
    this.material.uniforms.uField.value = field.texture;
    this.material.uniforms.uShelf.value = field.shelf;
    (this.material.uniforms.uFieldStep.value as THREE.Vector2).set(
      1 / field.width,
      1 / field.height,
    );
    this.material.uniforms.uTexelWorld.value = field.texelWorld;

    const b = field.bounds;
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    a[0] = b.min_x; a[1] = b.min_y; a[2] = 0;
    a[3] = b.max_x; a[4] = b.min_y; a[5] = 0;
    a[6] = b.max_x; a[7] = b.max_y; a[8] = 0;
    a[9] = b.min_x; a[10] = b.max_y; a[11] = 0;
    pos.needsUpdate = true;
  }

  /**
   * Mark WHAT IS IN SCOPE on a descent. `[]` clears it and the whole world is
   * in scope again.
   *
   * A single disc around the parent was the old answer and it was imperceptible,
   * because a continent's containment radius covers most of the terrain — the
   * "you are here" boost was applied to two-thirds of the map. What is actually
   * in scope is the union of the CURRENT RUNG'S OWN BODIES, which is a handful
   * of small discs sitting exactly on the land you descended into. Everything
   * outside them drops to `--field-out-of-scope`, so descending reads as travel.
   */
  setFocusRegions(regions: readonly { x: number; y: number; r: number }[]): void {
    const arr = this.material.uniforms.uFocus.value as THREE.Vector4[];
    const n = Math.min(regions.length, REGION_FOCUS_MAX);
    for (let i = 0; i < n; i++) {
      arr[i].set(regions[i].x, regions[i].y, Math.max(regions[i].r, 1e-3), 1);
    }
    for (let i = n; i < REGION_FOCUS_MAX; i++) arr[i].set(0, 0, 1, 0);
    this.material.uniforms.uFocusN.value = n;
  }

  dispose(): void {
    this.field?.texture.dispose();
    this.field?.shelf.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
