/**
 * =============================================================================
 * COPY BLOCK — GUIDANCE: THE HELP DIALOG AND THE TASK TOURS
 * =============================================================================
 *
 * The words for the two surfaces that are supposed to teach the product, and
 * until now taught the thesis instead.
 *
 * -----------------------------------------------------------------------------
 * WHAT THE HELP OVERLAY WAS, MEASURED
 * -----------------------------------------------------------------------------
 * `.help__cols` is `repeat(auto-fit, minmax(280px, 1fr))` inside a 1120px sheet,
 * so at laptop width it resolves to THREE columns of prose set at 12.5px and
 * 11px — under the 13px control floor, and two of the three columns carried
 * their body on --ink-faint, which is the 3:1 decoration step. Underneath that
 * sat the glossary at `columns: 3 300px` over 42 entries: 42 disclosures in
 * three newspaper columns, whose `see` cross-references were rendered as
 * `entry.see.join(' · ')` — plain text naming other entries, with no way to
 * reach any of them. A cross-reference you cannot follow is a dead end that
 * costs a line.
 *
 * None of that is a help surface. It is a reference card, and a reference card
 * is what you read AFTER you know what the five things you can do are.
 *
 * So this block leads with FIVE TASKS — ask, read, open, return, check — in the
 * order a person actually meets them, and every other word in the overlay moves
 * behind a disclosure. The vocabulary is still all 42 entries; it is just no
 * longer the second thing on the screen.
 *
 * -----------------------------------------------------------------------------
 * WHAT THE WALKTHROUGH WAS, MEASURED
 * -----------------------------------------------------------------------------
 * Seven steps — terrain / staged / render / receipt / path / verify / rungs —
 * of which exactly ONE asked the user to do anything. Steps 2, 4 and 7 drove
 * `toggle('inspector')`, `toggle('receipt')` and `toggle('atlas')` and reverted
 * none of them, so pressing Done left three surfaces stacked on a workspace the
 * user had never opened. It taught what the engine believes and never taught how
 * to select a node, open all of the evidence for one hop, come back from a
 * drill-down, or read the map by date.
 *
 * A tour that operates the product FOR you teaches watching. So every step here
 * names a task the reader performs, the card reads whether the real store says
 * it happened, and the "do it for me" control is the fallback rather than the
 * script. The steps that remain are the five moves of the product, plus two
 * three-step tours for the two lenses that are worth a separate pass.
 *
 * -----------------------------------------------------------------------------
 * NAMING A CONTROL THAT IS NOT ON SCREEN, MEASURED
 * -----------------------------------------------------------------------------
 * The key GLYPHS below are single-sourced — they are read from `state/keys` at
 * render time, so a tour can never name a shortcut nobody wired. The button
 * LABELS were not, and the first thing that happened is the thing that always
 * happens: four strings in this block said `Return to result` while the only
 * control matching /result/ in the running DOM reads **Back to result**
 * (`COPY.nav.toResult`, rendered by NavStack). Two folds apart, the keyboard map
 * in the same dialog said "back to the result". A reader following step 4's one
 * imperative hunted for a button that is not there.
 *
 * The labels cannot be single-sourced the way the glyphs are: `deck.ts` imports
 * THIS file to build `COPY`, so importing the deck back would be a cycle and
 * `COPY` would be undefined while this module evaluates. So the rule is a check
 * instead of an import — **every deck label quoted verbatim in this block is
 * asserted against the deck at dev startup** by the guard at the top of
 * `ui/shell/Walkthrough.tsx`. Re-word a control and the console names this file.
 *
 * Types come from `../types`; nothing here imports a component.
 * =============================================================================
 */

import type { ActionCopy } from '@/copy/types';

/** One task in the overlay's opening list. Short enough to be read standing up. */
export interface GuidanceTopic {
  id: string;
  title: string;
  body: string;
}

/**
 * One step of a tour.
 *
 * `task` is the half that did not exist. It is imperative, it names a control
 * the reader can see, and the card checks the real store to find out whether it
 * was done — so `act` is genuinely optional and genuinely a fallback.
 */
export interface GuidanceStep {
  id: string;
  title: string;
  body: string;
  /** What the reader does. Imperative, names a visible control. */
  task: string;
  /** The same thing, performed through the real action, for someone who would rather watch. */
  act?: ActionCopy;
}

export interface GuidanceTour {
  id: string;
  label: string;
  title: string;
  steps: readonly GuidanceStep[];
}

