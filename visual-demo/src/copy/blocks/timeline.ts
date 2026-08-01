/**
 * =============================================================================
 * COPY BLOCK — THE TIMELINE LENS
 * =============================================================================
 *
 * The words for a lens whose behaviour was, until now, entirely undeclared.
 *
 * A user could see a row of two hundred ticks, two 8px handles and a button
 * marked `Selected`, and there was no sentence anywhere on the screen saying
 * what any of it would do. The model — brush a date window, then select every
 * graph node whose events fall inside it — had to be inferred by doing it, and
 * doing it cost you the camera. Copy is half of the fix; the other half is that
 * dragging no longer does anything but preview.
 *
 * NOTE THE VERBS. `Apply window` / `Reset window` / `Restore previous view` each
 * name their own object and their own consequence. `Selected` and `Clear` named
 * neither, and one of them was a verb pretending to be a noun.
 *
 * -----------------------------------------------------------------------------
 * THE WORD `WINDOW` MEANT TWO THINGS FORTY PIXELS APART
 * -----------------------------------------------------------------------------
 * The axis over the terrain printed `WINDOW  2019-03-04 → 2024-11-20` — the
 * corpus's WHOLE SPAN — while the two handles beneath it brushed a period that
 * the panel called a window everywhere else, and the button that committed it
 * was labelled `Selected`. One label, two readings, in one instrument, at the
 * same moment: exactly the compound-label failure this project treats as a
 * defect rather than as untidiness.
 *
 * So the span is `Axis` and the brush is `Window`, and neither word is used for
 * the other anywhere in this block. The `§ axis` section below is the dock's own
 * vocabulary; the deck's older `timeline` block still owns the two EVENT KINDS,
 * because those names are the engine's and are shared with the legend.
 * =============================================================================
 */

import type { ActionCopy, RowCopy, TermCopy } from '@/copy/types';

