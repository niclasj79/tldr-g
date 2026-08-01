/**
 * =============================================================================
 * COPY BLOCK — THE ASSISTIVE-TECHNOLOGY TWIN
 * =============================================================================
 *
 * The words for the half of the product that had none.
 *
 * -----------------------------------------------------------------------------
 * WHAT WAS THERE BEFORE, MEASURED
 * -----------------------------------------------------------------------------
 * The terrain declared `role="application"` and `tabIndex={0}` on ONE div and
 * gave it a STATIC accessible name — the same sentence whether the cursor was on
 * a continent, on a passage, or on nothing. Arrow keys really did traverse the
 * graph, and they moved a cursor that existed only in world coordinates: there
 * was no DOM element per node, focus never left that one div, and therefore
 * nothing was announced. Not the node, not the level, not the hop.
 *
 * There were ZERO `aria-live` regions in the entire application. The only two
 * implicit ones were the alarm band and the WebGL-failure plate, which means the
 * assistive reading of a render was: silence, then silence, then — if you
 * happened to go looking — an answer that had been sitting there.
 *
 * The richest per-node summary the product produces, the hover card, is
 * `aria-hidden="true"`. That was the correct call and it still is (it is
 * pointer-driven and duplicates the Inspector), but it left the structured
 * reading of a node with no owner at all.
 *
 * And `COPY.a11y.skipToCommand` — 'Skip to the command bar' — had been written,
 * shipped in the deck, and rendered by nothing.
 *
 * -----------------------------------------------------------------------------
 * WHAT WAS STILL WRONG AFTER THE FIRST PASS, ALSO MEASURED
 * -----------------------------------------------------------------------------
 * TWO DEFECTS, AND THE SECOND ONE IS THE BIGGER OF THE TWO.
 *
 * 1. THE LIST RE-RANKED UNDER THE CURSOR. Rows were grouped `Centred on` /
 *    `One relation away` / `Also held` / `Everything else`, and `Also held` is
 *    the store's `selection` — which an arrow key REPLACES on every press. So
 *    ArrowDown ten times from `e:tollstrand-battery` measured as
 *    tollstrand -> bruntorp -> rimsdal -> lysnas -> odsmal -> lysnas -> odsmal
 *    -> … forever: the row the cursor had just left was hoisted into the group
 *    above it and dropped straight back under the cursor. The pivot that was
 *    supposed to prevent this never engaged for a keyboard-only user at all.
 *    The group names below no longer name anything cursor-relative, because the
 *    ORDER is now a pure function of the view and the answer path.
 *
 * 2. FIVE INTENTS, ONE FLAT HOP LIST. The twin rendered `Hop 1: A via family
 *    (class) B` for every question the product can be asked. A sighted reader
 *    got a comparison table with a three-verdict column and an Unknown count, a
 *    chronology carrying the gap in days and the differenced entity sets, and a
 *    σ-class grouping with the omission count docked in its header. A screen
 *    reader got the hop list — the one reading every intent view exists to stop
 *    being the only one.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS BLOCK IS SMALL, AND WHY THAT IS THE POINT
 * -----------------------------------------------------------------------------
 * A twin of the terrain that authors its OWN sentences is a second product with
 * a second voice, and it will disagree with the first one inside a week. So
 * almost everything the outline and the announcer say is BORROWED from the
 * surface they are a twin of, and only the connective tissue lives here:
 *
 *   the four level names         COPY.rungs.levels[rung].label
 *   the six node kinds           COPY.rungs.kinds[kind]
 *   the relation family labels   byFamily[family].label, from the engine
 *   the σ-class names            COPY.sigma.classes[sigma]
 *   the five intent readings     COPY.intentViews.* — every label, verdict,
 *                                facet, note and disclosure the visible views
 *                                use, said in the same words
 *   'Selected'                   COPY.hud.selectionLabel
 *   'Degree'                     COPY.inspector.rows.degree.label
 *   the quarantine rule          COPY.quarantine.never
 *   the re-derivation verdicts   COPY.answer.explain.verdicts[v].short
 *   the signature verdict        verifyCopy(result).title
 *   'Rendering'                  COPY.command.running.label
 *
 * One canon per question. A verdict spoken to a screen reader in different words
 * from the verdict printed on the panel is two surfaces of one product
 * disagreeing about the same claim — which is the exact failure the independent
 * re-derivation exists to catch, reintroduced by the thing reporting it.
 *
 * `COPY.a11y` in the deck is a sibling, not a rival: it owns accessible NAMES for
 * surfaces that are otherwise unnamed. This block owns the twin's own structure.
 *
 * Types come from `../types`; nothing here imports a component.
 * =============================================================================
 */

