/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE BRIDGE VIEW, AND THE ATOMS EVERY INTENT VIEW USES
 * =============================================================================
 *
 * A route, drawn as a route: node, relation, node, relation, node — reading top
 * to bottom, with the bridge entity marked and the strait crossing marked on the
 * hop that makes it.
 *
 * -----------------------------------------------------------------------------
 * WHAT WAS THERE BEFORE, AND WHY A LIST IS NOT A CHAIN
 * -----------------------------------------------------------------------------
 * The answer path rendered as an ordered list of independent hop rows, each one
 * printing BOTH its endpoints. The demo's own two-hop bridge answer therefore
 * printed `Tollstrand Battery` twice, once as the target of hop 1 and once as the
 * source of hop 2, with nothing on screen saying they were the same node — and
 * they arrived in the order the render assembled them, which for this answer is
 * middle-first: `Tollstrand → Bruntorp`, then `Rimsdal → Tollstrand`. A reader
 * had to hold four names, notice that two of them were one name, and reverse the
 * pair to recover a route the engine had already found.
 *
 * The chain prints each node ONCE, in traversal order, so the shared node is
 * visibly shared and the route reads as one thing.
 *
 * -----------------------------------------------------------------------------
 * THE ORDERING IS DERIVED, SO IT IS ALLOWED TO FAIL, AND IT SAYS SO WHEN IT DOES
 * -----------------------------------------------------------------------------
 * `linkChain()` below walks the hops into a directed route. It refuses in three
 * cases the store's own `chainEndpoints()` already names as real: a fork
 * (`a ← r → b`), a collider (`a → r ← b`, which is exactly the corpus's staged
 * Compare question), and the star a free-text question returns when it is
 * answered from several edges incident to one entity. Free text lands on this
 * intent whenever the matched entity is a bridge, so the star is not a rare path
 * — it is a normal one.
 *
 * Drawing any of those three as `A → B → C` would be this view asserting a
 * traversal order the engine never returned. It refuses, states the hops in the
 * render's own order, and prints one sentence saying which of the two it is
 * showing. A layout that looks identical whether or not its premise held is the
 * defect this whole pass exists to remove.
 *
 * -----------------------------------------------------------------------------
 * WHY THE SHARED ATOMS LIVE IN THIS FILE
 * -----------------------------------------------------------------------------
 * The hop chain is the primitive shape and the other four views are
 * re-arrangements of it: a lookup is a chain of one, a compare is two chains
 * sharing an end, a timeline is a chain with dates, a summary is a chain's hops
 * sorted into classes. So the atoms — the clickable node name, the relation
 * label, the evidence control, the disclosure line — are declared here and
 * imported by the other four, rather than each view minting its own button and
 * the product growing five subtly different node names.
 *
 * `intents/index.ts` is a barrel and cannot hold them: it is a `.ts` file and
 * these are components.
 * =============================================================================
 */

import type { ReactNode } from 'react';

import { COPY, sigmaCopy } from '@/copy';
import { byFamily } from '@/engine';
import type { GraphNode, PathStep, QueryIntent, QueryRenderResponse, RenderTraceV1 } from '@/engine';
import { useAtlas } from '@/state';
import { Chip, Num, Row, SectionLabel, Tip } from '@/ui/primitives';

/* =============================================================================
 * THE SHARED PROPS
 * -----------------------------------------------------------------------------
 * Every intent view is a pure function of these four, and the panel above
 * resolves all four exactly once. A view that fetched its own nodes would be a
 * fifth place that has to decide what to do when a fetch fails, and five answers
 * to that question is four too many.
 *
 * `disputed` is the fourth and it was missing. The panel knew all three ways a
 * result can be invalidated and passed none of them down, so the fovea tier —
 * the route, the chips, the counts, the verdicts — was byte-identical whether or
 * not the answer's premise held.
 * ========================================================================== */

