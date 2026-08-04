/**
 * =============================================================================
 * COPY BLOCK — NAVIGATION: the breadcrumb, the level selector, the rung ledger
 * =============================================================================
 *
 * The words for the half of the descent that reported SCALE and gave no
 * ORIENTATION.
 *
 * -----------------------------------------------------------------------------
 * WHAT WAS THERE BEFORE, MEASURED
 * -----------------------------------------------------------------------------
 * The breadcrumb — the only surface in the product that says where on the spine
 * you are standing — was `display: none` below 1500px. Orientation was withdrawn
 * at exactly the widths where orientation is hardest, and the only remaining way
 * up the spine was a keyboard shortcut nobody had been shown. Its clickable
 * `World` root was painted `--ink-faint`: 3.25:1 against the top bar's own
 * ground (--panel-bg, compositing to rgb 15.04 18.76 26.92), which clears the
 * 3:1 floor for decoration and misses the 4.5:1 floor for text — and a button's
 * label is text. It is on --ink-dim now, 6.07:1 on the same ground.
 *
 * THE FIGURE THIS PARAGRAPH USED TO CITE WAS 2.70:1 AND IT WAS SUPERSEDED
 * BEFORE THIS FILE EXISTED. design-tokens.css §2 had already raised --ink-faint
 * from 2.87 / 2.70 / 2.54 to 3.40 / 3.19 / 3.01 against void / surface /
 * surface-2, so the button was at ~3.2:1 when this change reached it, not at
 * 2.70:1. Contrast is the one class of number this repo computes mechanically
 * (check-discipline §11); a superseded one written into permanent prose is how
 * the next reader re-derives a baseline the token file no longer holds.
 *
 * The ledger under it reported `20 of 521` at the asset rung and `20 of 2,207`
 * at the passage rung — an honest cap over a census nobody could act on. The
 * rows were `<li>`s with no `onClick`, no key handler and no filter above them,
 * so the 501st asset was not merely uncaptioned: it was UNREACHABLE. A rail that
 * names 2,207 things and offers twenty is not a navigator, it is a sample.
 *
 * -----------------------------------------------------------------------------
 * THE DUAL-LAYER RULE, APPLIED TO THE SPINE'S OWN VOCABULARY
 * -----------------------------------------------------------------------------
 * Three rungs called continent / island / asset, a control called
 * `Rung`, a panel called `The spine` and a term called `LOD` — four names for
 * one idea, none of which a first-time reader owns. Per the deck's dual-layer
 * rule the plain name LEADS and the technical term FOLLOWS, so every surface in
 * this block renders `COPY.vocabulary.lod` — `Detail level · LOD` — through the
 * deck's own `dual()` / `plain()` joiner rather than restating either half here.
 * The same applies to `COPY.vocabulary.strait`.
 *
 * ONE STRING IN THIS FILE IS A SECOND RENDERING OF A VOCABULARY PAIR AND IT IS
 * `straits.counted`. The canonical pair is singular (`Cross-cluster connection ·
 * Strait`) and the island ledger prints it beside a figure, where the counted
 * form is the only correct one — the ledger's own header has been arguing that
 * `6 strait` is a defect since it was written. The technical half of the counted
 * form already exists as `COPY.rungs.strait.plural`; this supplies the plain
 * half and nothing else. `IslandRow` in ui/atlas/RungLedger.tsx joins the two
 * with `dual()`'s own interpunct for the hover. If `COPY.vocabulary.strait.plain`
 * is ever re-worded, this is the one place that has to be re-worded with it.
 *
 * THAT JOIN WAS ASSERTED HERE BEFORE IT EXISTED. The row called `dual('strait')`
 * for its title, which renders the SINGULAR pair — so the label read
 * `Cross-cluster connections` and the tooltip answered `Cross-cluster connection
 * · Strait`, and `COPY.rungs.strait.plural` was referenced by no component in
 * src/ at all. This block's whole job is to be the one place a reviewer checks
 * the wording; prose here describing behaviour the code does not have is the
 * worst place in the repo for it, and the invariant above was guarding a string
 * nothing rendered.
 *
 * Types come from `../types`; nothing here imports a component.
 * =============================================================================
 */

import type { ActionCopy, RowCopy } from '@/copy/types';

