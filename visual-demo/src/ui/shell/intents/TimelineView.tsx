/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE TIMELINE VIEW
 * =============================================================================
 *
 * One card per dated session, in the order the engine's own structural fiber puts
 * them, each one saying what is different about it from the session before.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS REPLACED, VERBATIM
 * -----------------------------------------------------------------------------
 * The Timeline answer arrived as a single paragraph opening on the engine's gold
 * string in raw arrow notation:
 *
 *     2019-03-04 -> 2020-01-11 -> 2021-06-02 -> 2022-09-14. Tollstrand 2
 *     session follows Tollstrand 1; Tollstrand 3 session follows Tollstrand 2; …
 *
 * Four dated sessions, four documents with names and summaries and extracted
 * entity sets — presented as a punctuation sequence and a semicolon-separated
 * list of edge tokens. Every fact in it was true. None of it was a chronology:
 * there was nothing on screen you could point at and call "the third session",
 * and the one thing a reader wants from a timeline — what is DIFFERENT about each
 * step — was not stated anywhere, because the answer sentence had no way to say
 * it and the hop list had no interest in it.
 *
 * -----------------------------------------------------------------------------
 * THE ORDER IS THE ENGINE'S. IT IS NOT A DATE SORT
 * -----------------------------------------------------------------------------
 * `orderFiber()` walks the session fiber — `_session_follows` or its inverse
 * `_session_precedes`, whichever the render returned, and it reports back which
 * — because that is the whole point of this staged question: "Ordering carried
 * by the structural fiber, not by a sort in the UI. Truth-gate exempt on
 * purpose." Sorting the cards by
 * `boundary_declared_at` here would produce the same sequence on this corpus and
 * would be a different claim — it would mean the interface believes the dates
 * rather than the graph, and the two agreeing today is not a reason to stop
 * reading the half that is engine-backed. When the fiber does not resolve into a
 * single order, this view says so and does NOT fall back to sorting.
 *
 * -----------------------------------------------------------------------------
 * "WHAT CHANGED" IS A DIFFERENCE, NOT A NARRATION
 * -----------------------------------------------------------------------------
 * The review asked for cards with "what changed", and the tempting version of
 * that is a sentence about each session. There is no engine field that carries
 * one, and writing it here would be this interface inventing content and
 * attributing it to a render — the single thing these views may not do.
 *
 * What the payload DOES support is arithmetic over fields the engine returned:
 * the whole-day gap between two declared boundaries, and the set difference
 * between the entity lists the extractor produced for each asset. So a card says
 * how long after the previous session it was declared, how many entities are
 * named here that no earlier session on the fiber named, and how many the
 * previous session named that this one does not. Each of those is checkable
 * against the payload; none of them is a story.
 *
 * `Not carried forward` is deliberately not phrased as an ending. A document that
 * stops naming something has stopped naming it — that is all the corpus says, and
 * all this card is allowed to.
 * =============================================================================
 */

import { COPY } from '@/copy';
import type { Asset, GraphNode, PathStep } from '@/engine';
import { Num, Row, Tip } from '@/ui/primitives';

import {
  DerivedNote,
  EvidenceChip,
  IntentHead,
  NodeName,
  Relation,
  hopEvidence,
  type IntentViewProps,
} from './BridgeView';

/** The structural families that carry a session order. */
const FIBER: ReadonlySet<string> = new Set(['_session_follows', '_session_precedes']);

/**
 * The chain of session ids, earliest first, and the families that carried it —
 * or `null` when the fiber does not resolve into exactly one order.
 *
 * `_session_follows` reads `from` FOLLOWS `to`, so the pair is normalised to
 * `[later, earlier]` before walking. Getting that backwards would print a
 * correctly-ordered chronology upside down, which is the most plausible-looking
 * way this view could be wrong.
 *
 * THE FAMILIES COME BACK OUT WITH THE IDS, because the disclosure row above the
 * cards states which relation the order came from and it used to state the
 * literal `_session_follows` — authored in the component, not read off anything.
 * This function accepts BOTH members of `FIBER` and normalises either into an
 * order, so a render whose fiber is carried by `_session_precedes` produced
 * correctly ordered cards under a row naming a relation the engine never
 * returned. A hardcoded token cannot be checked against the data; it restates a
 * constant. The row exists specifically so the disclosure sentence is checkable.
 */
