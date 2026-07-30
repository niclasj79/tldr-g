/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE CURVES
 * =============================================================================
 *
 * Two easings and one spring, none of them restated as numbers in TypeScript.
 *
 * `--ease-ui` and `--ease-camera` are declared once in design-tokens.css §8 and
 * solved here, so the DOM transitions the browser runs and the buffer writes this
 * layer runs are on the identical curve. A hand-typed `cubic-bezier(.16,1,.3,1)`
 * in a .ts file is a second declaration of a shared value, and it drifts.
 *
 * THE SPRING IS CRITICALLY DAMPED AND THAT IS NOT A TASTE DECISION. An
 * underdamped spring overshoots, and this layer's springs move NODES ALONG THE
 * RESOLUTION RAMP: an overshoot would carry a node one tier past the resolution
 * the engine admitted it at and hold it there for two frames. That is the
 * interface lying about the engine, briefly and beautifully, which is the worst
 * kind. So: p(t) = 1 - (1 + wt)e^(-wt). Monotonic, fast in, gentle out, arrives.
 * =============================================================================
 */

/** A cubic-bezier as CSS declares it. */
export type Curve = (x: number) => number;

const LINEAR: Curve = (x) => x;

function axis(a: number, b: number, t: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * t * a + 3 * mt * t * t * b + t * t * t;
}

/** Solve a CSS `cubic-bezier(x1,y1,x2,y2)` for y at a given x, by Newton. */
export function bezier(x1: number, y1: number, x2: number, y2: number): Curve {
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = axis(x1, x2, t) - x;
      if (Math.abs(err) < 1e-5) break;
      const mt = 1 - t;
      const d = 3 * mt * mt * x1 + 6 * mt * t * (x2 - x1) + 3 * t * t * (1 - x2);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    return axis(y1, y2, t);
  };
}

const parsed = new Map<string, Curve>();

/**
 * Read a `cubic-bezier(...)` custom property and turn it into a function.
 *
 * Falls back to linear rather than to an invented curve: a missing token is a
 * contract violation and `@/styles/tokens.ts` already shouts about those. What
 * this must never do is silently substitute a DIFFERENT ease, because then the
 * DOM and the buffers would be on two curves and nobody would be able to see it.
 */
export function easeToken(prop: '--ease-ui' | '--ease-camera'): Curve {
  const hit = parsed.get(prop);
  if (hit !== undefined) return hit;
  if (typeof document === 'undefined') return LINEAR;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
  const m = /^cubic-bezier\(([^)]+)\)$/.exec(raw);
  if (m === null) return LINEAR;
  const n = m[1].split(',').map((s) => Number(s.trim()));
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return LINEAR;
  const curve = bezier(n[0], n[1], n[2], n[3]);
  parsed.set(prop, curve);
  return curve;
}

/** Drop the parsed curves. Call after a stylesheet reload. */
export function invalidateCurves(): void {
  parsed.clear();
}

/**
 * A CRITICALLY DAMPED spring, normalised to arrive at 1.
 *
 * @param t       seconds since release
 * @param omega   angular frequency — `--ingest-spring`
 */
export function spring(t: number, omega: number): number {
  if (!(t > 0)) return 0;
  const wt = omega * t;
  return 1 - (1 + wt) * Math.exp(-wt);
}

/**
 * The same spring over a NORMALISED 0..1 timeline, rescaled so that it reaches
 * exactly 1 at the end rather than asymptotically approaching it.
 *
 * The rescale matters: an animation that ends at 0.997 leaves every node one
 * quarter of a ramp step short of the tier the engine admitted it at, forever.
 */
export function springOver(p: number, omega: number, durationSec: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const full = spring(durationSec, omega);
  if (!(full > 0)) return p;
  return Math.min(1, spring(p * durationSec, omega) / full);
}
