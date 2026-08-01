/**
 * =============================================================================
 * COPY BLOCK — THE FIVE INTENT VIEWS
 * =============================================================================
 *
 * The words for the answer body, once it stopped being one layout for five
 * different questions.
 *
 * WHAT WAS ON SCREEN BEFORE. Every intent rendered the same three things in the
 * same order: the answer sentence, a flat list of hops, a confidence gauge. So
 * the Timeline answer arrived as one paragraph opening on the engine's own gold
 * string — `2019-03-04 -> 2020-01-11 -> 2021-06-02 -> 2022-09-14` — a chronology
 * rendered as arrow notation inside a sentence, with the four sessions it names
 * appearing nowhere as four things. And the Compare answer read `Bruntorp
 * Facility and Kvarnhult Terminal are both regulated by the Nordbridge
 * Instrument`, then listed the two hops that had just said so. A comparison that
 * states what two subjects share and nothing else is not a comparison; it is one
 * fact, written twice.
 *
 * -----------------------------------------------------------------------------
 * THE DISCLOSURE LINE IS THE PRICE OF DERIVING THE STRUCTURE IN THE INTERFACE
 * -----------------------------------------------------------------------------
 * These layouts are composed by the UI from what the engine returned — the path,
 * the citations, the node payloads — and NOT from a structured per-intent payload
 * the engine emits. That is a deliberate decision for a demo whose whole subject
 * is the architecture under the hood, and it obliges the interface to say so.
 *
 * So every view carries one quiet sentence naming exactly what the engine
 * returned and exactly what this interface did with it. It is a sentence, not a
 * banner: a disclosure loud enough to be a warning would be theatre, and a
 * disclosure absent altogether would make these views the one thing this product
 * treats as worse than no presentation at all — an arrangement that cannot be
 * traced back to the thing it is arranging.
 *
 * -----------------------------------------------------------------------------
 * `UNKNOWN` IS A FIRST-CLASS VERDICT, AND THAT IS WHY THE TABLE HAS THREE
 * -----------------------------------------------------------------------------
 * A two-column comparison forces every row to be filled, and a row that must be
 * filled gets filled — with an inference, a default, or a plausible blank. The
 * third verdict is what makes the table safe to derive: where the engine returned
 * no value for a facet on one of the two subjects, the row says `Unknown` and
 * says which side is missing. Nothing in these views is allowed to originate
 * here; every cell traces to a PathStep, a Citation, or a field on a GraphNode.
 * =============================================================================
 */

import type { ActionCopy, RowCopy, TermCopy } from '@/copy/types';

