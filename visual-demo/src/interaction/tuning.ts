/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — INPUT TUNING
 * =============================================================================
 *
 * The one place a CSS token becomes a number the input layer can multiply by.
 *
 * Same pattern as `@/graph/palette.ts`: `@/styles/tokens.ts` is the LOCKED bridge
 * for the colour/motion roster the whole product shares, and each layer reads its
 * own appended geometry through a small reader of its own. Nothing in
 * `src/interaction/**` is allowed to invent one of these numbers inline — every
 * one of them is declared in design-tokens.css §15 and read back here.
 *
 * MEMOISED. `getComputedStyle` plus twenty property reads is cheap once and
 * ruinous inside a pointermove handler. Call `invalidateTuning()` after a density
 * switch or a reduced-motion change; the interaction layer does that itself.
 * =============================================================================
 */

import { readTokens, invalidateTokens } from '@/styles/tokens';

export interface Tuning {
  /** ln(zoom) gained per CSS pixel of wheel travel. */
  wheelRate: number;
  /** The same, for a trackpad pinch (which arrives as ctrl+wheel). */
  pinchRate: number;
  /** Per-event travel ceiling, in CSS px, before a flicked wheel is clamped. */
  stepMaxPx: number;
  /** Movement in CSS px before a press becomes a drag rather than a click. */
  dragThresholdPx: number;
  /** Momentum decay time constant, in ms. */
  flingTauMs: number;
  /** CSS px per ms below which a fling has stopped. */
  flingMinSpeed: number;
  /** CSS px per ms ceiling on the measured release velocity. */
  flingMaxSpeed: number;
  /** The trailing window, in ms, the release velocity is measured over. */
  flingWindowMs: number;
  /** A hand that rested longer than this before letting go did not throw anything. */
  flingReleaseMs: number;
  /** Half-frustums the camera centre may travel past the world edge. */
  overscroll: number;
  /** How long the pointer must rest before the neighbourhood is fetched. */
  hoverDebounceMs: number;
  /** Multiple of the rung's framing zoom at which the ontology changes downward. */
  rungIn: number;
  /** …and upward. */
  rungOut: number;
  /** Refractory period after a rung change, in ms. */
  rungCooldownMs: number;
  /** The world-map strip, in CSS px. 160×90 by contract. */
  worldMap: { w: number; h: number; dot: number };
  /** Hard cap on a rubber-band selection. Reported on screen when it binds. */
  marqueeMax: number;
  /** Hard cap on search results per group. Reported on screen when it binds. */
  searchMax: number;
  /** The shared motion budget, already reflecting `prefers-reduced-motion`. */
  ms: { fast: number; ui: number; scene: number };
  /** True when the user asked for reduced motion. No fling, no flight. */
  reducedMotion: boolean;
  /** `--hit-slop-node` in CSS px. Grows with `touch` density. */
  hitSlopPx: number;
}

function px(cs: CSSStyleDeclaration, prop: string, fallback: number): number {
  const n = Number.parseFloat(cs.getPropertyValue(prop));
  return Number.isFinite(n) ? n : fallback;
}

function ms(cs: CSSStyleDeclaration, prop: string, fallback: number): number {
  const raw = cs.getPropertyValue(prop).trim();
  const m = /^(-?[\d.]+)(ms|s)?$/.exec(raw);
  if (m === null) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return fallback;
  return m[2] === 's' ? n * 1000 : n;
}

let cache: Tuning | null = null;

/**
 * Read the input tuning. The fallbacks exist so a stylesheet that has not loaded
 * yet still produces a usable instrument rather than a division by zero; every
 * one of them is the value declared in design-tokens.css §15.
 */
export function readTuning(el: HTMLElement = document.documentElement): Tuning {
  if (cache !== null) return cache;
  const cs = getComputedStyle(el);
  const tokens = readTokens(el);

  cache = {
    wheelRate: px(cs, '--zoom-wheel-rate', 0.0022),
    pinchRate: px(cs, '--zoom-pinch-rate', 0.0125),
    stepMaxPx: px(cs, '--zoom-step-max', 260),
    dragThresholdPx: px(cs, '--drag-threshold', 3),
    flingTauMs: ms(cs, '--fling-tau', 340),
    flingMinSpeed: px(cs, '--fling-min-speed', 0.02),
    flingMaxSpeed: px(cs, '--fling-max-speed', 6),
    flingWindowMs: ms(cs, '--fling-window', 100),
    flingReleaseMs: ms(cs, '--fling-release', 140),
    overscroll: px(cs, '--pan-overscroll', 0.5),
    hoverDebounceMs: ms(cs, '--hover-request-debounce', 140),
    rungIn: px(cs, '--rung-zoom-in', 2.75),
    rungOut: px(cs, '--rung-zoom-out', 0.42),
    rungCooldownMs: ms(cs, '--rung-zoom-cooldown', 900),
    worldMap: {
      w: px(cs, '--worldmap-w', 160),
      h: px(cs, '--worldmap-h', 90),
      dot: px(cs, '--worldmap-dot', 1),
    },
    marqueeMax: px(cs, '--marquee-max', 256),
    searchMax: px(cs, '--search-results-max', 40),
    ms: tokens.ms,
    reducedMotion: tokens.reducedMotion,
    hitSlopPx: px(cs, '--hit-slop-node', 6),
  };
  return cache;
}

/** Drop the memoised tuning AND the token snapshot underneath it. */
export function invalidateTuning(el: HTMLElement | null = null): void {
  cache = null;
  invalidateTokens(el);
}
