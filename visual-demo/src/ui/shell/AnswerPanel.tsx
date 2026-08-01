/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE ANSWER TAB
 * =============================================================================
 *
 * What the render actually produced, arranged the way the QUESTION was asked, and
 * what that arrangement is worth.
 *
 * -----------------------------------------------------------------------------
 * WHAT LEFT THIS PANEL, AND WHY IT IS NOT DUPLICATED HERE
 * -----------------------------------------------------------------------------
 * The answer SENTENCE and the trust state are pinned in the task header above
 * every tab now, because a verification verdict is a property of the ANSWER and
 * has to travel with it onto every surface the answer appears on. Reprinting the
 * sentence here would put the same string on screen twice, forty pixels apart,
 * and give a reader two things to reconcile before they can start reading — which
 * is the failure this panel is being cut down to end, not one to reproduce.
 *
 * So this tab is now four things, in order of how sceptical a reader should be:
 *
 *   1  THE INTENT VIEW    the answer laid out as the kind of answer it is
 *   2  BY CONSTRUCTION    whether it matches the answer the corpus itself holds
 *   3  CONFIDENCE         the composite, with its decomposition folded
 *   4  RE-DERIVATION      an independent traversal, and whether the two agree
 *
 * -----------------------------------------------------------------------------
 * THE FIVE INTENTS STOPPED SHARING ONE LAYOUT
 * -----------------------------------------------------------------------------
 * Every intent used to render the same three things: the sentence, a numbered
 * list of hops, a gauge. The chip in the panel header said `Timeline` or
 * `Compare`, and nothing else on the screen did. That made the Timeline answer a
 * paragraph opening on `2019-03-04 -> 2020-01-11 -> …` with its four sessions
 * appearing nowhere as four things, and the Compare answer a restatement that two
 * subjects share a regulator, twice, with nothing distinguishing them.
 *
 * `./intents` holds one view per `QueryIntent`. Each one derives its structure
 * from what the render returned — the path, the citations, the node payloads —
 * and each one carries a sentence saying so. Read that directory's barrel for the
 * argument; the short version is that this is a visual demo of the architecture,
 * the interface is allowed to compose a reading of the trace, and it is obliged
 * to say when it has.
 *
 * -----------------------------------------------------------------------------
 * A RE-DERIVATION DISAGREEMENT IS A DISPUTE, WHETHER OR NOT THE APP IS DEGRADED
 * -----------------------------------------------------------------------------
 * `explain.verdict === 'differs'` used to reach this panel only through the app's
 * DEGRADED state, and DEGRADED is dismissible: pressing `Recover` cleared the
 * alarm band and left this panel printing `0.87` in render teal under a green
 * `Matches the by-construction answer` badge, over an answer the product had just
 * proved two of its own surfaces disagree about. The dismissal was of the BAND;
 * the contradiction was still in `explain`, and nothing here read it.
 *
 * It is read directly now. `differs` is a dispute on its own terms, it survives
 * dismissing the band, and it is only resolved by re-rendering clean or by
 * discarding the result — which is exactly the contract the pinned header states.
 * =============================================================================
 */

import { useEffect, useRef, useState } from 'react';

import { COPY, intentCopy, modeCopy } from '@/copy';
import { engine } from '@/engine';
import type { GraphNode, PathStep, QueryRenderResponse } from '@/engine';
import { useAtlas, useAtlasStore } from '@/state';
import { Disclosure, Meter, Num, Panel, Row, SectionLabel, Tip } from '@/ui/primitives';

import {
  BridgeView,
  CompareView,
  LookupView,
  SummariseView,
  TimelineView,
  type IntentViewProps,
} from './intents';

/** A stable empty path, so the resolver's effect does not re-fire on every render. */
const NO_PATH: readonly PathStep[] = Object.freeze([]);

