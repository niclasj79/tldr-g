/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE TIMELINE
 * =============================================================================
 *
 * ONE CLOCK. Every animation in this product — the descent, the render reveal,
 * the trace ping, the receipt and the ingest settle — is a run on this scheduler,
 * so all five read as one physics rather than as five things that happen to have
 * been given similar numbers.
 *
 * -----------------------------------------------------------------------------
 * WHAT "ONE PHYSICS" ACTUALLY BUYS
 * -----------------------------------------------------------------------------
 *   ONE rAF. MOTION LAW 4. Five independent loops is five wake-ups per frame and,
 *   worse, five different ideas of what `now` is: two animations started in the
 *   same tick would drift apart by a frame and never re-converge. Here they share
 *   a timestamp, so the text tier and the map tier of one render land on the SAME
 *   FRAME rather than on two frames that are usually adjacent.
 *
 *   ONE INTERRUPTION RULE. A second run of the same name SUPERSEDES the first —
 *   it does not queue behind it and it does not cancel it into a stuck state. The
 *   superseded run's promise RESOLVES with `interrupted: true`, exactly like the
 *   camera's `moveTo`, so a caller awaiting it never has to handle an exception
 *   for having been overtaken. MOTION LAW 2, made general: the camera is one
 *   object, and so is every other thing that moves.
 *
 *   ONE COLLAPSE. `prefers-reduced-motion` is applied in one place: durations
 *   fall to `--t-fast` and every stagger falls to a single step. There is no
 *   animation in this layer that can forget to honour it, because none of them
 *   implements it.
 *
 *   ONE HONEST `settled()`. `motionIdle()` is false while anything is running,
 *   and the shell folds it into the idle probe the screenshot harness waits on.
 *   Before this existed, `settled()` knew about camera flights and about nothing
 *   else — a reveal or a settle could still be mid-stagger when the shutter fired.
 *
 * -----------------------------------------------------------------------------
 * TWO CLOCKS, ON PURPOSE
 * -----------------------------------------------------------------------------
 * rAF STOPS IN A BACKGROUND TAB. A run driven by rAF alone would never finish for
 * a user who switched tabs mid-animation: the promise would never settle, the
 * idle probe would report "busy" forever and every screenshot after it would time
 * out. So every run also carries a `setTimeout` watchdog — the only clock that
 * keeps running when the frames do not — which writes the terminal frame and
 * finishes the run. The rAF is the accurate clock; the timer is the honest one.
 *
 * -----------------------------------------------------------------------------
 * THE LOG IS A MEASUREMENT, NOT A DECLARATION
 * -----------------------------------------------------------------------------
 * `motionLog()` reports WALL-CLOCK ms measured from the first frame to the last,
 * per run. It is not the duration the caller asked for. When the two disagree the
 * log is right and the machine was busy, and that is exactly the number a critic
 * asking "is the descent really 700ms" needs to be given.
 * =============================================================================
 */

import { collapse, readMotionBudget, steps as stepsFor } from './budget';
import { easeToken, type Curve } from './ease';
import { checkWitness, recordViolation, type MotionName, type Witness } from './witness';

import './motion.css';

/* =============================================================================
 * 1. THE SHAPE
 * ========================================================================== */

/** What a run is told on every frame. Everything in it is measured. */
export interface MotionFrame {
  /** Raw progress, 0..1. */
  t: number;
  /** Eased progress, 0..1, through the run's own curve. */
  e: number;
  /**
   * How many staggered steps have LANDED, 0-based: `0` means the first step is
   * in, `steps - 1` means the last one is. Never advances past `steps - 1`.
   */
  stage: number;
  /** Steps this run was cut into. `1` under reduced motion, always. */
  steps: number;
  /** Wall-clock ms since the first frame. */
  elapsedMs: number;
  /** True on the last frame, which is always delivered with `t === 1`. */
  last: boolean;
}

/** What a run did. Reported to `onEnd`, to the awaiting caller, and to the log. */
export interface MotionResult {
  name: MotionName;
  /** MEASURED wall-clock ms, first frame to last. Never the requested duration. */
  ms: number;
  /** The duration that was asked for, after the reduced-motion collapse. */
  requestedMs: number;
  steps: number;
  reduced: boolean;
  /** True when a newer run of the same name took over, or `cancel()` was called. */
  interrupted: boolean;
  /** True when the watchdog finished it because rAF had stopped. */
  bailed: boolean;
}

