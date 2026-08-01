/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE SUMMARISE VIEW
 * =============================================================================
 *
 * A breadth answer's claims, grouped under the class the engine filed each one
 * in, with the count of what it deliberately did not spend on beside them.
 *
 * -----------------------------------------------------------------------------
 * WHY THE THEME IS THE σ-CLASS AND NOT A TOPIC
 * -----------------------------------------------------------------------------
 * "Findings grouped by theme" invites a grouping by subject matter, and there is
 * no field in the payload that carries one. Inventing topics here — clustering
 * the labels, keying off words in the summaries — would be this interface
 * producing content and letting the render's authority stand behind it. That is
 * the one thing these views may not do.
 *
 * The engine already classifies every edge, and the classification is not a
 * decoration: `SigmaClass` is what KIND of claim the relation makes — state of
 * the world, when and in what order, because, what happened to somebody, who said
 * it, and the document's own skeleton. For a breadth question that IS the useful
 * grouping. "Six things are true of this facility, four of which are events and
 * two of which are somebody's attribution" is a genuinely different reading from
 * a flat list of six hops, and every part of it came out of the payload.
 *
 * The structural group is kept and labelled rather than filtered out. Those edges
 * are truth-gate exempt because they describe the artifact rather than the world,
 * and a summary that silently drops them would be quietly inflating how much of
 * its content is a claim about reality.
 *
 * -----------------------------------------------------------------------------
 * THE OMISSION COUNT IS THE HEADLINE, NOT A FOOTNOTE
 * -----------------------------------------------------------------------------
 * The corpus's own note on this staged question is: "A breadth question. The
 * interesting number is what the renderer chose NOT to spend on." The old layout
 * had nowhere to put that — `omitted_but_connected` lived several thousand pixels
 * down inside the render trace — so the one thing this question exists to
 * demonstrate was the least visible thing on the screen. It is docked in this
 * view's header now, as a count, pointing at the receipt that lists every one of
 * them with the engine's reason.
 * =============================================================================
 */

import { COPY, sigmaCopy } from '@/copy';
import { SIGMA_CLASSES } from '@/engine';
import type { PathStep, SigmaClass } from '@/engine';
import { Num, Row, Tip } from '@/ui/primitives';

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

/**
 * The node this render's claims attach to most often, and how many of them.
 *
 * A COUNT, NOT A JUDGEMENT. It is not "the subject" and it is not "the most
 * important node" — it is the id appearing in more of the returned hops than any
 * other, which is a fact about this render and nothing more. Returned as `null`
 * below two, because "appears in one of six hops" names a leader of nothing.
 */
function busiestNode(path: readonly PathStep[]): { id: string; count: number } | null {
  const tally = new Map<string, number>();
  for (const step of path) {
    tally.set(step.from_id, (tally.get(step.from_id) ?? 0) + 1);
    tally.set(step.to_id, (tally.get(step.to_id) ?? 0) + 1);
  }
  let best: { id: string; count: number } | null = null;
  for (const [id, count] of tally) {
    if (best === null || count > best.count) best = { id, count };
  }
  return best !== null && best.count >= 2 ? best : null;
}

