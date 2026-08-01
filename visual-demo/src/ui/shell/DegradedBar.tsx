/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE FAILURE INSTRUMENT
 * =============================================================================
 *
 * ONE STATE, ONE INSTRUMENT: a full-width band, docked in the frame, in
 * --alarm, naming the exact failure and the exact remedy in the engine's own
 * words, with the controls that perform the remedy inside the same cell. Never
 * a silent retry. Never a generic toast.
 *
 * -----------------------------------------------------------------------------
 * ONE BUTTON CALLED `RECOVER` WAS A TRUST DEFECT, NOT A ROUGH EDGE
 * -----------------------------------------------------------------------------
 * A no-match question, a dead transport and a path-verification DISAGREEMENT all
 * arrived here through the same machinery and were answered by the same control,
 * and that control did not say what it would do. For three of the four failure
 * kinds it was merely vague. For the fourth it was actively wrong:
 *
 *   `PATH_DISAGREEMENT` says an independent re-traversal of the graph between an
 *   answer's own endpoints returned a different route than the receipt records.
 *   Pressing `Recover` cleared the alarm — and left the contradicted answer on
 *   screen, still wearing a green by-construction badge. The interface went on
 *   vouching for a payload it had just disproved, because the only affordance in
 *   the band was one whose entire effect was to stop mentioning the problem.
 *
 * So the band renders the FAILURE CLASS — `@/state/failure` sorts seventeen
 * codes into four kinds — and offers that class's own remedies. Every verb names
 * its own consequence and not one of them is "stop mentioning this". For the
 * integrity class there is no dismissing control at all, and the band says so in
 * as many words: the result on screen is the thing in dispute, so the honest
 * moves are look at it, render it again, or throw it away.
 *
 * -----------------------------------------------------------------------------
 * TWO REMEDIES CLEAR THE BAND, AND THAT IS NOT A DISMISSAL
 * -----------------------------------------------------------------------------
 * `Retry` and `Render again` route through `recover()` before `runQuery()`, and
 * they have to: `runQuery` never writes `degraded`, so a retry that SUCCEEDED
 * from DEGRADED would land a fresh answer underneath a stale alarm about the
 * question it replaced. Clearing first is the honest order — the alarm goes
 * because the state that raised it is being replaced, not because a button hid
 * it, and if the render fails again `degrade()` re-raises it carrying the NEW
 * failure. The band PRINTS exactly this, under the buttons — it is the one thing
 * about these controls a reader cannot verify by looking at them, which is
 * precisely why it cannot live on a hover state.
 *
 * `Revise the question` does the same for the opposite reason. Every action that
 * depends on a corpus is gated behind `recover()`, so staging a question into a
 * composer the user cannot then run would be an affordance that does nothing —
 * which is worse than an absent one, because it teaches people not to trust the
 * band. It stages the text and returns the instrument to its last good state, in
 * that order, so the composer is populated at the moment it becomes live.
 *
 * `Inspect the discrepancy` deliberately does NOT recover. Looking at a
 * disagreement must not be the act that silences it.
 *
 * -----------------------------------------------------------------------------
 * `PICK A VERIFIED QUESTION` CALLED A TOGGLE, AND A TOGGLE CLOSES
 * -----------------------------------------------------------------------------
 * It ran `toggle('search')`, which FLIPS. With the palette already open — one
 * keystroke away, `/`, and the alarm does not block it — pressing the button
 * labelled `Pick a verified question` closed the picker it exists to open, and
 * because it recovers first, its entire observable effect was: alarm gone,
 * picker gone, nothing picked. Measured in the built app at scene
 * `degraded-query`: before `{app:'DEGRADED', search:true}`, after
 * `{app:'READY', search:false}`. That is a pure dismiss, which is the one thing
 * no remedy in this taxonomy is allowed to be.
 *
 * It calls `openCommandSearch()` now — the door that only opens, which
 * `CommandPalette.tsx` wrote for exactly this hazard: "a control labelled
 * 'Search' that CLOSES search when the surface is already open is a control that
 * lies about what it does."
 *
 * -----------------------------------------------------------------------------
 * NOTHING STATED ONLY ONCE IS STATED ONLY ON HOVER
 * -----------------------------------------------------------------------------
 * Two sentences in this band lived inside a `<Tip>` hung off a plain `<span>`.
 * `Tip` opens on hover OR focus, but a span carries no `tabIndex` and no role,
 * so the focus half is dead: all three `.tip-anchor`s in the band measured
 * `tabIndex: -1`, and the band's only focusables are the remedy buttons. A
 * keyboard-only or touch reader could not reach either sentence — in a state
 * whose whole job is to be trusted.
 *
 * Both were the ONLY statement of their fact: the failure class's full meaning,
 * and the one thing about these controls a reader cannot verify by looking at
 * them (that the bar clearing is a consequence, not a dismissal). So both are
 * printed. The rule this leaves behind is narrow and is the one the band can
 * defend: A TIP MAY CARRY A REDUNDANT SENTENCE, NEVER A SOLE ONE. The code's
 * tooltip stays a tooltip under exactly that test — the deck's headline for the
 * code is the same failure `what_failed` already states in the engine's own more
 * specific words, which is why it was moved off the band in the first place.
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
 * the same DEGRADED a dead transport produces. An interface that answers that
 * state with a 670px amber card in a corner is UNDERREPORTING ITS OWN MACHINE.
 *
 * The taxonomy is the correct half of that instinct, arriving at the layer where
 * it belongs. The band's SEVERITY still reports the machine exactly — one state,
 * one instrument — while its CONTENT distinguishes four kinds of cause, because
 * "how loud is this" and "what should you do about it" are different questions
 * and only the second one has four answers.
 *
 * -----------------------------------------------------------------------------
 * IT DOCKS. IT DOES NOT FLOAT.
 * -----------------------------------------------------------------------------
 * It is a row of `.shell`, between the top bar and the body, spanning the whole
 * window — the same class of object as the top bar and the HUD, because it is
 * the same class of thing: part of the frame, reporting a condition of the
 * instrument. That costs the body its own height while the bar is up, and the
 * alternative — floating it over the terrain — gives a failure state less
 * structural presence than the rung legend.
 *
 * -----------------------------------------------------------------------------
 * THE FIELDS, AND WHY IT DOES NOT SAY ANYTHING TWICE
 * -----------------------------------------------------------------------------
 *   class          the taxonomy's name for the KIND, plus what that kind MEANS
 *                  and what it implies about the next move. Four possible
 *                  readings, from this build. Printed, not hovered.
 *   what_failed    VERBATIM from `DegradedReason`. It interpolates the real id,
 *                  URL or quoted question, so it is always the more specific of
 *                  the two sentences available.
 *   exact_remedy   VERBATIM, and it sits NEXT TO the controls that perform it
 *                  rather than 1200px away at the other end of a row.
 *   code           monospaced, always shown: it is what you search for.
 *
 * The deck's human HEADLINE for the code is the tooltip. Printing it beside
 * `what_failed` was the same failure stated twice in one band.
 *
 * TWO DIFFERENT "we do not know this one" MARKERS CAN BOTH BE TRUE, and they say
 * different things: `knowsFailure` is whether the deck has a HEADLINE for the
 * code, `knowsFailureClass` is whether the taxonomy has a KIND for it. The
 * eighteen classified codes and the sixteen headlined codes are not the same
 * set, and a build that has sorted a code without naming it is in a different
 * condition from one that has done neither.
 * =============================================================================
 */