export const a11y = {
  /* ===========================================================================
   * 1. THE STRUCTURED TWIN
   * ======================================================================== */
  outline: {
    title: 'Terrain outline',
    /**
     * Read once, at the top of the region. It states the SYNCHRONISATION, which
     * is the whole reason this is a twin rather than a description: there is one
     * cursor in this product and both surfaces move it.
     */
    intro:
      'The same terrain as a list. Operating this list moves the real selection on the map, and moving the map moves this list. It is not a description of the terrain — it is the terrain, read out.',

    scope: {
      title: 'Where you are',
      levelLabel: 'Detail level',
      insideLabel: 'Inside',
      wholeWorld: 'The whole world. This level is not scoped to anything.',
    },

    /**
     * THE ANSWER SECTION.
     *
     * Everything under this heading is borrowed from `COPY.intentViews` — the
     * same facet labels, the same three verdicts, the same disclosure sentence
     * the visible view prints. The twin composes them into text; it does not
     * word them. See defect 2 in the header for what it looked like when it did
     * not have them.
     */
    answer: {
      /** `Read as: Compare — Side by side`. The intent, and the shape it takes. */
      readAs: 'Read as',
    },

    list: {
      title: 'Nodes you can move to',
      empty: 'This level has no nodes.',
      /**
       * THE CAP, SAID IN THE ACCESSIBLE NAME.
       *
       * The passage level carries thousands of nodes and a list that long is not
       * a list. So it is cropped — and a silent crop is precisely the failure the
       * receipt's own `omitted_but_connected` block exists to prevent, so the
       * crop is stated where the name is read, between the two figures it sits
       * on top of.
       */
      capped:
        'The rest of this level is not listed. What is listed is ranked by the engine’s own centrality, so what is missing is what the layout considers least load-bearing — and what you are holding is never cropped.',
      /**
       * THE ORDER, STATED, BECAUSE THE ORDER USED TO MOVE.
       *
       * Measured: ArrowDown ten times used to walk four rows and then bounce
       * between two forever, because the groups were cursor-relative and the
       * cursor was what the arrow key moved. The order below depends on the
       * view and the answer path and on nothing else, so a reader can walk it
       * in a straight line and count.
       */
      order:
        'The order is fixed: the answer’s own nodes first, in the order the render walked them, then everything else at this level by the engine’s centrality. It does not change as the cursor moves.',
      /**
       * `focus`, `neighbour` and `held` used to be GROUPS, and all three of them
       * were positions relative to the reader — which is what made the list
       * re-rank under the cursor. Two groups remain and both are facts about the
       * graph. Where the cursor is standing is carried by the active descendant,
       * what is held is carried by `aria-selected`, and what is one relation
       * away is said on the row it is true of.
       */
      groups: {
        answer: 'On the answer path',
        level: 'Everything else at this level, by centrality',
      },
      /** On a row the cursor can reach in one relation. `One relation from the cursor, via`. */
      reach: 'One relation from the cursor, via',
      /** On a row on the answer path, before its position. `Hop` comes from COPY.answer.path. */
      hopLabel: 'Position on the path',
    },

    /**
     * WHAT THE KEYS DO, STATED ONCE ON THE CONTAINER rather than on every option.
     * Two hundred options each reciting the same four verbs is how a structured
     * twin becomes slower to operate than the picture it stands in for.
     */
    keys:
      'Up and Down move the cursor and hold what it lands on. Space adds or removes a hold. Enter descends into the node under the cursor, or opens it when there is nothing below it. Escape releases everything. Plus and minus zoom the terrain.',

    /** Rendered ONLY on the option under the cursor — see `keys` above. */
    actions: {
      descend: 'Enter descends into it.',
      open: 'Enter opens the passage and reads it in place.',
      frame: 'Enter frames it. It is not a body of this level, so it cannot be entered.',
    },

    /**
     * THE CARET PLATE — the one part of the list a SIGHTED keyboard user sees.
     *
     * Measured: `.tro__list` is a `tabIndex={0}` listbox with a layout box of
     * 1 x 623px inside a `clip-path: inset(50%)` ancestor, which clips the whole
     * subtree's paint INCLUDING the shared `:focus-visible` ring. Tabbing forward
     * from the skip link landed on it, nothing appeared anywhere on screen, and
     * the next ArrowDown changed the selection on the map with the caret nowhere
     * visible. That is the same trap the skip link is revealed to avoid, one
     * control further along the tab order.
     *
     * It is a focus indicator, not a second list: one line naming the node under
     * the cursor. Revealing the two hundred rows would be the second information
     * architecture this whole file exists to argue against.
     */
    caret: {
      label: 'Terrain outline',
      none: 'No node under the cursor yet. Press Down to start.',
      hint: 'Up and Down move · Space holds · Enter opens · Escape releases',
    },
  },

  /* ===========================================================================
   * 2. THE HELD COUNT — one wording, two surfaces
   * -----------------------------------------------------------------------------
   * The outline prints it and the live region speaks it. Pluralisation is copy's
   * job, not a component's, and it is the same three words in both places because
   * it is the same fact.
   * ======================================================================== */
  heldWords: {
    one: 'node held.',
    many: 'nodes held.',
    none: 'Nothing held.',
  },

  /* ===========================================================================
   * 3. THE INPUT SURFACE'S OWN NAME
   * ======================================================================== */
  surface: {
    /**
     * The accessible name of the terrain WHILE SOMETHING IS UNDER THE CURSOR.
     * `COPY.a11y.terrain` is the resting name and stays the resting name; it
     * teaches the controls, which is the right thing to say once and the wrong
     * thing to repeat on every arrow press. This one names the node instead,
     * because the node is what changed.
     */
    focusedOn: 'Knowledge terrain, on',

    /**
     * THE RUBBER BAND'S CAP.
     *
     * The visible readout prints `40 of 137` and a sighted reader takes the
     * omission from the word `of`. Said aloud, `40 of 137` is two numbers. This
     * is the sentence that makes the cap a fact rather than a pair of figures.
     *
     * IT CARRIES ONE FIGURE, AND IT IS THE ONE NOTHING ELSE CARRIES. It used to
     * print the taken count as well — which is `selectionCount`, the exact
     * figure the live region already speaks as `N nodes held`. A fact with two
     * owners is a fact that gets said twice, and the second saying is the one
     * that makes a reader wonder which number to believe.
     */
    marquee: {
      lead: 'The rubber band caught',
      trail:
        'nodes, which is past the selection cap. The rest were dropped rather than held — the number now held is spoken on its own.',
    },
  },

  /* ===========================================================================
   * 4. THE LIVE REGION
   * -----------------------------------------------------------------------------
   * Five things get spoken and nothing else does. Hover is not on the list and
   * never will be: a pointer crossing 4,406 nodes would produce 4,406 utterances,
   * which is a denial of service delivered in your own voice.
   *
   * THE FAILURE BANNER IS NO LONGER ONE OF THEM, and that is a deduplication
   * rather than a removal: `DegradedBar` mounts `role="alert"` carrying
   * `COPY.degraded.banner` and the engine's own `what_failed` the instant the
   * store goes DEGRADED. Writing the same two sentences into the assertive
   * region made an integrity failure the one event in the product that gets read
   * out twice, at the moment attention matters most.
   * ======================================================================== */
  announce: {
    /** Follows `COPY.command.running.label` ('Rendering') into the polite region. */
    answerReady: 'Answer ready.',
    /** `{level} level. Scoped to {place}.` — or the unscoped form. */
    scope: {
      level: 'level.',
      scopedTo: 'Scoped to',
      world: 'The whole world.',
    },
  },
} as const;
