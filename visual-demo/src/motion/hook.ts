/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — window.__atlas.motion, THE MOTION LAYER'S HALF
 * =============================================================================
 *
 * Everything a critic can ask about this layer, MEASURED off the running product
 * rather than read off a token file:
 *
 *   log()         the last 64 runs, each with the wall-clock ms it actually took
 *                 and the duration it asked for. When the two disagree the log is
 *                 right and the machine was busy.
 *   active()      what is animating this instant, by name.
 *   idle()        whether anything is. The shell folds this into `settled()`, so
 *                 a screenshot can no longer be taken mid-stagger.
 *   violations()  every animation that ran without the state to justify it.
 *                 Also reported by `audit().animationsWithoutState`.
 *   budget()      the durations this session is actually spending, after the
 *                 reduced-motion collapse. This is how "prefers-reduced-motion
 *                 collapses every scene animation to 120ms" stops being a claim.
 *
 * INSTALLATION MERGES, in both directions, exactly like the store's and the
 * shell's halves: it does not matter which of the three runs first.
 * =============================================================================
 */

import { readMotionBudget, type MotionBudget } from './budget';
import { clearMotionLog, motionActive, motionIdle, motionLog, type MotionResult } from './timeline';
import { clearMotionViolations, motionViolations, type MotionName } from './witness';

/** The motion layer's contribution to `window.__atlas`. */
export interface MotionHook {
  log(): readonly MotionResult[];
  active(): MotionName[];
  idle(): boolean;
  violations(): readonly string[];
  budget(): MotionBudget;
  /** Forget the log and the violations. The scene driver calls this per scene. */
  reset(): void;
}

export function installMotionHook(): void {
  if (typeof window === 'undefined') return;
  const host = window as unknown as { __atlas?: Record<string, unknown> };
  host.__atlas = {
    ...(host.__atlas ?? {}),
    motion: {
      log: () => motionLog(),
      active: () => motionActive(),
      idle: () => motionIdle(),
      violations: () => motionViolations(),
      budget: () => readMotionBudget(),
      reset: () => {
        clearMotionLog();
        clearMotionViolations();
      },
    } satisfies MotionHook,
  };
}
