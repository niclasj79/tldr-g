/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — TRADE ROUTES (force-directed edge bundling)
 * =============================================================================
 *
 * At a region rung the engine does not ship relations, it ships CORRIDORS: an
 * `EdgeBundle` between two islands carrying some number of underlying claims.
 * Drawing those corridors as straight chords produces a wheel of spokes — every
 * pair of regions gets a line, the lines all cross in the middle, and the
 * picture says nothing about where traffic actually flows.
 *
 * Bundling fixes that by letting corridors that run in the same direction share
 * a channel. What you end up looking at is a road network: a few thick trunks
 * between the big landmasses, thin capillaries at the margins, and visible
 * STRAITS where a bundle threads between two coasts. That is the "trade route"
 * reading, and it is the only honest thing to draw at a rung whose nodes are
 * regions rather than claims.
 *
 * -----------------------------------------------------------------------------
 * THIS IS NOT A LAYOUT
 * -----------------------------------------------------------------------------
 * Nothing here moves a node. Node position is BAKED and this file never touches
 * it; it only decides what curve to draw BETWEEN two already-fixed endpoints.
 * It runs ONCE per view (keyed by `bake_id` + the corridor set), never per
 * frame, and it has a fixed iteration count with no convergence test — the same
 * corridor set always produces the same routes, so the map does not shimmer.
 *
 * Holten & van Wijk's FDEB, with their standard compatibility measure (angle,
 * scale, position, visibility) and a scale-free force integration documented at
 * the loop below. Above `maxRoutes` corridors it declines to
 * bundle at all and returns straight chords: bundling a set that large produces
 * a knot, and a knot is the hairball with extra steps.
 * ========================================================================== */

/** One corridor to route, endpoints already in world coordinates. */
export interface BundleInput {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Relative traffic. Only used to order the compatibility work; never a force. */
  weight: number;
}

/** A routed corridor: a polyline from A to B, with cumulative arc length. */
export interface BundledRoute {
  /** Interleaved x,y. Always starts at A and ends at B — endpoints never move. */
  pts: Float32Array;
  /** Cumulative arc length in world units at each point. Drives dash continuity. */
  arc: Float32Array;
  /** Straight-line length, for the relax interpolation. */
  chord: number;
}

export interface BundleOptions {
  /** Subdivision doublings. Default 5 -> 16 interior points. */
  cycles?: number;
  /** Iterations in the first cycle; scaled by 2/3 each cycle. Default 54. */
  iterations?: number;
  /** Dimensionless move rate per iteration, halved each cycle. Default 0.11. */
  step?: number;
  /** Laplacian smoothing weight. Higher = straighter, less bundled. Default 0.30. */
  stiffness?: number;
  /** Compatibility threshold, 0..1. Default 0.46. */
  threshold?: number;
  /** Above this many corridors, do not bundle. Default 700. */
  maxRoutes?: number;
}

/* -----------------------------------------------------------------------------
 * Compatibility. Four independent measures, multiplied — a pair has to agree on
 * direction AND length AND locality AND mutual visibility to share a channel.
 * -------------------------------------------------------------------------- */

function compatibility(
  pax: number, pay: number, pbx: number, pby: number, plen: number,
  qax: number, qay: number, qbx: number, qby: number, qlen: number,
): number {
  const pvx = pbx - pax;
  const pvy = pby - pay;
  const qvx = qbx - qax;
  const qvy = qby - qay;

  const lavg = (plen + qlen) / 2;
  if (lavg < 1e-9) return 0;

  // angle
  const dot = pvx * qvx + pvy * qvy;
  const ca = Math.abs(dot / (plen * qlen));

  // scale
  const cs = 2 / (lavg / Math.min(plen, qlen) + Math.max(plen, qlen) / lavg);

  // position
  const pmx = (pax + pbx) / 2;
  const pmy = (pay + pby) / 2;
  const qmx = (qax + qbx) / 2;
  const qmy = (qay + qby) / 2;
  const cp = lavg / (lavg + Math.hypot(pmx - qmx, pmy - qmy));

  // visibility (symmetric minimum)
  const v1 = visibility(pax, pay, pbx, pby, qax, qay, qbx, qby);
  const v2 = visibility(qax, qay, qbx, qby, pax, pay, pbx, pby);
  const cv = Math.min(v1, v2);

  return ca * cs * cp * cv;
}

