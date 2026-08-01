/**
 * =============================================================================
 * COPY BLOCK — THE THREE INSTRUMENTS
 * =============================================================================
 *
 * The HUD, the empty state, and the failure band: the three surfaces that report
 * on the machine rather than on the corpus. Their words live together because
 * they answer one question between them — WHAT HAS THIS INSTRUMENT ACTUALLY
 * MEASURED — and the three answers have to be a consistent scale.
 *
 * -----------------------------------------------------------------------------
 * WHY THE HUD NEEDED ITS OWN WORDS AT ALL
 * -----------------------------------------------------------------------------
 * The row carried fifteen cells before a question had been asked. Two of them
 * printed an em dash, a third printed an em dash inside a fraction, and one
 * printed `0 ms` — a wrong figure, produced because `engine.lastLatency`
 * initialises to zero and the cell had no way to ask whether a call had ever
 * been made. Fifteen labels reporting nothing is not an instrument at rest; it
 * is debug output that happens to be laid out.
 *
 * The cells did not need shortening. They needed a SUBJECT TEST: a cell prints a
 * figure when the thing it counts exists, and is absent when it does not. That
 * turns "a row of em dashes" into "a row of what has been measured", and it
 * needs exactly one sentence of prose — `hud.noSubject` — for the one state
 * where the answer is "nothing yet".
 *
 * -----------------------------------------------------------------------------
 * THE THREE RENDER READINGS ARE ONE CLOSED SET, SO THEY HAVE ONE OWNER
 * -----------------------------------------------------------------------------
 * `hud.render.states` could have been assembled from three existing strings —
 * `common.notRun`, `command.running.label`, and a new word for the third. It is
 * not, and the reason is that these are the readings of a single cell and have
 * to read as a scale: three lowercase status words, in one place, that can only
 * ever be revised together. `Rendering` on the command button is a CONTROL
 * label answering "what is this button doing"; `rendering` here is a READING
 * answering "what state is the render in". Sourcing one from the other is how a
 * scale acquires a capital letter in the middle of it.
 *
 * -----------------------------------------------------------------------------
 * THE EMPTY SCREEN SAYS WHICH FIELD IS ON SCREEN, BECAUSE THERE ARE TWO
 * -----------------------------------------------------------------------------
 * `states.EMPTY.body` in the deck says "the grid behind this panel". That is
 * true for one of the two fields the screen can draw and false for the other:
 * when the corpus has been materialised and closed, what is behind the panel is
 * the REAL BAKED LAYOUT, and calling it a grid is the same class of error as the
 * caption that claimed real positions under the fallback lattice. Two sentences,
 * one per source, chosen by `latentSource()`.
 *
 * Types come from `../types`; nothing here imports a component.
 * =============================================================================
 */

import type { RowCopy } from '@/copy/types';

