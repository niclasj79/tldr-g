/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE COMPARE VIEW
 * =============================================================================
 *
 * Two subjects, side by side, one facet per row, and a verdict on every row that
 * is `Same`, `Different` or `Unknown`.
 *
 * -----------------------------------------------------------------------------
 * WHAT THE COMPARE ANSWER USED TO BE
 * -----------------------------------------------------------------------------
 * The staged Compare question renders `Bruntorp Facility and Kvarnhult Terminal
 * are both regulated by the Nordbridge Instrument` — and then the panel below it
 * listed the two hops that had just said exactly that, in the same layout the
 * one-hop lookup and the two-hop bridge answers use. The reader was told twice
 * that the two subjects share a regulator and never told a single thing that
 * distinguishes them. A comparison that only reports the shared term is one fact
 * written twice; the whole reason to put two subjects on one screen is the
 * asymmetry.
 *
 * -----------------------------------------------------------------------------
 * THE FORK IS ALREADY IN THE DATA — THIS VIEW ONLY HAS TO READ IT
 * -----------------------------------------------------------------------------
 * `buildStagedQueries()` constructs this question as TWO EDGES SHARING ONE
 * OBJECT and says so in as many words: "Two subjects joined by one shared object.
 * The constellation should be a fork, not a chain." That shape is exactly a
 * comparison table's skeleton — the shared object IS the `Same` row, and the two
 * subjects are the two columns. Nothing has to be invented to get from one to the
 * other; `findFork()` below is thirty lines of reading `to_id` and `from_id`.
 *
 * -----------------------------------------------------------------------------
 * WHY THERE ARE THREE VERDICTS AND NOT TWO
 * -----------------------------------------------------------------------------
 * A two-column table forces every row to be filled, and a row that must be filled
 * gets filled — with an inference, a default, or a plausible blank that reads as
 * a measurement. `Unknown` is what makes deriving this table in the interface
 * safe: every cell traces to a field on a `GraphNode`, a `PathStep` or a
 * `Citation`, and where the engine returned nothing the row says nothing and
 * names which side is missing.
 *
 * The sharpest row in the table is the one that is `Unknown` on this corpus:
 * `Its relation to the other`. This render walked no edge joining the two
 * subjects — and an edge this render did not walk is not an edge the corpus does
 * not hold. Reporting that as `Different`, or as an empty cell, would be the
 * table asserting an absence it never checked.
 *
 * That row was ALSO the one latent fabrication in the table. It wrote the single
 * joining edge's family into BOTH cells and hardcoded `verdict: 'same'`, so an
 * A–B edge would have printed one fact as two cells and declared them identical
 * — trivially true, because they were the same value, not because two subjects
 * were compared. It reads per column and per direction now: the edge A→B is a
 * fact about A, and B→A, if the render walked one, is a different fact. The
 * staged fork has neither, so it still renders `Unknown` — but for the reason
 * the tip states rather than by a branch nobody could reach.
 *
 * -----------------------------------------------------------------------------
 * THE VERDICT COLOURS ARE THE PRODUCT'S EXISTING MEANINGS, NOT NEW ONES
 * -----------------------------------------------------------------------------
 *   Same       --ok          an agreement that was actually checked
 *   Different  --ink-dim     a real reading, and not a fault: ink, not a light
 *   Unknown    --curiosity   violet already means "the question, and what is not
 *                            known" everywhere else in this product — staged and
 *                            unspent, omitted but connected. An unfilled cell is
 *                            the same idea at table scale.
 * =============================================================================
 */

import { COPY } from '@/copy';
import { byFamily } from '@/engine';
import type { GraphNode, PathStep, RenderTraceV1 } from '@/engine';
import { Num, Tip } from '@/ui/primitives';

import {
  DerivedNote,
  EvidenceChip,
  IntentHead,
  NoEvidence,
  NodeName,
  Relation,
  hopEvidence,
  type IntentViewProps,
} from './BridgeView';

/* =============================================================================
 * 1. FINDING THE FORK
 * ========================================================================== */

