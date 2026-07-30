/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — RUNG GEOMETRY
 * =============================================================================
 *
 * ALTITUDE -> ONTOLOGY. This module answers one question and nothing else:
 * given the altitude the camera is at, which of the four rungs is the world
 * supposed to BE right now?
 *
 * That question is the whole product. Zoom in this Atlas does not magnify
 * pixels; it changes what things ARE. Continents become islands, islands become
 * documents, documents become spans. One continuous camera, four discrete
 * resolution regimes — Powers-of-Ten dramaturgy, not infinite magnification.
 *
 * -----------------------------------------------------------------------------
 * WHY HYSTERESIS IS NOT A POLISH ITEM
 * -----------------------------------------------------------------------------
 * If a single threshold decided the rung, a user resting the pointer at that
 * threshold would flicker between two ontologies — the map would rewrite what
 * its nodes MEAN sixty times a second, on a hand tremor. That is not a jitter
 * bug, it is the interface changing its mind about reality, and it makes the
 * boundary literally unusable.
 *
 * So the gate is a Schmitt trigger with three separate defences:
 *
 *   1. AN ASYMMETRIC BAND. You must climb to `--rung-zoom-in` x the altitude the
 *      current rung was framed at before the world descends, and fall to
 *      `--rung-zoom-out` x it before the world ascends. The band is wide (0.42
 *      .. 2.75, a factor of 6.5) because a rung change is a place change.
 *
 *   2. RE-ANCHORING. After a crossing the gate re-anchors to the altitude the
 *      NEW rung settles at. The reverse crossing therefore requires travelling
 *      the whole band again from the new anchor — there is no altitude at which
 *      both thresholds are within a nudge of each other.
 *
 *   3. A REFRACTORY PERIOD. `--rung-zoom-cooldown` after a crossing, the gate
 *      abstains. One continuous flick of a wheel cannot fall through two
 *      ontologies before the eye has arrived at the first.
 *
 * -----------------------------------------------------------------------------
 * THE ANCHOR IS MEASURED, NEVER ASSUMED
 * -----------------------------------------------------------------------------
 * The reference altitude is whatever the camera actually SETTLES at after a
 * rung's auto-frame, not a constant. It has to be: the zoom that frames six
 * continents and the zoom that frames eleven passages differ by orders of
 * magnitude and depend on the bake's own bounds. A hardcoded ladder of zoom
 * values would be a lie about a world it has never seen.
 *
 * Nothing here reads the DOM, the store or the renderer, so `createRungGate()`
 * is testable without a browser. Every threshold comes from design-tokens.css
 * §15 through `@/interaction/tuning.ts`, which is the declared reader for that
 * block — a second reader of the same four tokens would be a second place they
 * can drift.
 * =============================================================================
 */

import { RUNGS, RUNG_DEPTH } from '@/engine';
import type { Rung } from '@/engine';
import { invalidateTokens, readTokens } from '@/styles/tokens';
import { readTuning } from '@/interaction/tuning';

/* =============================================================================
 * 1. THE BAND
 * ========================================================================== */

/** The altitude band a rung owns, as multiples of the altitude it was framed at. */
export interface RungBand {
  /** Climb past this multiple of the anchor and the ontology descends. */
  in: number;
  /** Fall below this multiple of the anchor and the ontology ascends. */
  out: number;
  /** Refractory period after a crossing, in ms. */
  cooldownMs: number;
}

/**
 * The band, read from the tokens. `in` is forced above `out` and both are kept
 * finite: an inverted band would make every altitude a crossing in both
 * directions at once, which is the flicker the band exists to prevent.
 */
export function readRungBand(): RungBand {
  const t = readTuning();
  const out = Number.isFinite(t.rungOut) && t.rungOut > 0 ? t.rungOut : 0.42;
  const wanted = Number.isFinite(t.rungIn) && t.rungIn > 0 ? t.rungIn : 2.75;
  return {
    out,
    in: Math.max(wanted, out * 1.5),
    cooldownMs: Number.isFinite(t.rungCooldownMs) ? Math.max(0, t.rungCooldownMs) : 900,
  };
}

