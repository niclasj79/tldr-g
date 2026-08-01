/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE ANNOUNCER
 * =============================================================================
 *
 * The two live regions this product did not have.
 *
 * -----------------------------------------------------------------------------
 * THE MEASUREMENT
 * -----------------------------------------------------------------------------
 * There were ZERO `aria-live` regions in the entire application. The only two
 * implicit ones were `role="alert"` on the failure band and on the WebGL-failure
 * plate — both of which announce a catastrophe and neither of which announces
 * anything that happens when the product is working. So the assistive reading of
 * the central act of the product, pressing Render, was: silence while the engine
 * traversed, silence when the answer landed, and an answer that could only be
 * discovered by going to look for it. The same was true of every rung change,
 * every selection, and both halves of the verification the whole trust argument
 * rests on.
 *
 * -----------------------------------------------------------------------------
 * FIVE THINGS ARE SPOKEN, AND HOVER IS NOT ONE OF THEM
 * -----------------------------------------------------------------------------
 *   Rendering                 the engine entered QUERYING
 *   Answer ready              it came back to READY with a result, plus the
 *                             answer's first clause — the claim itself, not a
 *                             notification that a claim exists
 *   N nodes held              the selection COUNT changed
 *   <Level>, scoped to X      the level or its scope changed
 *   the re-derivation verdict polite when the graph and the receipt agree,
 *                             ASSERTIVE when they do not
 *   the signature verdict     same rule: polite valid, assertive broken
 *
 * Hover is deliberately absent and `s.hover` is not read anywhere in this file.
 * A pointer crossing 4,406 nodes would produce 4,406 utterances, which is a
 * denial of service delivered in the user's own voice.
 *
 * -----------------------------------------------------------------------------
 * THE FAILURE IS NOT ON THAT LIST ANY MORE, AND THAT IS A DEDUPLICATION
 * -----------------------------------------------------------------------------
 * It used to be. The banner above noticed the pre-existing `role="alert"` on the
 * failure band and then wrote the SAME two sentences into the assertive region
 * anyway: `DegradedBar` mounts `role="alert"` carrying `COPY.degraded.banner`
 * (DegradedBar.tsx:212) and the engine's own `degraded.what_failed` (:235) the
 * instant the store goes DEGRADED, and both fired on the one store transition.
 * The measured result was the failure banner and the `what_failed` sentence,
 * then the whole band read out again as an alert — an assertive double utterance
 * at the exact moment the user's attention matters most.
 *
 * One fact, one owner, and the owner is the surface that CARRIES the text. This
 * region speaks the events that have no visible band of their own.
 *
 * -----------------------------------------------------------------------------
 * WHY THERE IS A QUEUE AND A DEBOUNCE
 * -----------------------------------------------------------------------------
 * A held arrow key moves the cursor at the OS repeat rate, roughly every 30ms.
 * Writing a live region on each one produces a backlog a screen reader will
 * faithfully read out long after the user has stopped moving, which is worse than
 * silence because it is silence that arrives late and wrong. So changes land in a
 * per-topic slot — a later change to the same topic SUPERSEDES the earlier one
 * rather than queueing behind it — and the slots are flushed together once the
 * store has been quiet for `DEBOUNCE_MS`. Forty arrow presses become one
 * sentence, and it is the true one.
 *
 * Assertive announcements bypass the wait, because an integrity disagreement that
 * arrives a quarter of a second late is an integrity disagreement that arrived
 * after the user acted on the answer.
 *
 * THEY DID NOT, AND THE REASON WAS ONE SHARED `timer`. `schedule()` cleared it
 * unconditionally before re-arming, so the urgent path's `setTimeout(flush, 0)`
 * was cancelled by the next non-urgent write and re-armed at the full
 * `DEBOUNCE_MS` — repeatedly. A `differs` verdict commonly lands alongside a
 * selection change and a scope change in one interaction, and each of those
 * pushed the disagreement back another 250ms. There are two timers now, and the
 * urgent one is never cleared by the polite one: the only thing that clears it is
 * the flush it was armed for.
 *
 * A flush that would repeat the region's current text writes nothing at all. Two
 * identical utterances in a row read as a stutter, and a stutter in an instrument
 * reads as a fault in the instrument.
 *
 * -----------------------------------------------------------------------------
 * ONLY A CHANGE THAT PRODUCED SPEECH MAY RESET THE TIMER
 * -----------------------------------------------------------------------------
 * The first version of this re-armed the debounce on EVERY store write, which is
 * what a debounce normally means and is wrong here, because this store is written
 * by things that are not the user. The frame sampler emits at 4Hz — one write
 * every 250ms, against a 250ms window — and the camera writes its target every
 * time a flight settles. Measured against the running app: with unrelated store
 * writes arriving every 100ms, a selection announcement never landed AT ALL, for
 * as long as the writes continued. A timer that anything can push forward is not
 * a debounce, it is starvation with a plausible name.
 *
 * So the window is re-armed only by an event that actually filled a slot. A held
 * arrow key still collapses to one utterance, because every one of those presses
 * DOES fill the selection slot; a terrain quietly reporting its frame rate no
 * longer delays a word of it.
 * ========================================================================== */

