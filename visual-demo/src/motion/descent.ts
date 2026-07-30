/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE DESCENT, AS MOTION
 * =============================================================================
 *
 * The choreography of a rung change lives in `@/ui/atlas/descent.ts`: it owns the
 * camera targets, the fovea-outward resolve, the breadcrumb push and the glyph
 * flip. What lives HERE is the beat that is pure motion — the APPROACH — and the
 * registration that puts a rung change on the same clock as the other four
 * signature animations.
 *
 * -----------------------------------------------------------------------------
 * THE APPROACH: A BODY BECOMING THE GROUND
 * -----------------------------------------------------------------------------
 * Descending into a continent is not opening it. The continent stops being a
 * THING and becomes the PLACE you are standing in — and the picture has to say
 * that before the new rung lands, or the change reads as a page load with a
 * camera move stapled to it.
 *
 * So while the camera flies in, the target DEFOCUSES down the resolution ramp:
 *   lod-0 -> lod-1 -> lod-2 -> ghost
 * Its stroke thins, its dot softens, its opacity falls to the ghost tier — and
 * the region wash the renderer draws underneath its own children takes over. It
 * has not been hidden and it has not been deleted: it is exactly where it was, at
 * the tier a thing you are standing INSIDE is drawn at. Its siblings fall to
 * `latent` in the same map, because the engine has stopped spending on them.
 *
 * ASCENT IS THE TRUE REVERSE, and it is the same code with the ramp read the
 * other way: the ground you are standing on RESOLVES back into a body as the
 * camera pulls away from it, ghost -> lod-2 -> lod-1 -> lod-0, arriving as one of
 * its own siblings just as they bloom back around it.
 *
 * -----------------------------------------------------------------------------
 * WHY THE RUN IS `manual`
 * -----------------------------------------------------------------------------
 * A rung change is over when the WORK is over: the fetch has returned, the
 * fovea-outward ramp has run and the camera has come to rest. That is `--t-scene`
 * on a warm cache and longer on a cold one, and a run that ended on the token
 * would be reporting a duration rather than measuring one. The atlas layer ends
 * it when the choreography ends, and `motionLog()` reports what it really took.
 * =============================================================================
 */

import type { LodState, Rung } from '@/engine';
import { useAtlas } from '@/state';

import { readMotionBudget } from './budget';
import { terrainNow } from './terrain';
import { runMotion, type MotionRun } from './timeline';

/**
 * The ramp a body walks down as it becomes the ground.
 *
 * Four tiers, in the ramp's own order, and not one of them is invented: they are
 * the four states design-tokens.css §7 declares above `latent`, which is the
 * tier reserved for topology nobody is spending on. The body you are entering is
 * never latent — you are standing in it.
 */
const DEFOCUS: readonly LodState[] = ['lod-0', 'lod-1', 'lod-2', 'ghost'];

export interface RungMotionInput {
  /** The `rung|scope` the store is moving to. The witness. */
  place: string;
  direction: 'descend' | 'ascend' | 'jump';
  /** The body being entered or left. `null` for a whole-rung jump. */
  targetId: string | null;
  /** The target's siblings — what the engine stops spending on. */
  narrow: readonly string[];
  /** From-rung, to-rung: reported in the log so a descent is legible in it. */
  from: Rung;
  to: Rung;
}

/** The handle the atlas layer drives its own choreography's registration with. */
export interface RungMotion {
  /**
   * The approach is over: the place has changed and the resolve owns the ramp.
   *
   * Load-bearing rather than tidy. Two writers on the resolution map in one
   * frame is a race, and the loser is whichever one the browser called second —
   * so the approach STOPS writing the instant the resolve starts writing.
   */
  endApproach(): void;
  /** The whole choreography finished. Checks the witness against the store. */
  finish(): void;
  /** Superseded by a newer move, or refused by the store. */
  cancel(): void;
}

/**
 * Register a rung change on the shared timeline and run its approach.
 *
 * With no renderer attached the approach draws nothing and the run still exists,
 * because the log and `settled()` care that a rung change is in flight whether or
 * not there is a picture of it.
 */
export function beginRungMotion(input: RungMotionInput): RungMotion {
  const budget = readMotionBudget();
  const approachMs = budget.sceneMs;
  let approaching = input.targetId !== null;

  const narrow = new Set(input.narrow);
  const target = input.targetId;
  // Ascending, the body is coming BACK into focus: the same four tiers, read the
  // other way round. This is the whole of "the ascent is the true reverse".
  const ramp = input.direction === 'ascend' ? [...DEFOCUS].reverse() : DEFOCUS;

  const run: MotionRun = runMotion({
    name: 'descent',
    witness: { of: 'rung', place: input.place },
    durationMs: approachMs,
    steps: ramp.length,
    stepMs: approachMs / ramp.length,
    ease: '--ease-camera',
    manual: true,
    onFrame: (f) => {
      if (!approaching || target === null) return;
      const terrain = terrainNow();
      if (terrain === null) return;
      const map: Record<string, LodState> = { ...useAtlas.getState().lod };
      for (const id of narrow) map[id] = 'latent';
      /* Under reduced motion there is one step, and it is the END of the ramp:
         the body arrives as the ground in one crossfade rather than walking down
         four tiers. The ontology change is untouched; the travel is gone. */
      map[target] = f.steps <= 1 ? ramp[ramp.length - 1] : ramp[Math.min(ramp.length - 1, f.stage)];
      terrain.setLod(map);
    },
  });

  return {
    endApproach: () => {
      approaching = false;
    },
    finish: () => {
      approaching = false;
      run.finish();
    },
    cancel: () => {
      approaching = false;
      run.cancel();
    },
  };
}
