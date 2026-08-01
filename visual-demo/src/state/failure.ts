/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE FAILURE TAXONOMY
 * =============================================================================
 *
 * Seventeen error codes, four KINDS, and the difference between those two
 * numbers is the whole reason this file exists.
 *
 * The product used to route every one of them through one band with one button
 * on it labelled `Recover`. That is defensible for a transport failure and
 * indefensible for the other three, because the four kinds do not want the same
 * thing from the user and two of them do not want a button at all:
 *
 *   NO-ANSWER     the engine looked and found nothing. Nothing is broken. The
 *                 next move is a DIFFERENT QUESTION, so the remedy is a question,
 *                 not a retry — retrying an unanswerable question re-asks it.
 *
 *   RENDER        one render failed on its way through. The state is intact and
 *                 the same question may well work. `Retry` is exactly right here
 *                 and nowhere else.
 *
 *   INTEGRITY     two surfaces of the engine disagree about the same claim. This
 *                 is the one class where dismissing the alarm is the WRONG
 *                 affordance, because the result is still on screen and is still
 *                 wrong. It does not offer `Recover`. It offers: look at the
 *                 discrepancy, render it again, or throw the result away.
 *
 *   SYSTEM        the transport, the runtime or the interface itself failed. The
 *                 session may not be intact. Reconnect, or reset.
 *
 * -----------------------------------------------------------------------------
 * WHY THE CLASSIFIER IS A TABLE AND NOT A HEURISTIC
 * -----------------------------------------------------------------------------
 * A prefix match on `QUERY_` would have been shorter and would have silently
 * mis-sorted the next code somebody adds. Every code is named here, and one that
 * is NOT named falls to SYSTEM — the most conservative class, the one that
 * assumes least about how much of the session survived. An unrecognised failure
 * being treated as more serious than it is costs a reload; being treated as less
 * serious than it is costs the user's trust in the alarm.
 * =============================================================================
 */

/** The four kinds. Each one implies a different set of things to offer. */
export type FailureClass = 'no-answer' | 'render' | 'integrity' | 'system';

/**
 * The remedies a failure class may offer, in the order they are rendered.
 *
 * These are ACTION IDS, not labels — the deck owns the words, this owns which
 * verbs are honest for which failure.
 */
export type RemedyId =
  | 'revise-question'
  | 'pick-sample'
  | 'retry'
  | 'inspect-discrepancy'
  | 'rerun'
  | 'discard-result'
  | 'reconnect'
  | 'reset';

/** Every code this build can produce, mapped to what actually went wrong. */
const CLASS_BY_CODE: Readonly<Record<string, FailureClass>> = Object.freeze({
  /* The engine looked and found nothing. Not a fault. */
  QUERY_NO_MATCH: 'no-answer',
  QUERY_NO_EVIDENCE: 'no-answer',

  /* A render did not complete, or was asked for something that is not there. */
  NOT_FOUND: 'render',
  BAD_RUNG: 'render',
  BAD_DRAWN_REASON: 'render',
  BAD_REQUEST: 'render',
  REQUEST_ABORTED: 'render',

  /* Two surfaces of the engine disagree. The result on screen is not trustworthy. */
  PATH_DISAGREEMENT: 'integrity',
  RECEIPT_INVALID: 'integrity',

  /* The plumbing, the runtime, or this interface. */
  TRANSPORT_FAILED: 'system',
  MALFORMED_RESPONSE: 'system',
  ENGINE_REJECTED: 'system',
  NO_FETCH: 'system',
  NO_SUCH_ROUTE: 'system',
  ENGINE_UNCAUGHT: 'system',
  WEBGL_UNAVAILABLE: 'system',
  SAVED_VIEW_CORRUPT: 'system',
  SHELL_RENDER_FAILED: 'system',
});

/** Which kind of failure this code is. Unknown codes are treated as SYSTEM. */
export function failureClassOf(code: string): FailureClass {
  return CLASS_BY_CODE[code] ?? 'system';
}

/** True when this build has classified the code rather than falling back. */
export function knowsFailureClass(code: string): boolean {
  return code in CLASS_BY_CODE;
}

/**
 * What to offer for a failure of this kind.
 *
 * NOTE WHAT IS NOT HERE: there is no `dismiss` in any row. Every remedy either
 * changes the state that failed or throws away the result that cannot be trusted.
 * A control whose only effect is to stop the interface mentioning a problem it
 * has not fixed is the affordance this taxonomy exists to delete.
 */
export function remediesFor(kind: FailureClass): readonly RemedyId[] {
  switch (kind) {
    case 'no-answer':
      return ['revise-question', 'pick-sample'];
    case 'render':
      return ['retry', 'pick-sample'];
    case 'integrity':
      return ['inspect-discrepancy', 'rerun', 'discard-result'];
    case 'system':
      return ['reconnect', 'reset'];
  }
}

/**
 * Does a failure of this kind leave the RESULT ON SCREEN untrustworthy?
 *
 * Only the integrity class does. This is the predicate the answer panel reads to
 * decide whether to keep vouching for a confidence figure and a by-construction
 * match — and it is deliberately independent of whether the alarm band is still
 * showing, because the alarm is dismissible and the disagreement is not.
 */
export function invalidatesResult(kind: FailureClass): boolean {
  return kind === 'integrity';
}