import { useEffect, useState } from 'react';

import { COPY, verifyCopy } from '@/copy';
import { useAtlas } from '@/state';
import { Num } from '@/ui/primitives';

/**
 * How long the store must be quiet before the polite region is written.
 *
 * Above the ~30ms key-repeat interval by an order of magnitude, so a sweep of any
 * length collapses to one utterance; below the ~400ms at which an announcement
 * stops feeling like a consequence of the key you just pressed. It is not a
 * motion duration and is deliberately not read from `--t-*`: nothing here is
 * animating, and borrowing a camera easing token for a speech delay would tie two
 * unrelated numbers together for the sake of not declaring one.
 */
const DEBOUNCE_MS = 250;

/**
 * One utterance fragment. `value` renders through `<Num>` like every other
 * measured figure in the product — a live region is read from its DOM, so the
 * mono primitive belongs here exactly as much as it does on a panel.
 */
interface Part {
  lead: string;
  value: number | null;
  trail: string;
}

/** A fragment that is only words. */
function say(trail: string): Part {
  return { lead: '', value: null, trail };
}

/** What an utterance is ABOUT. One slot each; a later event supersedes an earlier. */
type Topic = 'app' | 'scope' | 'selection' | 'rederivation' | 'signature';

/** Flush order. It is the order the events matter in, not the order they arrived. */
const TOPIC_ORDER: readonly Topic[] = ['app', 'scope', 'selection', 'rederivation', 'signature'];

/**
 * The answer's first clause.
 *
 * "Answer ready" on its own is a notification, and a notification is what a
 * sighted reader does NOT get — they get the sentence. So the sentence is read.
 * It is cut at the first terminator and NOT truncated at a character count: a
 * silently cropped claim is the one thing this product may not produce, and every
 * answer in this corpus is a sentence or two. No terminator means the whole
 * answer is read, which is the honest fallback.
 */
function firstClause(answer: string): string {
  const text = answer.trim();
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(text);
  return match === null ? text : match[0];
}

/** The deepest breadcrumb entry's id — the thing the current level is scoped to. */
function scopeIdOf(stack: readonly { id: string }[]): string | null {
  return stack.length === 0 ? null : stack[stack.length - 1].id;
}

/** Stable text of an utterance, for the never-say-it-twice check. */
function utteranceKey(parts: readonly Part[]): string {
  return parts.map((p) => `${p.lead}${String(p.value)}${p.trail}`).join('');
}

function Utterance({ parts }: { parts: readonly Part[] }): JSX.Element | null {
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((p, i) => (
        // One paragraph per fragment: a screen reader pauses at the element
        // boundary, so the fragments do not need punctuation invented for them by
        // a component. The copy deck owns every full stop in this product.
        <p key={i}>
          {p.lead.length > 0 ? <>{p.lead} </> : null}
          {p.value === null ? null : (
            <>
              <Num value={p.value} format="int" />{' '}
            </>
          )}
          {p.trail}
        </p>
      ))}
    </>
  );
}

export interface AnnouncerProps {
  className?: string;
}

