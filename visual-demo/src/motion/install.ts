/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — INSTALLING THE MOTION LAYER
 * =============================================================================
 *
 * One call, from the shell, and every animation in this layer is live. The shell
 * should not have to know that a reveal is a store subscription and a trace
 * cleanup is another one — it should have to know that motion exists and that it
 * is installed once.
 *
 * `installMotion()` is idempotent and returns the teardown, so it composes with a
 * React effect exactly like `installDescentChoreography()` does.
 * =============================================================================
 */

import { useAtlas } from '@/state';

import { installTraceCleanup } from './ping';
import { installRenderReveal } from './reveal';
import { primeMotionTerrain } from './terrain';
import { installMotionHook } from './hook';
import { cancelMotion } from './timeline';

let installed = false;

/**
 * NOTHING ANIMATES A WORLD THAT HAS BEEN CLOSED.
 *
 * `unload()` takes the corpus away — the view goes null, the bake goes with it,
 * and every id any run in flight is holding stops referring to anything. A
 * descent finishing after that would assert it had arrived at a place that no
 * longer exists, and the witness would be right to report it.
 *
 * So a closing corpus CANCELS rather than completes: the runs stand down, hand
 * their resolution maps back and are logged as interrupted, which is exactly
 * what happened to them.
 */
function installLifecycleCleanup(): () => void {
  return useAtlas.subscribe((state, prev) => {
    if (state.view !== null || prev.view === null) return;
    cancelMotion('descent');
    cancelMotion('reveal');
    cancelMotion('ingest');
    cancelMotion('trace');
    cancelMotion('receipt');
  });
}

/**
 * Install every store subscription this layer needs, plus the measurement
 * surface the visual-QA pass reads. Returns the teardown.
 */
export function installMotion(): () => void {
  if (installed) return () => undefined;
  installed = true;
  void primeMotionTerrain();
  installMotionHook();
  const stop = [installRenderReveal(), installTraceCleanup(), installLifecycleCleanup()];
  return () => {
    installed = false;
    for (const s of stop) s();
  };
}