/** How wide the band is, as a ratio. The eye has to travel this far to flip. */
export function bandWidth(band: RungBand): number {
  return band.in / band.out;
}

/* =============================================================================
 * 2. THE SPINE, AS A LADDER
 * ========================================================================== */

/** The rung one step DOWN the spine, or `null` at the passage rung. */
export function rungBelow(rung: Rung): Rung | null {
  return RUNGS[RUNG_DEPTH[rung] + 1] ?? null;
}

/** The rung one step UP the spine, or `null` at the continent rung. */
export function rungAbove(rung: Rung): Rung | null {
  return RUNGS[RUNG_DEPTH[rung] - 1] ?? null;
}

/** Depth on the spine, 0..3. Exposed so a depth gauge does not re-derive it. */
export function depthOf(rung: Rung): number {
  return RUNG_DEPTH[rung];
}

/** The deepest depth the spine has. Three, and it is not going to change. */
export const MAX_DEPTH = RUNGS.length - 1;

/* =============================================================================
 * 3. THE DECISION
 * ========================================================================== */

/** Which way the ontology is about to change, and between which two rungs. */
export interface RungCrossing {
  direction: 'descend' | 'ascend';
  from: Rung;
  to: Rung;
  /** The altitude ratio that triggered it. Real, measured, shown in the readout. */
  ratio: number;
}

/** What the caller is allowed to do. The gate never navigates past the spine. */
export interface CrossingPermissions {
  /** False at the passage rung, or when there is no addressable body below. */
  canDescend: boolean;
  /** False at the top of the world. */
  canAscend: boolean;
}

/**
 * The pure decision: does this altitude ratio leave the current rung's band?
 *
 * Returns `null` inside the band — which is where the camera spends almost all
 * of its life, and is the answer that keeps the ontology still.
 */
export function crossingFor(
  rung: Rung,
  ratio: number,
  band: RungBand,
  allow: CrossingPermissions,
): RungCrossing | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;

  if (ratio >= band.in && allow.canDescend) {
    const to = rungBelow(rung);
    if (to !== null) return { direction: 'descend', from: rung, to, ratio };
  }
  if (ratio <= band.out && allow.canAscend) {
    const to = rungAbove(rung);
    if (to !== null) return { direction: 'ascend', from: rung, to, ratio };
  }
  return null;
}

/**
 * Where an altitude sits inside its band, 0..1.
 *
 * 0 is the ascend threshold, 1 is the descend threshold, and it is measured in
 * LOG space because altitude is perceived as a ratio: half way up the band is
 * sqrt(in x out), not (in + out) / 2. This is the number an altimeter draws, so
 * getting the perceptual axis right is the difference between a gauge that
 * tracks the hand and one that appears to stick at the bottom.
 */
export function bandPosition(ratio: number, band: RungBand): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  const lo = Math.log(band.out);
  const hi = Math.log(band.in);
  if (hi <= lo) return 0;
  return Math.min(1, Math.max(0, (Math.log(ratio) - lo) / (hi - lo)));
}

/* =============================================================================
 * 3b. THIS LAYER'S OWN APPENDED TOKENS
 * -----------------------------------------------------------------------------
 * Same pattern as `@/graph/palette.ts` and `@/interaction/tuning.ts`: the shared
 * colour/motion roster comes from the locked bridge in `@/styles/tokens.ts`, and
 * the values design-tokens.css §16 appended for the descent layer are read back
 * here. Nothing in `src/ui/atlas/**` invents any of them inline.
 * ========================================================================== */

