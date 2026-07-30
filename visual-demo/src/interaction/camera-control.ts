/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — DIRECT MANIPULATION
 * =============================================================================
 *
 * Wheel, drag, fling and pinch. Framework-free on purpose: it takes screen
 * coordinates and a `TerrainCamera` and it returns nothing, so it can be driven
 * from a React surface, from a minimap, or from a test that never mounts a
 * component.
 *
 * -----------------------------------------------------------------------------
 * THE ONE DETAIL THAT DECIDES WHETHER THIS FEELS LIKE AN INSTRUMENT
 * -----------------------------------------------------------------------------
 * THE WORLD POINT UNDER THE CURSOR MUST NOT MOVE WHILE YOU ZOOM. Not "barely
 * move" — not move. Everything else about a map can be forgiven; a map that
 * slides out from under the pointer while you are trying to look closer at
 * something is a map you stop trusting with your hands.
 *
 * The transform is two lines and it lives in ONE place — `TerrainCamera.zoomAt`,
 * which the renderer exposes precisely so every caller gets the same exact
 * arithmetic:
 *
 *     before = screenToWorld(sx, sy)
 *     zoom  *= factor                       // clamped to the altitude range
 *     after  = screenToWorld(sx, sy)
 *     centre += before - after
 *
 * Because `after` is computed with the zoom that was ACTUALLY applied, the
 * invariant survives the clamp: at maximum altitude the factor silently becomes
 * 1 and the point stays exactly where it was, instead of drifting by the amount
 * the clamp swallowed. This module's job is to hand that function the right
 * anchor and the right factor, and then to not undo it — see `clamp()`.
 *
 * -----------------------------------------------------------------------------
 * THE HARD CLAMP, AND WHY IT DOES NOT RUN ON ZOOM
 * -----------------------------------------------------------------------------
 * You can never get lost. The camera CENTRE is bounded to the world rectangle
 * inflated by `--pan-overscroll` half-frustums, so at the extreme the terrain
 * still occupies a quarter of the viewport.
 *
 * THE CLAMP RUNS ON PAN ONLY. This was measured, not assumed: with the clamp on
 * the zoom path, `scripts/verify-interaction.mjs` recorded a steady ~9.8px of
 * drift per wheel event once the centre reached a boundary — the clamp pulled the
 * centre back and the anchored world point went with it. The clamp was solving a
 * problem zoom does not have. An anchored zoom keeps a world point pinned under
 * the cursor, and the cursor is on screen by definition, so the world cannot
 * translate away from you no matter how many times you zoom. Only a translation
 * can lose the terrain, and only pan translates.
 *
 * What zoom gets instead is `keepInSight`, a genuine safety net rather than a
 * constraint: it does nothing at all unless the frustum has stopped intersecting
 * the world rectangle entirely — reachable only by zooming IN on empty space
 * beyond the terrain, which is a thing the user did deliberately. In every normal
 * gesture it is a no-op, and the anchored point is exact to float precision.
 *
 * -----------------------------------------------------------------------------
 * MOMENTUM DECAYS HONESTLY
 * -----------------------------------------------------------------------------
 * Velocity decays as e^(-t/τ) with τ = `--fling-tau`, and the distance travelled
 * over a frame is the integral of that curve across the frame — v·τ·(1 - e^(-dt/τ))
 * — not `v · dt` with the velocity scaled afterwards. The difference is visible
 * on a dropped frame: the cheap version travels short and the terrain hitches.
 * The fling ends when the speed genuinely falls below `--fling-min-speed`; there
 * is no timer deciding when the gesture "should" be over.
 *
 * THE RELEASE VELOCITY IS MEASURED OVER A WINDOW, FROM COALESCED SAMPLES, ON THE
 * EVENT CLOCK. All three halves of that were forced by measurement, not taste:
 *
 *   A WINDOW, not the last two samples — a pair-wise estimate swings wildly with
 *   however fast the samples happened to arrive.
 *
 *   COALESCED SAMPLES — the browser delivers ONE `pointermove` per animation
 *   frame and hides the rest behind `getCoalescedEvents()`. On a slow display
 *   that is a single sample for an entire flick, and the rig caught exactly that:
 *   `samples=2, window=0.0ms`, no fling, on a gesture that visibly threw the
 *   terrain. Reading the coalesced history makes the estimate independent of the
 *   frame rate, which is the whole point — momentum must not stop working on the
 *   machines that need it most.
 *
 *   THE EVENT CLOCK — the gap between the last motion and the release is measured
 *   from `event.timeStamp` on both sides, so however long the events sat in the
 *   input queue cancels out. Measured on handler time, a busy frame reads as a
 *   hand that paused, and the flick is silently swallowed.
 *
 * A release after `--fling-release` of genuine stillness still throws nothing,
 * because a hand that stopped before letting go did not throw anything.
 * ========================================================================== */