export interface IntentViewProps {
  /** The render this view is a reading of. Never null — the panel gates on it. */
  active: QueryRenderResponse;
  /**
   * Every node on the answer path, plus the bridge entity, resolved to its
   * payload. A MISSING id is not an error and not a blank: the view falls back to
   * the raw id, which is the engine's own name for a thing whose label did not
   * arrive. An invented label would be worse than an ugly one.
   */
  nodes: ReadonlyMap<string, GraphNode>;
  /** The receipt, for the citation counts. `null` before it lands. */
  trace: RenderTraceV1 | null;
  /**
   * THE RESULT IS IN DISPUTE. Any of the three: a broken signature, edited
   * payload bytes, or an independent re-traversal contradicting the receipt.
   *
   * IT IS REQUIRED, NOT OPTIONAL, AND THAT IS THE POINT. The panel above knew
   * all three and none of them reached this tier, so the fovea was
   * byte-identical either way — the route, the chips, the counts and the table
   * verdicts all kept vouching at full luminance over a contradicted answer. A
   * required prop is the only version of this a sixth view cannot forget.
   */
  disputed: boolean;
  className?: string;
}

/* =============================================================================
 * THE ATOMS
 * ========================================================================== */

/**
 * A node name you can press.
 *
 * `.u-hitslop` IS THE FIX FOR THE SMALLEST TARGET IN THE PRODUCT. These names
 * are set inline in a running row: roughly 17px tall, with no padding and no hit
 * rule of any kind — the only interactive elements in the build that had none.
 * They cannot be padded to the 36px floor without becoming buttons in a sentence,
 * so they keep their size and gain pressable area they do not paint. The vertical
 * extent of that area is set in `intents.css`, because `shell.css` owns the
 * class and this pass does not.
 */
export function NodeName({
  id,
  nodes,
  className,
}: {
  id: string;
  nodes: ReadonlyMap<string, GraphNode>;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={['answer__node', 'u-hitslop', className].filter(Boolean).join(' ')}
      onClick={() => useAtlas.getState().selectNode(id, false)}
    >
      {nodes.get(id)?.label ?? id}
    </button>
  );
}

/**
 * The relation, in the engine's own token, with its class on hover.
 *
 * IN INK, NOT IN LIGHT. It wore `--render` on every hop of every answer, which
 * put two or three teal machine codes in the rail beside the one teal thing the
 * frame is about — the path itself, on the map.
 */
export function Relation({ step }: { step: PathStep }): JSX.Element {
  return (
    <Tip content={`${byFamily[step.family].label} · ${sigmaCopy(step.sigma).short}`}>
      <span className="answer__family mono ink-dim">{step.family}</span>
    </Tip>
  );
}

/**
 * The evidence control, and the figure it is NOT allowed to absorb.
 *
 * IT MOVES ONE TAB. It used to call `openPassage(evidence_passage_ids[0])` —
 * always the first source, never a choice — and that navigates the whole
 * application to the passage rung, replacing the view, the scope, the breadcrumb
 * and the camera. A count of three that reaches one of them, at the cost of the
 * reader's place, is a control lying about what it counts. The evidence trail
 * lists every one of them, grouped by hop, and it is one tab away.
 *
 * IT COUNTS THE RECEIPT, AND THE RECEIPT ONLY. The count was floored at
 * `evidence_passage_ids.length`, which on the staged bridge question printed `3`
 * over a hop the receipt carries `2` citations for — so the chip promised three
 * and the tab it navigates to listed two. The argument for the floor was that
 * the larger number is more honest about the graph. It is; it is not the number
 * this control advertises. It is stated beside it instead, as its own figure
 * under its own label, in the violet this product already spends on
 * omitted-but-connected.
 */