/* -----------------------------------------------------------------------------
 * THE NODES THE ANSWER IS MADE OF, RESOLVED ONCE.
 *
 * This used to resolve LABELS, because a list of hops needs nothing else. The
 * intent views need the payloads: a comparison reads `entity_type`, `island_ids`,
 * `degree` and `mentions` off them, and a chronology reads `boundary_declared_at`
 * and `entity_ids`. Resolving them here rather than in five views means there is
 * exactly one answer to "what happens when a fetch fails" — the id stays in the
 * map's place, the views fall back to it, and nothing invents a label.
 * -------------------------------------------------------------------------- */

function useAnswerNodes(active: QueryRenderResponse | null): ReadonlyMap<string, GraphNode> {
  const viewNodes = useAtlasStore((s) => s.view?.nodes ?? null);
  const [nodes, setNodes] = useState<ReadonlyMap<string, GraphNode>>(() => new Map());

  const path = active?.constellation.path ?? NO_PATH;
  const bridgeId = active?.constellation.bridge_entity_id ?? null;

  useEffect(() => {
    const ids = new Set<string>();
    for (const step of path) {
      ids.add(step.from_id);
      ids.add(step.to_id);
    }
    if (bridgeId !== null) ids.add(bridgeId);

    /* The current view already holds most of them and is free. Only what it does
       not hold costs a call, and the client's cache has usually served it once
       already for the terrain. */
    const known = new Map<string, GraphNode>();
    for (const node of viewNodes ?? []) {
      if (ids.has(node.id)) known.set(node.id, node);
    }
    const missing = [...ids].filter((id) => !known.has(id));
    if (missing.length === 0) {
      setNodes(known);
      return;
    }

    let live = true;
    void Promise.all(
      missing.map((id) =>
        engine
          .getNode(id)
          .then((n) => n)
          .catch(() => null),
      ),
    ).then((fetched) => {
      if (!live) return;
      const next = new Map(known);
      for (const node of fetched) if (node !== null) next.set(node.id, node);
      setNodes(next);
    });
    return () => {
      live = false;
    };
  }, [path, bridgeId, viewNodes]);

  return nodes;
}

/**
 * The view for this intent.
 *
 * AN EXHAUSTIVE SWITCH, NOT A LOOKUP WITH A DEFAULT. A sixth intent added to the
 * engine's union must fail to compile here rather than quietly rendering the
 * bridge layout — which is precisely how five intents came to share one layout in
 * the first place.
 *
 * AND A STATED FALLBACK UNDERNEATH IT, because the compile-time guarantee was
 * being bought with a runtime crash. `QueryIntent` is enforced at the type level
 * only: `checkProvenance` does not validate the intent field on the wire, so a
 * value outside the union is reachable, and a switch with no default returns
 * `undefined` — which React turns into `Nothing was returned from render`,
 * taking the entire Answer tab down with it, including the failure banner that
 * would have said why. The `never` binding keeps the build failing on a sixth
 * union member; the paragraph after it keeps a malformed wire response to a
 * degraded render instead of a blank tab.
 */
function IntentView(props: IntentViewProps): JSX.Element {
  const intent = props.active.intent;
  switch (intent) {
    case 'lookup':
      return <LookupView {...props} />;
    case 'bridge':
      return <BridgeView {...props} />;
    case 'compare':
      return <CompareView {...props} />;
    case 'timeline':
      return <TimelineView {...props} />;
    case 'summarize':
      return <SummariseView {...props} />;
  }
  const unmodelled: never = intent;
  return (
    <p className="t-12-5 tone-alarm u-tone" data-prose>
      {COPY.intentViews.answerTab.unmodelledIntent}{' '}
      <span className="mono">{String(unmodelled)}</span>
    </p>
  );
}

/* =============================================================================
 * THE PANEL
 * ========================================================================== */

export interface AnswerPanelProps {
  className?: string;
}