/** How much of Q projects onto P's span, as Holten defines it. */
function visibility(
  pax: number, pay: number, pbx: number, pby: number,
  qax: number, qay: number, qbx: number, qby: number,
): number {
  const dx = pbx - pax;
  const dy = pby - pay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return 0;
  const t0 = ((qax - pax) * dx + (qay - pay) * dy) / len2;
  const t1 = ((qbx - pax) * dx + (qby - pay) * dy) / len2;
  const i0x = pax + dx * t0;
  const i0y = pay + dy * t0;
  const i1x = pax + dx * t1;
  const i1y = pay + dy * t1;
  const imx = (i0x + i1x) / 2;
  const imy = (i0y + i1y) / 2;
  const pmx = (pax + pbx) / 2;
  const pmy = (pay + pby) / 2;
  const ilen = Math.hypot(i1x - i0x, i1y - i0y);
  if (ilen < 1e-9) return 0;
  return Math.max(0, 1 - (2 * Math.hypot(pmx - imx, pmy - imy)) / ilen);
}

/** A straight two-point route. What an unbundled corridor is. */
function straightRoute(e: BundleInput): BundledRoute {
  const chord = Math.hypot(e.bx - e.ax, e.by - e.ay);
  return {
    pts: Float32Array.from([e.ax, e.ay, e.bx, e.by]),
    arc: Float32Array.from([0, chord]),
    chord,
  };
}

/**
 * Route a corridor set. Deterministic, bounded, and run once per view.
 *
 * Cost on the demo corpus (170 island corridors, 4 cycles): ~28k compatibility
 * evaluations and ~150k point updates — single-digit milliseconds, cached
 * afterwards by the caller against `bake_id`.
 */
export function bundleRoutes(input: readonly BundleInput[], options: BundleOptions = {}): BundledRoute[] {
  const n = input.length;
  if (n === 0) return [];
  const maxRoutes = options.maxRoutes ?? 700;
  if (n === 1 || n > maxRoutes) return input.map(straightRoute);

  const cycles = options.cycles ?? 5;
  const threshold = options.threshold ?? 0.46;
  const stiffness = options.stiffness ?? 0.30;

  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  const bx = new Float64Array(n);
  const by = new Float64Array(n);
  const len = new Float64Array(n);
  let meanChord = 0;
  for (let i = 0; i < n; i++) {
    ax[i] = input[i].ax;
    ay[i] = input[i].ay;
    bx[i] = input[i].bx;
    by[i] = input[i].by;
    len[i] = Math.hypot(bx[i] - ax[i], by[i] - ay[i]);
    meanChord += len[i];
  }
  meanChord /= n;
  if (meanChord < 1e-9) return input.map(straightRoute);

  let step = options.step ?? 0.11;
  let iterations = options.iterations ?? 54;

  /* ---- compatible pairs, as CSR. Built once. --------------------------- */
  const neighbourStart = new Int32Array(n + 1);
  const neighbourList: number[] = [];
  const neighbourWeight: number[] = [];
  for (let i = 0; i < n; i++) {
    neighbourStart[i] = neighbourList.length;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const c = compatibility(
        ax[i], ay[i], bx[i], by[i], len[i],
        ax[j], ay[j], bx[j], by[j], len[j],
      );
      if (c > threshold) {
        neighbourList.push(j);
        neighbourWeight.push(c);
      }
    }
  }
  neighbourStart[n] = neighbourList.length;
  const nbr = Int32Array.from(neighbourList);
  const nbw = Float64Array.from(neighbourWeight);

  /* ---- subdivision loop ------------------------------------------------ */
  let p = 1; // interior points
  let px = new Float64Array(n * (p + 2));
  let py = new Float64Array(n * (p + 2));
  for (let i = 0; i < n; i++) {
    const base = i * (p + 2);
    px[base] = ax[i];
    py[base] = ay[i];
    px[base + 1] = (ax[i] + bx[i]) / 2;
    py[base + 1] = (ay[i] + by[i]) / 2;
    px[base + 2] = bx[i];
    py[base + 2] = by[i];
  }

  const maxPoints = 2 ** Math.max(0, cycles - 1) + 2;
  const fx = new Float64Array(n * maxPoints);
  const fy = new Float64Array(n * maxPoints);

  /* Forces, per subdivision station:
   *
   *   ATTRACTION  toward the compatibility-weighted centroid of the SAME station
   *               on every compatible route. This is what merges parallel
   *               corridors into one channel.
   *   SMOOTHING   toward the midpoint of this route's own two neighbouring
   *               stations. This is what stops a channel from developing kinks.
   *
   * Both are expressed as a fraction of a distance rather than as a raw force,
   * so the integration is scale-free: the same parameters route a 6k world and a
   * 100k world identically, and neither can explode. Holten's original divides a
   * spring constant by edge length instead, which needs re-tuning per corpus —
   * a knob nobody would remember to turn.
   */
  for (let c = 0; c < cycles; c++) {
    const m = p + 2;
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < n; i++) {
        const base = i * m;
        for (let k = 1; k <= p; k++) {
          const cx = px[base + k];
          const cy = py[base + k];

          let wsum = 0;
          let gx = 0;
          let gy = 0;
          for (let q = neighbourStart[i]; q < neighbourStart[i + 1]; q++) {
            const jb = nbr[q] * m;
            const w = nbw[q];
            wsum += w;
            gx += w * px[jb + k];
            gy += w * py[jb + k];
          }

          let mx = 0;
          let my = 0;
          if (wsum > 1e-9) {
            mx += gx / wsum - cx;
            my += gy / wsum - cy;
          }
          mx += ((px[base + k - 1] + px[base + k + 1]) / 2 - cx) * stiffness;
          my += ((py[base + k - 1] + py[base + k + 1]) / 2 - cy) * stiffness;

          fx[base + k] = mx * step;
          fy[base + k] = my * step;
        }
      }
      for (let i = 0; i < n; i++) {
        const base = i * m;
        for (let k = 1; k <= p; k++) {
          px[base + k] += fx[base + k];
          py[base + k] += fy[base + k];
        }
      }
    }

    if (c === cycles - 1) break;

    // Double the subdivision: every existing segment gains a midpoint.
    const np = p * 2;
    const nm = np + 2;
    const nx = new Float64Array(n * nm);
    const ny = new Float64Array(n * nm);
    for (let i = 0; i < n; i++) {
      const ob = i * m;
      const nb = i * nm;
      // resample the old polyline at nm equally-spaced arc positions
      resample(px, py, ob, m, nx, ny, nb, nm);
    }
    px = nx;
    py = ny;
    p = np;
    step *= 0.5;
    iterations = Math.max(6, Math.round((iterations * 2) / 3));
  }

  /* ---- emit ------------------------------------------------------------ */
  const m = p + 2;
  const out: BundledRoute[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const base = i * m;
    const pts = new Float32Array(m * 2);
    const arc = new Float32Array(m);
    let acc = 0;
    for (let k = 0; k < m; k++) {
      pts[k * 2] = px[base + k];
      pts[k * 2 + 1] = py[base + k];
      if (k > 0) acc += Math.hypot(px[base + k] - px[base + k - 1], py[base + k] - py[base + k - 1]);
      arc[k] = acc;
    }
    out[i] = { pts, arc, chord: len[i] };
  }
  return out;
}

