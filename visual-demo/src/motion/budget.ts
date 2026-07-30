/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE MOTION BUDGET
 * =============================================================================
 *
 * Every duration this layer spends, read from the stylesheet at run time.
 *
 * Same pattern as `@/graph/palette.ts`, `@/interaction/tuning.ts` and
 * `@/ui/atlas/rungGeometry.ts`: the shared roster comes from the locked bridge in
 * `@/styles/tokens.ts`, and the values design-tokens.css §18 appended for the
 * motion layer are read back here. Nothing in `src/motion/**` invents a number.
 *
 * -----------------------------------------------------------------------------
 * REDUCED MOTION IS A COLLAPSE, NOT A REMOVAL
 * -----------------------------------------------------------------------------
 * `prefers-reduced-motion` already shortens `--t-ui` and `--t-scene` to 120ms in
 * the stylesheet. That is not sufficient on its own: a five-wave stagger at
 * 120ms is still five events, and five events is precisely what a reader who
 * asked for less motion asked not to have. So this module also collapses the
 * STRUCTURE — `steps()` returns 1 — and every one of the five signature
 * animations becomes exactly one 120ms crossfade.
 *
 * What is never collapsed is the STATE CHANGE. The rung still changes, the
 * render still lands, the citation still travels to its source, the corpus still
 * settles. Only the travel is removed.
 *
 * INSTRUMENTS ARE NOT MOTION. Nothing here gates a readout. A gauge, a token
 * count, a hash and a resolution chip update on the frame their value changes in
 * every mode, because a gauge that lies for 240ms is a broken gauge.
 * =============================================================================
 */

import { invalidateTokens, readTokens } from '@/styles/tokens';

/** The whole budget, already reflecting `prefers-reduced-motion`. */
export interface MotionBudget {
  /** `--t-fast`. Also the floor every collapsed animation lands on. */
  fastMs: number;
  /** `--t-ui`. One tier of a reveal, one dot of a trace, one ramp crossfade. */
  uiMs: number;
  /** `--t-scene`. A camera move, a rung change, the receipt count. */
  sceneMs: number;
  /** `--reveal-step`. The interval between the three tiers of one render. */
  stepMs: number;
  /** `--reveal-rise`, in CSS px. Declared here so the log can report it. */
  risePx: number;
  /** `--trace-ring`, in CSS px. The evidence ring a cited source gains. */
  ringPx: number;
  /** `--ingest-settle`. How long the corpus takes to stop arriving. */
  ingestMs: number;
  /** `--ingest-spring`. Angular frequency of the critically damped settle. */
  ingestOmega: number;
  reduced: boolean;
}

function msToken(cs: CSSStyleDeclaration, prop: string, fallback: number): number {
  const m = /^(-?[\d.]+)(ms|s)?$/.exec(cs.getPropertyValue(prop).trim());
  if (m === null) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return fallback;
  return m[2] === 's' ? n * 1000 : n;
}

function pxToken(cs: CSSStyleDeclaration, prop: string, fallback: number): number {
  const n = Number.parseFloat(cs.getPropertyValue(prop).trim());
  return Number.isFinite(n) ? n : fallback;
}

let cache: MotionBudget | null = null;

/**
 * Read the budget. Memoised — `getComputedStyle` is cheap once and ruinous
 * inside a stagger loop, which is the only place this is ever needed.
 */
export function readMotionBudget(el: HTMLElement = document.documentElement): MotionBudget {
  if (cache !== null) return cache;
  const tokens = readTokens(el);
  const cs = getComputedStyle(el);
  cache = {
    fastMs: tokens.ms.fast,
    uiMs: tokens.ms.ui,
    sceneMs: tokens.ms.scene,
    stepMs: msToken(cs, '--reveal-step', tokens.ms.fast),
    risePx: pxToken(cs, '--reveal-rise', 2),
    ringPx: pxToken(cs, '--trace-ring', 22),
    ingestMs: msToken(cs, '--ingest-settle', 1120),
    ingestOmega: pxToken(cs, '--ingest-spring', 6),
    reduced: tokens.reducedMotion,
  };
  return cache;
}

/** Drop the memoised budget AND the token snapshot under it. */
export function invalidateMotionBudget(el: HTMLElement | null = null): void {
  cache = null;
  invalidateTokens(el);
}

/**
 * The duration a scene animation actually gets.
 *
 * Under reduced motion EVERY scene animation is one `--t-fast` crossfade, which
 * is the whole of the guarantee: not "shorter", not "mostly instant" — one
 * duration, one event, every time.
 */
export function collapse(ms: number, budget: MotionBudget = readMotionBudget()): number {
  return budget.reduced ? budget.fastMs : Math.max(0, ms);
}

/** How many staggered steps an animation gets. One, under reduced motion. */
export function steps(wanted: number, budget: MotionBudget = readMotionBudget()): number {
  return budget.reduced ? 1 : Math.max(1, Math.round(wanted));
}
