/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE RECEIPT
 * =============================================================================
 *
 * THE PRODUCT'S ONE CELEBRATORY MOMENT, and the reason it is allowed one: the
 * number is real. The counterfactual token count — what a naive stuffed context
 * would have cost, summed per asset by the engine — counts DOWN to what the
 * render actually spent, over `--t-scene`, in tabular mono, and the savings
 * percentage settles in --evidence.
 *
 * The count is not an entrance animation. It IS the state transition: 21 044
 * becoming 5 040 is the engine having spent one and not the other, which is the
 * entire thesis of the product expressed as one figure moving.
 *
 * -----------------------------------------------------------------------------
 * ONCE PER QUERY. THIS IS THE PART THAT MATTERS.
 * -----------------------------------------------------------------------------
 * A celebration that fires every time you open the tab is a celebration of
 * nothing — decorative motion in the strictest sense, and the one instance of it
 * this product would be most tempted to allow. So the guard is at MODULE scope,
 * keyed on `query_id`: component state resets on unmount, and a guard held there
 * would re-fire the count every time the panel was closed and reopened, making
 * the animation a property of the tab rather than of the render.
 *
 * The guard lives HERE rather than in the panel because the panel is not the only
 * thing that can show a receipt, and two copies of a once-per-query rule is a
 * once-per-query rule that fires twice.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS HOOK DOES AND DOES NOT OWN
 * -----------------------------------------------------------------------------
 * The digits are counted by `<Num countFrom>`, which is the mono numeric
 * primitive and the only thing in the product allowed to format a figure. This
 * hook owns WHETHER the count happens and HOW LONG the panel wears its in-flight
 * mark — on the shared timeline, so `settled()` waits for it and `motionLog()`
 * reports what it measured rather than what it asked for.
 * =============================================================================
 */

import { useEffect, useRef, useState } from 'react';

import { readMotionBudget } from './budget';
import { runMotion } from './timeline';

/** Query ids whose receipt has already been counted down, this session. */
const CELEBRATED = new Set<string>();

/** True when this query's receipt has already had its one count. */
export function receiptCelebrated(queryId: string): boolean {
  return CELEBRATED.has(queryId);
}

/** Forget the guard. Tests and the scene driver, never the product. */
export function forgetReceiptCelebrations(): void {
  CELEBRATED.clear();
}

export interface ReceiptCelebration {
  /** Pass straight to `<Num countFrom>`. `undefined` means "do not animate". */
  countFrom: number | undefined;
  /** True while the count is running, for the panel's in-flight rail. */
  counting: boolean;
}

/**
 * The one count this product performs.
 *
 * @param queryId the render being celebrated. `null` renders nothing.
 * @param from    the counterfactual figure the count starts at.
 *
 * TWO THINGS HERE WERE WRONG THE FIRST TIME AND BOTH ONLY SHOWED UP ON SCREEN:
 *
 * 1. The seed was raised by an effect, so the first painted frame was the FINAL
 *    figure, which then jumped UP to the counterfactual and counted back down.
 *    The seed is computed DURING RENDER instead — see `pending` below — so the
 *    first paint is already the number the count starts from, whichever order
 *    the panel and the render arrived in.
 *
 * 2. `StrictMode` runs every effect twice: the first pass marked the id
 *    celebrated and the second pass found it marked and cancelled the count, so
 *    the celebration silently never happened in dev. The instance's own `started`
 *    ref distinguishes "this component already began this count" from "some
 *    earlier mount did", which is the distinction the guard always meant to make.
 */
export function useReceiptCelebration(
  queryId: string | null,
  from: number,
): ReceiptCelebration {
  const started = useRef<string | null>(null);
  const [countFrom, setCountFrom] = useState<number | undefined>(() =>
    queryId !== null && Number.isFinite(from) && !CELEBRATED.has(queryId) ? from : undefined,
  );
  const [counting, setCounting] = useState(false);

  /* THE SEED IS COMPUTED DURING RENDER, NOT IN AN EFFECT, AND THE DIFFERENCE IS
     VISIBLE ON SCREEN.

     A `useState` initialiser only runs on the FIRST mount, which is the wrong
     moment whenever the receipt panel is ALREADY OPEN when the render lands: at
     that mount there was no query, so the seed was `undefined`, the hero figure
     painted the FINAL number, and one frame later it jumped up to 21 044 and
     counted back down. A DOM probe caught it — the first sampled figure was
     5 040 — and nothing about the code looked wrong.

     Computing it here means the first frame that carries a hero figure already
     carries the figure the count starts from, whichever order the panel and the
     render arrived in. It is pure: the guard is still only WRITTEN in the effect
     below, so a render that never commits cannot mark a query celebrated.

     `mine` is the other half, and it was worth a probe to find. Between the
     effect marking this query celebrated and the state it sets landing, React
     rendered this component twice more — driven by the store's own commit, not
     by us — and a test of the form "not celebrated" reported FALSE for both.
     Those two renders painted the final figure with no count attached, which is
     the identical defect one layer down. So the question is not "has anybody
     counted this query" but "has anybody OTHER THAN THIS INSTANCE counted it". */
  const mine = started.current === queryId;
  const pending =
    queryId !== null && Number.isFinite(from) && (mine || !CELEBRATED.has(queryId));

  useEffect(() => {
    if (queryId === null || !Number.isFinite(from)) return;
    if (started.current === queryId) return; // this instance already started it
    if (CELEBRATED.has(queryId)) {
      setCountFrom(undefined); // an earlier mount already spent it
      return;
    }
    CELEBRATED.add(queryId);
    started.current = queryId;
    setCountFrom(from);

    const budget = readMotionBudget();
    if (budget.reduced) {
      // INSTRUMENTS UPDATE INSTANTLY. `<Num>` snaps under reduced motion, so
      // there is no count to time and no in-flight mark to wear.
      return;
    }
    setCounting(true);
    const run = runMotion({
      name: 'receipt',
      witness: { of: 'receipt', queryId },
      // The same `--t-scene` <Num> reads from the stylesheet. One duration, one
      // token, two readers — never two numbers.
      durationMs: budget.sceneMs,
      ease: '--ease-camera',
      onFrame: () => {
        /* THE FIGURE IS NOT DRIVEN FROM HERE. `<Num countFrom>` owns the digits
           because it owns every digit in the product. This run exists so the
           count is on the same clock as everything else: `settled()` waits for
           it, and the log measures it. */
      },
      onEnd: () => setCounting(false),
    });
    return () => run.cancel();
  }, [queryId, from]);

  return { countFrom: pending ? from : countFrom, counting };
}