export const guidance = {
  /* ===========================================================================
   * 1. THE HELP DIALOG
   * ======================================================================== */
  /**
   * ===========================================================================
   * THE ORIENTATION CARD — the sequence, stated, before anything is pressed
   * ===========================================================================
   *
   * A test drive was asked "is the sequence obvious?" and answered no. The whole
   * rework arranged the product around one — ask, understand, verify, explore —
   * and never said it out loud, which left a reader to infer a path from the
   * fact that the surfaces happened to be in that order. They do not; they meet
   * three tabs that look like a filing cabinet.
   *
   * THREE LINES, AND EACH ONE NAMES A CONTROL THAT IS ON SCREEN. No step
   * describes something the reader cannot see and press, because a numbered list
   * whose second item is invisible is worse than no list: it teaches that the
   * guidance is decorative.
   */
  orientation: {
    title: 'How this works',
    lede: 'Three moves. The question stays on screen through all of them.',
    steps: [
      {
        id: 'ask',
        title: 'Ask',
        body: 'Pick one of the questions below, or type your own. Nothing has been spent yet — pressing Render is what makes the engine move.',
      },
      {
        id: 'read',
        title: 'Read the answer, and the route',
        body: 'The answer arrives with the chain of hops that carried it, drawn on the map at the same time. Both stay attached to the question.',
      },
      {
        id: 'check',
        title: 'Check it yourself',
        body: 'Every source the answer stands on is listed under the hop it supports, with the signed receipt behind them. You never have to take the answer’s word for it.',
      },
    ],
    walk: {
      label: 'Walk me through it',
      title: 'A five-step guided tour that performs each move on the real engine',
    },
  },

  dialog: {
    /** The panel's section marker. */
    title: 'How to use this',
    /**
     * The dialog's accessible NAME, which is a different job from the marker
     * above: a screen reader announces this on entry, before any of the content,
     * so it has to say what the surface is FOR rather than what it is called.
     */
    label: 'How to use this: five tasks, then the reference material',
    lede: 'Five things to do, in the order you meet them. Everything else — how to read the terrain, why you can check it, what this build does not do, the keyboard, and the vocabulary — is folded underneath.',
  },

  /**
   * THE FIVE TASKS. Ask, read, open, return, check.
   *
   * They are the sequence a person is actually in — ask a question, understand
   * the answer, verify it, explore from it — rather than the sequence the
   * architecture is in. Each one names controls that exist on screen; none of
   * them explains a mechanism.
   */
  topics: [
    {
      id: 'ask',
      title: 'Ask a question',
      body: 'The command bar holds one question at a time, staged and unrun. Nothing on the map has been retrieved until you run it — the engine spends its budget at that moment and not before.',
    },
    {
      id: 'read',
      title: 'Read the answer path',
      body: 'The Answer surface carries the claim, how confident the engine is in it, and every hop it crossed to get there. The same hops are the lit route on the map, so the picture and the prose are one reading rather than two.',
    },
    {
      id: 'open',
      title: 'Open a source',
      body: 'The Evidence trail groups every quote under the hop it supports. Read source opens the verbatim bytes with the hash they were taken over; Locate on map holds the passage on the terrain without taking you anywhere.',
    },
    {
      id: 'return',
      title: 'Find your way back',
      body: 'Every move has a reverse. Back undoes the last one. Back to result aims at the scene the answer was framed in, however deep you went. Home is the whole map with nothing held — the one landmark that can be promised in advance.',
    },
    {
      id: 'check',
      title: 'Check it yourself',
      body: 'The receipt is signed and verification runs locally, so you never ask the party that issued a receipt whether the receipt is good. You can break it on purpose and watch which half fails: the payload or the signature.',
    },
  ] as const satisfies readonly GuidanceTopic[],

  /* ===========================================================================
   * 2. THE GLOSSARY, BEHIND SEARCH
   * ======================================================================== */
  glossary: {
    search: {
      /** A real label, because a search field with only a placeholder has no name once you type in it. */
      label: 'Search the glossary',
      /* NO COUNT IN THE PLACEHOLDER. The list is 42 entries today; a figure typed
         into prose is a figure that goes wrong on the next commit, and the real
         count is rendered next to the field through the mono primitive. */
      placeholder: 'Filter terms',
    },
    /** Between the count and the total. Both figures render through the mono primitive. */
    of: 'of',
    terms: 'terms',
    empty: 'No term matches that. The glossary is the product’s own vocabulary, so a word that is not in it is a word this interface does not use.',
    /**
     * THE CROSS-REFERENCES ARE CONTROLS NOW.
     *
     * They named three or four other entries and did nothing, in a three-column
     * list of 42 — which is the worst possible place to be told to go and find
     * something yourself.
     */
    see: {
      label: 'See also',
      title: 'Open that entry',
    } satisfies ActionCopy,
    /** Announced when a cross-reference clears an active filter to reach its target. */
    jumpedNote: 'The filter was cleared to reach that entry.',
  },

  /* ===========================================================================
   * 3. THE TOURS
   * ======================================================================== */
  tours: {
    /** The card's accessible name. Names the CURRENT tour, not a step count that will rot. */
    regionLabel: 'Guided tour',
    /** Above the task line. One word, so the reader can find the imperative in a glance. */
    taskLabel: 'Your turn',
    /** Replaces the task line once the store says the task actually landed. */
    doneLabel: 'Done',
    /** Offered on the last step of the main tour. */
    prompt: 'Two shorter tours, if you want them:',
    finish: {
      label: 'Finish',
      title: 'Close this and leave the workspace on the result, in Explore, with nothing spurious open',
    } satisfies ActionCopy,

    main: {
      id: 'main',
      label: 'The five moves',
      title: 'Ask, read, open, return, widen',
      steps: [
        {
          id: 'ask',
          title: 'Ask the question that is staged',
          body: 'It sits in the command bar unrun. The engine has not spent a token on it, so everything on the map right now is the corpus at rest rather than a result.',
          task: 'Run it from the command bar.',
          act: {
            label: 'Run it for me',
            title: 'Render the staged question through the same action the button drives',
          } satisfies ActionCopy,
        },
        {
          id: 'read',
          title: 'Read the answer path',
          body: 'The Answer surface carries the claim, its confidence, and every hop the engine crossed. A hop names its relation family and the two nodes it joins, and the same hops are the lit route on the map.',
          task: 'Open the Answer surface.',
          act: {
            label: 'Open Answer',
            title: 'Show the answer surface',
          } satisfies ActionCopy,
        },
        {
          id: 'open',
          title: 'Open one of the sources',
          body: 'Every quote is grouped under the hop it supports and carries the hash of the bytes it was taken over. Reading one is the most displacing move in the product — it changes the level, the scope, the selection and the camera — so it leaves a way back behind it.',
          task: 'Press Read source on any quote.',
          act: {
            label: 'Open the first source',
            title: 'Open the first cited passage, through the same action the row’s own control drives',
          } satisfies ActionCopy,
        },
        {
          id: 'return',
          title: 'Come back to the answer',
          body: 'You are several moves from where the answer was framed and exactly one move from being back there. Back undoes the last move one at a time; Back to result aims at the answer’s own scene however deep you went.',
          task: 'Press Back to result.',
          act: {
            label: 'Back to result',
            title: 'Restore the scene the answer was framed in, through the same action the control drives',
          } satisfies ActionCopy,
        },
        {
          id: 'widen',
          title: 'Then widen it, if you want to',
          body: 'Timeline reads the same map by date and keeps this answer’s scope until you widen it on purpose. The four detail levels change what the map is made OF — continents, islands, documents, passages — rather than how large it is drawn.',
          task: 'Try a lens or a detail level. Or finish here.',
        },
      ],
    } satisfies GuidanceTour,

    timeline: {
      id: 'timeline',
      label: 'Timeline in three steps',
      title: 'The same map, read by date',
      steps: [
        {
          id: 'enter',
          title: 'A lens is a place, not a panel',
          body: 'You are in exactly one lens at a time, the way you are on exactly one detail level at a time. Leaving gives the camera back exactly where it was borrowed from, so a look at the clock never costs you your orientation.',
          task: 'Enter the Timeline lens.',
          act: { label: 'Enter Timeline', title: 'Switch to the timeline lens' } satisfies ActionCopy,
        },
        {
          id: 'scope',
          title: 'It covers this answer, not the archive',
          body: 'Covering starts at This answer, because a lens over a result is a lens over that result until you say otherwise. Whole corpus is the widest scope and the only one the engine samples rather than returns in full — and the axis says so when the sample actually binds.',
          task: 'Read the Covering control. Widen it only when you mean to.',
        },
        {
          id: 'window',
          title: 'Brushing is a preview; applying is a press',
          body: 'Dragging either end of the axis previews a period and changes nothing — nothing is held and the camera does not move. Apply window commits it; Reset window is its reverse.',
          task: 'Drag an end of the axis, then press Apply window.',
          act: {
            label: 'Apply a window for me',
            title: 'Brush the middle half of the axis and commit it, through the real actions',
          } satisfies ActionCopy,
        },
      ],
    } satisfies GuidanceTour,

    analyze: {
      id: 'analyze',
      label: 'Analyze in three steps',
      title: 'Filters and engine internals',
      steps: [
        {
          id: 'enter',
          title: 'The internals have one home now',
          body: 'Filters, edge policy and the engine’s own readouts live together in one lens instead of being scattered through the rail as switches at the same rank as the answer.',
          task: 'Enter the Analyze lens.',
          act: { label: 'Enter Analyze', title: 'Switch to the analyze lens' } satisfies ActionCopy,
        },
        {
          id: 'filters',
          title: 'Restricting the map is a stated act',
          body: 'Turning a relation class or a family off changes what the terrain may stroke, and the readouts say what is being withheld. Rejected claims ship either way — showing them strokes them rather than conjuring them.',
          task: 'Turn one relation class off, then on again.',
        },
        {
          id: 'leave',
          title: 'Leaving hands the map back',
          body: 'Explore is the resting lens and the only one that is a home. Returning to it restores the viewpoint this lens borrowed, which is the same contract Back offers, applied to a move that never looked like one.',
          task: 'Return to Explore, or finish here.',
          act: { label: 'Back to Explore', title: 'Return to the explore lens' } satisfies ActionCopy,
        },
      ],
    } satisfies GuidanceTour,
  },
} as const;
