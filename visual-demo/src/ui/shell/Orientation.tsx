/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE ORIENTATION CARD
 * =============================================================================
 *
 * THREE NUMBERED STEPS, ON SCREEN, BEFORE ANYTHING IS PRESSED.
 *
 * A test drive of the reworked shell was asked one question — "is the sequence
 * obvious?" — and answered it in one word: no. That is worth taking exactly at
 * face value, because everything the rework did was arrange the product AROUND a
 * sequence: ask, then understand, then verify, then explore. The arrangement was
 * right and it was silent. A reader who has not been told the sequence cannot
 * infer it from the fact that the surfaces happen to be in that order — they
 * meet a map, a question box and three tabs, and the tabs look like a filing
 * cabinet rather than like a path.
 *
 * -----------------------------------------------------------------------------
 * WHY A CARD AND NOT A BETTER WALKTHROUGH
 * -----------------------------------------------------------------------------
 * The walkthrough already exists, is task-based, and drives the real actions. It
 * has one structural problem no amount of rewriting fixes: IT HAS TO BE STARTED.
 * It auto-offers once per browser and is then reachable from Help, which means
 * the reader most likely to need it — the one who opened the demo a week ago,
 * bounced, and came back — never sees it again.
 *
 * So the sequence is stated in the rail, in three lines, permanently, in the
 * state where nothing has been asked. It costs a reader who does not need it one
 * glance; it costs a reader who does nothing at all, because they were going to
 * be lost. The walkthrough is one press away from it, which is the first time
 * that offer has been visible rather than remembered.
 *
 * -----------------------------------------------------------------------------
 * IT IS NOT A TOUR AND IT MAKES NO PROMISES
 * -----------------------------------------------------------------------------
 * Every line names a surface that exists and a control that is on screen. There
 * is no "and then the magic happens" step, no progress bar over work nobody is
 * doing, and no dismissal that has to be remembered — it is replaced by the
 * result the moment a question is rendered, because at that point the sequence
 * is no longer something to read, it is something you are inside.
 * =============================================================================
 */

import { COPY } from '@/copy';
import { useAtlasStore } from '@/state';
import { Btn, Num, Panel } from '@/ui/primitives';

import { startWalkthrough } from './Walkthrough';

export interface OrientationProps {
  className?: string;
}

export function Orientation({ className }: OrientationProps): JSX.Element | null {
  /* IT GOES AWAY WHEN IT HAS BEEN OUTGROWN, not when it is dismissed. A card
     explaining how to ask a question, still on screen beside the answer to one,
     is the interface talking over itself. */
  const hasAnswer = useAtlasStore((s) => s.query.active !== null);
  if (hasAnswer) return null;

  const copy = COPY.guidance.orientation;

  return (
    <Panel title={copy.title} tone="curiosity" className={['orient', className].filter(Boolean).join(' ')}>
      <p className="orient__lede t-13 ink-dim" data-prose>
        {copy.lede}
      </p>

      {/* AN ORDERED LIST, BECAUSE IT IS AN ORDER. `<ol>` is what carries that to
          a screen reader — "list, 3 items, item 1 of 3" — and it is the same
          fact the numerals carry visually. */}
      <ol className="orient__steps">
        {copy.steps.map((step, i) => (
          <li key={step.id} className="orient__step">
            <span className="orient__n mono" aria-hidden="true">
              <Num value={i + 1} format="int" tone="curiosity" />
            </span>
            <span className="orient__body">
              <span className="orient__title t-13">{step.title}</span>
              <span className="orient__note t-12-5 ink-dim" data-prose>
                {step.body}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <Btn variant="quiet" onClick={() => startWalkthrough()} title={copy.walk.title} className="orient__walk">
        {copy.walk.label}
      </Btn>
    </Panel>
  );
}
