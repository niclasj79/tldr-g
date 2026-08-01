/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE TASK HEADER
 * =============================================================================
 *
 * THE QUESTION NEVER DISAPPEARS. That is the whole of this component.
 *
 * It used to be an input in the middle of the top bar, flexing between a 520px
 * basis and a 220px floor against a wordmark, a breadcrumb, five panel switches,
 * a help chip, a share control and a corpus stamp. At 1280px it truncated
 * heavily. Near 1024px it was effectively invisible. And once a render landed,
 * the rail printed the ANSWER without restating what had been asked — so at the
 * exact width where a reader most needs the question, the product had neither
 * the question nor a way back to it.
 *
 * Here it is the first thing in the rail, at the rail's full width, pinned above
 * every detail surface, in one of two states:
 *
 *   ASKING     the composer. A question staged and unrun, with the verb that
 *              runs it. This is the product's most important control and it is
 *              now the widest thing in its own column.
 *   ASKED      the question as a sentence, with Edit and Rerun beside it, the
 *              answer under it, and the result's trust state under that.
 *
 * -----------------------------------------------------------------------------
 * THE TRUST STATE IS PART OF THE HEADER, NOT PART OF A TAB
 * -----------------------------------------------------------------------------
 * This is the fix for the worst defect the review found. The curated Compare
 * question could raise `PATH_DISAGREEMENT` — an independent re-traversal of the
 * graph disagreeing with the receipt — and pressing `Recover` cleared the alarm
 * band while the answer above stayed at full luminance, kept its 0.87 confidence
 * in render teal, and kept a green `Matches the by-construction answer` badge.
 * The interface went on vouching for a claim it had itself disproved, with the
 * disproof scrolled below the fold.
 *
 * A verification verdict is therefore a property of the ANSWER and travels with
 * it: rendered here, above every tab, on every screen the result appears on, and
 * it cannot be dismissed — only resolved by a successful re-render or by
 * discarding the result. `answer--disputed` in the panel below is the same fact
 * rendered a second time, deliberately, because a reader who is looking at the
 * confidence figure must not have to look up to learn it has been withdrawn.
 * =============================================================================
 */

import { useEffect, useState } from 'react';

import { COPY } from '@/copy';
import { openCommandSearch } from '@/interaction';
import { keyHintFor, useAtlas, useAtlasStore } from '@/state';
import { Btn, KeyHint, Tip } from '@/ui/primitives';

import { CommandBar } from './CommandBar';

/** The five verdict states, mapped to one sentence and one tone. */
function trustLine(
  verdict: 'identical' | 'not-a-chain' | 'no-admitted-route' | 'differs' | null,
): { text: string; tone: 'ok' | 'dim' | 'alarm' } | null {
  switch (verdict) {
    case 'identical':
      return { text: COPY.result.trust.ok, tone: 'ok' };
    case 'not-a-chain':
      return { text: COPY.result.trust.notAChain, tone: 'dim' };
    case 'no-admitted-route':
      return { text: COPY.result.trust.noRoute, tone: 'dim' };
    case 'differs':
      return { text: COPY.result.trust.differs, tone: 'alarm' };
    default:
      return null;
  }
}

export interface TaskHeaderProps {
  className?: string;
}

export function TaskHeader({ className }: TaskHeaderProps): JSX.Element {
  const { active, running, explain, verify, tampered } = useAtlasStore((s) => ({
    active: s.query.active,
    running: s.query.running,
    explain: s.explain,
    verify: s.verify,
    tampered: s.tampered,
  }));

  /* EDIT IS A STATE OF THIS HEADER, NOT A NAVIGATION.
     Putting the question back in the composer must not throw the result away —
     the reader is comparing a new phrasing against an answer they can still see,
     which is exactly what the header is for. */
  const [editing, setEditing] = useState(false);
  const queryId = active?.query_id ?? null;
  useEffect(() => {
    // A new result closes the composer: the question it was editing has landed.
    setEditing(false);
  }, [queryId]);

  if (active === null || editing) {
    return (
      <div className={['task', className].filter(Boolean).join(' ')} data-state="asking">
        <CommandBar className="task__composer" />
        {active === null ? null : (
          <Btn
            variant="ghost"
            size="sm"
            className="task__cancel"
            onClick={() => setEditing(false)}
            title={COPY.common.close.title}
          >
            {COPY.common.close.label}
          </Btn>
        )}
      </div>
    );
  }

  /* THE ANSWER'S TRUST STATE, DERIVED ONCE, HERE.
     Three independent things can invalidate a result and all three must reach
     the same place: a broken signature, edited payload bytes, and a re-traversal
     that contradicts the receipt. */
  const signatureFailed = verify !== null && !verify.valid;
  const disagrees = explain?.verdict === 'differs';
  const untrusted = disagrees || signatureFailed || tampered;
  const line = running ? { text: COPY.result.trust.pending, tone: 'dim' as const } : trustLine(explain?.verdict ?? null);

  return (
    <div className={['task', className].filter(Boolean).join(' ')} data-state="asked" data-untrusted={untrusted}>
      <div className="task__askedrow">
        <Tip content={COPY.result.askedTip}>
          <span className="task__label caps">{COPY.result.asked}</span>
        </Tip>
        <div className="task__acts">
          {/* THE SEARCH DOOR SURVIVES THE FIRST RENDER.
              It lives on the composer, and the composer is only mounted before a
              result or while editing one — so the product's best discovery tool
              became unreachable except by a keystroke nobody had been shown, at
              exactly the moment a reader has just learned what a question can do
              and is most likely to want another. Asking a second question is not
              an edit of the first. */}
          <Btn
            variant="ghost"
            size="sm"
            onClick={() => openCommandSearch()}
            title={COPY.searchSurface.open.title}
          >
            {COPY.searchSurface.open.label}
            <KeyHint keys={keyHintFor('search')} />
          </Btn>
          <Btn variant="ghost" size="sm" onClick={() => setEditing(true)} title={COPY.result.edit.title}>
            {COPY.result.edit.label}
          </Btn>
          <Btn
            variant="quiet"
            size="sm"
            disabled={running}
            onClick={() => void useAtlas.getState().runQuery(active.query)}
            title={COPY.result.rerun.title}
          >
            {COPY.result.rerun.label}
          </Btn>
        </div>
      </div>

      {/* THE QUESTION, IN FULL. It wraps; it never truncates. A question you can
          only read the first two thirds of is a question you have to remember. */}
      <p className="task__q t-14" data-prose>
        {active.query}
      </p>

      {/* THE ANSWER, PINNED. Struck when the bytes it was measured over moved. */}
      <p className="task__a t-14" data-prose data-struck={tampered || (verify !== null && !verify.payload_hash_matches)}>
        {active.answer}
      </p>

      {untrusted ? (
        /* NOT DISMISSIBLE. There is no close control on this block by design —
           it goes away when the result is re-rendered clean or discarded, and by
           no other route. See the header. */
        <div className="task__untrusted" role="status">
          <span className="caps tone-alarm u-tone">{COPY.result.trust.untrusted}</span>
          <p className="t-12-5 ink-dim" data-prose>
            {COPY.result.trust.untrustedBody}
          </p>
        </div>
      ) : line === null ? null : (
        <p className={`task__trust t-12-5 u-tone tone-${line.tone}`} data-prose>
          {line.text}
        </p>
      )}
    </div>
  );
}