export function EvidenceChip({ evidence }: { evidence: HopEvidence }): JSX.Element {
  /* NEVER while the receipt is out. `admitted === null` is "no figure can be
     sourced yet", which the numeric primitive renders as an em dash — a zero
     there would be a measurement nobody took. */
  const unadmitted =
    evidence.admitted === null ? 0 : evidence.attached - evidence.admitted;
  return (
    <>
      <Tip
        content={
          evidence.admitted === null
            ? COPY.intentViews.evidencePending
            : COPY.intentViews.evidence.title
        }
      >
        <Chip
          tone="evidence"
          count={evidence.admitted ?? Number.NaN}
          onClick={() => useAtlas.getState().setTab('evidence', { pin: true })}
        >
          {COPY.intentViews.evidence.label}
        </Chip>
      </Tip>
      {unadmitted <= 0 ? null : (
        <Tip content={COPY.intentViews.unadmitted.tip}>
          <span className="iv__unadmitted caps u-tone tone-curiosity">
            {COPY.intentViews.unadmitted.label}{' '}
            <Num value={unadmitted} format="int" tone="curiosity" />
          </span>
        </Tip>
      )}
    </>
  );
}

/** A hop the engine returned with nothing to cite. Stated in the alarm tone, never hidden. */
export function NoEvidence(): JSX.Element {
  return <span className="caps tone-alarm u-tone">{COPY.intentViews.noEvidence}</span>;
}

/**
 * THE DISCLOSURE LINE. One sentence, quiet, at the foot of every intent view.
 *
 * It exists because these layouts are composed HERE, from the path and the
 * citations and the node payloads, rather than returned by the engine as
 * structured per-intent output. That is the right trade for a demo whose subject
 * is the architecture — and it is only the right trade if the interface says so
 * where the composition happens. A presentation that cannot be traced back to
 * what it is presenting is worse than no presentation.
 */
export function DerivedNote({ intent }: { intent: QueryIntent }): JSX.Element {
  return (
    <Tip content={COPY.intentViews.derivedTip}>
      <p className="iv__derived t-11 ink-dim" data-prose>
        {COPY.intentViews.derived[intent]}
      </p>
    </Tip>
  );
}

/**
 * THE DISPUTE, STATED WHERE THE ARRANGEMENT IS.
 *
 * The panel above withdraws the composite and stops the gold row vouching; this
 * tier did neither, so an answer two engine surfaces disagree about kept its
 * route, its counts and its verdicts at full luminance. The sentence is the
 * stated half; `.iv[data-disputed='true']` in `intents.css` is the withdrawn
 * half, and the two exist as a pair.
 */
export function DisputedNote(): JSX.Element {
  return (
    <Tip content={COPY.intentViews.disputed.tip} className="u-block">
      <p className="iv__disputed t-12-5 tone-alarm u-tone" data-prose>
        {COPY.intentViews.disputed.label}
      </p>
    </Tip>
  );
}

/**
 * The view's own marker plus whatever the view docks beside it.
 *
 * A REAL HEADING, NOT A STYLED SPAN. `SectionLabel` renders a `<span>`, so
 * `document.querySelectorAll('.iv h1,.iv h2,.iv h3,.iv h4,[role="heading"]')`
 * returned ZERO across all five views: the layout that exists to make five
 * intents structurally different exposed no structure at all to anything reading
 * the document rather than looking at it. The `<h3>` sits under the panel's own
 * `<h2>` and takes its type from the label inside it.
 *
 * `disputed` is REQUIRED so the dispute cannot be forgotten by a view: every
 * head is a head, and every head carries the line when there is one.
 */
export function IntentHead({
  intent,
  disputed,
  aside,
}: {
  intent: QueryIntent;
  disputed: boolean;
  aside?: ReactNode;
}): JSX.Element {
  return (
    <>
      <div className="iv__head">
        <h3 className="iv__title">
          <SectionLabel>{COPY.intentViews.titles[intent]}</SectionLabel>
        </h3>
        {aside === undefined ? null : <div className="iv__aside">{aside}</div>}
      </div>
      {disputed ? <DisputedNote /> : null}
    </>
  );
}

/* =============================================================================
 * SHARED DERIVATION
 * ========================================================================== */

