/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE FAILURE INSTRUMENT
 * =============================================================================
 *
 * ONE STATE, ONE INSTRUMENT: a full-width band, docked in the frame, in
 * --alarm, naming the exact failure and the exact remedy in the engine's own
 * words, with the control that performs the remedy inside the same cell. Never
 * a silent retry. Never a generic toast.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS NOT TWO TIERS ANY MORE
 * -----------------------------------------------------------------------------
 * It was, briefly, and the argument for it was a good one: a mistyped question
 * is not a breach, and an alarm that cries at a typo is an alarm people learn to
 * ignore. So `QUERY_*` codes were demoted to a compact --warn notice floating
 * under the command bar, and everything else got the band.
 *
 * The reason that is wrong here is not aesthetic, it is the governing principle.
 * THE STATE MACHINE HAS EXACTLY ONE FAILURE STATE. `runQuery` catching a
 * `QUERY_NO_MATCH` calls `degrade()`, which puts the application in DEGRADED —
 * the same DEGRADED a dead transport produces. The status dot goes to `fail`,
 * the HUD says so, and every action that depends on a corpus is now gated behind
 * `recover()`. An interface that answers that state with a 670px amber card in a
 * corner is UNDERREPORTING ITS OWN MACHINE: it is showing a softer condition
 * than the one the product is actually in.
 *
 * If a merely-unanswerable question deserves a softer treatment — and it very
 * possibly does — then it deserves a softer STATE, raised and cleared by the
 * state machine without ever entering DEGRADED. That is a change to the machine,
 * not a change to the paint on this band. Until the machine draws that
 * distinction, this instrument reports what the machine says, exactly.
 *
 * -----------------------------------------------------------------------------
 * IT DOCKS. IT DOES NOT FLOAT.
 * -----------------------------------------------------------------------------
 * It is a row of `.shell`, between the top bar and the body, spanning the whole
 * window — the same class of object as the top bar and the HUD, because it is
 * the same class of thing: part of the frame, reporting a condition of the
 * instrument.
 *
 * That costs the body its own height while the bar is up, which is a real price
 * and it is worth stating plainly. The alternative — floating it over the
 * terrain to keep the map's rect intact — makes the loudest report in the
 * product into a card lying on top of the thing it is reporting about, and gives
 * a failure state less structural presence than the rung legend. The map is
 * still there, still at the same world coordinates, and `recover()` gives the
 * height straight back.
 *
 * -----------------------------------------------------------------------------
 * THE FIELDS, AND WHY IT DOES NOT SAY ANYTHING TWICE
 * -----------------------------------------------------------------------------
 *   what_failed    VERBATIM from `DegradedReason`. It interpolates the real id,
 *                  URL or quoted question, so it is always the more specific of
 *                  the two sentences available.
 *   exact_remedy   VERBATIM, and it sits NEXT TO the control that performs it
 *                  rather than 1200px away at the other end of a row.
 *   code           monospaced, always shown: it is what you search for.
 *
 * The deck's human HEADLINE for the code is the tooltip. Printing it beside
 * `what_failed` was the same failure stated twice in one band.
 * =============================================================================
 */

import { COPY, degradedCopy, knowsFailure } from '@/copy';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Tip } from '@/ui/primitives';

export interface DegradedBarProps {
  className?: string;
}

export function DegradedBar({ className }: DegradedBarProps): JSX.Element | null {
  const degraded = useAtlasStore((s) => s.degraded);
  if (degraded === null) return null;

  const copy = degradedCopy(degraded.code);
  const known = knowsFailure(degraded.code);
  const recover = (): void => void useAtlas.getState().recover();

  return (
    <div
      className={['degraded', className].filter(Boolean).join(' ')}
      role="alert"
      aria-label={COPY.a11y.degradedBar}
    >
      <div className="degraded__head">
        <span className="degraded__banner caps">{COPY.degraded.banner}</span>
        <Tip content={`${copy.title} — ${copy.meaning} ${COPY.degraded.note}`}>
          <span className="degraded__code mono">{degraded.code}</span>
        </Tip>
        {known ? null : <span className="degraded__unknown caps ink-faint">{COPY.common.unknown}</span>}
      </div>

      <div className="degraded__field">
        <span className="degraded__flabel caps ink-faint">{COPY.degraded.whatFailedLabel}</span>
        <p className="degraded__ftext t-12-5" data-prose>
          {degraded.what_failed}
        </p>
      </div>

      {/* THE REMEDY AND THE CONTROL THAT PERFORMS IT, IN ONE CELL. They used to
          sit at opposite ends of a 2560px row. */}
      <div className="degraded__field degraded__field--remedy">
        <span className="degraded__flabel caps ink-faint">{COPY.degraded.remedyLabel}</span>
        <p className="degraded__ftext degraded__remedy t-12-5" data-prose>
          {degraded.exact_remedy}
        </p>
        {/* INK, NOT TEAL. `Btn` defaults to `tone="render"`, and --render has
            exactly one job in this product: the engine's attention — the
            rendered path, the live selection, the button that spends tokens.
            Recover spends nothing; it returns the machine to its last good
            state. A teal button in an alarm band is the render light appearing
            somewhere nothing is being rendered, which is how a three-light
            language stops meaning anything. */}
        <Btn
          variant="primary"
          size="sm"
          tone="neutral"
          onClick={recover}
          title={COPY.degraded.recover.title}
        >
          {COPY.degraded.recover.label}
        </Btn>
      </div>
    </div>
  );
}
