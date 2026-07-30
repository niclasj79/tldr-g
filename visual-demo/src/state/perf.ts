/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE FRAME-BUDGET ACCUMULATOR
 * =============================================================================
 *
 * The terrain draws at whatever rate the GPU allows and calls `push()` once per
 * frame. React must NOT hear about that: sixty state updates a second would put
 * a reconciliation between every pair of frames, and the HUD readout would be an
 * unreadable smear of digits changing faster than an eye can integrate them.
 *
 * So this accumulates real per-frame measurements and emits a mean at ~4Hz. Four
 * updates a second is fast enough to see a stall land and slow enough to read.
 *
 * -----------------------------------------------------------------------------
 * EVERY NUMBER THAT LEAVES HERE IS MEASURED
 * -----------------------------------------------------------------------------
 *   fps       frames counted in the window / the window's real duration
 *   frameMs   mean of the frame durations the renderer reported in the window
 *   points    the renderer's own count from the last frame of the window
 *   drawCalls likewise
 *
 * When frames STOP arriving the watchdog emits `fps: 0`. That is not a failure
 * readout dressed up as one — it is the measurement. Zero frames were drawn in
 * that window. A gauge that freezes at its last good value instead is the exact
 * lie this product cannot afford: it says "60" while the tab is hung.
 * =============================================================================
 */

/** The store's `perf` slice. Four numbers, all monospaced wherever they appear. */
export interface PerfReadout {
  fps: number;
  frameMs: number;
  points: number;
  drawCalls: number;
}

/**
 * One frame's worth of renderer stats. Structurally compatible with the
 * terrain's `FrameStats` (which also carries `edges` and `labels`), so
 * `terrain.onFrame(sampler.push)` type-checks without an adapter — and without
 * this module importing the graph layer.
 */
export interface FrameSample {
  fps?: number;
  frameMs?: number;
  points?: number;
  edges?: number;
  drawCalls?: number;
  labels?: number;
}

export interface PerfSampler {
  /** Call once per rendered frame. Cheap: two additions and a comparison. */
  push(sample: FrameSample): void;
  /** Emit whatever has accumulated right now. Used by the visual-QA hook. */
  flush(): void;
  /** The last emitted readout. */
  readout(): PerfReadout;
  /** Stop the watchdog. Call from the renderer's teardown. */
  stop(): void;
}

/** Emit rate. Four a second: fast enough to see a stall, slow enough to read. */
export const PERF_HZ = 4;

const ZERO: PerfReadout = Object.freeze({ fps: 0, frameMs: 0, points: 0, drawCalls: 0 });

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function same(a: PerfReadout, b: PerfReadout): boolean {
  return a.fps === b.fps && a.frameMs === b.frameMs && a.points === b.points && a.drawCalls === b.drawCalls;
}

/**
 * Build an accumulator.
 *
 * @param emit    called at most `hz` times a second, and only when at least one
 *                of the four numbers actually changed. An identical readout is
 *                not published, so an idle instrument does not re-render React
 *                four times a second to say the same thing.
 */
export function createPerfSampler(
  emit: (readout: PerfReadout) => void,
  opts: { hz?: number; now?: () => number; watchdog?: boolean } = {},
): PerfSampler {
  const hz = Math.max(1, opts.hz ?? PERF_HZ);
  const interval = 1000 / hz;
  const clock = opts.now ?? nowMs;

  let windowStart = clock();
  let frames = 0;
  let msSum = 0;
  let lastPoints = 0;
  let lastDrawCalls = 0;
  let lastPush = clock();
  let last: PerfReadout = ZERO;
  let timer: ReturnType<typeof setInterval> | null = null;

  const publish = (next: PerfReadout): void => {
    if (same(next, last)) return;
    last = next;
    emit(next);
  };

  const flushWindow = (at: number): void => {
    const elapsed = at - windowStart;
    if (frames === 0) {
      // No frames in the window. Say so.
      publish({ fps: 0, frameMs: 0, points: lastPoints, drawCalls: lastDrawCalls });
    } else {
      const rate = (frames * 1000) / Math.max(1, elapsed);
      publish({
        // Above 10fps the decimal is noise on a 4Hz readout and rounding it away
        // makes the number readable. BELOW 10 it is the story — the difference
        // between 0.5 and 1 is the difference between a stall and a crawl, and
        // rounding 0.5 up to "1" would be the gauge quietly flattering itself.
        fps: rate >= 10 ? Math.round(rate) : Math.round(rate * 10) / 10,
        frameMs: Math.round((msSum / frames) * 100) / 100,
        points: lastPoints,
        drawCalls: lastDrawCalls,
      });
    }
    windowStart = at;
    frames = 0;
    msSum = 0;
  };

  if (opts.watchdog !== false && typeof setInterval === 'function') {
    timer = setInterval(() => {
      const at = clock();
      // Only the watchdog's own idea of "stalled" fires here; a live renderer
      // flushes on its own frames well before this.
      if (at - lastPush >= interval * 2) flushWindow(at);
    }, interval);
    // Never hold a node process open for a frame counter.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  return {
    push(sample: FrameSample): void {
      const at = clock();
      lastPush = at;
      frames += 1;
      // Prefer the renderer's own frame duration; fall back to the delta between
      // pushes, which is the same quantity measured one layer out.
      msSum += Number.isFinite(sample.frameMs) ? (sample.frameMs as number) : at - windowStart;
      if (Number.isFinite(sample.points)) lastPoints = sample.points as number;
      if (Number.isFinite(sample.drawCalls)) lastDrawCalls = sample.drawCalls as number;
      if (at - windowStart >= interval) flushWindow(at);
    },
    flush(): void {
      flushWindow(clock());
    },
    readout(): PerfReadout {
      return last;
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