export const intents = {
  /* ===========================================================================
   * WHAT EACH VIEW IS CALLED
   * -----------------------------------------------------------------------------
   * Named by SHAPE, not by intent: `Side by side` rather than `Compare view`. The
   * intent is already stated in the panel header, and a marker that repeats it
   * spends a line telling the reader what they were just told.
   * ======================================================================== */
  titles: {
    lookup: 'The claim',
    bridge: 'The route',
    compare: 'Side by side',
    timeline: 'In order',
    summarize: 'Findings by theme',
  },

  /**
   * THE DISCLOSURE LINE. One sentence per intent — see the header.
   *
   * Each one names the engine's half first and this interface's half second, in
   * that order, because the order is the claim: the substance came from the
   * render, the arrangement came from here.
   */
  derived: {
    lookup:
      'The engine returned one hop and the passages that evidence it. This view states that hop as a sentence and links its sources; it adds nothing to either.',
    bridge:
      'The engine returned the hops and the entity they route through. Linking them end to end is this interface reading the trace — where they do not link, it says so rather than inventing a route.',
    compare:
      'The engine returned two claims sharing one object. Every cell below is a field the engine returned for one of the two subjects; where it returned none, the cell reads Unknown rather than filling itself in.',
    timeline:
      'The engine returned the sessions and the structural fiber that orders them. The cards follow that fiber rather than a sort applied here, and what changed is this interface differencing the entity sets the engine extracted for each session.',
    summarize:
      'The engine returned the claims and the class it filed each one under. The groups below are those classes; this view sorted and counted them, and named nothing the engine did not.',
  },

  /** The tooltip on every disclosure line. One sentence, shared, so it cannot drift. */
  derivedTip:
    'This is a visual demo of how the architecture works under the hood. The answer and the path are the engine’s; the arrangement on this surface is this interface’s reading of them, and this line is where it says which is which.',

  /* ===========================================================================
   * SHARED VOCABULARY
   * ======================================================================== */

  /**
   * THE EVIDENCE CONTROL, SAID ONCE.
   *
   * IT COUNTS WHAT THE RECEIPT CONTAINS, AND THE LABEL SAYS SO. It used to
   * print `max(citations for this hop, evidence_passage_ids.length)` — measured
   * live on the staged bridge question, the `operates` hop attaches three
   * passage ids and the receipt admits two of them, so the chip read `3` and the
   * tab it navigates to listed `2`. A count that overstates its own destination,
   * under a label naming a quantity it is not, is the control lying about what
   * it counts — on the one surface whose entire subject is auditability.
   */
  evidence: {
    label: 'Evidence',
    title: 'The citations this receipt contains for this hop. Opens the evidence trail, where every one of them is listed under the hop it supports. Stays on this result.',
  } satisfies ActionCopy,

  /** The receipt has not landed yet, so there is no count to state. An em dash, never a zero. */
  evidencePending:
    'The receipt for this render has not arrived yet, so there is no citation count to state. The evidence trail is still one press away.',

  /**
   * THE OTHER HALF OF THE COUNT, AS ITS OWN FIGURE UNDER ITS OWN LABEL.
   *
   * A hop carries passage ids the render's citation cap and token budget stop
   * before admitting. That is a real and interesting fact — the graph is thicker
   * than the receipt — and the honest way to say it is a second figure, never by
   * adding it to the first.
   */
  unadmitted: {
    label: 'not admitted',
    tip: 'Passages this hop is evidenced by that the receipt did NOT admit — the render’s citation cap and token budget stop before all of them. They are evidence the edge carries; they are not evidence this answer was rendered from, so they are counted separately and never added to the citation count.',
  } satisfies RowCopy,

  /** A hop the engine returned with nothing to cite. Stated, never hidden. */
  noEvidence: 'No evidence passage — this claim cannot be cited.',

  /**
   * WHAT A DISPUTE MEANS ONE LEVEL DOWN.
   *
   * The panel above withdraws the composite and stops the by-construction row
   * vouching. Until this line existed the fovea tier was BYTE-IDENTICAL either
   * way: the route, the evidence chips, the citation counts and the table
   * verdicts all kept vouching at full luminance over a result the product had
   * just proved two of its own surfaces disagree about. A layout that looks the
   * same whether or not its premise held is the defect this whole surface exists
   * to remove.
   */
  disputed: {
    label:
      'This result is disputed — the panel above names by what. The hops, the counts and the cells below are still what this render returned, and none of them is a verification of it.',
    tip: 'The arrangement is unchanged, because the render did return these hops and these citations. What is withdrawn is the vouching: the route rail, the source rules and every Same verdict are set back to ink until the dispute is resolved by re-rendering clean or by discarding the result.',
  } satisfies RowCopy,

  /* ===========================================================================
   * LOOKUP — one hop, one citation
   * ======================================================================== */
  lookup: {
    /**
     * The floor case, and the one where a layout can most easily overreach: a
     * single hop wants to be presented as a paragraph, and a paragraph around one
     * fact is padding with a source attached.
     */
    /**
     * KEPT AS A LABELLED ROW BECAUSE THE NON-VISUAL TWIN NEEDS THE LABEL.
     * The visible view spends only the tip — the quote sits under the claim it
     * belongs to, so a caption above it would name what the layout already says.
     * `TerrainOutline` has no layout: it states the label as text before the
     * blockquote, which is the only way that reader gets the same fact.
     */
    quote: {
      label: 'The passage it rests on',
      tip: 'The first citation the render admitted for this hop, at the resolution the receipt declares. Every other source for it is one press away in the evidence trail.',
    } satisfies RowCopy,
    /**
     * Free-text questions land on this intent too, and they are answered from a
     * handful of edges incident to one entity rather than from a single hop. That
     * is a real difference in what the render returned, so it is stated rather
     * than smoothed over by a layout that looks the same either way.
     */
    several:
      'This render returned more than one hop. Nothing in the trace links them into a route, so they are stated as separate claims about the same subject.',
  },

  /* ===========================================================================
   * BRIDGE — the hop chain
   * ======================================================================== */
  bridge: {
    /** The mark on the node the route could not exist without. */
    mark: 'bridge',
    markTip:
      'Mentioned in assets on both islands. Remove this entity and there is no route between the two sides of this answer.',
    strait: 'crosses a strait',
    straitTip:
      'This hop leaves one island for another. It is only possible because the entity above it is mentioned on both.',
    /**
     * THE HONEST FAILURE OF THE CHAIN LAYOUT.
     *
     * A fork and a collider have the same degree signature as a chain, and a
     * free-text question routed through one bridge entity returns a star rather
     * than a route. Drawing any of those three as `A → B → C` would be this view
     * asserting a traversal order the engine never returned.
     */
    unordered:
      'These hops do not link end to end, so they are shown in the order the render assembled them rather than as a route. That is a fact about the answer, not a failure of it.',
  },

  /* ===========================================================================
   * COMPARE — the three-verdict table
   * ======================================================================== */
  compare: {
    /**
     * THE THREE VERDICTS. `Unknown` is not a degraded `Different` — it is the
     * verdict that stops the other two from being invented. See the header.
     */
    verdicts: {
      same: {
        label: 'Same',
        short: 'Both subjects carry this value, and it is the same value.',
        long:
          'The engine returned a value for this facet on both subjects and the two are identical. Identical here means byte-identical in the payload, not judged equivalent by this view.',
      } satisfies TermCopy,
      different: {
        label: 'Different',
        short: 'Both subjects carry this value, and the two do not match.',
        long:
          'The engine returned a value for this facet on both subjects and they differ. What the difference MEANS is not asserted — only that the two payloads are not the same.',
      } satisfies TermCopy,
      unknown: {
        label: 'Unknown',
        short: 'This render did not return the value on at least one side.',
        long:
          'Either the engine returned no value for this facet on one of the two subjects, or it returned none on both. It is not a claim that the two are alike, and it is not a claim that they are not — it is this view refusing to fill a cell it was not given.',
      } satisfies TermCopy,
    },

    subjects: {
      label: 'The two subjects',
      tip: 'The two endpoints the render’s claims fork from. They are the engine’s own nodes; press either name to read it.',
    } satisfies RowCopy,

    /** Every row of the table. Each one names the engine field it reads. */
    facets: {
      /**
       * THE FORK ITSELF — THE NODE, STATED ONCE, ABOVE THE TABLE.
       *
       * `What they share` used to name TWO quantities on one screen forty pixels
       * apart: the shared NODE here, and the row holding the two RELATION
       * FAMILIES below. One label over two quantities is the compound-label
       * failure the project's vocabulary rule exists to prevent, and it made the
       * second occurrence read as a duplicate of the first. This key keeps the
       * node — which is what it names on the non-visual twin too — and the row
       * got `reaches`, its own label, below.
       */
      shared: {
        label: 'What they share',
        tip: 'The object both claims point at. It is the fork itself — the reason these two subjects are on one screen at all — so it is stated once, above the rows, rather than inside one of them.',
      } satisfies RowCopy,
      reaches: {
        label: 'How each one reaches it',
        tip: 'The relation family each subject used to get to the shared object. Two cells, two different hops: this row is Same when the render walked the same family from both sides and Different when it did not.',
      } satisfies RowCopy,
      kind: {
        label: 'What it is',
        tip: 'The node kind the engine assigned: entity, asset, island, passage. Not an interpretation — the discriminant on the payload.',
      } satisfies RowCopy,
      type: {
        label: 'Type',
        tip: 'The entity type for an entity, the declared boundary kind for an asset. Blank on any node kind that carries neither — and Unknown whenever the two subjects are different kinds, because an entity type and a boundary kind are two different fields and a verdict over them would be one label ruling on two quantities.',
      } satisfies RowCopy,
      clusters: {
        label: 'Clusters it appears in',
        tip: 'How many islands contain at least one asset mentioning this entity. More than one means it spans a strait.',
      } satisfies RowCopy,
      strait: {
        label: 'Spans a strait',
        tip: 'True when the entity is mentioned on more than one island. Derived by the engine and carried on the payload, not recomputed here.',
      } satisfies RowCopy,
      mentions: {
        label: 'Passages mentioning it',
        tip: 'The count of passages the extractor placed a mention in. It is the evidence for the entity existing at all.',
      } satisfies RowCopy,
      degree: {
        label: 'Relations on it',
        tip: 'Raw edge count in both directions, structural edges included. Every node the payload resolved carries it; a subject whose payload did not resolve reads not returned, and the Unknown count in the header rises by one when that happens.',
      } satisfies RowCopy,
      evidence: {
        label: 'Sources for its claim',
        tip: 'Citations the receipt contains for this subject’s own hop — what the render admitted, not what the edge attaches. A fork with one source on one side and three on the other is a real asymmetry and this row is where it shows.',
      } satisfies RowCopy,
      /**
       * THE ROW THAT USED TO WRITE ONE FACT INTO TWO COLUMNS.
       *
       * It read the single edge joining the two subjects, put the SAME string in
       * both cells and hardcoded the verdict `same` — trivially true, because
       * they were the same value, not because two subjects were compared. It is
       * read per column and per direction now: an edge A→B is a fact about A,
       * and the edge B→A, if the render walked one, is a different fact.
       */
      direct: {
        label: 'Its relation to the other',
        tip: 'The edge this render walked FROM this subject TO the other one, in the direction it walked it. A direction it did not walk reads not returned — an edge this render did not walk is not an edge the corpus does not hold, and this view will not say otherwise.',
      } satisfies RowCopy,
      summary: {
        label: 'How the record describes it',
        tip: 'The engine-generated one-line gloss on each node. It is not verbatim source text and may never be cited.',
      } satisfies RowCopy,
    },

    /**
     * A FORK IS NOT ALWAYS TWO-PRONGED, AND THE TABLE IS ALWAYS TWO COLUMNS.
     *
     * Three or more subjects reaching one object is the same shape with more
     * branches. Setting the first two side by side and saying nothing about the
     * rest is silent truncation of the input — the reader cannot tell a
     * two-subject fork from a five-subject one — so the count of what is not on
     * screen is stated.
     */
    more: {
      label: 'Subjects not shown',
      tip: 'More than two of this render’s claims fork from one object. The table sets two subjects side by side, so the rest are counted here rather than dropped; every hop for all of them is in the evidence trail.',
    } satisfies RowCopy,

    /** Where no shared object exists, there is nothing to lay side by side. */
    noFork:
      'This render returned no object that two claims share, so there is nothing to put side by side. The hops are stated as claims instead.',
    /** The value cell when the engine returned nothing for that side. */
    absent: 'not returned',
    /** Boolean facets, rendered as words rather than as ticks. */
    yes: 'Yes',
    no: 'No',
  },

  /* ===========================================================================
   * TIMELINE — chronological cards, and what changed between them
   * ======================================================================== */
  timeline: {
    order: {
      label: 'Ordered by',
      tip: 'The structural session fiber the engine returned, in its own token, read off the links this view actually walked. NOT a date sort applied here: the two agree on this corpus, and if they ever disagreed the fiber is the half that is engine-backed.',
    } satisfies RowCopy,
    /**
     * THE UNIT ON THE HEADER FIGURE.
     *
     * The header docked a bare `4` beside `IN ORDER` — sessions, days or hops,
     * the reader had to guess. `COPY.common.units` has no entry for this one, so
     * it is authored here beside the view that spends it, the same way
     * `summarize.claims` is.
     */
    sessions: 'sessions',
    /**
     * The visible card spends only the tip — the date is the thing the card is
     * organised around and it needs no caption above it. `TerrainOutline` states
     * the label as text, because a mono span in a sentence is not a column.
     */
    when: {
      label: 'Declared',
      tip: 'The boundary the asset itself declares — when somebody said “this is one thing”. Not the ingest time.',
    } satisfies RowCopy,
    changed: {
      label: 'What changed',
      tip: 'Differences between this session and the one before it on the fiber, computed here from fields the engine returned: the gap between the two declared boundaries, and the entity sets the extractor produced for each.',
    } satisfies RowCopy,
    gap: {
      label: 'After the previous session',
      tip: 'Whole days between the two declared boundaries. Arithmetic on two engine timestamps — nothing else.',
      unit: 'd',
    } satisfies RowCopy,
    fresh: {
      label: 'First named here',
      tip: 'Entities the extractor found in this session that no earlier session on this fiber named. It is the closest thing to “what is new” that the payload actually supports.',
    } satisfies RowCopy,
    dropped: {
      label: 'Not carried forward',
      tip: 'Entities the previous session named that this one does not. Absence in one session is not a claim that the thing ended — only that this document stopped naming it.',
    } satisfies RowCopy,
    /** The first card. There is nothing behind it to difference against. */
    first: 'The earliest session on this fiber. There is nothing before it in this render to differ from.',
    /** A real finding, not an empty state. */
    nothingNew: 'Every entity in this session was already named by an earlier one on this fiber.',
    /** A node with no declared boundary cannot be placed on the order. */
    undated: 'This node declares no boundary date, so the order cannot place it.',
    /** The intent fired but the render did not return a fiber. */
    noFiber:
      'This render returned no session fiber for the question, so there is no engine-backed order to follow. The hops are stated in the order the render assembled them.',
  },

  /* ===========================================================================
   * SUMMARISE — findings grouped by the engine's own classification
   * ======================================================================== */
  summarize: {
    themes: {
      label: 'Grouped by',
      tip: 'The σ-class the engine filed each claim under — what KIND of claim the edge makes, not what it is about. The grouping is the engine’s own; this view sorted by it and counted.',
    } satisfies RowCopy,
    /**
     * The VALUE of that row. It was the literal string `sigma`, authored inside
     * the component: not an engine token the reader can check against anything
     * on screen, and the least legible form of the name it could have used — the
     * group headings under it read `Factual`, `Episodic`, `Structural`.
     */
    themesValue: 'σ-class',
    subject: {
      label: 'Most claims attach to',
      tip: 'The node appearing in more of this render’s hops than any other. A count, not a judgement about importance.',
    } satisfies RowCopy,
    omitted: {
      label: 'Connected, not rendered',
      tip: 'Nodes the render reached and deliberately did not spend budget on. For a breadth question this is the interesting figure: the answer is as much what was left out as what was said, and the receipt lists every one of them with the reason.',
    } satisfies RowCopy,
    /* Both forms, because the screen-reader twin reads this ALOUD and a plural
       over a singular is not a typo you skim past — it is a word the reader
       hears. The visible view happens never to render a group of one; the twin
       does, and did, as `1 claims`. */
    claim: 'claim',
    claims: 'claims',
    /** A breadth question that returned no traversed claim. */
    empty:
      'This render admitted context but traversed no claim, so there is nothing to group. The evidence trail still lists everything the budget was spent on.',
  },

  /* ===========================================================================
   * THE ANSWER TAB'S OWN NEW STRINGS
   * -----------------------------------------------------------------------------
   * Not per-intent, but authored in the same pass and for the same surface, so
   * they live in the same block rather than in a second place that has to be kept
   * in step with this one.
   * ======================================================================== */
  answerTab: {
    /**
     * THE DECOMPOSITION IS FOLDED NOW, AND THE FOLD HAS TO EARN IT.
     *
     * The deck's older note argues the four signals belong beside the gauge
     * rather than behind a click. That argument was right about the STAKE and
     * wrong about the cost: on the rebuilt rail the four tracks sat between the
     * answer and the route, so every reader paid for a decomposition most of them
     * had not asked for, on every result. Folded is not hidden — the summary names
     * the case worth opening it for, and it is one press.
     */
    decomposition: {
      label: 'Show what the composite is made of',
      title: 'The four measured signals L is weighted from. A high L over a thin composite is the case this fold exists for.',
    } satisfies ActionCopy,
    decompositionNote:
      'Four signals, one shared 0..1 track. Read down the column: a composite carried by one strong signal and three thin ones is a different claim from a composite that is evenly thick.',

    /**
     * WITHDRAWN, NOT ZEROED. An em dash is a statement that no figure can be
     * sourced; a `0.00` is a measurement, and it would be a false one.
     */
    withheldTip:
      'The composite is the engine’s claim about its own render. This result is disputed, so there is no figure here that can be attributed to it — an em dash is the only honest reading, and a zero would be a measurement nobody took.',

    /**
     * A SIXTH INTENT ARRIVING OVER THE WIRE.
     *
     * The view switch is exhaustive so a sixth member of the union fails to
     * compile — but `intent` is a wire field and `checkProvenance` does not
     * validate it, so a value outside the union is reachable at run time.
     * Returning nothing there throws `Nothing was returned from render` and
     * takes the entire Answer tab with it, including the failure banner that
     * would have explained why. This is what it says instead.
     */
    unmodelledIntent:
      'This render declares an intent this build has no layout for, so nothing is arranged below. Laying it out as one of the five would be this interface guessing which kind of answer it is. The engine’s own token:',

    /**
     * The by-construction row stops vouching on a re-derivation disagreement, and
     * this is what it says instead. It is a different sentence from the tamper
     * one because it is a different failure: nothing was edited — two surfaces of
     * the engine disagree about the same two nodes.
     */
    disputedByPath:
      'An independent re-traversal contradicts this receipt. The by-construction check was scored before that was known, so it is no longer a verdict.',
  },
} as const;
