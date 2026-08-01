/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE NAVIGATION STACK
 * =============================================================================
 *
 * EVERY NAVIGATION ACTION HAS A VISIBLE REVERSE ACTION. Four controls, and each
 * one exists because a specific move in this product had no way back.
 *
 *   BACK             the reverse of the two moves that displace a whole scene —
 *                    rendering a new question, and opening a source. Both change
 *                    the level, the scope, the selection and the camera in one
 *                    step; until now neither left anything behind, so a reader
 *                    who drilled into a passage to check one quote had no route
 *                    back to the answer that sent them except reconstructing it.
 *
 *   UP               the reverse of a descent. It existed, in the breadcrumb —
 *                    which was `display: none` below 1500px, i.e. withdrawn at
 *                    exactly the widths where a user is most likely to be lost.
 *
 *   BACK TO RESULT   the reverse of arbitrarily many moves. `Back` unwinds one
 *                    step; this returns to the view the answer was framed in,
 *                    from wherever exploring has ended up, in one press.
 *
 *   HOME             the reverse of everything, and the only destination that
 *                    can be promised in advance: the whole map at island level
 *                    with nothing held. It does NOT discard the answer — Home is
 *                    a place, not a reset, and a control that quietly threw away
 *                    a receipt would be the last one anybody pressed twice.
 *
 * -----------------------------------------------------------------------------
 * A DISABLED REVERSE ACTION IS BETTER THAN AN ABSENT ONE
 * -----------------------------------------------------------------------------
 * `Back` and `Back to result` are rendered whenever there is a corpus, disabled
 * when there is nothing to go back to. A control that appears and disappears
 * teaches nothing and cannot be aimed at from memory; a control that is always
 * in the same place, sometimes dim, teaches the whole model in one session.
 * `title` states what each one would do, so the reverse action is never a guess.
 * =============================================================================
 */

import { COPY } from '@/copy';
import { keyHintFor, useAtlas, useAtlasStore } from '@/state';
import { Btn, KeyHint, Tip } from '@/ui/primitives';

export interface NavStackProps {
  className?: string;
}

export function NavStack({ className }: NavStackProps): JSX.Element | null {
  const { canBack, backLabel, canUp, hasResult, atHome, hasCorpus } = useAtlasStore((s) => ({
    canBack: s.history.length > 0,
    backLabel: s.history.length === 0 ? '' : s.history[s.history.length - 1].label,
    canUp: s.stack.length > 0 || s.rung !== 'continent',
    hasResult: s.resultScene !== null,
    atHome: s.rung === 'island' && s.stack.length === 0 && s.selection.length === 0,
    hasCorpus: s.view !== null,
  }));

  if (!hasCorpus) return null;

  return (
    <nav className={['nav', className].filter(Boolean).join(' ')} aria-label={COPY.nav.label}>
      <Tip
        content={
          <span className="nav__tip">
            {backLabel.length > 0 ? `${COPY.nav.backTo} ${backLabel}` : COPY.nav.back.title}
            <KeyHint keys={keyHintFor('back')} />
          </span>
        }
      >
        <Btn
          variant="ghost"
          size="sm"
          disabled={!canBack}
          onClick={() => void useAtlas.getState().back()}
          title={COPY.nav.back.title}
        >
          {COPY.nav.back.label}
        </Btn>
      </Tip>

      <Tip
        content={
          <span className="nav__tip">
            {COPY.nav.up.title}
            <KeyHint keys={keyHintFor('ascend')} />
          </span>
        }
      >
        <Btn
          variant="ghost"
          size="sm"
          disabled={!canUp}
          onClick={() => void useAtlas.getState().ascend()}
          title={COPY.nav.up.title}
        >
          {COPY.nav.up.label}
        </Btn>
      </Tip>

      <Tip
        content={
          <span className="nav__tip">
            {COPY.nav.toResult.title}
            <KeyHint keys={keyHintFor('return-to-result')} />
          </span>
        }
      >
        <Btn
          variant="ghost"
          size="sm"
          disabled={!hasResult}
          onClick={() => void useAtlas.getState().returnToResult()}
          title={COPY.nav.toResult.title}
        >
          {COPY.nav.toResult.label}
        </Btn>
      </Tip>

      <Tip
        content={
          <span className="nav__tip">
            {COPY.nav.home.title}
            <KeyHint keys={keyHintFor('home')} />
          </span>
        }
      >
        <Btn
          variant="ghost"
          size="sm"
          disabled={atHome}
          onClick={() => void useAtlas.getState().home()}
          title={COPY.nav.home.title}
        >
          {COPY.nav.home.label}
        </Btn>
      </Tip>
    </nav>
  );
}