/** The descent's motion budget, already reflecting `prefers-reduced-motion`. */
export interface AtlasMotion {
  /** `--t-scene`. One rung change is one scene, always. */
  sceneMs: number;
  /** `--t-ui`. */
  uiMs: number;
  /** `--t-fast`. */
  fastMs: number;
  /** `--rung-stagger`. The interval between fovea-outward resolve waves. */
  staggerMs: number;
  /** `--atlas-dwell`. A reading pause, not a transition. Never scaled by motion. */
  dwellMs: number;
  /** Waves the resolve is cut into. DERIVED: scene / stagger, floored at 1. */
  waves: number;
  reducedMotion: boolean;
}

function msToken(cs: CSSStyleDeclaration, prop: string, fallback: number): number {
  const m = /^(-?[\d.]+)(ms|s)?$/.exec(cs.getPropertyValue(prop).trim());
  if (m === null) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return fallback;
  return m[2] === 's' ? n * 1000 : n;
}

let motionCache: AtlasMotion | null = null;

/**
 * Read the descent's motion budget. Memoised — `getComputedStyle` is cheap once
 * and ruinous inside a stagger loop. `invalidateAtlasMotion()` after a density
 * or reduced-motion change.
 *
 * UNDER REDUCED MOTION THE ONTOLOGY STILL CHANGES. The scene collapses to
 * `--t-fast` (design-tokens.css does that itself) and the resolve collapses to a
 * SINGLE wave — a crossfade rather than a ripple. What is removed is the travel,
 * never the fact that continents became islands.
 */
export function readAtlasMotion(el: HTMLElement = document.documentElement): AtlasMotion {
  if (motionCache !== null) return motionCache;
  const tokens = readTokens(el);
  const cs = getComputedStyle(el);
  const staggerMs = msToken(cs, '--rung-stagger', 60);
  const waves = tokens.reducedMotion
    ? 1
    : Math.max(1, Math.round(tokens.ms.scene / Math.max(1, staggerMs)));
  motionCache = {
    sceneMs: tokens.ms.scene,
    uiMs: tokens.ms.ui,
    fastMs: tokens.ms.fast,
    staggerMs,
    dwellMs: msToken(cs, '--atlas-dwell', 2400),
    waves,
    reducedMotion: tokens.reducedMotion,
  };
  return motionCache;
}

/** Drop the memoised motion budget AND the token snapshot underneath it. */
export function invalidateAtlasMotion(el: HTMLElement | null = null): void {
  motionCache = null;
  namingCache = null;
  invalidateTokens(el);
}

/* -----------------------------------------------------------------------------
 * THE NAMING BUDGET — §16 `--atlas-label-fine`, `--atlas-world-scale-max`
 * -----------------------------------------------------------------------------
 * Two numbers, both of them about what the ONTOLOGY at a rung is rather than
 * about how the rung looks. See the rationale in design-tokens.css §16: at
 * altitude you name places, up close you name things, and at the top of the
 * world the subject is the land rather than the six points at its centroids.
 * -------------------------------------------------------------------------- */

/** The two values that decide how a rung is named and how the world is framed. */
export interface AtlasNaming {
  /** Ceiling on names at the asset and passage rungs, where the candidates are THINGS. */
  fineCeiling: number;
  /** Ceiling on how far the continent rung may expand its frame to reach the coastlines. */
  worldScaleMax: number;
}

function numToken(cs: CSSStyleDeclaration, prop: string, fallback: number): number {
  const n = Number.parseFloat(cs.getPropertyValue(prop).trim());
  return Number.isFinite(n) ? n : fallback;
}

let namingCache: AtlasNaming | null = null;

/** Read the naming budget. Memoised; `invalidateAtlasMotion()` drops it. */
export function readAtlasNaming(el: HTMLElement = document.documentElement): AtlasNaming {
  if (namingCache !== null) return namingCache;
  const cs = getComputedStyle(el);
  namingCache = {
    fineCeiling: Math.max(1, Math.round(numToken(cs, '--atlas-label-fine', 14))),
    worldScaleMax: Math.max(1, numToken(cs, '--atlas-world-scale-max', 2.4)),
  };
  return namingCache;
}

