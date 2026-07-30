/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — DENSITY, INPUT MODE AND THE MOTION BUDGET
 * =============================================================================
 *
 * Density changes SPACING AND HIT TARGETS. It never changes colour, never
 * changes meaning, and never changes the resolution ramp. The tokens enforce
 * that (design-tokens.css §12 and the three `:root[data-density=...]` blocks);
 * this module's whole job is to put the right attribute on `<html>`, persist the
 * choice, and tell the token bridge that the computed values moved.
 *
 * THE TOUCH SIGNAL. `touch` is the density a coarse pointer gets, and it is also
 * the signal the shell reads to turn the inspector from a right-hand panel into
 * a bottom sheet — a 320px column is not reachable with a thumb. One value
 * drives both, so the layout and the hit targets can never disagree about what
 * kind of hand is holding the instrument.
 * =============================================================================
 */

import { DENSITY_MODES, invalidateTokens } from '@/engine';
import type { DensityMode } from '@/engine';

/* -----------------------------------------------------------------------------
 * Storage keys. Namespaced, because a demo that squats on `density` in
 * localStorage is a demo that fights with whatever else the user has open.
 * -------------------------------------------------------------------------- */
export const DENSITY_STORAGE_KEY = 'tldrg.visual-demo.density';
export const VISITED_STORAGE_KEY = 'tldrg.visual-demo.visited';

/** True when there is a DOM to write to. False under node, in the verifier. */
function hasDom(): boolean {
  return typeof document !== 'undefined' && document.documentElement !== null;
}

/** localStorage, or `null` when it is absent or blocked (private mode, file://). */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Runtime guard for a value that came out of storage or a URL. */
export function isDensityMode(value: unknown): value is DensityMode {
  return typeof value === 'string' && (DENSITY_MODES as readonly string[]).includes(value);
}

/** The persisted choice, or `null` if the user has never made one. */
export function readStoredDensity(): DensityMode | null {
  const raw = storage()?.getItem(DENSITY_STORAGE_KEY);
  return isDensityMode(raw) ? raw : null;
}

/** Persist the choice. Silent when storage is unavailable — this is a preference, not data. */
export function storeDensity(mode: DensityMode): void {
  try {
    storage()?.setItem(DENSITY_STORAGE_KEY, mode);
  } catch {
    /* private mode. The session still works; the choice just will not survive it. */
  }
}

/**
 * The density to start in when nothing is stored.
 *
 * A coarse pointer means a finger, and a finger needs `touch`. Everything else
 * gets `comfortable`, because reading a terrain is a slow activity and the
 * default should not be optimised for cramming.
 */
export function detectDensity(): DensityMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'comfortable';
  return window.matchMedia('(pointer: coarse)').matches ? 'touch' : 'comfortable';
}

/**
 * Apply a density to the document and persist it.
 *
 * Writes `data-density` (the tokens' switch) and `data-input` (the layout's
 * switch: `touch` puts the inspector in a bottom sheet), then invalidates the
 * memoised token snapshot — every derived padding and hit-target custom property
 * just changed, and the WebGL side reads its numbers through that snapshot.
 */
export function applyDensity(mode: DensityMode, opts: { persist?: boolean } = {}): void {
  if (hasDom()) {
    const root = document.documentElement;
    root.dataset.density = mode;
    root.dataset.input = mode === 'touch' ? 'touch' : 'fine';
    invalidateTokens(root);
  }
  if (opts.persist !== false) storeDensity(mode);
}

/** The bottom-sheet signal. One derivation, used by the shell and by the inspector alike. */
export function isTouchMode(mode: DensityMode): boolean {
  return mode === 'touch';
}

/**
 * Subscribe to pointer-capability changes — a Surface that gets a keyboard
 * attached mid-session is a real thing, and the instrument should follow the
 * hand rather than the boot-time guess. Only fires while the user has made no
 * explicit choice; an explicit choice always wins.
 */
export function subscribeInputMode(cb: (mode: DensityMode) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia('(pointer: coarse)');
  const handler = (): void => cb(mq.matches ? 'touch' : 'comfortable');
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

/* =============================================================================
 * MOTION
 * -----------------------------------------------------------------------------
 * `prefers-reduced-motion` collapses the camera and panel choreography to
 * `--t-fast` (design-tokens.css handles the CSS half). The store carries the
 * boolean so the renderer — which cannot read a media query from a shader — can
 * make the same decision. INSTRUMENT READOUTS ARE NEVER ANIMATED IN ANY MODE, so
 * this flag must never be used to gate a data update.
 * ========================================================================== */

/** Current reduced-motion preference. `false` where the query is unavailable. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Subscribe to reduced-motion changes. Returns an unsubscribe. */
export function subscribeReducedMotion(cb: (reduced: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const handler = (): void => {
    // The token snapshot carries `ms.fast/ui/scene`; they change with the query.
    invalidateTokens();
    cb(mq.matches);
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

/* =============================================================================
 * FIRST RUN
 * -----------------------------------------------------------------------------
 * FIRST-RUN is a real state with a real screen, and it is worth exactly one
 * visit: the terrain explains itself, the user accepts the invitation, and every
 * later load goes straight to the map. A "first run" that fires every time is a
 * splash screen, which is a different and much worse thing.
 * ========================================================================== */

/** True when this browser has completed a first run before. */
export function hasVisited(): boolean {
  return storage()?.getItem(VISITED_STORAGE_KEY) === '1';
}

/** Record that the invitation was accepted. */
export function markVisited(): void {
  try {
    storage()?.setItem(VISITED_STORAGE_KEY, '1');
  } catch {
    /* preference storage is unavailable; every load will be a first run. */
  }
}

/** Forget the first run. Used by the `first-run` scene so visual QA can shoot it. */
export function forgetVisited(): void {
  try {
    storage()?.removeItem(VISITED_STORAGE_KEY);
  } catch {
    /* nothing to forget. */
  }
}