export interface Fork {
  /** The object both claims reach. */
  sharedId: string;
  /** The two subjects, and the hop each one used to reach the shared object. */
  left: { id: string; step: PathStep };
  right: { id: string; step: PathStep };
  /**
   * Subjects on this fork that the two columns do not hold.
   *
   * A TABLE THAT DROPS ITS INPUT SILENTLY IS THE SAME CLASS AS A FILLED CELL.
   * A fork with five subjects sharing one object rendered as two columns and
   * said nothing about the other three, so a reader could not tell a two-subject
   * fork from a five-subject one. The count is carried out and stated.
   */
  unshown: number;
}

/**
 * The two claims that share one object, or `null`.
 *
 * BOTH ORIENTATIONS COUNT. A collider (`a → r ← b`) is what the staged question
 * builds — two subjects each `regulated_by` one instrument. A fork (`a ← r → b`)
 * is the same shape read the other way, and a question phrased from the shared
 * node's side produces it. Either is a comparison; only a chain is not.
 */
export function findFork(path: readonly PathStep[]): Fork | null {
  const group = (key: (s: PathStep) => string, other: (s: PathStep) => string): Fork | null => {
    const buckets = new Map<string, PathStep[]>();
    for (const step of path) {
      const list = buckets.get(key(step));
      if (list === undefined) buckets.set(key(step), [step]);
      else list.push(step);
    }
    for (const [sharedId, steps] of buckets) {
      /* DISTINCT SUBJECTS, NOT DISTINCT EDGES. Two edges of different families
         between the same pair of nodes is not a comparison — it is one pair
         described twice, and putting it in two columns would compare a thing
         with itself. */
      const seen = new Map<string, PathStep>();
      for (const step of steps) if (!seen.has(other(step))) seen.set(other(step), step);
      const subjects = [...seen.entries()];
      if (subjects.length < 2) continue;
      return {
        sharedId,
        left: { id: subjects[0][0], step: subjects[0][1] },
        right: { id: subjects[1][0], step: subjects[1][1] },
        unshown: subjects.length - 2,
      };
    }
    return null;
  };

  return (
    group((s) => s.to_id, (s) => s.from_id) ?? group((s) => s.from_id, (s) => s.to_id)
  );
}

/* =============================================================================
 * 2. THE FACETS
 * -----------------------------------------------------------------------------
 * Each reader takes ONE node and returns a value the engine put on it, or `null`.
 * There is no reader in this file that computes, infers or defaults a value: if
 * the payload does not carry it, the answer is `null` and the row says Unknown.
 * ========================================================================== */

export type Value = string | number | null;
export type Verdict = 'same' | 'different' | 'unknown';

function readKind(node: GraphNode | undefined): Value {
  return node === undefined ? null : node.kind;
}

/** Entity type for an entity, declared boundary kind for an asset, nothing else. */
function readType(node: GraphNode | undefined): Value {
  if (node === undefined) return null;
  if (node.kind === 'entity') return node.entity_type;
  if (node.kind === 'asset') return node.boundary_kind;
  return null;
}

function readClusters(node: GraphNode | undefined): Value {
  return node !== undefined && node.kind === 'entity' ? node.island_ids.length : null;
}

function readStrait(node: GraphNode | undefined): Value {
  if (node === undefined || node.kind !== 'entity') return null;
  return node.is_bridge ? COPY.intentViews.compare.yes : COPY.intentViews.compare.no;
}

function readMentions(node: GraphNode | undefined): Value {
  return node !== undefined && node.kind === 'entity' ? node.mentions.length : null;
}

/**
 * The raw edge count off the payload.
 *
 * ITS TIP USED TO CLAIM THIS ROW IS NEVER UNKNOWN, and this function is the
 * counter-example: a node whose payload did not resolve arrives here as
 * `undefined` and reads `null` like every other absent value. That matters
 * beyond one cell, because the Unknown COUNT docked in the header is derived
 * from these verdicts — an unresolved payload silently moves a figure the view
 * presents as the sceptic's first reading. The copy states the real condition.
 */
function readDegree(node: GraphNode | undefined): Value {
  return node === undefined ? null : node.degree;
}

/** Passages and sources carry no gloss. `in` is the narrowing, not a cast. */
function readSummary(node: GraphNode | undefined): Value {
  if (node === undefined) return null;
  return 'summary' in node ? node.summary : null;
}