/* =============================================================================
 * 4. THE GATE
 * ========================================================================== */

/** Everything the gate knows, for a readout or a test. All of it is measured. */
export interface RungGateState {
  rung: Rung | null;
  /** The altitude the current rung settled at. `null` until the camera rests. */
  anchorZoom: number | null;
  band: RungBand;
  /** ms remaining in the refractory period. 0 when the gate is live. */
  cooldownLeftMs: number;
}

/**
 * The Schmitt trigger. One per terrain; it holds three numbers and no opinions.
 *
 * Usage, and the ORDER MATTERS:
 *   gate.anchor(rung, zoom)   when the camera comes to rest at a new place
 *   gate.evaluate(zoom, ...)  on camera motion; returns a crossing or null
 *   gate.commit()             the instant the caller acts on a crossing
 *
 * `evaluate` deliberately does NOT self-commit. The caller may refuse a crossing
 * (no body under the centre to descend into, the app is not READY, a render is
 * in flight), and a gate that had already armed its cooldown on a crossing that
 * never happened would swallow the next real one.
 */
export interface RungGate {
  anchor(rung: Rung, zoom: number, nowMs?: number): void;
  /** Drop the anchor without arming the cooldown. The next rest re-anchors. */
  release(): void;
  anchored(): boolean;
  /** current zoom / anchor zoom. `NaN` before an anchor exists. */
  ratio(zoom: number): number;
  /** 0..1 across the band, in log space. 0 before an anchor exists. */
  position(zoom: number): number;
  evaluate(zoom: number, allow: CrossingPermissions, nowMs?: number): RungCrossing | null;
  commit(nowMs?: number): void;
  /** Re-read the tokens. Call after a density switch or a stylesheet reload. */
  refresh(): void;
  state(nowMs?: number): RungGateState;
}

export function createRungGate(band: RungBand = readRungBand()): RungGate {
  let current: Rung | null = null;
  let anchorZoom: number | null = null;
  let lastCrossAt = Number.NEGATIVE_INFINITY;
  let live = band;

  const now = (given?: number): number =>
    given ?? (typeof performance === 'undefined' ? Date.now() : performance.now());

  return {
    anchor(rung, zoom, nowMs) {
      if (!Number.isFinite(zoom) || zoom <= 0) return;
      current = rung;
      anchorZoom = zoom;
      // Anchoring is not a crossing. The cooldown is armed by `commit()` alone,
      // so re-anchoring after a flight cannot silently extend a refractory
      // period the user already waited out.
      void nowMs;
    },

    release() {
      anchorZoom = null;
    },

    anchored() {
      return anchorZoom !== null && current !== null;
    },

    ratio(zoom) {
      if (anchorZoom === null || !Number.isFinite(zoom)) return Number.NaN;
      return zoom / anchorZoom;
    },

    position(zoom) {
      if (anchorZoom === null) return 0;
      return bandPosition(zoom / anchorZoom, live);
    },

    evaluate(zoom, allow, nowMs) {
      if (current === null || anchorZoom === null) return null;
      if (now(nowMs) - lastCrossAt < live.cooldownMs) return null;
      return crossingFor(current, zoom / anchorZoom, live, allow);
    },

    commit(nowMs) {
      lastCrossAt = now(nowMs);
      // The new rung's altitude is not known until its auto-frame settles, and
      // an anchor left pointing at the OLD rung's altitude would read as an
      // instant second crossing. So the anchor is dropped and the caller
      // re-anchors on rest.
      anchorZoom = null;
    },

    refresh() {
      live = readRungBand();
    },

    state(nowMs) {
      return {
        rung: current,
        anchorZoom,
        band: live,
        cooldownLeftMs: Math.max(0, live.cooldownMs - (now(nowMs) - lastCrossAt)),
      };
    },
  };
}
