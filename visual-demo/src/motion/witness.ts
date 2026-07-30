/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE WITNESS
 * =============================================================================
 *
 * MOTION LAW 3, ENFORCED IN CODE: motion only ever depicts real engine state.
 *
 * Every animation this layer runs must name the FACT it is depicting, and that
 * fact is checked against the live store when the animation starts and again
 * when it ends. A reveal claims a `query_id`; a descent claims the place the
 * store is going to; a trace claims a `trace_id` and the passage it is travelling
 * to; a settle claims the ids the ingest actually admitted. If the store does not
 * agree, the animation is recorded as a VIOLATION and `audit()` reports it in
 * `animationsWithoutState` alongside the endless-CSS-animation check that has
 * been there since the shell was built.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A CODE REVIEW
 * -----------------------------------------------------------------------------
 * Decorative motion is not usually introduced deliberately. It arrives as a
 * spinner someone left running after the fetch resolved, a shimmer that outlives
 * the state it was skeletoning, or — the case this product is most exposed to —
 * a celebration that fires on a tab switch rather than on the render it is
 * celebrating. All three are invisible in a diff and obvious in a measurement.
 *
 * So the measurement is the check, it runs in the product, and the visual-QA pass
 * already reads it: `scripts/shoot.mjs` exits non-zero on a console error, and a
 * violation logs one. A regression cannot land quietly.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS NOT CHECKED, AND WHY
 * -----------------------------------------------------------------------------
 * The check is EXISTENCE, never timing. It asks "is there a render with this
 * query_id in the store" — not "did it arrive in the last 40ms". A timing test
 * would fail on a slow machine and pass on a fast one, which is a test that
 * measures the harness. The failure mode this catches is the animation that
 * depicts NOTHING, and that one is decidable.
 * =============================================================================
 */

import { useAtlas } from '@/state';
import type { Rung } from '@/engine';

/** The five things this layer is allowed to animate, and nothing else. */
export type MotionName = 'descent' | 'reveal' | 'trace' | 'receipt' | 'ingest';

/**
 * The engine fact an animation depicts.
 *
 * Every variant carries an ID rather than a boolean, because "a query is
 * running" is satisfied by any query and "this query_id" is satisfied by exactly
 * the render on screen.
 */
export type Witness =
  /** A rung change. `place` is the `rung|scope` the store is moving to. */
  | { of: 'rung'; place: string }
  /** A render landing. `queryId` must be the store's active render. */
  | { of: 'render'; queryId: string }
  /** A citation travelling to its source. */
  | { of: 'trace'; traceId: string; passageId: string }
  /** The receipt's count-down, once per rendered query. */
  | { of: 'receipt'; queryId: string }
  /** New nodes settling. `ids` must be nodes the ingest actually admitted. */
  | { of: 'ingest'; ids: readonly string[] };

/** The place, as one comparable string: rung plus scope is the whole identity. */
export function placeKey(rung: Rung, stack: readonly { id: string }[]): string {
  return `${rung}|${stack.length === 0 ? '' : stack[stack.length - 1].id}`;
}

/** The place the store is at right now. */
export function currentPlace(): string {
  const s = useAtlas.getState();
  return placeKey(s.rung, s.stack);
}

/**
 * Does the store agree that this fact is true?
 *
 * Returns `null` when it does, or a sentence naming the disagreement when it does
 * not. The sentence is what lands in `audit().animationsWithoutState`, so it has
 * to be readable by somebody who is not holding this file in their head.
 *
 * @param when `start` is lenient about a place the store has not committed to
 *        yet — a descent aims its camera one microtask before `descend()`
 *        returns, and that lead is the whole reason the move reads as continuous.
 *        `end` is strict: by then the store has either moved or refused.
 */
export function checkWitness(w: Witness, when: 'start' | 'end'): string | null {
  const s = useAtlas.getState();
  switch (w.of) {
    case 'rung': {
      const now = placeKey(s.rung, s.stack);
      if (now === w.place) return null;
      if (when === 'start') return null; // the store commits a beat after the aim
      return `the rung choreography ran for "${w.place}" and the store is at "${now}"`;
    }
    case 'render': {
      const id = s.query.active?.query_id ?? null;
      if (id === w.queryId) return null;
      return `a render reveal ran for query_id "${w.queryId}" and the store's active render is ${
        id === null ? 'none' : `"${id}"`
      }`;
    }
    case 'receipt': {
      const id = s.query.active?.query_id ?? null;
      if (id !== w.queryId) {
        return `the receipt counted for query_id "${w.queryId}" and the store's active render is ${
          id === null ? 'none' : `"${id}"`
        }`;
      }
      if (s.trace === null) return `the receipt counted with no render trace in the store`;
      return null;
    }
    case 'trace': {
      if (s.trace === null) return `a trace ping travelled with no render trace in the store`;
      if (s.trace.trace_id !== w.traceId) {
        return `a trace ping travelled for trace "${w.traceId}" and the store holds "${s.trace.trace_id}"`;
      }
      // `end` only: `openPassage` legitimately replaces the trace's own view, and
      // a citation opened from a restored link may cite a passage the current
      // trace no longer lists. The travel itself is still evidence of the edge
      // the receipt named, so the passage check is a START check.
      if (when === 'start' && !s.trace.citations.some((c) => c.passage_id === w.passageId)) {
        return `a trace ping travelled to passage "${w.passageId}", which the receipt does not cite`;
      }
      return null;
    }
    case 'ingest': {
      if (w.ids.length === 0) return `an ingest settled with no nodes to settle`;
      // The settle gate runs INSIDE `SETTLING`; by the time it resolves the store
      // may already be READY, which is the correct end state and not a violation.
      if (when === 'start' && s.app !== 'SETTLING' && s.app !== 'INGESTING') {
        return `an ingest settled while the app was ${s.app}`;
      }
      const admitted = new Set(s.ingestedIds);
      const stray = w.ids.filter((id) => !admitted.has(id));
      if (stray.length > 0) {
        return `an ingest settled ${stray.length} node(s) the store never admitted (e.g. "${stray[0]}")`;
      }
      return null;
    }
    default:
      return null;
  }
}

/* =============================================================================
 * THE LEDGER
 * ========================================================================== */

/** How many violations are remembered. Enough for a whole screenshot pass. */
const MAX = 32;

const violations: string[] = [];

/**
 * Record a violation, once per distinct sentence.
 *
 * It also goes to the console as an error, which is deliberate:
 * `scripts/shoot.mjs` fails the run on any console error, so decorative motion
 * cannot be introduced and photographed as if it were fine.
 */
export function recordViolation(name: MotionName, message: string): void {
  const line = `${name}: ${message}`;
  if (violations.includes(line)) return;
  violations.push(line);
  if (violations.length > MAX) violations.shift();
  // eslint-disable-next-line no-console
  console.error(
    `[motion] ${line}. Motion in this product depicts a state transition and nothing else — ` +
      `see MOTION LAW 3 in src/motion/witness.ts.`,
  );
}

/** Every animation that ran without the state to justify it. Read by `audit()`. */
export function motionViolations(): readonly string[] {
  return violations;
}

/** Forget them. The scene driver calls this between scenes; tests use it too. */
export function clearMotionViolations(): void {
  violations.length = 0;
}
