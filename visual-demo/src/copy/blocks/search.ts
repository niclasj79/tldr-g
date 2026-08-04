/**
 * =============================================================================
 * COPY BLOCK — DISCOVERY: THE SEARCH DOOR AND THE COMPOSER'S SUGGESTIONS
 * =============================================================================
 *
 * The words for the two things that make command search FINDABLE. The palette
 * itself already had copy (`COPY.search`); what it did not have was any prose
 * for a way in that is not a keystroke.
 *
 * -----------------------------------------------------------------------------
 * THE MEASUREMENT: ONE ROUTE, AND NOTHING ON SCREEN NAMED IT
 * -----------------------------------------------------------------------------
 * Command search indexes 3,885 nodes — the figure the palette's own footer
 * prints — plus the keyboard map and the three detail levels, and it is the only
 * tool in the product that can find a name you already know. Until this block
 * existed there was exactly ONE production affordance that opened it — the `/`
 * key — plus one accident: pressing Enter on an empty composer.
 *
 * NOTHING VISIBLE MENTIONED IT. A scan of every `button` and `[role=button]` in
 * the mounted tree for text matching /search/ returned nothing. An earlier draft
 * of this note named a `<KeyHint>` chip in the staged-question panel as the one
 * reference; the component that renders that chip, `StagedPanel`, is mounted by
 * nothing, and the panel that IS mounted has no search reference at all. So the
 * measurement was not "one reference that could not be pressed" — it was zero,
 * and a user who does not already know the convention had no route at all.
 *
 * -----------------------------------------------------------------------------
 * WHY THERE ARE TWO DOORS AND NOT ONE
 * -----------------------------------------------------------------------------
 * `open` is the pointer door: a real, labelled control beside the question
 * field, with `/` printed next to it as a HINT rather than as the route. The key
 * keeps working and now teaches itself.
 *
 * `suggest` is the other half, and it is deliberately NOT the palette. "Show
 * suggestions when the field is focused" describes a combobox; opening a modal
 * dialog on focus would take the caret away from a user who clicked into the
 * field to type, which is the opposite of a suggestion. So the composer grows an
 * inline listbox over the staged questions, and the modal palette — the whole
 * index, including every label and alias in the bake — stays behind `/` and
 * behind the new button.
 *
 * -----------------------------------------------------------------------------
 * `stages` IS THE LOAD-BEARING SENTENCE
 * -----------------------------------------------------------------------------
 * Picking a suggestion STAGES the question; it does not run it. The composer's
 * entire thesis is that the first render is the user's act — an autocomplete
 * that renders on selection would spend the token budget on a click the user
 * made to read a list. One sentence says so, under the list, once.
 *
 * Nothing here re-words `By construction`. The plain/technical pair lives in
 * `COPY.vocabulary.byConstruction` and these surfaces call `plain()` on it, so
 * the rename cannot drift between the composer, the palette and the panel.
 *
 * Types come from `../types`; nothing here imports a component.
 * =============================================================================
 */

import type { ActionCopy } from '@/copy/types';

export const search = {
  /**
   * THE VISIBLE DOOR. A control, not a chip.
   *
   * The label is one word because it sits in a 320px rail beside `Render`, and
   * the title carries what it actually searches — the four groups the palette
   * indexes — plus the fact that `/` is the same door. A shortcut a user learns
   * from the control it duplicates is a shortcut they keep.
   */
  open: {
    label: 'Search',
    title:
      'Search everything in this corpus: the staged questions, every label and alias on the map, the keyboard map, and the three detail levels. The / key opens the same thing.',
  } satisfies ActionCopy,

  /**
   * THE INLINE SUGGESTIONS — a combobox under the question field, not a modal.
   */
  suggest: {
    /**
     * The listbox's accessible name and its visible marker.
     *
     * It names the SET, not the mechanism: what is offered here is not "search
     * results", it is the closed list of questions this corpus was built to be
     * scored on. A reader who has just met the product learns the important
     * thing about the demo from the marker alone.
     */
    label: 'Questions this corpus can answer',

    /**
     * Under the list. The one sentence that stops this from being an
     * autocomplete that spends the budget on a click.
     */
    stages: 'Picking one stages it. Nothing is rendered until you press Render.',

    /**
     * Shown in place of the list when the typed text matches no staged
     * question. It states what WILL happen rather than reporting a dead end —
     * free text is a legitimate path here, it just has no gold answer behind it.
     */
    empty: 'No staged question matches that. What you have typed will be rendered as a free question.',

    /**
     * THE LAST ROW, ALWAYS PRESENT. The escape hatch from the short list into
     * the whole index, carrying whatever has been typed with it.
     *
     * It is a row rather than a second button because it is the continuation of
     * the list the user is already reading: five questions, then everything
     * else.
     */
    everything: {
      label: 'Search everything',
      title:
        'Open command search over the whole bake, carrying what you have typed. Names and aliases on the map, the keyboard map, and the three detail levels.',
    } satisfies ActionCopy,

    /** The second line on that row: what "everything" is, named rather than implied. */
    everythingSub: 'Names on the map · commands · detail levels',
  },
} as const;