export const timeline = {
  scope: {
    label: 'Covering',
    tip: 'What this axis is an axis OF. An alternate lens keeps the current answer’s scope until you widen it on purpose.',
    options: {
      answer: {
        label: 'This answer',
        short: 'Dated claims around the answer on screen.',
        long:
          'The events attached to the constellation this answer was rendered from. This is the default: a lens over a result is a lens over that result until you say otherwise.',
      } satisfies TermCopy,
      selection: {
        label: 'Selection',
        short: 'Dated claims around whatever is held.',
        long:
          'The events attached to the node you are holding and its neighbourhood. Useful after pointing at something the answer did not reach.',
      } satisfies TermCopy,
      corpus: {
        label: 'Whole corpus',
        short: 'Every dated claim in the archive.',
        long:
          'The full chronology. This is the widest scope and the only one the engine samples rather than returns in full — the note below says so when the sample actually binds.',
      } satisfies TermCopy,
    },
  },

  /** THE MODEL, STATED. This sentence did not exist. */
  hint: 'Drag either end of the axis to preview a period. Nothing is selected until you apply it.',

  apply: {
    label: 'Apply window',
    title: 'Hold the nodes whose events fall in this period. The camera does not move.',
  } satisfies ActionCopy,
  reset: {
    label: 'Reset window',
    title: 'Back to the whole span, with nothing held',
  } satisfies ActionCopy,
  restore: {
    label: 'Restore previous view',
    title: 'Leave the timeline and return the camera to where it was when you opened it',
  } satisfies ActionCopy,

  handles: {
    start: 'Start date',
    end: 'End date',
    tip: 'Drag to move this end of the window. Arrow keys nudge it one day, Page Up and Page Down move it a twentieth of the axis, and Home and End take it as far as this end can travel.',
  },

  /**
   * ===========================================================================
   * THE AXIS OVER THE TERRAIN — the dock's own vocabulary
   * ===========================================================================
   *
   * Separate from the deck's `timeline` block on purpose. That block is the
   * instrument's ORIGINAL wording and it is still correct about the two event
   * kinds; it is wrong about `Window`, which it spends on the corpus's whole
   * span. A block cannot fix a word it does not own, so the dock reads its
   * readout labels from here and its event-kind names from there.
   */
  axis: {
    /** The panel's own name. NOT `Timeline` — the rail panel is already called
        that, and two panels of one lens wearing one name is how a reader stops
        being able to say which surface they are looking at. */
    title: 'Event axis',
    tip: 'Every dated event this scope returned, on the corpus’s real span. The two handles brush a period; brushing is a preview and changes nothing until you apply it in the panel beside this one.',

    span: {
      label: 'Axis',
      tip: 'The corpus’s whole span, earliest declared boundary to latest. Never a sentinel date: a placeholder that escapes into an instrument cannot be told from a measurement.',
    } satisfies RowCopy,
    window: {
      label: 'Window',
      tip: 'The period the two handles are brushing. This is the ONLY thing this instrument calls a window.',
    } satisfies RowCopy,

    /** The word the `→` between two dates stands for. The glyph is the mark; a
        reader who is not looking at it gets this. */
    through: 'to',
    events: {
      label: 'Events',
      tip: 'Dated events drawn on this axis. While a window is brushed, the first figure is how many of them fall inside it.',
    } satisfies RowCopy,

    /** The two states of a brush, said in a word rather than inferred from
        whether the map happened to change. */
    previewing: {
      label: 'Previewing',
      tip: 'This window has not been applied. Nothing is held, and the camera has not moved.',
    } satisfies RowCopy,
    applied: {
      label: 'Applied',
      tip: 'The nodes with events in this window are held. Reset window releases them.',
    } satisfies RowCopy,

    unsampled: {
      label: 'Not sampled',
      tip: 'The span past the last event in hand. Hatched rather than filled, because a solid band would read as data of its own — and because a reader takes the shape of a chart before they take its numbers.',
    } satisfies RowCopy,

    /** No dated event anywhere on the axis. Not an error — a fact about the scope. */
    empty: 'Nothing in this scope carries a date. Widen the scope to bring more of the corpus onto the clock.',

    /**
     * -------------------------------------------------------------------------
     * THE STRUCTURED TEXTUAL TWIN
     * -------------------------------------------------------------------------
     * A screen reader met this axis as two hundred unnamed marks and two 8px
     * buttons that both announced as `Window` — the same name on both ends, and
     * on the header cell printing the corpus's whole span — which is not an
     * axis, it is noise with a scrollbar. Making the marks focusable would have
     * been worse: two hundred tab stops between a reader and the next control,
     * each one announcing nothing.
     *
     * So the terrain gets a SUMMARY rather than an enumeration — how many
     * events, over what span, how many the window admits, how many are on nodes
     * currently held — and the enumeration lives where it can actually be
     * worked through, as the rail's list of rows. This sentence and that list
     * are the same population; neither is a consolation prize for the other.
     *
     * TWO OF THE PICTURE'S FACTS WERE MISSING FROM IT, AND BOTH ARE DRAWN AS
     * `aria-hidden` MARKS, so this sentence is their only carrier:
     *
     *   THE SPAN THE EVENTS OCCUPY, which is not the axis. It is what the year
     *   grid is for — turning "the ticks stop a third of the way along" into
     *   "there is nothing after 2024" — and the sentence stated only the axis's
     *   own ends, which are the same in a corpus with one event and a corpus
     *   with two thousand.
     *
     *   THE COUNT THE SAMPLE CUT. `truncated` was never mentioned. With 2,168
     *   events cut, a sighted reader got a hatched band and a legend key reading
     *   `Not sampled`; this sentence said "…carrying 200 dated events" and
     *   stopped — a complete-sounding statement of a ninth of the corpus.
     *
     * Named arguments rather than eight positional ones: `summary(200, a, b, c,
     * 162, 3, 2168)` is a call nobody can read and any two of whose arguments
     * can be swapped without a type error.
     */
    summary: (r: {
      total: number;
      from: string;
      to: string;
      /** The first and last DRAWN event, or null when nothing is on the axis. */
      drawnFrom: string | null;
      drawnTo: string | null;
      inside: number;
      held: number;
      truncated: number;
    }): string => {
      /* Said only when it differs from the axis. When the events span the whole
         axis the clause is a restatement of the sentence before it, and a
         summary that repeats itself is one the reader learns to stop finishing. */
      const occupies =
        r.drawnFrom === null || r.drawnTo === null || (r.drawnFrom === r.from && r.drawnTo === r.to)
          ? ''
          : `The events themselves run ${r.drawnFrom} to ${r.drawnTo}. `;

      /* EMPTY AND UNSAMPLED ARE NOT THE SAME REMAINDER, and the whole reason the
         axis hatches rather than fills is that a reader must not take one for
         the other. The sentence has to make the same distinction. */
      const remainder =
        r.truncated > 0
          ? r.drawnTo === null || r.drawnTo === r.to
            ? `${r.truncated} further events were cut by the sampling limit and are not drawn. `
            : `${r.truncated} further events were cut by the sampling limit, so the span after ${r.drawnTo} is unsampled rather than empty. `
          : occupies === ''
            ? ''
            : 'The rest of the axis carries none. ';

      return (
        /* It does NOT open by naming itself: the element it sits in is already
           labelled `Event axis`, and a description that repeats its own group's
           label spends the reader's first clause on something they were just
           told. It opens on the span, which is the fact the picture leads with. */
        `${r.from} to ${r.to}, carrying ${r.total} dated events. ` +
        occupies +
        remainder +
        /* `All of them are in view` rather than `no window is brushed`: the two
           are not the same state — a brushed window can legitimately admit
           everything — and a summary that names the wrong one of them is a
           plausible sentence about a state the reader is not in. */
        (r.inside === r.total
          ? 'All of them are in view. '
          : `${r.inside} of them fall inside the brushed window. `) +
        (r.held === 0 ? '' : `${r.held} of them are on nodes you are holding. `) +
        'Each event is listed as a row, and can be opened on the map, in the Events in this period panel beside this axis.'
      );
    },
  },

  events: {
    title: 'Events in this period',
    label: 'events',
    empty: 'No dated claim falls inside this window.',
    open: { label: 'Show on the map', title: 'Hold this event’s node and frame it' } satisfies ActionCopy,
  },

  /**
   * THE SAMPLING LIMIT, SAID ONCE AND LAST.
   *
   * It used to read `200 shown / 2,168 not shown` in the header, which made a
   * lens about the corpus's chronology lead with its own incompleteness — and
   * invited the reading that the axis was a random 9% of the truth. It is a real
   * limit and it is stated; it is not the headline, and it only appears when the
   * scope is wide enough for it to actually bind.
   */
  truncated:
    'The whole-corpus axis is sampled: the most recent events beyond the sample are not drawn. Narrow the scope for a complete one.',
} as const;
