/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE LIFECYCLE STATE MACHINE
 * =============================================================================
 *
 * The app has seven states and they are NOT a mood ring. Every screen in the
 * product is designed for a specific one, and the only way to keep that promise
 * honest is to make the set of legal moves between them a declared table rather
 * than an emergent property of whichever `set({ app: ... })` call ran last.
 *
 *   FIRST-RUN -> EMPTY -> INGESTING -> SETTLING -> READY <-> QUERYING
 *   DEGRADED is reachable from ANY state; `recover()` returns to the prior one.
 *
 * -----------------------------------------------------------------------------
 * WHY AN ILLEGAL TRANSITION THROWS
 * -----------------------------------------------------------------------------
 * A store that lets `EMPTY -> QUERYING` happen silently will render a query
 * panel over a corpus that does not exist, and the first symptom will be a blank
 * receipt three screens away from the bug. So the table is enforced:
 *
 *   dev  -> `IllegalTransition` is THROWN at the call site that attempted it.
 *   prod -> the attempt is reported on the console and then applied, because
 *           stranding a user mid-session is a worse failure than a wrong state.
 *
 * Either way it is never silent. This file is the fail-loud engineering culture
 * of the product, rendered as code.
 * =============================================================================
 */

import type { AppState } from '@/engine';

/* -----------------------------------------------------------------------------
 * Dev detection. `import.meta.env` is absent under plain node (the verifier
 * bundles this module and runs it headlessly), and the strict behaviour is the
 * right default there: a test harness wants the throw.
 * -------------------------------------------------------------------------- */
const ENV = (import.meta as unknown as { env?: { DEV?: boolean } }).env;

/** True in `vite dev` and under node. False only in a production bundle. */
export const STRICT_TRANSITIONS: boolean = ENV?.DEV ?? true;

/** The seven states, in lifecycle order. Index is not depth — this is not a spine. */
export const APP_STATES = Object.freeze([
  'FIRST-RUN',
  'EMPTY',
  'INGESTING',
  'SETTLING',
  'READY',
  'QUERYING',
  'DEGRADED',
] as const);

/**
 * THE TRANSITION TABLE. One row per state, listing every state it may move to.
 *
 * Read it as sentences:
 *   FIRST-RUN -> EMPTY        the invitation is accepted; there is still no corpus
 *   EMPTY     -> INGESTING    documents start arriving
 *   INGESTING -> SETTLING     everything landed; the layout is being baked
 *   INGESTING -> EMPTY        the ingest produced nothing. Honest, and not an error
 *   SETTLING  -> READY        positions are frozen; this is the normal state
 *   READY     -> QUERYING     a render is in flight
 *   READY     -> INGESTING    more documents arrive into a live corpus
 *   READY     -> SETTLING     a re-bake (anchored re-projection)
 *   READY     -> EMPTY | FIRST-RUN   the corpus was closed (`unload`)
 *   QUERYING  -> READY        the render finished
 *   *         -> DEGRADED     something failed and we are saying so
 *   DEGRADED  -> *            `recover()` returns to the state we came from
 *
 * SETTLING deliberately has only one non-degraded exit. A bake either completes
 * and freezes the world or it fails; there is no third option, and offering one
 * would let a half-baked layout reach the screen.
 */
export const TRANSITIONS: Readonly<Record<AppState, readonly AppState[]>> = Object.freeze({
  'FIRST-RUN': Object.freeze(['EMPTY', 'INGESTING', 'DEGRADED'] as const),
  EMPTY: Object.freeze(['FIRST-RUN', 'INGESTING', 'DEGRADED'] as const),
  INGESTING: Object.freeze(['SETTLING', 'EMPTY', 'DEGRADED'] as const),
  SETTLING: Object.freeze(['READY', 'DEGRADED'] as const),
  READY: Object.freeze(['QUERYING', 'INGESTING', 'SETTLING', 'EMPTY', 'FIRST-RUN', 'DEGRADED'] as const),
  QUERYING: Object.freeze(['READY', 'DEGRADED'] as const),
  DEGRADED: Object.freeze([
    'FIRST-RUN',
    'EMPTY',
    'INGESTING',
    'SETTLING',
    'READY',
    'QUERYING',
  ] as const),
});

/**
 * States that describe WORK IN FLIGHT rather than a place the user can sit.
 * `recover()` never returns to one of these: the work that defined them is gone.
 */
export function isTransient(state: AppState): boolean {
  return state === 'INGESTING' || state === 'SETTLING' || state === 'QUERYING';
}

/** True when `from -> to` is declared in the table. `from === to` is a legal no-op. */
export function canTransition(from: AppState, to: AppState): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

/** Thrown, in dev, at the exact call site that attempted an undeclared move. */
export class IllegalTransition extends Error {
  readonly from: AppState;
  readonly to: AppState;
  /** The action that attempted it, e.g. `runQuery`. Names the bug, not the symptom. */
  readonly via: string;

  constructor(from: AppState, to: AppState, via: string) {
    super(
      `[state/machine] illegal transition ${from} -> ${to} attempted by ${via}(). ` +
        `Legal from ${from}: ${TRANSITIONS[from].join(', ')}. ` +
        `If this move is genuinely part of the lifecycle, declare it in TRANSITIONS ` +
        `and say why in the table's comment — do not route around the check.`,
    );
    this.name = 'IllegalTransition';
    this.from = from;
    this.to = to;
    this.via = via;
  }
}

/**
 * Gate a transition. Returns `true` when the move may be applied.
 *
 * Throws in dev. In a production bundle it reports loudly and returns `true`,
 * because a user stranded in a state the UI cannot leave is a worse outcome than
 * a state we did not predict.
 */
export function assertTransition(from: AppState, to: AppState, via: string): boolean {
  if (canTransition(from, to)) return true;
  if (STRICT_TRANSITIONS) throw new IllegalTransition(from, to, via);
  // eslint-disable-next-line no-console
  console.error(new IllegalTransition(from, to, via).message);
  return true;
}

/**
 * Where `recover()` lands after a failure.
 *
 * The state we were in when we degraded is the honest first answer, but the
 * three transient states are not returnable: the ingest, the bake or the render
 * that defined them is over. Those collapse to READY when there is a corpus on
 * screen and to EMPTY when there is not.
 */
export function recoveryTarget(prior: AppState, hasCorpus: boolean): AppState {
  if (prior === 'DEGRADED') return hasCorpus ? 'READY' : 'EMPTY';
  if (isTransient(prior)) return hasCorpus ? 'READY' : 'EMPTY';
  return prior;
}

/**
 * Every declared edge of the machine, flattened. Exported for the verifier and
 * for a help overlay that wants to draw the machine rather than describe it.
 */
export function transitionPairs(): { from: AppState; to: AppState }[] {
  const out: { from: AppState; to: AppState }[] = [];
  for (const from of APP_STATES) {
    for (const to of TRANSITIONS[from]) out.push({ from, to });
  }
  return out;
}

/** Every pair the table forbids. The verifier asserts each of these throws. */
export function illegalPairs(): { from: AppState; to: AppState }[] {
  const out: { from: AppState; to: AppState }[] = [];
  for (const from of APP_STATES) {
    for (const to of APP_STATES) {
      if (from === to) continue;
      if (!TRANSITIONS[from].includes(to)) out.push({ from, to });
    }
  }
  return out;
}
