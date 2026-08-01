/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE HOST BRIDGE
 * =============================================================================
 *
 * The store must never import the renderer. Position is baked, the camera is
 * interpolated outside React, and a store that could reach into the terrain
 * would eventually drive a frame from a reducer. But three things genuinely need
 * to cross that line, so they cross it HERE, through registration rather than
 * through an import:
 *
 *   1. THE SETTLE GATE. `SETTLING` is not over when the data arrives — it is
 *      over when the terrain has finished physically settling the new nodes into
 *      place. The shell registers `terrain.settleIngest` and the store awaits it,
 *      so the state on screen matches the motion on screen.
 *
 *   2. THE IDLE PROBE. `window.__atlas.settled()` must not resolve while a camera
 *      flight is still in the air, or every screenshot catches a half-finished
 *      transition. The shell registers `() => terrain.camera.idle()`.
 *
 *   3. THE CHECKPOINT HOLD. Visual QA has to photograph transient states —
 *      INGESTING lasts about as long as a corpus takes to materialise. A hold
 *      parks the pipeline at a NAMED CHECKPOINT of real work, so the screenshot
 *      is of a genuine state with genuine data in it, rather than of a mock. It
 *      is a debugger's pause button, not a fake loading screen: nothing about
 *      the work changes, it just waits to be released.
 *
 * Nothing here is required. With no registrations the store still runs the whole
 * machine correctly — it simply cannot wait for animations it has no knowledge
 * of, which is exactly the right failure mode.
 * =============================================================================
 */

import type { AppState } from '@/engine';

/* =============================================================================
 * 1. THE SETTLE GATE
 * ========================================================================== */

/** Runs the terrain's ingest-settling animation over the ids that just arrived. */
export type SettleGate = (nodeIds: readonly string[]) => Promise<void> | void;

let settleGate: SettleGate | null = null;

/**
 * Register the terrain's settle animation. Pass `null` on teardown.
 *
 * The shell wires this to `terrain.settleIngest`. Until it does, SETTLING covers
 * only the real data work, which is honest but shorter.
 */
export function registerSettleGate(gate: SettleGate | null): void {
  settleGate = gate;
}

/**
 * Await the registered settle animation. Resolves immediately when nothing is
 * registered. A gate that throws is reported and swallowed: a failed animation
 * must not take down the corpus that successfully baked behind it.
 */
export async function runSettleGate(nodeIds: readonly string[]): Promise<void> {
  if (settleGate === null) return;
  try {
    await settleGate(nodeIds);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[state/bridge] the settle gate threw; the corpus is fine, the animation is not.', err);
  }
}

/* =============================================================================
 * 2. THE IDLE PROBE
 * ========================================================================== */

/** True when no camera flight or scene transition is in the air. */
export type IdleProbe = () => boolean;

let idleProbe: IdleProbe | null = null;

/** Register the renderer's idle predicate — normally `() => terrain.camera.idle()`. */
export function registerIdleProbe(probe: IdleProbe | null): void {
  idleProbe = probe;
}

/** True when the renderer says it is idle, or when nothing has claimed otherwise. */
export function isIdle(): boolean {
  if (idleProbe === null) return true;
  try {
    return idleProbe();
  } catch {
    return true;
  }
}

/* =============================================================================
 * 3. CHECKPOINT HOLDS
 * ========================================================================== */

/**
 * The named points the lifecycle can be parked at. Each one is a real boundary
 * of real work, not an arbitrary sleep:
 *
 *   `<STATE>:enter`   the moment the machine entered the state
 *   `INGESTING:done`  every document has landed and the first view is in hand,
 *                     but the layout has not been handed to the renderer yet
 *   `SETTLING:done`   the bake is on screen and the settle animation has run
 */
export type Checkpoint =
  | `${AppState}:enter`
  | 'INGESTING:done'
  | 'SETTLING:done'
  | 'QUERYING:done';

/** How long a hold may park the pipeline before it releases itself, in ms. */
export const HOLD_TIMEOUT_MS = 20_000;