interface Fiber {
  ids: string[];
  /** The fiber families actually matched, in the order they were first seen. */
  families: string[];
}

function orderFiber(path: readonly PathStep[]): Fiber | null {
  const links = path.filter((s) => FIBER.has(s.family));
  if (links.length === 0) return null;

  const families = [...new Set(links.map((s) => s.family))];

  const pairs = links.map((s) =>
    s.family === '_session_follows'
      ? ([s.from_id, s.to_id] as const)
      : ([s.to_id, s.from_id] as const),
  );

  const laterOf = new Map<string, string>();
  const isLater = new Set<string>();
  for (const [later, earlier] of pairs) {
    if (laterOf.has(earlier)) return null; // two successors: not one order
    laterOf.set(earlier, later);
    isLater.add(later);
  }

  const heads = [...new Set(pairs.map(([, earlier]) => earlier))].filter((id) => !isLater.has(id));
  if (heads.length !== 1) return null;

  const ids: string[] = [heads[0]];
  const seen = new Set(ids);
  for (;;) {
    const next = laterOf.get(ids[ids.length - 1]);
    if (next === undefined) break;
    if (seen.has(next)) return null; // a loop is not a chronology
    ids.push(next);
    seen.add(next);
  }
  return ids.length === pairs.length + 1 ? { ids, families } : null;
}

/** The asset payload, or `null` for any node kind that declares no boundary. */
function assetOf(node: GraphNode | undefined): Asset | null {
  return node !== undefined && node.kind === 'asset' ? node : null;
}

/** Whole days between two declared boundaries. Arithmetic on two engine timestamps. */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The date, as the corpus declares it. A date is a machine string, so: the mono rail. */
function When({ iso }: { iso: string }): JSX.Element {
  return (
    <Tip content={`${COPY.intentViews.timeline.when.tip} ${iso}`}>
      <span className="iv-tl__when mono">{iso.slice(0, 10)}</span>
    </Tip>
  );
}