import type { Bounds } from '@/engine';
import type { TerrainCamera } from '@/graph';
import { readTuning, type Tuning } from '@/interaction/tuning';

/** A pointer's position in CSS pixels, relative to the terrain canvas. */
interface Pt {
  x: number;
  y: number;
}

/**
 * One pointer sample with its own timestamp, in CSS pixels relative to the
 * terrain canvas. `t` is on the EVENT clock (`event.timeStamp`), which shares an
 * origin with `performance.now()` and, unlike a handler-time reading, does not
 * fold the input queue into the measurement.
 */
export interface PointerSample {
  x: number;
  y: number;
  t: number;
}

export interface CameraControlOptions {
  /**
   * Called once whenever direct manipulation quiesces — the drag ended, the
   * fling stopped, the wheel went quiet. The surface uses it to write the
   * camera back to the store, so a saved view carries where you actually are.
   */
  onSettled?: () => void;
  /** Called on every applied change, for the minimap and the semantic-zoom watch. */
  onChange?: () => void;
}

export interface CameraControl {
  /** The live camera, or `null` before the terrain has mounted. */
  attach(camera: TerrainCamera | null): void;
  /** The world rectangle the clamp is taken against. `null` disables the clamp. */
  setBounds(bounds: Bounds | null): void;

  /**
   * One wheel event. `sx`/`sy` are CSS pixels relative to the canvas; `ctrl` is
   * true for a trackpad pinch, which every browser reports as ctrl+wheel.
   */
  wheel(deltaY: number, deltaMode: number, ctrl: boolean, sx: number, sy: number): void;

  pointerDown(id: number, sx: number, sy: number, t?: number): void;
  /**
   * `history` is `event.getCoalescedEvents()`, mapped into surface coordinates.
   * Pass it whenever it is available: one `pointermove` per frame is not enough
   * to fit a velocity to, and the browser kept the rest for exactly this.
   */
  pointerMove(id: number, sx: number, sy: number, history?: readonly PointerSample[]): void;
  pointerUp(id: number, t?: number): void;
  /** Drop a pointer without ending the gesture in a fling (cancel, capture loss). */
  pointerCancel(id: number): void;

  /** True once the active press has moved past `--drag-threshold`. */
  moved(): boolean;
  /** Number of pointers currently down. 2+ means a pinch is in progress. */
  pointers(): number;
  /**
   * True while the hand is on the terrain OR a fling is still travelling.
   *
   * Load-bearing for whoever syncs the store's camera target: `camera.idle()`
   * only reports FLIGHTS, and a drag is not a flight. Writing the store on every
   * idle frame during a drag is 60 store writes a second, which is the exact
   * failure the target/current split exists to prevent.
   */
  busy(): boolean;

  /**
   * What the last release actually measured. Diagnostics, not state: a fling
   * that does not happen should be explainable without a debugger, and "the
   * hand had already stopped" and "the samples were too close together to fit a
   * velocity to" are different answers.
   */
  lastRelease(): {
    /** Time between the newest pointer sample and the release, in ms. */
    gapMs: number;
    /** The window the fit was taken over, in ms. */
    dtMs: number;
    /** Samples in the trailing window. */
    samples: number;
    /** Fitted release speed, in CSS px per ms. Zero when no fling was started. */
    speed: number;
    /** Why it did or did not fling. */
    verdict:
      | 'flung'
      | 'stopped-at-wall'
      | 'released-at-rest'
      | 'window-too-short'
      | 'below-min-speed'
      | 'reduced-motion'
      | 'no-samples';
  };

  /** Stop any fling immediately. Called on every discrete navigation. */
  stop(): void;
  dispose(): void;
}

/**
 * THE HARD CLAMP, as a free function so the minimap and the surface cannot drift
 * apart about where the edge of the world is.
 *
 * A no-op inside the allowed rectangle — which is everywhere a zoom gesture over
 * the terrain can put the centre — so it never disturbs the zoom anchor.
 */