/**
 * What the receipt says about one hop's sources, and what it does not say.
 *
 * TWO FIGURES, BECAUSE THEY ARE TWO QUANTITIES. `attached` is how many passage
 * ids the engine hung on the edge; `admitted` is how many of those the receipt
 * actually contains. They are not the same number and the difference is not
 * noise: the render's citation cap and token budget stop before the whole set.
 * Measured on the staged bridge question, the `operates` hop attaches three and
 * the receipt admits two — `p:storage.tollstrand-cluster.003.1` never made it —
 * and the `acquired` hop is the same two-of-three.
 *
 * The old function returned `max(admitted, attached)` under the argument that
 * the larger figure is more honest about the graph. The larger figure IS a true
 * thing about the graph, and it is not the thing a control labelled with the
 * receipt's own word may print: the chip said `3` and the evidence trail it
 * navigates to — which groups `trace.citations` — listed `2`. A count that
 * overstates its own destination is the failure the chip exists to end.
 *
 * `admitted` is `null`, never `attached`, while the receipt is still out: no
 * figure can be sourced, so no figure is stated.
 */
export interface HopEvidence {
  /** Citations the receipt contains for this hop. `null` until the receipt lands. */
  admitted: number | null;
  /** Passage ids the engine hung on this edge. The candidate set, not the receipt. */
  attached: number;
}

export function hopEvidence(trace: RenderTraceV1 | null, step: PathStep): HopEvidence {
  const attached = step.evidence_passage_ids.length;
  if (trace === null) return { admitted: null, attached };
  const wanted = new Set(step.evidence_passage_ids);
  return {
    admitted: trace.citations.filter((c) => wanted.has(c.passage_id)).length,
    attached,
  };
}

/**
 * The admitted count alone, as a plain number.
 *
 * FOR THE NON-VISUAL TWIN. `TerrainOutline` — the mounted, visually-hidden
 * screen-reader surface — imports this so the two readings of one answer cannot
 * drift, and it is a run of sentences with nowhere to hang a second figure. It
 * is the same number the chip prints, which is the whole point: the outline said
 * `Evidence: 1` from the same floored count the chip said `3` from, and both
 * were reading past the receipt.
 *
 * `NaN` while the receipt is out, never `0` — the numeric primitive renders a
 * non-finite value as an em dash, and a zero would be a measurement nobody took.
 * The branch is defensive: the store commits `active` and `trace` in one action
 * and nulls them in one action, so a mounted view with a null trace does not
 * occur today.
 */
export function citationCount(trace: RenderTraceV1 | null, step: PathStep): number {
  return hopEvidence(trace, step).admitted ?? Number.NaN;
}

/**
 * Walk the hops into a directed route, or refuse.
 *
 * Returns the ordered node ids and the step between each adjacent pair, or `null`
 * when the hops are not a single route. The test is DIRECTIONAL and that is the
 * whole of it: a chain's internal node is passed THROUGH — exactly one hop
 * arrives and exactly one leaves — while a fork's centre has two leaving and a
 * collider's has two arriving. Degree alone cannot tell the three apart, and the
 * cost of believing it could was a curated question shipping as a trust failure
 * (see `chainEndpoints()` in the store, which learned this the same way).
 */
export function linkChain(
  path: readonly PathStep[],
): { ids: string[]; steps: PathStep[] } | null {
  if (path.length === 0) return null;

  const outgoing = new Map<string, PathStep>();
  const inDegree = new Map<string, number>();
  for (const step of path) {
    if (outgoing.has(step.from_id)) return null; // two hops leave one node: a fork
    outgoing.set(step.from_id, step);
    inDegree.set(step.to_id, (inDegree.get(step.to_id) ?? 0) + 1);
    if ((inDegree.get(step.to_id) ?? 0) > 1) return null; // two hops arrive: a collider
  }

  const starts = [...outgoing.keys()].filter((id) => (inDegree.get(id) ?? 0) === 0);
  if (starts.length !== 1) return null; // no single head, or a cycle

  const ids: string[] = [starts[0]];
  const steps: PathStep[] = [];
  const seen = new Set<string>(ids);
  let cursor: string | undefined = starts[0];
  while (cursor !== undefined) {
    const step: PathStep | undefined = outgoing.get(cursor);
    if (step === undefined) break;
    if (seen.has(step.to_id)) return null; // a loop is not a route
    steps.push(step);
    ids.push(step.to_id);
    seen.add(step.to_id);
    cursor = step.to_id;
  }
  return steps.length === path.length ? { ids, steps } : null;
}