/**
 * The verdict for a pair of values.
 *
 * `Same` means the two payload values are IDENTICAL, not that this view judged
 * them equivalent. There is no fuzzy branch here on purpose: a comparison that
 * decides two different strings mean the same thing is a comparison making a
 * claim of its own, and this one is not entitled to.
 */
function verdictOf(a: Value, b: Value): Verdict {
  if (a === null || b === null) return 'unknown';
  return a === b ? 'same' : 'different';
}

/**
 * The `Type` row's verdict, which needs one guard the others do not.
 *
 * TWO VALUES FROM TWO DIFFERENT FIELDS ARE NOT A COMPARISON. `readType` returns
 * `entity_type` for an entity and `boundary_kind` for an asset, so a fork whose
 * two subjects are different KINDS puts an entity type beside a boundary kind
 * and `verdictOf` rules on the pair — printing `Different` over two quantities
 * that were never the same measurement, or `Same` if two unrelated vocabularies
 * happen to collide on a string. That is the compound-label failure at cell
 * scale. Where the kinds differ there is no comparable value on at least one
 * side, which is exactly what `Unknown` means; the cells still show what each
 * subject carries.
 */
function typeVerdict(a: GraphNode | undefined, b: GraphNode | undefined): Verdict {
  const ka = readKind(a);
  const kb = readKind(b);
  if (ka === null || kb === null || ka !== kb) return 'unknown';
  return verdictOf(readType(a), readType(b));
}

export interface FacetRow {
  key: string;
  copy: { label: string; tip: string };
  a: Value;
  b: Value;
  verdict: Verdict;
  /**
   * Stack the two cells instead of setting them in columns.
   *
   * THE RAIL IS 320px AND A GLOSS IS A SENTENCE. Two columns of ~144px each are
   * exactly right for a word, a figure or a token, and hostile to prose: the
   * one-line summary a node carries would set as ten lines of four words in each
   * column, side by side, which is a shape nobody reads across. A stacked row
   * keeps the sentence readable — and it keeps each half ATTRIBUTED, because the
   * column position is what carried the attribution and stacking spends it, so
   * the subject's name is restated above its own cell.
   */
  wide?: boolean;
}

/* =============================================================================
 * 3. RENDERING
 * ========================================================================== */

const VERDICT_TONE: Readonly<Record<Verdict, string>> = {
  same: 'tone-ok',
  different: 'tone-dim',
  unknown: 'tone-curiosity',
};

function Cell({ value }: { value: Value }): JSX.Element {
  if (value === null) {
    return <span className="iv-cmp__absent t-12-5 ink-dim">{COPY.intentViews.compare.absent}</span>;
  }
  if (typeof value === 'number') return <Num value={value} format="int" tone="dim" />;
  return (
    <span className="iv-cmp__val t-12-5" data-prose>
      {value}
    </span>
  );
}

function FacetLine({ row, subjects }: { row: FacetRow; subjects: [string, string] }): JSX.Element {
  const copy = COPY.intentViews.compare.verdicts[row.verdict];
  const wide = row.wide === true;
  return (
    <li className="iv-cmp__row" data-verdict={row.verdict}>
      <div className="iv-cmp__rowhead">
        <Tip content={row.copy.tip}>
          <span className="iv-cmp__facet t-13 ink-dim">{row.copy.label}</span>
        </Tip>
        <Tip content={copy.long}>
          <span className={`iv-cmp__v caps u-tone ${VERDICT_TONE[row.verdict]}`}>{copy.label}</span>
        </Tip>
      </div>
      <div className="iv-cmp__cells" data-wide={wide}>
        <div className="iv-cmp__cell">
          {wide ? <span className="iv-cmp__whose caps ink-dim">{subjects[0]}</span> : null}
          <Cell value={row.a} />
        </div>
        <div className="iv-cmp__cell">
          {wide ? <span className="iv-cmp__whose caps ink-dim">{subjects[1]}</span> : null}
          <Cell value={row.b} />
        </div>
      </div>
    </li>
  );
}

/* =============================================================================
 * THE VIEW
 * ========================================================================== */