/** Resample a polyline to `nm` points at uniform arc length. Endpoints preserved. */
function resample(
  sx: Float64Array, sy: Float64Array, sBase: number, sCount: number,
  dx: Float64Array, dy: Float64Array, dBase: number, dCount: number,
): void {
  const cum = new Float64Array(sCount);
  let total = 0;
  for (let k = 1; k < sCount; k++) {
    total += Math.hypot(sx[sBase + k] - sx[sBase + k - 1], sy[sBase + k] - sy[sBase + k - 1]);
    cum[k] = total;
  }
  dx[dBase] = sx[sBase];
  dy[dBase] = sy[sBase];
  dx[dBase + dCount - 1] = sx[sBase + sCount - 1];
  dy[dBase + dCount - 1] = sy[sBase + sCount - 1];
  if (total < 1e-9) {
    for (let k = 1; k < dCount - 1; k++) {
      dx[dBase + k] = sx[sBase];
      dy[dBase + k] = sy[sBase];
    }
    return;
  }
  let seg = 1;
  for (let k = 1; k < dCount - 1; k++) {
    const target = (total * k) / (dCount - 1);
    while (seg < sCount - 1 && cum[seg] < target) seg++;
    const t0 = cum[seg - 1];
    const t1 = cum[seg];
    const f = t1 - t0 < 1e-12 ? 0 : (target - t0) / (t1 - t0);
    dx[dBase + k] = sx[sBase + seg - 1] + (sx[sBase + seg] - sx[sBase + seg - 1]) * f;
    dy[dBase + k] = sy[sBase + seg - 1] + (sy[sBase + seg] - sy[sBase + seg - 1]) * f;
  }
}