export const navigation = {
  /* ===========================================================================
   * 1. THE BREADCRUMB, INCLUDING ITS NARROW FORM
   * ======================================================================== */
  breadcrumb: {
    /**
     * THE COMPACT FORM. Not a smaller breadcrumb — a DIFFERENT ONE.
     *
     * Below 1500px the route's ancestors are dropped and what survives is the
     * three facts a lost reader actually needs: which level they are reading,
     * what they are inside, and the way out of it. Everything the compact form
     * drops is still reachable through the level selector beside it, which is
     * why dropping it is a narrowing rather than a removal.
     */
    compact: {
      label: 'Where you are',
      tip: 'The narrow form of the descent: the level you are reading, the thing you are inside, and the way up. The full route returns when there is width for it.',
    } satisfies RowCopy,
    /** The scope crumb's own caption, when the compact form has no room for a route. */
    inside: {
      label: 'Inside',
      tip: 'The body the current level is scoped to. Everything listed below is contained by it.',
    } satisfies RowCopy,
    /** What the compact form says when nothing scopes the level: the whole world. */
    unscoped: 'the whole map',
  },

  /* ===========================================================================
   * 1b. THE TILING CONTROL — what replaces "one level further down"
   * ========================================================================
   * This control exists because the descent STOPS at the document. Below an
   * asset there is no finer level, because the asset is the last boundary
   * somebody actually drew; there are two ways of COVERING the same surface,
   * and this is how you choose between them. The wording avoids "level",
   * "deeper" and "zoom" for that reason — every one of them would re-teach the
   * ladder this control exists to end.
   */
  /**
   * THE GROUND, on the altimeter. Two states, and the difference between them is
   * the difference between "the ladder ends here" and "you are standing on it".
   * Neither says "level" or "deeper": the whole point of the mark is that the
   * thing below the last rung is not another rung.
   */
  ground: {
    below: 'the floor — no rung below this',
    on: 'standing on the floor',
  },

  tiling: {
    label: 'How this document is covered',
    tip: 'Two ways of covering the same document. Not two levels — the same bytes, read two ways.',
    reading: {
      label: 'Reading order',
      /* THIS SENTENCE USED TO END "Every byte belongs to exactly one span," and
         that was FALSE in this corpus — checked at the generator, not assumed.
         `world.ts` starts the first span at `header.length` and advances the
         cursor by `end + 2` for the `\n\n` between spans, so the source header
         and every separator belong to no span at all. No span may overlap
         another, which is the property that actually matters here; total
         coverage is not one the data has. The gaps are already visible on the
         axis as the space between marks — the words were the only thing lying. */
      long: 'The document as written: its spans, in the order they were written, at their true character offsets inside the declared boundary. No two spans overlap, and the space between the marks is the space between them in the source.',
    },
    graph: {
      label: 'Graph',
      long: 'The document as understood: the entities it mentions and the relations between them. This covering overlaps and it leaves gaps — not every span mentions something, and one entity is mentioned in many.',
    },
  },

  /* ===========================================================================
   * 2. THE LEVEL SELECTOR — four mutually exclusive stops, not four switches
   * -----------------------------------------------------------------------------
   * It was four independent `<button>`s in one list. Four buttons is four
   * things you may press; four RADIOS is one thing with four positions, which
   * is what the spine actually is — you are on exactly one rung the way you are
   * in exactly one lens. Screen readers were being told the wrong model, and so
   * was everyone else.
   * ======================================================================== */
  levels: {
    /** The group's accessible name. Rendered through `dual('lod')`, never restated. */
    tip: 'The three levels of the containment spine. Changing level is not magnification: at each one the map is made of different objects. The spine stops at the document, because that is the last boundary somebody actually drew.',
    /**
     * THE SCOPE PROMISE, IN ONE SENTENCE.
     *
     * A stop used to jump to the WHOLE rung: pressing `Assets` from inside one
     * island threw away the island and drew all 521 assets in the corpus. The
     * stop now descends into whatever the reader is already holding — the
     * selection, then the breadcrumb scope, then the answer's own place — and
     * only shows the whole level when there is genuinely nothing to keep.
     */
    scoped: 'Keeps what you are holding: this level, inside your current scope.',
    whole: 'Nothing scopes this level yet, so it shows all of it.',
    /** The stop for a level with no scope available above it. */
    root: 'The top of the spine. There is nothing above it to be inside of.',
  },

  /* ===========================================================================
   * 3. THE RUNG LEDGER
   * ======================================================================== */
  ledger: {
    /** Over the rows: what the list is a list OF, said before the figures. */
    scope: {
      label: 'Listing',
      tip: 'What this register covers. It is the current level inside the current scope — never the whole level, unless the whole level is what you are standing in.',
    } satisfies RowCopy,

    /**
     * THE FILTER. The half that made the cap honest instead of merely stated.
     *
     * `20 of 2,207` was a true sentence and an unusable one: the 501st asset
     * had no route to the screen at all. Filtering runs over every body at the
     * level, not over the twenty on show, so a name outside the cap is one
     * substring away rather than unreachable.
     */
    filter: {
      label: 'Filter this level by name',
      placeholder: 'Filter by name',
      tip: 'Matches on the name of every body at this level — all of them, not the ones currently listed. This is how a body past the row cap is reached.',
    },
    /** The count line beside the filter. `<Num>` supplies every figure. */
    matching: 'matching',
    /** Said once, under the rows, when the cap actually binds. Never silent. */
    capped:
      'The register stops here. Filter by name to bring a body past this point onto the screen — every name at this level is searched, not only the ones listed.',
    /** No body matches the filter. A fact about the filter, not a failure. */
    noMatch: 'No name at this level contains that. Clear the filter to see the register again.',
    clear: { label: 'Clear', title: 'Empty the filter and list this level again' } satisfies ActionCopy,

    /* ---- what a row DOES ------------------------------------------------ */
    /**
     * TWO VERBS, NAMED SEPARATELY.
     *
     * `Where is this` and `what is inside it` are different questions, and a row
     * that answered both with one undifferentiated click would be the same
     * conflation the evidence trail's `Evidence 3` control was split to end.
     * The row holds; the trailing control enters.
     */
    select: { label: 'Hold', title: 'Hold this body and read it. The level does not change.' } satisfies ActionCopy,
    descend: { label: 'Enter', title: 'Descend into this body. The next level down, scoped to it.' } satisfies ActionCopy,
    /** The row that is already held. Said, not merely painted. */
    held: 'held',
  },

  /* ===========================================================================
   * 4. THE COUNTED FORM OF ONE VOCABULARY PAIR — see the header note
   * ======================================================================== */
  /**
   * WHAT THE ISLAND LEDGER'S THIRD FIGURE ACTUALLY COUNTS.
   *
   * It counts `bridge_entity_ids` — ENTITIES this island shares with another —
   * and it was labelled `Cross-cluster connections · Straits`, which names the
   * RELATIONS. The two are not the same quantity and the difference is the
   * interesting part: a bridge entity is the thing a strait crosses TO, so one
   * entity can carry several straits and an entity shared by two islands with no
   * admitted relation between them carries none at all. A figure labelled as
   * something it does not count is the defect class this whole pass exists to
   * remove, and it is worse here than most places, because this figure is the
   * one the ledger's own header calls "the interesting figure".
   */
  bridges: {
    label: 'Shared entities',
    tip: 'Entities this cluster names that another cluster also names. They are what a cross-cluster connection crosses to — one shared entity can carry several connections, or none, so this is not a count of connections.',
  },

  straits: {
    /**
     * The plain half of `COPY.vocabulary.strait`, pluralised for the island
     * ledger. The technical half of the counted form is
     * `COPY.rungs.strait.plural`, and `IslandRow` joins the two for the hover —
     * see the header note for the period in which it did not.
     */
    counted: 'Cross-cluster connections',
  },

  /* ===========================================================================
   * 5. WHERE THE REVERSE ACTIONS LIVE
   * -----------------------------------------------------------------------------
   * Atlas Mode used to carry its own `Ascend` beside the navigation row's `Up`:
   * one move, two names, forty pixels apart, with different tooltips. The panel
   * no longer offers a second copy of a control it does not own — it points at
   * the one that does.
   * ======================================================================== */
  reverse: {
    note: 'Up, Back, Back to result and Home are in the navigation row at the top of this column.',
  },

  /* ===========================================================================
   * 6. THE GUIDED DESCENT'S OWN STOP
   * -----------------------------------------------------------------------------
   * Removing `Ascend` left the guided run with no named way out except closing
   * the panel, and "close the thing to stop the thing" is a consequence nobody
   * should have to discover. `Stop` is not a second copy of a navigation
   * control — it ends a narration and moves nothing.
   * ======================================================================== */
  tour: {
    stop: {
      label: 'Stop',
      title: 'End the guided descent here. The camera stays where it is.',
    } satisfies ActionCopy,
  },
} as const;