export interface MotionSpec {
  name: MotionName;
  /** The engine fact this motion depicts. MOTION LAW 3; see `./witness`. */
  witness: Witness;
  /** Full-motion duration. Collapsed to `--t-fast` under reduced motion. */
  durationMs: number;
  /** Full-motion step count. Collapsed to 1 under reduced motion. */
  steps?: number;
  /** Full-motion interval between steps. Ignored when `steps` collapses to 1. */
  stepMs?: number;
  /** Which token curve to ease on. Scene-scale motion uses the camera curve. */
  ease?: '--ease-ui' | '--ease-camera' | 'linear';
  /**
   * The run does not end when its duration is up — the caller ends it.
   *
   * For choreography whose length is decided by REAL WORK rather than by a
   * number: a rung change is over when the fetch has returned, the ramp has run
   * and the camera has stopped, and that is longer than `--t-scene` on a cold
   * cache and shorter on a warm one. `durationMs` still shapes `t` and still
   * arms the watchdog, so a caller that forgets to finish cannot leave a run
   * live for ever — it is reported as `bailed` instead.
   */
  manual?: boolean;
  /** Called every frame, and always once more with `t === 1` before the end. */
  onFrame(frame: MotionFrame): void;
  /**
   * Called exactly once, after the last `onFrame`, whatever ended the run.
   *
   * ALWAYS CALLED — superseded, cancelled, bailed or finished. This is where a
   * run hands its authority back (the resolution map, an overlay, a DOM
   * attribute), and a path that skipped it would leave the interface asserting
   * something the engine had stopped doing.
   */
  onEnd?(result: MotionResult): void;
}

/** A live run. `done` resolves — never rejects — however the run ends. */
export interface MotionRun {
  readonly name: MotionName;
  readonly id: number;
  readonly done: Promise<MotionResult>;
  /** Stand it down. The terminal frame is NOT written; `onEnd` still is. */
  cancel(): void;
  /**
   * End a `manual` run normally: the work it depicts is done. The witness is
   * checked, exactly as it would be for a run that reached its own duration.
   */
  finish(): void;
}

/* =============================================================================
 * 2. THE SCHEDULER
 * ========================================================================== */

interface Live {
  id: number;
  spec: MotionSpec;
  start: number;
  duration: number;
  steps: number;
  stepMs: number;
  curve: Curve;
  reduced: boolean;
  stage: number;
  finished: boolean;
  watchdog: number;
  settle: (r: MotionResult) => void;
}

const LINEAR: Curve = (x) => x;

let nextId = 1;
let raf = 0;
const live = new Map<MotionName, Live>();
const log: MotionResult[] = [];
const LOG_MAX = 64;
const waiters = new Set<() => void>();

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * The single frame pump.
 *
 * Every live run is advanced against ONE timestamp, then the loop reschedules
 * itself only if something is still live. There is no idle loop in this product:
 * a scheduler that ticks while nothing is animating is a battery cost with no
 * state to depict, which is the same objection this layer makes to a spinner.
 */
function pump(ts: number): void {
  raf = 0;
  for (const run of [...live.values()]) advance(run, ts);
  if (live.size > 0 && typeof requestAnimationFrame === 'function') {
    raf = requestAnimationFrame(pump);
  }
}

function wake(): void {
  if (raf !== 0 || live.size === 0) return;
  if (typeof requestAnimationFrame !== 'function') return;
  raf = requestAnimationFrame(pump);
}

function advance(run: Live, ts: number): void {
  if (run.finished) return;
  const elapsed = Math.max(0, ts - run.start);
  const t = run.duration <= 0 ? 1 : Math.min(1, elapsed / run.duration);
  const stage = run.steps <= 1 ? 0 : Math.min(run.steps - 1, Math.floor(elapsed / run.stepMs));
  run.stage = stage;
  const last = t >= 1;
  run.spec.onFrame({
    t,
    e: run.curve(t),
    stage,
    steps: run.steps,
    elapsedMs: elapsed,
    last,
  });
  if (last && run.spec.manual !== true) finish(run, { interrupted: false, bailed: false, elapsed });
}

/**
 * End a run, once.
 *
 * `terminal` writes the last frame first — the run's own idea of its resting
 * state — because a run that is stopped by the watchdog has never been told it
 * arrived, and leaving it half way is the interface holding a transition on
 * screen forever.
 */