export function Announcer({ className }: AnnouncerProps): JSX.Element {
  const [polite, setPolite] = useState<readonly Part[]>([]);
  const [assertive, setAssertive] = useState<readonly Part[]>([]);

  useEffect(() => {
    const pendingPolite = new Map<Topic, Part[]>();
    const pendingAssertive = new Map<Topic, Part[]>();
    /* TWO TIMERS, NOT ONE. See the banner: sharing one is what made the urgent
       path wait. `0` is the "not armed" value — `window.setTimeout` never
       returns it. */
    let politeTimer = 0;
    let urgentTimer = 0;
    let lastPolite = '';
    let lastAssertive = '';

    const collect = (pending: Map<Topic, Part[]>): Part[] => {
      const out: Part[] = [];
      for (const topic of TOPIC_ORDER) {
        const parts = pending.get(topic);
        if (parts !== undefined) out.push(...parts);
      }
      pending.clear();
      return out;
    };

    const flushAssertive = (): void => {
      urgentTimer = 0;
      const next = collect(pendingAssertive);
      if (next.length === 0) return;
      const key = utteranceKey(next);
      if (key === lastAssertive) return;
      lastAssertive = key;
      setAssertive(next);
    };

    const flushPolite = (): void => {
      politeTimer = 0;
      const next = collect(pendingPolite);
      if (next.length === 0) return;
      const key = utteranceKey(next);
      if (key === lastPolite) return;
      lastPolite = key;
      setPolite(next);
    };

    const schedule = (urgent: boolean): void => {
      /* The polite window is re-armed on EVERY slot-filling write, urgent or
         not, because a write can fill both maps at once and the polite half
         still owes its debounce. */
      window.clearTimeout(politeTimer);
      politeTimer = window.setTimeout(flushPolite, DEBOUNCE_MS);
      /* The urgent one is armed once and never pushed forward. Two urgent events
         in one tick collapse into the single flush already pending, which is the
         supersede rule the slots implement — not a delay. */
      if (urgent && urgentTimer === 0) urgentTimer = window.setTimeout(flushAssertive, 0);
    };

    /* THE SUBSCRIPTION IS THE WHOLE MECHANISM.
       It fires on every store write — including `hoverNode`, which writes one
       field 60 times a second while a pointer is moving. That is fine and it is
       the reason nothing below reads `s.hover`: the cost of an ignored event is
       five reference comparisons, and the cost of a spoken one is the user's
       attention. */
    const unsubscribe = useAtlas.subscribe((s, before) => {
      let urgent = false;
      /* THE RE-ARM GATE. See the banner: a write that produced no speech must not
         push the flush forward, or the frame sampler alone starves the region. */
      let filled = false;

      /* ---- the lifecycle ------------------------------------------------ */
      if (s.app !== before.app) {
        if (s.app === 'QUERYING') {
          pendingPolite.set('app', [say(COPY.command.running.label)]);
          filled = true;
        } else if (s.app === 'READY' && before.app === 'QUERYING' && s.query.active !== null) {
          pendingPolite.set('app', [
            say(COPY.a11yTwin.announce.answerReady),
            say(firstClause(s.query.active.answer)),
          ]);
          filled = true;
        }
        /* NO BRANCH FOR `DEGRADED`. `DegradedBar` already mounts `role="alert"`
           over the same banner and the same `what_failed` on this exact store
           transition; writing it here too made the one event in the product that
           gets read out twice the one where a second reading costs the most. See
           the deduplication note in the banner. */
      }

      /* ---- where you are ------------------------------------------------ */
      if (s.rung !== before.rung || scopeIdOf(s.stack) !== scopeIdOf(before.stack)) {
        const scope = s.stack.length === 0 ? null : s.stack[s.stack.length - 1];
        pendingPolite.set('scope', [
          {
            lead: COPY.rungs.levels[s.rung].label,
            value: null,
            trail: COPY.a11yTwin.announce.scope.level,
          },
          scope === null
            ? say(COPY.a11yTwin.announce.scope.world)
            : { lead: COPY.a11yTwin.announce.scope.scopedTo, value: null, trail: scope.label },
        ]);
        filled = true;
      }

      /* ---- what is held -------------------------------------------------
         THE COUNT, NOT THE CONTENTS. Arrowing across the terrain replaces a
         one-node selection with another one-node selection on every press; the
         count is unchanged and there is nothing to say, because the active
         descendant already named the node that changed. */
      if (s.selection.length !== before.selection.length) {
        pendingPolite.set(
          'selection',
          s.selection.length === 0
            ? [say(COPY.a11yTwin.heldWords.none)]
            : [
                {
                  lead: '',
                  value: s.selection.length,
                  trail:
                    s.selection.length === 1
                      ? COPY.a11yTwin.heldWords.one
                      : COPY.a11yTwin.heldWords.many,
                },
              ],
        );
        filled = true;
      }

      /* ---- the two verifications ---------------------------------------- */
      if (s.explain !== before.explain && s.explain !== null) {
        const parts = [
          say(COPY.answer.explain.title),
          say(COPY.answer.explain.verdicts[s.explain.verdict].short),
        ];
        if (s.explain.verdict === 'differs') {
          pendingAssertive.set('rederivation', parts);
          pendingPolite.delete('rederivation');
          urgent = true;
        } else {
          pendingPolite.set('rederivation', parts);
          pendingAssertive.delete('rederivation');
        }
        filled = true;
      }

      if (s.verify !== before.verify && s.verify !== null) {
        const parts = [say(verifyCopy(s.verify).title)];
        if (s.verify.valid) {
          pendingPolite.set('signature', parts);
          pendingAssertive.delete('signature');
        } else {
          pendingAssertive.set('signature', parts);
          pendingPolite.delete('signature');
          urgent = true;
        }
        filled = true;
      }

      if (filled) schedule(urgent);
    });

    return () => {
      unsubscribe();
      window.clearTimeout(politeTimer);
      window.clearTimeout(urgentTimer);
    };
  }, []);

  /* BOTH REGIONS EXIST FROM THE FIRST FRAME, EMPTY.
     A live region created at the same moment it is populated is a live region a
     screen reader has never observed and therefore does not watch — the classic
     way to ship an announcement that never fires. They are rendered here always,
     and only their contents change. */
  return (
    <div className={['anc', className].filter(Boolean).join(' ')}>
      <div className="u-sr" role="status" aria-live="polite" aria-atomic="true">
        <Utterance parts={polite} />
      </div>
      <div className="u-sr" role="alert" aria-live="assertive" aria-atomic="true">
        <Utterance parts={assertive} />
      </div>
    </div>
  );
}