export const instruments = {
  /* =========================================================================
   * THE BOTTOM HUD
   * ====================================================================== */
  hud: {
    /**
     * The one sentence that replaced a row of em dashes.
     *
     * It is a SENTENCE rather than a set of blank cells because "we have
     * measured nothing" is a real reading and deserves to be stated once, not
     * spelled out fifteen times in punctuation.
     */
    noSubject: 'No corpus loaded. Nothing on this row has anything to measure yet.',

    /**
     * THERE IS NO `selectionTip` HERE, AND THAT IS THE SECOND HALF OF A FIX.
     *
     * A HUD cell printing the selection count was added, and it was the SECOND
     * owner of that count: `InteractionSurface` already prints `.ix-selection`
     * over the terrain, from the same `hud.selectionLabel`, with the marquee cap
     * the HUD could not carry. The cell is gone; this string went with it,
     * because copy that no surface renders is a claim the deck is still making
     * about a surface that no longer exists. See BottomHUD.tsx for which owner
     * won and why.
     */

    /**
     * WHETHER A QUESTION HAS BEEN RENDERED. Not whether the machine is healthy —
     * that is the top bar's dot, and a failure gets the full-width alarm band.
     */
    render: {
      label: 'Render',
      tip: 'Whether a question has been rendered against this corpus. The budget figures beside it appear when there is a render for them to describe, and not before — an em dash where a token count will go is a cell asking to be believed later.',
      states: {
        'not-run': 'not run',
        running: 'rendering',
        done: 'rendered',
      },
    },

    /**
     * The section marker over the cells the analyze lens adds.
     *
     * They are named as a GROUP because that is the whole argument of the fix:
     * they are not fifteen peers of the render budget, they are one expert
     * appendix to it, and a reader has to be able to see where the default row
     * ends.
     */
    analyst: {
      label: 'Analyze',
      tip: 'Renderer and graph-policy figures. They describe how the picture was produced rather than what the answer cost, so they live in the Analyze workspace and are absent everywhere else.',
    },
  } satisfies {
    noSubject: string;
    render: { label: string; tip: string; states: Record<'not-run' | 'running' | 'done', string> };
    analyst: RowCopy;
  },

  /* =========================================================================
   * THE EMPTY STATE
   * ====================================================================== */
  empty: {
    /**
     * WHAT IS ACTUALLY BEHIND THE PANEL. One sentence per source, and the screen
     * picks with `latentSource()` rather than asserting the same thing over
     * both.
     */
    field: {
      bake: 'Behind this panel is the real baked layout of the corpus you closed, drawn at latent resolution: outline only, no labels, nothing spent. It is not a picture of what will appear — it is what will appear, unresolved.',
      grid: 'Behind this panel is the engine’s own deterministic lattice, drawn at latent resolution: outline only, no labels, nothing spent. Nothing has been built in this session, so there are no real positions to draw and the shape of the world is not being guessed at.',
    },
    /**
     * The HUD's own state, said on the screen that is about state.
     *
     * The old wording claimed "every figure in the HUD reads as an em dash",
     * which was both the intent and, in one cell, false: `Last call` printed
     * `0 ms` on a cold session. The claim is now about ABSENCE rather than about
     * dashes, and absence is what the row actually does.
     */
    hudNote: 'The row along the bottom is measuring nothing, and says so rather than printing zeros.',
  } satisfies {
    field: { bake: string; grid: string };
    hudNote: string;
  },

  /* =========================================================================
   * THE FAILURE BAND
   * ====================================================================== */
  failure: {
    /** The field marker over the taxonomy's own name for what went wrong. */
    classLabel: 'Failure class',
    /**
     * The marker over the remedy buttons, and the one honest thing to say about
     * what pressing one of them costs.
     *
     * Plural, and that is the fix: there was one button called `Recover`, it did
     * not name its own consequence, and on an integrity disagreement what it
     * actually did was clear the alarm and leave the contradicted answer on
     * screen still wearing a green by-construction badge.
     *
     * `note` IS PRINTED, NOT HOVERED, AND IT USED TO BE A `tip`. A bar that
     * vanishes is indistinguishable from a bar that was dismissed unless
     * somebody says which one happened — so this is the sentence a reader most
     * needs and cannot get from the pixels, and it was sitting on a hover state
     * hung off a `<span>` with `tabIndex: -1`. Unreachable by keyboard, and
     * unreachable by thumb, in a failure state.
     *
     * IT ALSO STOPPED COUNTING. The old wording said "two of them" make the bar
     * disappear, which was true of the eight remedies in the abstract and false
     * of most of the four SETS the band actually renders: no-answer offers two
     * controls and both clear, system offers two and both clear. A sentence that
     * miscounts the buttons directly above it is worse than no sentence, so this
     * one states the RULE — the bar goes when the state that raised it is
     * replaced — which is true of every set.
     */
    remedies: {
      label: 'What you can do',
      note: 'Every one of these changes the state that failed. Where this bar goes, it goes because the state that raised it was replaced — not because a control hid it — and if the same thing fails again it returns carrying the NEW failure, not this one.',
    } satisfies { label: string; note: string },
    /**
     * Shown under the buttons for the one class where dismissal is the wrong
     * affordance. It is not a warning about the failure — the band above is
     * that. It is a statement about what these buttons deliberately do NOT
     * include.
     */
    noDismiss:
      'None of these hides this bar. The result on screen is the thing in dispute, so the only honest moves are to look at the disagreement, render it again, or throw the result away.',
  } satisfies {
    classLabel: string;
    remedies: { label: string; note: string };
    noDismiss: string;
  },
} as const;