import { COPY, degradedCopy, knowsFailure } from '@/copy';
import { openCommandSearch } from '@/interaction';
import {
  failureClassOf,
  invalidatesResult,
  knowsFailureClass,
  remediesFor,
  useAtlas,
  useAtlasStore,
} from '@/state';
import type { RemedyId } from '@/state';
import { Btn, Tip } from '@/ui/primitives';

import './instruments.css';

export interface DegradedBarProps {
  className?: string;
}

/**
 * WHICH REMEDIES SPEND TOKENS.
 *
 * --render has exactly one job in this product: the engine's attention — the
 * rendered path, the live selection, the button that spends tokens. `Recover`
 * carried it for a while and should not have: returning the machine to its last
 * good state renders nothing. These two do render, so these two get the light
 * and everything else in the band is ink.
 */
const SPENDS: ReadonlySet<RemedyId> = new Set<RemedyId>(['retry', 'rerun']);

export function DegradedBar({ className }: DegradedBarProps): JSX.Element | null {
  const { degraded, question } = useAtlasStore((s) => ({
    degraded: s.degraded,
    /* THE TEXT A RETRY WOULD RE-RENDER. `runQuery` writes `staged` before it
       issues the request, so on a failed render this holds the question that
       failed rather than the last one that succeeded — which is the one a retry
       has to re-ask. `active.query` is the fallback for a failure raised AFTER a
       successful render, where the two are the same string anyway. */
    question: s.query.staged.trim().length > 0 ? s.query.staged : (s.query.active?.query ?? ''),
  }));

  if (degraded === null) return null;

  const copy = degradedCopy(degraded.code);
  const known = knowsFailure(degraded.code);
  const kind = failureClassOf(degraded.code);
  const classCopy = COPY.remedies.classes[kind];
  const classified = knowsFailureClass(degraded.code);

  /* Every handler either changes the state that failed or throws away the result
     that cannot be trusted. There is no branch here whose only effect is to stop
     the interface mentioning something it has not fixed. */
  const perform = (remedy: RemedyId): void => {
    const s = useAtlas.getState();
    switch (remedy) {
      case 'revise-question':
        s.stageQuery(question);
        void s.recover();
        return;
      case 'pick-sample':
        /* THE DOOR THAT ONLY OPENS. `toggle('search')` flipped, so with the
           palette already up this control closed it — see the header. */
        void s.recover().then(() => openCommandSearch());
        return;
      case 'retry':
      case 'rerun':
        if (question.length === 0) {
          void s.recover();
          return;
        }
        void s.recover().then(() => void useAtlas.getState().runQuery(question));
        return;
      case 'inspect-discrepancy':
        /* NO `recover()`. The re-derivation verdict and both routes are on the
           Answer surface, and pinning is what stops the next commit moving the
           reader off the panel they were sent to look at. The alarm stays up
           because the disagreement it reports is still true. */
        s.setTab('answer', { pin: true });
        return;
      case 'discard-result':
        /* This removes the ANSWER, not the warning about it — and `discardResult`
           re-fetches the rung under the plain edge policy so the terrain stops
           stroking a constellation that belongs to a render nobody is standing
           behind any more. It clears the alarm last, because by then the thing
           the alarm was about is gone. */
        s.discardResult();
        return;
      case 'reconnect':
        void s.recover();
        return;
      case 'reset':
        s.unload('EMPTY');
        return;
    }
  };

  const remedies = remediesFor(kind);

  return (
    <div
      className={['degraded', className].filter(Boolean).join(' ')}
      role="alert"
      aria-label={COPY.a11y.degradedBar}
      data-class={kind}
    >
      <div className="degraded__head">
        <span className="degraded__banner caps">{COPY.degraded.banner}</span>
        <Tip content={`${copy.title} — ${copy.meaning} ${COPY.degraded.note}`}>
          <span className="degraded__code mono">{degraded.code}</span>
        </Tip>
        {known ? null : <span className="degraded__unknown caps ink-dim">{COPY.common.unknown}</span>}
      </div>

      {/* WHAT KIND OF FAILURE THIS IS. Four readings, and they are the reason the
          three cells to the right of this one are worth reading in a different
          order depending on which one it says.

          THE MEANING IS PRINTED, NOT HOVERED. `long` was a tooltip on a
          non-focusable span, which put the only full statement of the class out
          of reach of a keyboard and of a thumb. It is the class's `long` rather
          than its `short` because `long` is the one that carries the move —
          "nothing needs retrying, the next move is a different question" — and
          two glosses of one fact stacked in one cell is the duplication this
          band already refuses elsewhere. */}
      <div className="degraded__field degraded__field--class">
        <span className="degraded__flabel caps ink-dim">{COPY.instruments.failure.classLabel}</span>
        <span className="degraded__class t-13 w-650">{classCopy.label}</span>
        <p className="degraded__ftext degraded__meaning t-12-5" data-prose>
          {classCopy.long}
        </p>
      </div>

      <div className="degraded__field">
        <span className="degraded__flabel caps ink-dim">{COPY.degraded.whatFailedLabel}</span>
        <p className="degraded__ftext t-12-5" data-prose>
          {degraded.what_failed}
        </p>
      </div>

      {/* THE ENGINE'S OWN REMEDY SENTENCE, VERBATIM, AND THE CONTROLS THAT
          PERFORM IT, IN ONE CELL. They used to sit at opposite ends of a 2560px
          row, and there used to be exactly one control regardless of what the
          sentence said. */}
      <div className="degraded__field degraded__field--remedy">
        <span className="degraded__flabel caps ink-dim">{COPY.degraded.remedyLabel}</span>
        <p className="degraded__ftext degraded__remedy t-12-5" data-prose>
          {degraded.exact_remedy}
        </p>

        <div className="degraded__remedies">
          <span className="degraded__flabel caps ink-dim">
            {COPY.instruments.failure.remedies.label}
          </span>
          <div className="degraded__actions">
            {remedies.map((remedy, i) => {
              const action = COPY.remedies.actions[remedy];
              return (
                <Btn
                  key={remedy}
                  /* The class's FIRST remedy is the one its `long` copy names
                     first, so it is the one that leads. The rest are peers, not
                     afterthoughts, which is why they are `quiet` rather than
                     smaller. */
                  variant={i === 0 ? 'primary' : 'quiet'}
                  size="sm"
                  tone={SPENDS.has(remedy) ? 'render' : 'neutral'}
                  onClick={() => perform(remedy)}
                  title={action.title}
                >
                  {action.label}
                </Btn>
              );
            })}
          </div>
        </div>

        {/* THE ONE THING ABOUT THESE CONTROLS A READER CANNOT VERIFY BY LOOKING.
            Every remedy changes the state that failed; where the bar goes, it
            goes because that state was replaced and not because a control hid
            it. That was a tooltip on a span, which is to say it was unreachable
            without a mouse — in the one state where a reader is deciding whether
            to trust the instrument. */}
        <p className="degraded__consequence t-12-5 ink-dim" data-prose>
          {COPY.instruments.failure.remedies.note}
        </p>

        {/* THE ONE CLASS WHERE THE ABSENCE OF A CONTROL IS ITSELF INFORMATION.
            A reader who has been trained by every other alarm they have ever met
            will look for the dismiss button; this says why there is not one,
            rather than letting them conclude the band is broken. */}
        {invalidatesResult(kind) ? (
          <p className="degraded__nodismiss t-12-5" data-prose>
            {COPY.instruments.failure.noDismiss}
          </p>
        ) : null}

        {/* The taxonomy fell back to SYSTEM — the most conservative kind, the one
            that assumes least about how much of the session survived. Said once,
            here, under the remedies it explains. */}
        {classified ? null : (
          <p className="degraded__unclassified t-12-5 ink-dim" data-prose>
            {COPY.remedies.unclassified}
          </p>
        )}
      </div>
    </div>
  );
}