function finish(
  run: Live,
  how: { interrupted: boolean; bailed: boolean; elapsed?: number; terminal?: boolean },
): void {
  if (run.finished) return;
  run.finished = true;
  if (live.get(run.spec.name)?.id === run.id) live.delete(run.spec.name);
  if (run.watchdog !== 0) clearTimeout(run.watchdog);

  if (how.terminal === true) {
    run.spec.onFrame({
      t: 1,
      e: 1,
      stage: run.steps - 1,
      steps: run.steps,
      elapsedMs: how.elapsed ?? run.duration,
      last: true,
    });
  }

  const result: MotionResult = {
    name: run.spec.name,
    ms: Math.round(how.elapsed ?? now() - run.start),
    requestedMs: Math.round(run.duration),
    steps: run.steps,
    reduced: run.reduced,
    interrupted: how.interrupted,
    bailed: how.bailed,
  };

  // THE END OF THE RUN IS THE STRICT WITNESS CHECK. A run that was superseded is
  // not asked to justify itself against a world that has since moved on — its
  // successor is the thing that has to be true now.
  if (!how.interrupted) {
    const wrong = checkWitness(run.spec.witness, 'end');
    if (wrong !== null) recordViolation(run.spec.name, wrong);
  }

  log.push(result);
  if (log.length > LOG_MAX) log.shift();

  run.spec.onEnd?.(result);
  run.settle(result);
  if (live.size === 0) {
    for (const w of [...waiters]) w();
    waiters.clear();
  }
}

/**
 * Start a run. A live run of the same name is superseded, not queued.
 *
 * The first frame is delivered SYNCHRONOUSLY, before this returns. That is
 * load-bearing rather than tidy: several of these runs take authority over the
 * resolution map from the store, and a run that took authority one rAF later
 * would let the store's own map paint for exactly one frame first — which is the
 * pop that MOTION LAW 1 exists to forbid.
 */
export function runMotion(spec: MotionSpec): MotionRun {
  const budget = readMotionBudget();
  const previous = live.get(spec.name);
  if (previous !== undefined) finish(previous, { interrupted: true, bailed: false });

  const wrong = checkWitness(spec.witness, 'start');
  if (wrong !== null) recordViolation(spec.name, wrong);

  const duration = collapse(spec.durationMs, budget);
  const steps = stepsFor(spec.steps ?? 1, budget);
  const stepMs = steps <= 1 ? duration : Math.max(1, spec.stepMs ?? duration / steps);
  const curve =
    spec.ease === 'linear' || spec.ease === undefined ? LINEAR : easeToken(spec.ease);

  let settle: (r: MotionResult) => void = () => {};
  const done = new Promise<MotionResult>((resolve) => {
    settle = resolve;
  });

  const run: Live = {
    id: nextId++,
    spec,
    start: now(),
    duration,
    steps,
    stepMs,
    curve,
    reduced: budget.reduced,
    stage: 0,
    finished: false,
    watchdog: 0,
    settle,
  };
  live.set(spec.name, run);

  /* THE WATCHDOG. Generous — a run is allowed to be late, it is not allowed to
     be immortal. It fires the terminal frame so the interface still lands on the
     resting state a person would have seen. */
  if (typeof setTimeout === 'function') {
    // A manual run is waiting on real work — a fetch, a ramp and a camera coming
    // to rest — so it gets a much longer leash before the watchdog decides
    // something has gone wrong. It is still a leash.
    const leash = spec.manual === true ? duration * 2 + budget.sceneMs * 6 + 400 : duration + budget.sceneMs * 2 + 200;
    run.watchdog = setTimeout(
      () => finish(run, { interrupted: false, bailed: true, terminal: true }),
      leash,
    ) as unknown as number;
  }

  advance(run, run.start);
  wake();
  return {
    name: spec.name,
    id: run.id,
    done,
    cancel: () => finish(run, { interrupted: true, bailed: false }),
    finish: () => finish(run, { interrupted: false, bailed: false }),
  };
}

/* =============================================================================
 * 3. WHAT THE REST OF THE PRODUCT ASKS THIS MODULE
 * ========================================================================== */

/** True when nothing is animating. The shell folds this into the idle probe. */
export function motionIdle(): boolean {
  return live.size === 0;
}

/** Which animations are in flight right now, by name. For the audit surface. */
export function motionActive(): MotionName[] {
  return [...live.keys()];
}

/** True when this particular animation is in flight. */
export function isRunning(name: MotionName): boolean {
  return live.has(name);
}

/** Stand one animation down. Its `onEnd` still runs, so authority is handed back. */
export function cancelMotion(name: MotionName): void {
  const run = live.get(name);
  if (run !== undefined) finish(run, { interrupted: true, bailed: false });
}

/**
 * Resolve when nothing is animating.
 *
 * Never hangs: the timeout is a real bound and every run has its own watchdog
 * under it, so the worst case is a late resolve rather than a stuck harness.
 */
export function awaitMotion(timeoutMs = 8000): Promise<void> {
  if (live.size === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finishOnce = (): void => {
      if (done) return;
      done = true;
      waiters.delete(finishOnce);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finishOnce, timeoutMs);
    waiters.add(finishOnce);
  });
}

/** The last 64 runs, with their MEASURED durations. Newest last. */
export function motionLog(): readonly MotionResult[] {
  return log;
}

/** Forget the log. The scene driver calls this between scenes. */
export function clearMotionLog(): void {
  log.length = 0;
}