export function AnswerPanel({ className }: AnswerPanelProps): JSX.Element | null {
  const { active, explain, verify, tampered, trace } = useAtlasStore((s) => ({
    active: s.query.active,
    explain: s.explain,
    verify: s.verify,
    tampered: s.tampered,
    trace: s.trace,
  }));

  const nodes = useAnswerNodes(active);

  /* THE VERDICT ARRIVES UNCLICKED.
     The strongest trust claim in the product — an independent re-traversal
     between the answer's own endpoints agreeing with the receipt — used to be
     three lines of past-tense prose above a button, which reads either as work
     that did not happen or as a result being kept behind a click. `runQuery` now
     runs it where the render is, so this effect is the safety net for the one
     case that does not go through a render: a view RESTORED FROM A LINK, which
     re-seats the same query_id with a null verdict. */
  const queryId = active?.query_id ?? null;
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (explain !== null) {
      asked.current = null;
      return;
    }
    if (queryId === null || asked.current === queryId) return;
    asked.current = queryId;
    void useAtlas.getState().explainPath();
  }, [queryId, explain]);

  if (active === null) {
    return (
      <Panel title={COPY.answer.title} className={className}>
        <p className="t-12-5 ink-dim" data-prose>
          {COPY.answer.empty}
        </p>
      </Panel>
    );
  }

  const stats = active.render_stats;

  /* ===========================================================================
   * THREE THINGS INVALIDATE A RESULT, AND ALL THREE REACH THIS PANEL DIRECTLY
   * ---------------------------------------------------------------------------
   * A broken signature, edited payload bytes, and an independent re-traversal
   * that contradicts the receipt. The third used to arrive only as the app's
   * DEGRADED state — which is dismissible — so dismissing the band restored a
   * fully-vouching panel over a contradicted answer. It is read from `explain`
   * now and cannot be dismissed, only resolved.
   * ======================================================================== */
  const failure =
    verify !== null && !verify.valid
      ? verify.payload_hash_matches
        ? COPY.trust.verify.invalidSignature
        : COPY.trust.verify.invalidPayload
      : null;
  const disagrees = explain?.verdict === 'differs';
  const disputed = failure !== null || tampered || disagrees;

  const matches = active.gold !== undefined && active.answer.includes(active.gold);

  const signals = [
    { key: 'semantic', value: stats.composite.semantic, copy: COPY.receipt.confidence.signals.semantic, standIn: true },
    { key: 'topology', value: stats.composite.topology, copy: COPY.receipt.confidence.signals.topology, standIn: false },
    { key: 'temporal', value: stats.composite.temporal, copy: COPY.receipt.confidence.signals.temporal, standIn: false },
    { key: 'authorial', value: stats.composite.authorial, copy: COPY.receipt.confidence.signals.authorial, standIn: false },
  ] as const;

  /* WHY THE BY-CONSTRUCTION ROW STOPS VOUCHING, IN THE FAILURE'S OWN WORDS.
     Three different things can silence it and they are three different
     sentences: bytes edited by the tamper control, a receipt that no longer
     verifies, and two engine surfaces contradicting each other. One generic
     `disputed` string for all three would tell the reader something happened and
     nothing about what. */
  const disputeLine = tampered
    ? COPY.trust.tamper.tampered
    : failure !== null
      ? failure.title
      : COPY.intentViews.answerTab.disputedByPath;

  return (
    <Panel
      title={COPY.answer.title}
      tone={disputed ? 'alarm' : 'render'}
      className={[className, disputed ? 'answer--disputed' : null].filter(Boolean).join(' ')}
      actions={
        <>
          <Tip content={intentCopy(active.intent).short}>
            <span className="caps ink-faint">{intentCopy(active.intent).label}</span>
          </Tip>
          <Tip content={modeCopy(active.mode).long}>
            <span className="caps ink-faint">{modeCopy(active.mode).label}</span>
          </Tip>
        </>
      }
    >
      {failure === null ? null : (
        <div className="answer__retracted">
          <span className="caps tone-alarm u-tone">{failure.badge}</span>
          <p className="t-14 tone-alarm u-tone" data-prose>
            {failure.title}
          </p>
          <p className="t-12-5 ink-dim" data-prose>
            {tampered ? COPY.trust.tamper.tampered : failure.body}
          </p>
        </div>
      )}

      {/* ---------------------------------------------------------------------
          THE RENDER LANDS IN THREE TIERS, AND THESE ARE THE TIERS.

          `data-reveal-tier` is read by ONE timeline in `@/motion` — the same one
          that lights the map — so the answer's own shape resolves in the rail on
          the same frame the fovea resolves on the terrain. The attribute is inert
          at rest: nothing here is styled by it unless a render is landing.

            0  fovea      the answer as the kind of answer it is
            1  penumbra   what it is worth
            2  periphery  the independent re-derivation
          -------------------------------------------------------------------- */}
      {/* THE DISPUTE REACHES THE FOVEA, NOT JUST THE TIERS BELOW IT.
          This panel withdrew L and stopped the gold row vouching, and passed the
          intent view nothing — so the answer's own structural claim was
          byte-identical either way: the route, the evidence chips, the citation
          counts and the table verdicts all kept vouching at full luminance over
          a result two engine surfaces disagree about. That is the same defect
          this panel's header names, one level down. `disputed` is a REQUIRED
          prop on `IntentViewProps`, so no view can be added that forgets it. */}
      <div data-reveal-tier="0">
        <IntentView active={active} nodes={nodes} trace={trace} disputed={disputed} />
      </div>

      {active.gold === undefined ? null : (
        <div className="answer__gold" data-disputed={disputed} data-reveal-tier="0">
          <Tip content={COPY.answer.goldTip}>
            <span className={`caps u-tone ${disputed ? 'tone-dim' : 'tone-evidence'}`}>
              {COPY.answer.goldLabel}
            </span>
          </Tip>
          <span className={`answer__goldv mono u-tone ${disputed ? 'tone-dim' : 'tone-evidence'}`}>
            {active.gold}
          </span>
          {/* IT STOPS VOUCHING. The comparison was scored before the dispute was
              known, so the verdict it produced is not a verdict any more. */}
          {disputed ? (
            <Tip content={COPY.trust.verify.separately}>
              <span className="t-11 tone-alarm u-tone" data-prose>
                {disputeLine}
              </span>
            </Tip>
          ) : (
            <Tip content={COPY.provenance.staged}>
              <span className={`t-11 u-tone ${matches ? 'tone-ok' : 'tone-alarm'}`} data-prose>
                {matches ? COPY.answer.matchesGold : COPY.answer.divergesFromGold}
              </span>
            </Tip>
          )}
        </div>
      )}

      {/* ---- confidence, with its decomposition folded --------------------- */}
      <SectionLabel>{COPY.receipt.confidence.title}</SectionLabel>
      {/* ONE HERO FIGURE, and a bare track beside it. The meter carries no label
          and no derived percentage on purpose: `0.87` and `87.0 %` next to each
          other are the same measurement printed twice, and a reader has to stop
          and check that they agree before they can move on.

          WITHDRAWN WHENEVER THE RESULT IS DISPUTED. L is the ENGINE'S claim about
          its own render. If the payload moved, it was measured over bytes that
          are gone; if the signature does not verify, the claim cannot be
          attributed to the engine that made it; and if an independent traversal
          contradicts the receipt, the render it was measured over is the thing in
          dispute. An em dash is the only honest reading in all three, and a
          `0.00` would be a measurement nobody took. */}
      <Tip content={COPY.receipt.confidence.L.tip} className="u-block">
        <div className="answer__L" data-reveal-tier="1">
          <Num
            value={disputed ? Number.NaN : stats.render_confidence_L}
            format="float2"
            tone={disputed ? 'alarm' : 'render'}
            className="t-28"
          />
          <Meter
            value={disputed ? 0 : stats.render_confidence_L}
            max={1}
            tone={disputed ? 'alarm' : 'render'}
          />
        </div>
      </Tip>

      {/* THE DECOMPOSITION IS FOLDED NOW, AND THAT IS A REVERSAL.
          The deck's older note argues the four signals belong beside the gauge
          rather than behind a click, and it is right about the stake: a high L
          over a thin composite is exactly the case worth seeing. It was wrong
          about the cost. On the rebuilt rail those four tracks sit between the
          answer and its verification, so every reader pays for a decomposition
          most of them never asked for, on every result, before reaching the thing
          they came for. Folded is not hidden — the summary names the case it
          exists for, and it is one press with native semantics behind it. */}
      <Disclosure
        summary={
          <Tip content={COPY.intentViews.answerTab.decomposition.title}>
            <span>{COPY.intentViews.answerTab.decomposition.label}</span>
          </Tip>
        }
        className="answer__fold"
      >
        <p className="t-11 ink-dim" data-prose>
          {COPY.intentViews.answerTab.decompositionNote}
        </p>
        {/* FOUR GAUGES IN A COLUMN INVITE EXACTLY ONE READING: down the column.
            They used to be sized to their own label text — the STAND-IN signal,
            the weakest-evidence proxy in the set, drew a track 1.8× longer than a
            component of the same value — which makes the only reading the layout
            invites the wrong one. One shared track, one 0..1 domain, one right
            edge; the CSS beside this file is what enforces it. */}
        <div className="answer__signals" data-disputed={disputed}>
          {signals.map((s) => (
            <Tip
              key={s.key}
              content={`${s.copy.tip} ${disputed ? COPY.intentViews.answerTab.withheldTip : ''}`.trim()}
              className="u-block"
            >
              <Meter
                className="answer__signal"
                value={disputed ? 0 : s.value}
                max={1}
                tone="dim"
                label={
                  <>
                    {s.copy.label}
                    {s.standIn ? <> · {COPY.common.standIn}</> : null}
                  </>
                }
                readout={<Num value={disputed ? Number.NaN : s.value} format="float2" tone="dim" />}
              />
            </Tip>
          ))}
        </div>
      </Disclosure>

      {/* ---- the independent re-derivation, already run ---------------------- */}
      <Tip content={COPY.answer.explain.note}>
        <SectionLabel>{COPY.answer.explain.title}</SectionLabel>
      </Tip>
      {explain === null ? (
        <p className="t-12-5 ink-dim" data-prose>
          {COPY.common.notRun}
        </p>
      ) : (
        <div className="answer__verdict" data-verdict={explain.verdict} data-reveal-tier="2">
          <span
            className={`caps ${
              explain.verdict === 'identical'
                ? 'tone-ok'
                : explain.verdict === 'differs'
                  ? 'tone-alarm'
                  : 'tone-dim'
            }`}
          >
            {COPY.answer.explain.verdicts[explain.verdict].label}
          </span>
          <p className="t-12-5 ink-dim" data-prose>
            {COPY.answer.explain.verdicts[explain.verdict].long}
          </p>
          {/* FIELD LABELS DO NOT TRUNCATE. These two rows used to elide to
              `Check…` and `Answ…` while printing their values in full, which is
              the priority exactly inverted: the value is unreadable without the
              name of the field it is in. The rows now wrap. */}
          <Row
            label={COPY.trust.verify.checkedAt.label}
            value={<span className="mono ink-faint">{explain.checked_at}</span>}
            mono
          />
          {explain.steps.length === 0 ? null : (
            <Row
              label={COPY.answer.path.title}
              value={<span className="mono ink-dim">{explain.steps.map((s) => s.family).join(' · ')}</span>}
              mono
            />
          )}
        </div>
      )}
    </Panel>
  );
}