export function clampCameraToWorld(
  camera: TerrainCamera,
  bounds: Bounds | null,
  overscroll: number,
): void {
  if (bounds === null) return;
  const f = camera.frustum();
  const padX = (f.w / 2) * overscroll;
  const padY = (f.h / 2) * overscroll;
  const cur = camera.get();
  const x = Math.min(bounds.max_x + padX, Math.max(bounds.min_x - padX, cur.x));
  const y = Math.min(bounds.max_y + padY, Math.max(bounds.min_y - padY, cur.y));
  if (x !== cur.x || y !== cur.y) camera.set(x, y, cur.zoom);
}

/** Wheel deltas arrive in three units. Normalise to CSS pixels, once, here. */
function wheelPixels(deltaY: number, deltaMode: number, viewportH: number): number {
  if (deltaMode === 1) return deltaY * 16; // DOM_DELTA_LINE — one line of text
  if (deltaMode === 2) return deltaY * viewportH; // DOM_DELTA_PAGE
  return deltaY;
}

export function createCameraControl(opts: CameraControlOptions = {}): CameraControl {
  let camera: TerrainCamera | null = null;
  let bounds: Bounds | null = null;

  const down = new Map<number, Pt>();
  let primary: number | null = null;
  let last: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let pastThreshold = false;

  /** Trailing pointer samples, newest last. The release velocity is fitted to these. */
  const samples: { x: number; y: number; t: number }[] = [];

  /** Screen-space velocity in CSS px per ms, fitted at release. */
  let vx = 0;
  let vy = 0;

  /** Pinch state: the distance and midpoint between the two active pointers. */
  let pinchDist = 0;
  let pinchMid: Pt = { x: 0, y: 0 };

  let flingRaf = 0;
  let flingAt = 0;
  /** The release instant, on the EVENT clock. See the header. */
  let releaseAt = 0;
  let flingFrames = 0;
  let flingPx = 0;
  let release: ReturnType<CameraControl['lastRelease']> = {
    gapMs: 0,
    dtMs: 0,
    samples: 0,
    speed: 0,
    verdict: 'no-samples',
  };
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const tuning = (): Tuning => readTuning();

  const changed = (): void => {
    opts.onChange?.();
  };

  /**
   * Bound the camera centre to the world. A no-op inside the allowed rectangle,
   * which is everywhere a zoom gesture over the terrain can put it — that is why
   * this can be applied unconditionally without disturbing the zoom anchor.
   */
  /** The hard clamp. PAN ONLY — see the header. */
  const clamp = (): void => {
    if (camera === null) return;
    clampCameraToWorld(camera, bounds, tuning().overscroll);
  };

  /**
   * The zoom path's safety net. A no-op unless the frustum has stopped
   * intersecting the world entirely, which only a zoom-in on far-away emptiness
   * can achieve. It must not fire in a normal gesture, because when it fires it
   * breaks the anchor — that is the trade, and it is worth making exactly once.
   */
  const keepInSight = (): void => {
    if (camera === null || bounds === null) return;
    const f = camera.frustum();
    const c = camera.get();
    const missesX = c.x - f.w / 2 > bounds.max_x || c.x + f.w / 2 < bounds.min_x;
    const missesY = c.y - f.h / 2 > bounds.max_y || c.y + f.h / 2 < bounds.min_y;
    if (!missesX && !missesY) return;
    clamp();
  };

  /**
   * Fit a velocity to the trailing `--fling-window` of pointer samples.
   *
   * Two samples is noise: a 240Hz mouse delivers pairs 4ms apart and one jittery
   * pair reads as 3 px/ms. A window is stable, and the ceiling catches whatever
   * the window does not.
   */
  const fitVelocity = (): void => {
    vx = 0;
    vy = 0;
    const t = tuning();
    const newest = samples[samples.length - 1];
    if (newest === undefined) {
      release = { gapMs: 0, dtMs: 0, samples: 0, speed: 0, verdict: 'no-samples' };
      return;
    }

    const gapMs = Math.max(0, releaseAt - newest.t);
    let oldest = newest;
    for (let i = samples.length - 1; i >= 0; i--) {
      if (newest.t - samples[i].t > t.flingWindowMs) break;
      oldest = samples[i];
    }
    /* THE WINDOW MUST CONTAIN AT LEAST TWO SAMPLES. On a machine rendering at
       16fps the pointer is sampled every ~120ms, which is wider than the whole
       `--fling-window`, and the loop above then leaves the window holding exactly
       one sample — no velocity, no momentum, ever, on precisely the machines that
       look worst without it. The window is a preference; two samples is the
       arithmetic. Measured: the rig produced samples 120ms apart and every flick
       came back `window-too-short`. */
    if (oldest === newest && samples.length >= 2) oldest = samples[samples.length - 2];
    const dtMs = newest.t - oldest.t;

    // A hand that rested before letting go did not throw anything. The gap is
    // measured from the LAST POINTER SAMPLE, which is when the hand actually
    // stopped — not from the last frame or the last store write.
    if (gapMs > t.flingReleaseMs) {
      release = { gapMs, dtMs, samples: samples.length, speed: 0, verdict: 'released-at-rest' };
      return;
    }
    if (dtMs < 8) {
      // Not enough travel time to fit anything real to. Refusing to guess is the
      // right answer: an invented velocity here is a terrain that lurches.
      release = { gapMs, dtMs, samples: samples.length, speed: 0, verdict: 'window-too-short' };
      return;
    }

    let ux = (newest.x - oldest.x) / dtMs;
    let uy = (newest.y - oldest.y) / dtMs;
    const speed = Math.hypot(ux, uy);
    if (speed > t.flingMaxSpeed) {
      ux = (ux / speed) * t.flingMaxSpeed;
      uy = (uy / speed) * t.flingMaxSpeed;
    }
    vx = ux;
    vy = uy;
    release = {
      gapMs,
      dtMs,
      samples: samples.length,
      speed: Math.min(speed, t.flingMaxSpeed),
      verdict: 'flung',
    };
  };

  /** Announce quiescence once the hand has actually stopped. */
  const scheduleSettle = (): void => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (!disposed) opts.onSettled?.();
    }, tuning().ms.ui);
  };

  const stopFling = (): void => {
    if (flingRaf !== 0) cancelAnimationFrame(flingRaf);
    flingRaf = 0;
    vx = 0;
    vy = 0;
  };

  const flingStep = (now: number): void => {
    flingRaf = 0;
    flingFrames++;
    if (disposed || camera === null) return;
    const t = tuning();
    const dt = Math.min(64, Math.max(1, now - flingAt));
    flingAt = now;

    const decay = Math.exp(-dt / t.flingTauMs);
    // Distance under the decay curve across this frame, not v·dt.
    const travel = t.flingTauMs * (1 - decay);
    const before = camera.get();
    camera.panByPixels(vx * travel, vy * travel);
    flingPx += Math.hypot(vx * travel, vy * travel);
    clamp();
    changed();
    const after = camera.get();

    /* THE WALL STOPS THE FLING. Momentum that the clamp absorbs entirely has
       ended — the terrain is not moving and nothing about it will change on the
       next frame either. Left running it is invisible AND harmful: `panByPixels`
       cancels any camera flight in progress, so a fling parked against a bound
       silently eats the next descent, the next `fitTo`, the next search result
       flown to. Caught by the rig, which framed the terrain and found the camera
       still pinned at the boundary a moment later. */
    if (before.x === after.x && before.y === after.y) {
      release = { ...release, verdict: 'stopped-at-wall' };
      stopFling();
      scheduleSettle();
      return;
    }

    vx *= decay;
    vy *= decay;
    if (Math.hypot(vx, vy) < t.flingMinSpeed) {
      stopFling();
      scheduleSettle();
      return;
    }
    flingRaf = requestAnimationFrame(flingStep);
  };

  const startFling = (): void => {
    const t = tuning();
    flingFrames = 0;
    flingPx = 0;
    fitVelocity();
    if (t.reducedMotion) release = { ...release, verdict: 'reduced-motion' };
    else if (release.verdict === 'flung' && Math.hypot(vx, vy) < t.flingMinSpeed) {
      release = { ...release, verdict: 'below-min-speed' };
    }
    if (t.reducedMotion || Math.hypot(vx, vy) < t.flingMinSpeed) {
      stopFling();
      scheduleSettle();
      return;
    }
    flingAt = performance.now();
    flingRaf = requestAnimationFrame(flingStep);
  };

  const midpoint = (): { mid: Pt; dist: number } => {
    const pts = [...down.values()];
    const a = pts[0];
    const b = pts[1];
    return {
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  };

  return {
    attach(next) {
      if (next !== camera) {
        stopFling();
        down.clear();
        primary = null;
      }
      camera = next;
    },

    setBounds(next) {
      bounds = next;
    },

    wheel(deltaY, deltaMode, ctrl, sx, sy) {
      if (camera === null) return;
      stopFling();
      const t = tuning();
      const f = camera.frustum();
      const viewportH = f.h * camera.get().zoom;
      const raw = wheelPixels(deltaY, deltaMode, viewportH);
      const travel = Math.max(-t.stepMaxPx, Math.min(t.stepMaxPx, raw));
      const rate = ctrl ? t.pinchRate : t.wheelRate;
      // Wheel down (positive deltaY) is zoom OUT, matching every map ever made.
      const factor = Math.exp(-travel * rate);
      if (factor === 1) return;
      camera.zoomAt(sx, sy, factor);
      // NOT `clamp()`. See the header: the clamp is for translation, and applying
      // it here drags the anchored world point out from under the cursor.
      keepInSight();
      changed();
      scheduleSettle();
    },

    pointerDown(id, sx, sy, t) {
      stopFling();
      down.set(id, { x: sx, y: sy });
      if (down.size === 1) {
        primary = id;
        start = { x: sx, y: sy };
        last = { x: sx, y: sy };
        samples.length = 0;
        samples.push({ x: sx, y: sy, t: t ?? performance.now() });
        pastThreshold = false;
      } else if (down.size === 2) {
        const m = midpoint();
        pinchDist = m.dist;
        pinchMid = m.mid;
        pastThreshold = true; // a two-finger gesture is never a click
      }
    },

    pointerMove(id, sx, sy, history) {
      if (camera === null || !down.has(id)) return;
      down.set(id, { x: sx, y: sy });

      if (down.size >= 2) {
        const m = midpoint();
        if (pinchDist > 0) {
          const factor = m.dist / pinchDist;
          if (factor > 0 && Number.isFinite(factor)) camera.zoomAt(m.mid.x, m.mid.y, factor);
        }
        // The two fingers may also be travelling together: that is a pan.
        camera.panByPixels(m.mid.x - pinchMid.x, m.mid.y - pinchMid.y);
        pinchDist = m.dist;
        pinchMid = m.mid;
        // A pinch is a pan and a zoom at once, so the PAN clamp applies. At a
        // world edge that costs the pinch anchor a pixel or two; a two-finger
        // gesture that walks off the map costs the user the map.
        clamp();
        changed();
        return;
      }

      if (id !== primary) return;
      const dx = sx - last.x;
      const dy = sy - last.y;
      const now = performance.now();

      if (!pastThreshold) {
        if (Math.hypot(sx - start.x, sy - start.y) < tuning().dragThresholdPx) {
          // Still a click. Do not move the world for two pixels of hand tremor.
          return;
        }
        pastThreshold = true;
      }

      camera.panByPixels(dx, dy);
      clamp();
      changed();

      /* The coalesced history is the real sample stream. Without it this is one
         sample per animation frame, which on a slow display is one sample for the
         entire gesture and no velocity at all. */
      if (history !== undefined && history.length > 1) {
        for (const h of history) samples.push(h);
      } else {
        samples.push({ x: sx, y: sy, t: now });
      }
      // Keep only the trailing window plus one, so the buffer cannot grow with
      // the length of the drag.
      /* Trim to the trailing window but never below three samples, so the fit
         always has a pair to work with however slowly the pointer is sampled. */
      const newestT = samples[samples.length - 1].t;
      const window = tuning().flingWindowMs;
      while (samples.length > 3 && newestT - samples[1].t > window) samples.shift();
      last = { x: sx, y: sy };
    },

    pointerUp(id, t) {
      releaseAt = t ?? performance.now();
      const wasPrimary = id === primary;
      down.delete(id);

      if (down.size === 1) {
        // Dropped from a pinch back to a drag: re-seat the drag on the survivor
        // so the terrain does not leap by the distance between the two fingers.
        const [remaining] = [...down.entries()];
        primary = remaining[0];
        last = { ...remaining[1] };
        start = { ...remaining[1] };
        samples.length = 0;
        samples.push({ ...remaining[1], t: releaseAt });
        vx = 0;
        vy = 0;
        return;
      }

      if (down.size > 1) return;

      primary = null;
      if (!wasPrimary || !pastThreshold) {
        stopFling();
        scheduleSettle();
        return;
      }
      startFling();
    },

    pointerCancel(id) {
      down.delete(id);
      if (down.size === 0) {
        primary = null;
        stopFling();
        scheduleSettle();
      }
    },

    moved() {
      return pastThreshold;
    },

    pointers() {
      return down.size;
    },

    busy() {
      return down.size > 0 || flingRaf !== 0;
    },

    lastRelease() {
      return { ...release, flingFrames, flingPx };
    },

    stop() {
      stopFling();
    },

    dispose() {
      disposed = true;
      stopFling();
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = null;
      down.clear();
      camera = null;
    },
  };
}
