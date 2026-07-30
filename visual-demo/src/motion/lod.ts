/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE RESOLUTION MAP, WHILE SOMETHING IS ARRIVING
 * =============================================================================
 *
 * MOTION LAW 1: RESOLUTION STEPS, NEVER POPS.
 *
 * Three of the five signature animations move nodes along the resolution ramp,
 * and all three do it through the SAME channel — the renderer's `setLod`
 * override, re-asserted every frame, handed back verbatim at the end. That last
 * clause is the whole discipline: the terminal frame of a choreography and the
 * resting frame of the store are the same frame, so nothing this layer does can
 * leave the picture disagreeing with what the engine spent.
 *
 * NOTHING HERE DECIDES A TIER. Every value written is either a tier the store
 * already derived from the trace's own admission records, or `latent` — the
 * load-bearing tier that exists precisely so the terrain never has a hole while
 * something is on its way. This layer decides ORDER and TIME, never resolution.
 * =============================================================================
 */

import type { LodState } from '@/engine';
import { useAtlas } from '@/state';

import { terrainNow } from './terrain';
import { isRunning } from './timeline';

/**
 * THE THREE TIERS OF ONE ARRIVING RENDER, in the ramp's own vocabulary.
 *
 *   0  fovea      lod-0, carried verbatim — the only tier a citation may rest on
 *   1  penumbra   lod-1, summarised
 *   2  periphery  lod-2 and everything below it: named, or known and unspent
 *
 * This is not a new classification invented for the animation. It is the
 * resolution ramp read as an ORDER, which is what makes the reveal legible: the
 * eye is being walked down the same ladder the receipt itemises.
 */
export function tierOf(lod: LodState): 0 | 1 | 2 {
  if (lod === 'lod-0') return 0;
  if (lod === 'lod-1') return 1;
  return 2;
}

/**
 * True while a motion run owns the resolution map.
 *
 * The shell pushes `store.lod` at the renderer whenever the view commits. While
 * one of these runs is re-asserting its own map every frame the worst that push
 * can do is one partially-advanced crossfade — but not pushing is cleaner than
 * winning the race, so the shell asks this first.
 */
export function motionOwnsLod(): boolean {
  return isRunning('reveal') || isRunning('ingest');
}

/**
 * Hand the resolution map back to the store, immediately and verbatim.
 *
 * Called by every run that took it, on EVERY exit — finished, superseded,
 * cancelled or bailed. A run that kept its map after ending would be the
 * interface claiming the engine had stopped spending on something it is still
 * spending on, which is the one thing this product may never do.
 */
export function restoreStoreLod(): void {
  terrainNow()?.setLod(useAtlas.getState().lod);
}