/* =============================================================================
 * THE DERIVATION, EXPORTED — because the answer is read in two places
 * -----------------------------------------------------------------------------
 * The screen-reader twin (`../TerrainOutline.tsx`) has to reach the SAME
 * conclusions about the same fork, and it did not: it carried its own copy of
 * this table, which still wrote one edge into both `direct` cells and hardcoded
 * the verdict `same` — the exact defect this view was refactored to remove,
 * surviving on the surface that is read aloud, where nobody would see it.
 *
 * Two derivations of one fact eventually disagree, and the version a sighted
 * reviewer never looks at is the one that stays wrong. So there is one table and
 * both surfaces render it.
 * ========================================================================== */

export function compareFacets(
  fork: Fork,
  path: readonly PathStep[],
  trace: RenderTraceV1 | null,
  a: GraphNode | undefined,
  b: GraphNode | undefined,
): FacetRow[] {
  const facets = COPY.intentViews.compare.facets;
  /* THE ONE ROW THAT IS NOT READ OFF A NODE, AND IT IS READ PER DIRECTION.
     `A regulated_by B` is a fact about A; `B regulated_by A` is a different fact
     about B. Taking one edge and writing it into both columns was one fact
     printed twice, and calling that `Same` was a verdict asserted rather than
     derived. Each cell is now its own `find` over its own direction, `null` when
     the render walked nothing that way — which is the true reading: this render
     did not look. */
  const directedFrom = (fromId: string, toId: string): Value => {
    const step = path.find((s) => s.from_id === fromId && s.to_id === toId);
    return step === undefined ? null : byFamily[step.family].label;
  };
  const directA = directedFrom(fork.left.id, fork.right.id);
  const directB = directedFrom(fork.right.id, fork.left.id);

  /* THE RECEIPT'S COUNT, NOT THE EDGE'S. `admitted` is `null` while the receipt
     is out, and a `null` here is what makes the row read Unknown instead of
     comparing two figures nobody has yet. */
  const evidenceA = hopEvidence(trace, fork.left.step).admitted;
  const evidenceB = hopEvidence(trace, fork.right.step).admitted;

  const rows: FacetRow[] = [
    {
      key: 'reaches',
      copy: facets.reaches,
      a: byFamily[fork.left.step.family].label,
      b: byFamily[fork.right.step.family].label,
      verdict: verdictOf(fork.left.step.family, fork.right.step.family),
    },
    {
      key: 'evidence',
      copy: facets.evidence,
      a: evidenceA,
      b: evidenceB,
      verdict: verdictOf(evidenceA, evidenceB),
    },
    {
      key: 'direct',
      copy: facets.direct,
      a: directA,
      b: directB,
      verdict: verdictOf(directA, directB),
    },
    { key: 'kind', copy: facets.kind, a: readKind(a), b: readKind(b), verdict: verdictOf(readKind(a), readKind(b)) },
    { key: 'type', copy: facets.type, a: readType(a), b: readType(b), verdict: typeVerdict(a, b) },
    {
      key: 'clusters',
      copy: facets.clusters,
      a: readClusters(a),
      b: readClusters(b),
      verdict: verdictOf(readClusters(a), readClusters(b)),
    },
    {
      key: 'strait',
      copy: facets.strait,
      a: readStrait(a),
      b: readStrait(b),
      verdict: verdictOf(readStrait(a), readStrait(b)),
    },
    {
      key: 'mentions',
      copy: facets.mentions,
      a: readMentions(a),
      b: readMentions(b),
      verdict: verdictOf(readMentions(a), readMentions(b)),
    },
    {
      key: 'degree',
      copy: facets.degree,
      a: readDegree(a),
      b: readDegree(b),
      verdict: verdictOf(readDegree(a), readDegree(b)),
    },
    {
      key: 'summary',
      copy: facets.summary,
      a: readSummary(a),
      b: readSummary(b),
      verdict: verdictOf(readSummary(a), readSummary(b)),
      wide: true,
    },
  ];
  return rows;
}