export function TimelineView({
  active,
  nodes,
  trace,
  disputed,
  className,
}: IntentViewProps): JSX.Element {
  const path = active.constellation.path;
  const fiber = orderFiber(path);

  if (fiber === null) {
    return (
      <div
        className={['iv', 'iv-tl', className].filter(Boolean).join(' ')}
        data-disputed={disputed}
      >
        <IntentHead intent="timeline" disputed={disputed} />
        <p className="iv__note t-12-5 ink-dim" data-prose>
          {COPY.intentViews.timeline.noFiber}
        </p>
        <ul className="iv__claims">
          {path.map((step) => (
            <li key={step.edge_id} className="iv__claim">
              <NodeName id={step.from_id} nodes={nodes} />
              <Relation step={step} />
              <NodeName id={step.to_id} nodes={nodes} />
              {step.evidence_passage_ids.length === 0 ? null : (
                <EvidenceChip evidence={hopEvidence(trace, step)} />
              )}
            </li>
          ))}
        </ul>
        <DerivedNote intent="timeline" />
      </div>
    );
  }

  const order = fiber.ids;

  /* The entity sets, accumulated as the fiber is walked. `seenBefore` is every
     entity any EARLIER session named, which is what makes "first named here"
     mean first rather than merely "not in the one immediately before". */
  const seenBefore = new Set<string>();

  return (
    <div
      className={['iv', 'iv-tl', className].filter(Boolean).join(' ')}
      data-disputed={disputed}
    >
      <IntentHead
        intent="timeline"
        disputed={disputed}
        /* A NAKED FIGURE IN A HEADER IS A MEASUREMENT WITH NO REFERENT. It read
           `IN ORDER 4` — sessions, days or hops, the reader had to guess. Every
           other view labels its own: `2 hops`, `8 claims`. */
        aside={
          <Num
            value={order.length}
            format="int"
            tone="dim"
            unit={COPY.intentViews.timeline.sessions}
          />
        }
      />

      {/* THE ORDERING CLAIM, STATED AS A ROW. The engine's own token, on the mono
          rail, so the sentence in the disclosure line below is checkable against
          something rather than merely asserted — which means it has to be READ
          OFF THE LINKS THIS VIEW WALKED. It was the literal `_session_follows`,
          authored here, while `orderFiber()` accepts `_session_precedes` too:
          a render carried by the inverse produced correctly ordered cards under
          a row naming a relation the engine never returned. */}
      <Tip content={COPY.intentViews.timeline.order.tip} className="u-block">
        <Row
          label={COPY.intentViews.timeline.order.label}
          value={<span className="mono ink-dim">{fiber.families.join(' · ')}</span>}
          mono
        />
      </Tip>

      <ol className="iv-tl__cards">
        {order.map((id, i) => {
          const node = nodes.get(id);
          const asset = assetOf(node);
          const previous = i === 0 ? null : assetOf(nodes.get(order[i - 1]));

          const fresh =
            asset === null ? null : asset.entity_ids.filter((e) => !seenBefore.has(e)).length;
          const dropped =
            asset === null || previous === null
              ? null
              : previous.entity_ids.filter((e) => !asset.entity_ids.includes(e)).length;
          const gap =
            asset === null || previous === null
              ? null
              : daysBetween(previous.boundary_declared_at, asset.boundary_declared_at);

          if (asset !== null) for (const e of asset.entity_ids) seenBefore.add(e);

          return (
            <li key={id} className="iv-tl__card">
              <div className="iv-tl__head">
                <span className="iv-tl__n caps ink-dim">
                  <Num value={i + 1} format="int" tone="dim" />
                </span>
                {asset === null ? (
                  <span className="iv-tl__when ink-dim t-12-5" data-prose>
                    {COPY.intentViews.timeline.undated}
                  </span>
                ) : (
                  <When iso={asset.boundary_declared_at} />
                )}
                <NodeName id={id} nodes={nodes} />
                {asset === null ? null : (
                  <span className="iv-tl__kind caps ink-dim">{asset.boundary_kind}</span>
                )}
              </div>

              {asset === null ? null : (
                <p className="iv-tl__summary t-12-5 ink-dim" data-prose>
                  {asset.summary}
                </p>
              )}

              {/* ---- what changed ------------------------------------------ */}
              <div className="iv-tl__changed">
                <Tip content={COPY.intentViews.timeline.changed.tip}>
                  <span className="iv-tl__clabel t-13 ink-dim">
                    {COPY.intentViews.timeline.changed.label}
                  </span>
                </Tip>

                {i === 0 ? (
                  <p className="t-12-5 ink-dim" data-prose>
                    {COPY.intentViews.timeline.first}
                  </p>
                ) : (
                  <div className="iv-tl__deltas">
                    {gap === null ? null : (
                      <Tip content={COPY.intentViews.timeline.gap.tip}>
                        <span className="iv-tl__delta t-12-5 ink-dim">
                          {COPY.intentViews.timeline.gap.label}{' '}
                          <Num
                            value={gap}
                            format="int"
                            tone="dim"
                            unit={COPY.intentViews.timeline.gap.unit}
                          />
                        </span>
                      </Tip>
                    )}
                    {fresh === null ? null : fresh === 0 ? (
                      <span className="iv-tl__delta t-12-5 ink-dim" data-prose>
                        {COPY.intentViews.timeline.nothingNew}
                      </span>
                    ) : (
                      <Tip content={COPY.intentViews.timeline.fresh.tip}>
                        <span className="iv-tl__delta t-12-5 ink-dim">
                          {COPY.intentViews.timeline.fresh.label}{' '}
                          <Num value={fresh} format="int" tone="render" />
                        </span>
                      </Tip>
                    )}
                    {dropped === null || dropped === 0 ? null : (
                      <Tip content={COPY.intentViews.timeline.dropped.tip}>
                        <span className="iv-tl__delta t-12-5 ink-dim">
                          {COPY.intentViews.timeline.dropped.label}{' '}
                          <Num value={dropped} format="int" tone="dim" />
                        </span>
                      </Tip>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <DerivedNote intent="timeline" />
    </div>
  );
}
