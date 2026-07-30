/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — window.__atlas, THE SHELL'S HALF
 * =============================================================================
 *
 * `scripts/shoot.mjs` is the critic's eyes and this is what it looks through.
 *
 * The store already installs `scenes` / `scene` / `settled` / `perf` /
 * `describe` and drives every one of them through the REAL actions — there is no
 * mock render anywhere in that path. The shell adds the two things only the
 * shell can know:
 *
 *   audit()   measurements taken off the LIVE DOM: how much of the window the
 *             terrain actually has, whether anything shaped like a left rail
 *             exists, how many labels are really painted, and every measured
 *             numeral rendered outside the mono primitive.
 *   perf()    upgraded to the renderer's FULL `FrameStats`. The store's readout
 *             carries four fields; the terrain measures six, and `edges` and
 *             `labels` are exactly the two a critic wants when judging whether
 *             the edge policy and the label ceiling are being honoured.
 *
 * INSTALLATION MERGES, in both directions. `installAtlasTestHook()` merges over
 * whatever is already on `window.__atlas`, and so does this, so it does not
 * matter which of the two runs first — which is important, because `boot()`
 * calls the store's installer from inside a promise and this one runs from a
 * React effect.
 * =============================================================================
 */

import type { Terrain } from '@/graph';
import { installAtlasTestHook } from '@/state';

import { auditNow, type AtlasAudit } from './audit';
import { frameStatsOf } from './wiring';

/** The shell's contribution to the hook. Everything else comes from `@/state`. */
export interface ShellHook {
  audit(): AtlasAudit;
  perf(): ReturnType<typeof frameStatsOf>;
}

/**
 * Install (or re-install) the shell's half of `window.__atlas`.
 *
 * `getTerrain` is a THUNK rather than a value because the renderer arrives after
 * the first effect: a captured `null` would freeze `perf()` at zero for the rest
 * of the session, and a frozen instrument reading is worse than a missing one.
 */
export function installShellHook(getTerrain: () => Terrain | null): void {
  if (typeof window === 'undefined') return;

  // Make sure the store's half exists first, so a very early `audit()` call has
  // `scenes` and `scene` next to it rather than on its own.
  installAtlasTestHook();

  const host = window as unknown as { __atlas?: Record<string, unknown> };
  host.__atlas = {
    ...(host.__atlas ?? {}),
    audit: () => auditNow(frameStatsOf(getTerrain())),
    perf: () => frameStatsOf(getTerrain()),
  };
}