interface Hold {
  at: Checkpoint;
  release: () => void;
  promise: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

let hold: Hold | null = null;

/**
 * Park the pipeline the next time it reaches `at`.
 *
 * VISUAL QA ONLY. Returns a promise that resolves the moment the pipeline
 * actually arrives, so a scene driver can wait for the state to be on screen.
 */
export function holdAt(at: Checkpoint): Promise<void> {
  releaseHold();
  let arrived: () => void = () => {};
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timer =
    typeof setTimeout === 'function'
      ? setTimeout(() => {
          // eslint-disable-next-line no-console
          console.error(
            `[state/bridge] the hold at ${at} was never released after ${HOLD_TIMEOUT_MS}ms and has released itself. ` +
              `Something drove a scene and then forgot to call releaseHold().`,
          );
          releaseHold();
        }, HOLD_TIMEOUT_MS)
      : null;
  (timer as unknown as { unref?: () => void } | null)?.unref?.();

  hold = { at, release, promise, timer };
  // The arrival promise is resolved by `awaitHold` when the pipeline gets there.
  arrivals.set(at, arrived);
  return arrival;
}

/** Resolvers for "the pipeline reached this checkpoint", keyed by checkpoint. */
const arrivals = new Map<Checkpoint, () => void>();

/** Release whatever is parked. Safe to call when nothing is. */
export function releaseHold(): void {
  if (hold === null) return;
  const current = hold;
  hold = null;
  if (current.timer !== null) clearTimeout(current.timer);
  arrivals.delete(current.at);
  current.release();
}

/** True when the pipeline is currently parked at a checkpoint. */
export function isHeld(): boolean {
  return hold !== null;
}

/** Which checkpoint is parked, or `null`. */
export function heldAt(): Checkpoint | null {
  return hold === null ? null : hold.at;
}

/**
 * Called by the store at every checkpoint. Resolves immediately unless a hold
 * has been registered for exactly this one.
 */
export async function awaitHold(at: Checkpoint): Promise<void> {
  if (hold === null || hold.at !== at) return;
  const arrived = arrivals.get(at);
  if (arrived !== undefined) arrived();
  await hold.promise;
}

/* =============================================================================
 * 4. THE VIEWPOINT — reading the live camera, and framing a set of ids
 * -----------------------------------------------------------------------------
 * A fourth thing genuinely needs to cross the line, and it is the one the
 * navigation stack is built on: WHERE THE USER WAS LOOKING.
 *
 * The store's `camera` field is a TARGET and a version counter — it changes only
 * when something deliberately moves the camera, and it says nothing at all about
 * where a hand-driven pan or a wheel-zoom left the viewpoint. Saving a scene from
 * it would save the last place the store pointed the camera rather than the place
 * the user is actually standing, so "Return to previous view" would return to
 * somewhere they never were. That is worse than having no back at all: a reverse
 * action that lands somewhere unexpected teaches people not to trust the control.
 *
 * So the renderer registers a reader for its own live camera, and a framer that
 * fits a set of ids the same way the descent does. Both are optional; with
 * neither registered the navigation stack still restores rung, scope, selection
 * and focus, and simply leaves the viewpoint alone — which is the honest
 * degradation, not a broken one.
 * ========================================================================== */

/** A place the camera can be standing. World units, not pixels. */
export interface Viewpoint {
  x: number;
  y: number;
  zoom: number;
}

/** Reads the renderer's CURRENT camera — not the store's target. */
export type CameraProbe = () => Viewpoint | null;

/** Frames a set of node ids, the way a descent or a constellation is framed. */
export type FrameGate = (ids: readonly string[], paddingPx?: number) => Promise<void> | void;

let cameraProbe: CameraProbe | null = null;
let frameGate: FrameGate | null = null;

/** Register the renderer's live-camera reader — normally `() => terrain.camera.get()`. */
export function registerCameraProbe(probe: CameraProbe | null): void {
  cameraProbe = probe;
}

/** Where the camera is standing right now, or `null` when nothing can say. */
export function readViewpoint(): Viewpoint | null {
  if (cameraProbe === null) return null;
  try {
    return cameraProbe();
  } catch {
    return null;
  }
}

/** Register the renderer's framer — normally `(ids, pad) => terrain.camera.fitTo([...ids], pad)`. */
export function registerFrameGate(gate: FrameGate | null): void {
  frameGate = gate;
}

/**
 * Frame a set of ids. Resolves immediately when nothing is registered.
 *
 * A framer that throws is reported and swallowed, for the same reason the settle
 * gate's is: a camera that failed to arrive must not take down the answer it was
 * being pointed at.
 */
export async function runFrameGate(ids: readonly string[], paddingPx?: number): Promise<void> {
  if (frameGate === null || ids.length === 0) return;
  try {
    await frameGate(ids, paddingPx);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[state/bridge] the frame gate threw; the result is fine, the camera is not.', err);
  }
}

/* =============================================================================
 * 5. IN-FLIGHT TRACKING
 * -----------------------------------------------------------------------------
 * `settled()` needs to know whether the store is mid-action. Rather than a
 * boolean that somebody will forget to clear, every async action registers its
 * own promise and removes it on completion, success or failure.
 * ========================================================================== */

const inflight = new Set<Promise<unknown>>();

/** Register an action's promise. Returns the same promise, so it composes inline. */
export function track<T>(promise: Promise<T>): Promise<T> {
  inflight.add(promise);
  const done = (): void => {
    inflight.delete(promise);
  };
  promise.then(done, done);
  return promise;
}

/** How many actions are in flight right now. */
export function inflightCount(): number {
  return inflight.size;
}

/**
 * Wait until no action is in flight.
 *
 * Returns early while a hold is engaged: the parked action is deliberately not
 * finishing, and waiting for it would deadlock the very screenshot the hold
 * exists to take.
 */
export async function drain(timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (inflight.size > 0 && !isHeld() && Date.now() - started < timeoutMs) {
    try {
      await Promise.race([...inflight]);
    } catch {
      /* the action's own caller reports it; drain only cares that it finished. */
    }
  }
}

/** Reset every registration. Tests and hot-reload only. */
export function resetBridge(): void {
  settleGate = null;
  idleProbe = null;
  cameraProbe = null;
  frameGate = null;
  releaseHold();
  inflight.clear();
}