export function SummariseView({
  active,
  nodes,
  trace,
  disputed,
  className,
}: IntentViewProps): JSX.Element {
  const path = active.constellation.path;
  const bridgeId = active.constellation.bridge_entity_id;
  const busiest = busiestNode(path);
  const omitted = trace === null ? null : trace.omitted_but_connected.length;

  /* GROUPED IN THE VOCABULARY'S OWN ORDER, not by group size. The six classes
     have a declared order in the contract and it is a meaningful one — factual
     before temporal before causal — so a render whose shape changes between two
     questions still reads down the same ladder. */
  const groups = SIGMA_CLASSES.map((sigma: SigmaClass) => ({
    sigma,
    steps: path.filter((s) => s.sigma === sigma),
  })).filter((g) => g.steps.length > 0);

  return (
    <div
      className={['iv', 'iv-sum', className].filter(Boolean).join(' ')}
      data-disputed={disputed}
    >
      <IntentHead
        intent="summarize"
        disputed={disputed}
        aside={
          <Num value={path.length} format="int" tone="dim" unit={COPY.intentViews.summarize.claims} />
        }
      />

      {/* ---- the two readouts a breadth answer is actually about ---------- */}
      {busiest === null ? null : (
        <Tip content={COPY.intentViews.summarize.subject.tip} className="u-block">
          <Row
            label={COPY.intentViews.summarize.subject.label}
            value={
              <span className="iv-sum__subject">
                <NodeName id={busiest.id} nodes={nodes} />
                <Num value={busiest.count} format="int" tone="dim" />
              </span>
            }
            tone={busiest.id === bridgeId ? 'curiosity' : 'neutral'}
          />
        </Tip>
      )}

      {omitted === null ? null : (
        <Tip content={COPY.intentViews.summarize.omitted.tip} className="u-block">
          <Row
            label={COPY.intentViews.summarize.omitted.label}
            value={<Num value={omitted} format="int" tone="curiosity" />}
            tone="curiosity"
          />
        </Tip>
      )}

      {groups.length === 0 ? (
        <p className="iv__note t-12-5 ink-dim" data-prose>
          {COPY.intentViews.summarize.empty}
        </p>
      ) : (
        <>
          {/* THE VALUE CAME FROM THE COMPONENT AND SAID `sigma`. It was the one
              shipped label on this surface not taken from `@/copy`, it is not an
              engine token the reader can check against anything on screen, and
              it was the least legible form of the name available: the group
              headings under it read `Factual`, `Episodic`, `Structural`, and the
              row's own tip calls it the σ-class. It is not a machine string, so
              it does not sit on the mono rail either. */}
          <Tip content={COPY.intentViews.summarize.themes.tip} className="u-block">
            <Row
              label={COPY.intentViews.summarize.themes.label}
              value={
                <span className="ink-dim">{COPY.intentViews.summarize.themesValue}</span>
              }
            />
          </Tip>

          <ul className="iv-sum__groups">
            {groups.map((group) => (
              <li key={group.sigma} className="iv-sum__group" data-sigma={group.sigma}>
                <div className="iv-sum__grouphead">
                  {/* A REAL HEADING. The group names were styled spans, so the
                      one view whose whole structure is "claims filed under six
                      classes" exposed no structure at all to a reader navigating
                      the document rather than looking at it. */}
                  <h4 className="iv-sum__title">
                    <Tip content={sigmaCopy(group.sigma).long}>
                      <span className="iv-sum__theme t-13 ink-dim">
                        {sigmaCopy(group.sigma).label}
                      </span>
                    </Tip>
                  </h4>
                  <Num value={group.steps.length} format="int" tone="dim" />
                </div>
                {/* THE CLASS'S OWN ONE-CLAUSE GLOSS, not a heading repeated. A
                    group named `episodic` above a list of episodic claims tells a
                    first-time reader nothing they can use; the clause does. */}
                <p className="iv-sum__gloss t-11 ink-dim" data-prose>
                  {sigmaCopy(group.sigma).short}
                </p>
                <ul className="iv__claims">
                  {group.steps.map((step) => (
                    <li key={step.edge_id} className="iv__claim">
                      <NodeName id={step.from_id} nodes={nodes} />
                      <Relation step={step} />
                      <NodeName id={step.to_id} nodes={nodes} />
                      {step.evidence_passage_ids.length > 0 ? (
                        <EvidenceChip evidence={hopEvidence(trace, step)} />
                      ) : group.sigma === 'structural' ? (
                        /* THE STRUCTURAL CLASS IS TRUTH-GATE EXEMPT, so an
                           uncited structural edge is not a defect: `_follows`
                           says one passage came after another in a document,
                           which is a fact about the file rather than a claim to
                           be evidenced. Flying the alarm here would teach the
                           reader that the loudest mark in the product means
                           nothing. */
                        null
                      ) : (
                        <NoEvidence />
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}

      <DerivedNote intent="summarize" />
    </div>
  );
}