/* =============================================================================
 * THE VIEW
 * ========================================================================== */

export function BridgeView({
  active,
  nodes,
  trace,
  disputed,
  className,
}: IntentViewProps): JSX.Element {
  const path = active.constellation.path;
  const bridgeId = active.constellation.bridge_entity_id;
  const chain = linkChain(path);

  return (
    <div
      className={['iv', 'iv-br', className].filter(Boolean).join(' ')}
      data-disputed={disputed}
    >
      <IntentHead
        intent="bridge"
        disputed={disputed}
        aside={<Num value={path.length} format="int" tone="dim" unit={COPY.common.units.hops} />}
      />

      {chain === null ? (
        /* ---- NOT A ROUTE. Say which of the two this is, then show the hops in
                the render's own order. See the header. ------------------------ */
        <>
          <p className="iv__note t-12-5 ink-dim" data-prose>
            {COPY.intentViews.bridge.unordered}
          </p>
          <ul className="iv__claims">
            {path.map((step) => (
              <li key={step.edge_id} className="iv__claim">
                <NodeName id={step.from_id} nodes={nodes} />
                <Relation step={step} />
                <NodeName id={step.to_id} nodes={nodes} />
                {step.crosses_strait ? <StraitMark /> : null}
                {step.evidence_passage_ids.length === 0 ? (
                  <NoEvidence />
                ) : (
                  <EvidenceChip evidence={hopEvidence(trace, step)} />
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        /* ---- THE ROUTE. Each node once, in traversal order. ----------------- */
        <ol className="iv-br__chain">
          {chain.ids.map((id, i) => {
            const step = i < chain.steps.length ? chain.steps[i] : null;
            return (
              <li key={id} className="iv-br__stop" data-bridge={id === bridgeId}>
                <div className="iv-br__node">
                  <NodeName id={id} nodes={nodes} />
                  {id === bridgeId ? (
                    <Tip content={COPY.intentViews.bridge.markTip}>
                      <span className="iv-br__mark caps u-tone tone-curiosity">
                        {COPY.intentViews.bridge.mark}
                      </span>
                    </Tip>
                  ) : null}
                </div>
                {step === null ? null : (
                  <div className="iv-br__link">
                    <Relation step={step} />
                    {step.crosses_strait ? <StraitMark /> : null}
                    {step.evidence_passage_ids.length === 0 ? (
                      <NoEvidence />
                    ) : (
                      <EvidenceChip evidence={hopEvidence(trace, step)} />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {/* The bridge entity is stated as a row as well as marked in the chain,
          because a mark is only legible once you already know what it means —
          and because a star-shaped answer has no chain to mark it in. */}
      {bridgeId === null ? null : (
        <Tip content={COPY.intentViews.bridge.markTip} className="u-block">
          <Row
            label={COPY.answer.bridge.label}
            value={<NodeName id={bridgeId} nodes={nodes} />}
            tone="curiosity"
          />
        </Tip>
      )}

      <DerivedNote intent="bridge" />
    </div>
  );
}

/**
 * The one hop that crosses open water.
 *
 * BY LUMINANCE, NOT BY HUE. Violet in this product means the question and what is
 * not known — staged and unspent, omitted but connected. A strait crossing is the
 * opposite: it is the strongest thing the answer says about itself, and it wore
 * the light for absence.
 */
export function StraitMark(): JSX.Element {
  return (
    <Tip content={COPY.intentViews.bridge.straitTip}>
      <span className="answer__strait caps">{COPY.intentViews.bridge.strait}</span>
    </Tip>
  );
}