export function CompareView({
  active,
  nodes,
  trace,
  disputed,
  className,
}: IntentViewProps): JSX.Element {
  const path = active.constellation.path;
  const fork = findFork(path);

  if (fork === null) {
    /* NO SHARED OBJECT, NO TABLE. A comparison layout over a chain would be two
       columns whose only honest content is "these are different nodes". */
    return (
      <div
        className={['iv', 'iv-cmp', className].filter(Boolean).join(' ')}
        data-disputed={disputed}
      >
        <IntentHead intent="compare" disputed={disputed} />
        <p className="iv__note t-12-5 ink-dim" data-prose>
          {COPY.intentViews.compare.noFork}
        </p>
        <ul className="iv__claims">
          {path.map((step) => (
            <li key={step.edge_id} className="iv__claim">
              <NodeName id={step.from_id} nodes={nodes} />
              <Relation step={step} />
              <NodeName id={step.to_id} nodes={nodes} />
              {step.evidence_passage_ids.length === 0 ? (
                <NoEvidence />
              ) : (
                <EvidenceChip evidence={hopEvidence(trace, step)} />
              )}
            </li>
          ))}
        </ul>
        <DerivedNote intent="compare" />
      </div>
    );
  }

  const a = nodes.get(fork.left.id);
  const b = nodes.get(fork.right.id);
  const facets = COPY.intentViews.compare.facets;
  const rows = compareFacets(fork, path, trace, a, b);

  const unknowns = rows.filter((r) => r.verdict === 'unknown').length;
  const subjects: [string, string] = [
    a?.label ?? fork.left.id,
    b?.label ?? fork.right.id,
  ];

  return (
    <div
      className={['iv', 'iv-cmp', className].filter(Boolean).join(' ')}
      data-disputed={disputed}
    >
      <IntentHead
        intent="compare"
        disputed={disputed}
        aside={
          /* THE UNKNOWN COUNT IS DOCKED IN THE HEADER, NOT BURIED IN THE ROWS.
             How much of this table the render could not fill is the first thing a
             sceptic wants and the last thing a comparison usually admits. */
          <Tip content={COPY.intentViews.compare.verdicts.unknown.long}>
            <span className="iv-cmp__unk caps u-tone tone-curiosity">
              <Num value={unknowns} format="int" tone="curiosity" />{' '}
              {COPY.intentViews.compare.verdicts.unknown.label}
            </span>
          </Tip>
        }
      />

      {/* ---- the two columns, named once, at the top ---------------------- */}
      <Tip content={COPY.intentViews.compare.subjects.tip} className="u-block">
        <div className="iv-cmp__subjects">
          <div className="iv-cmp__subject">
            <NodeName id={fork.left.id} nodes={nodes} />
          </div>
          <div className="iv-cmp__subject">
            <NodeName id={fork.right.id} nodes={nodes} />
          </div>
        </div>
      </Tip>

      {/* THE FORK ITSELF, STATED ONCE. Both columns reach this node; that is the
          reason they are on one screen, so it sits above the rows rather than
          inside one of them.

          THE ROW BELOW IT HAS ITS OWN LABEL NOW. Both used `facets.shared.label`,
          so `What they share` appeared twice on one screen over two different
          quantities — the shared NODE here, the two RELATION FAMILIES four lines
          down — which made the second read as a duplicate of the first. This key
          keeps the node; the row took `facets.reaches`. */}
      <Tip content={facets.shared.tip} className="u-block">
        <div className="iv-cmp__shared">
          <span className="iv-cmp__facet t-13 ink-dim">{facets.shared.label}</span>
          <NodeName id={fork.sharedId} nodes={nodes} />
        </div>
      </Tip>

      {/* WHAT THE TWO COLUMNS DO NOT HOLD. Silent truncation of the input is the
          same class as filling a cell the engine did not return. */}
      {fork.unshown === 0 ? null : (
        <Tip content={COPY.intentViews.compare.more.tip}>
          <span className="iv-cmp__more caps u-tone tone-curiosity">
            {COPY.intentViews.compare.more.label}{' '}
            <Num value={fork.unshown} format="int" tone="curiosity" />
          </span>
        </Tip>
      )}

      <ul className="iv-cmp__rows">
        {rows.map((row) => (
          <FacetLine key={row.key} row={row} subjects={subjects} />
        ))}
      </ul>

      <DerivedNote intent="compare" />
    </div>
  );
}
