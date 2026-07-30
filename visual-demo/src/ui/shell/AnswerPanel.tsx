/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE ANSWER
 * =============================================================================
 *
 * What the render produced, what it is worth, and how to disagree with it.
 *
 * The panel is ordered by how sceptical a reader should be, most sceptical
 * first: the answer, then whether it matches the by-construction answer the
 * corpus holds, then the engine's own confidence AND its decomposition, then the
 * chain of hops that carried it, then the control that re-derives that chain
 * independently and tells you when the two disagree.
 *
 * -----------------------------------------------------------------------------
 * THE GOLD ROW IS A DISCLOSURE, NOT A SCORE
 * -----------------------------------------------------------------------------
 * `gold` is present only for staged questions. Its presence says "this question
 * was set up in advance", which is exactly why the engine can be scored against
 * it rather than believed. So the row states the staging first and the verdict
 * second — a green tick with no explanation of where the truth came from is a
 * worse artifact than no tick at all.
 *
 * -----------------------------------------------------------------------------
 * CONFIDENCE IS SHOWN WITH ITS COMPOSITE, NEVER ALONE
 * -----------------------------------------------------------------------------
 * A high L over a thin composite is the single case a reader most needs to see,
 * so the four signals sit next to the gauge rather than behind a disclosure. The
 * semantic signal is a lexical stand-in in this build and says so, because a
 * substitute figure that does not announce itself is an invented one.
 * =============================================================================
 */

import { useEffect, useRef, useState } from 'react';

import { COPY, intentCopy, modeCopy } from '@/copy';
import { engine } from '@/engine';
import type { PathStep } from '@/engine';
import { useAtlas, useAtlasStore } from '@/state';
import { Chip, Meter, Num, Panel, Row, SectionLabel, Tip } from '@/ui/primitives';

/* -----------------------------------------------------------------------------
 * Labels for the path's endpoints. The view usually has them; anything it does
 * not is fetched through the client, which is already cached by bake.
 * -------------------------------------------------------------------------- */

function usePathLabels(path: readonly PathStep[]): Map<string, string> {
  const viewNodes = useAtlasStore((s) => s.view?.nodes ?? null);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const ids = new Set<string>();
    for (const step of path) {
      ids.add(step.from_id);
      ids.add(step.to_id);
    }
    const known = new Map<string, string>();
    for (const node of viewNodes ?? []) {
      if (ids.has(node.id)) known.set(node.id, node.label);
    }
    const missing = [...ids].filter((id) => !known.has(id));
    if (missing.length === 0) {
      setLabels(known);
      return;
    }
    let live = true;
    void Promise.all(
      missing.map((id) =>
        engine
          .getNode(id)
          .then((n) => [id, n.label] as const)
          .catch(() => [id, id] as const),
      ),
    ).then((pairs) => {
      if (!live) return;
      const next = new Map(known);
      for (const [id, label] of pairs) next.set(id, label);
      setLabels(next);
    });
    return () => {
      live = false;
    };
  }, [path, viewNodes]);

  return labels;
}

/* =============================================================================
 * THE PANEL
 * ========================================================================== */

export interface AnswerPanelProps {
  className?: string;
}

export function AnswerPanel({ className }: AnswerPanelProps): JSX.Element | null {
  const { active, explain, verify, tampered } = useAtlasStore((s) => ({
    active: s.query.active,
    explain: s.explain,
    verify: s.verify,
    tampered: s.tampered,
  }));

  const labels = usePathLabels(active?.constellation.path ?? []);

  /* THE VERDICT ARRIVES UNCLICKED.
     The strongest trust claim in the product — an independent re-traversal
     between the answer's own endpoints agreeing with the receipt — used to be
     three lines of past-tense prose above a button, which reads either as work
     that did not happen or as a result being kept behind a click. It is a local
     graph walk, it costs nothing, and it either agrees or it does not: so it
     runs when the answer lands and the panel prints what it found. The button
     that used to gate it is gone; `Explain the path` still exists as the scene
     the interaction layer drives, and it now expands what is already stated. */
  const queryId = active?.query_id ?? null;
  const asked = useRef<string | null>(null);
  useEffect(() => {
    // A verdict in hand clears the latch, so a view RESTORED FROM A LINK — which
    // re-seats the same query_id with a null verdict — re-derives rather than
    // printing `not run` under the heading that promises a comparison.
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
  const path = active.constellation.path;
  const matches = active.gold !== undefined && active.answer.includes(active.gold);

  /* ===========================================================================
   * A FAILED VERIFICATION INVALIDATES THE PRESENTATION. IT DOES NOT ANNOTATE IT.
   * ---------------------------------------------------------------------------
   * `verify-valid` and `verify-invalid` used to be the same picture apart from
   * one 210px card in the corner: the answer stayed at full luminance, the
   * confidence gauge kept reading 0.87 in --render teal, and a green badge kept
   * saying `Matches the by-construction answer` — over bytes the product had
   * just proved were edited after signing. That is worse than having no
   * verification at all, because the frame actively vouches for a payload it has
   * disproved.
   *
   * A payload-hash failure means the answer, the confidence and the path are
   * exactly the things that can no longer be trusted, so they are exactly what
   * changes: the sentence is struck, the composite is withdrawn to an em dash —
   * not measured, because it was measured over bytes that are gone — and the
   * by-construction row stops vouching and starts naming which half failed.
   * ======================================================================== */
  const failure =
    verify !== null && !verify.valid
      ? verify.payload_hash_matches
        ? COPY.trust.verify.invalidSignature
        : COPY.trust.verify.invalidPayload
      : null;
  const disputed = failure !== null || tampered;
  /* The signature half can fail while the payload is intact. Then the CONTENT is
     still the content the engine rendered — it simply cannot be attributed to
     that engine — so the answer is not struck, only the attribution is. */
  const payloadMoved = tampered || (verify !== null && !verify.payload_hash_matches);

  const signals = [
    { key: 'semantic', value: stats.composite.semantic, copy: COPY.receipt.confidence.signals.semantic, standIn: true },
    { key: 'topology', value: stats.composite.topology, copy: COPY.receipt.confidence.signals.topology, standIn: false },
    { key: 'temporal', value: stats.composite.temporal, copy: COPY.receipt.confidence.signals.temporal, standIn: false },
    { key: 'authorial', value: stats.composite.authorial, copy: COPY.receipt.confidence.signals.authorial, standIn: false },
  ] as const;

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
          that lights the map — so the answer sentence resolves in the rail on
          the same frame the fovea resolves on the terrain. The attribute is
          inert at rest: nothing in this panel is styled by it unless a render is
          actually landing.

            0  fovea      the answer itself, and the by-construction check
            1  penumbra   what it is worth, and the chain that carried it
            2  periphery  the independent re-derivation

          The order is the resolution ramp read as a sequence, which is why it is
          this order and not "most important first" — they are the same list.
          -------------------------------------------------------------------- */}
      <p className="answer__text t-16" data-prose data-struck={payloadMoved} data-reveal-tier="0">
        {active.answer}
      </p>

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
          {/* IT STOPS VOUCHING. The comparison was scored against bytes that have
              since moved, so the verdict it produced is not a verdict any more. */}
          {disputed ? (
            <Tip content={COPY.trust.verify.separately}>
              <span className="t-11 tone-alarm u-tone" data-prose>
                {failure === null ? COPY.trust.tamper.tampered : failure.title}
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

      {/* ---- confidence, with its decomposition beside it ------------------ */}
      <SectionLabel>{COPY.receipt.confidence.title}</SectionLabel>
      {/* ONE HERO FIGURE, and a bare track beside it. The meter carries no label
          and no derived percentage on purpose: `0.87` and `87.0 %` next to each
          other are the same measurement printed twice, and a reader has to stop
          and check that they agree before they can move on.

          WITHDRAWN WHEN THE PAYLOAD MOVED. L is a composite over the answer, the
          citations and the admissions. If those bytes changed, the figure was
          measured over something that is no longer on screen, and an em dash is
          the only honest reading. */}
      <Tip content={COPY.receipt.confidence.L.tip} className="u-block">
        <div className="answer__L" data-reveal-tier="1">
          <Num
            value={payloadMoved ? Number.NaN : stats.render_confidence_L}
            format="float2"
            tone={payloadMoved ? 'alarm' : 'render'}
            className="t-28"
          />
          <Meter
            value={payloadMoved ? 0 : stats.render_confidence_L}
            max={1}
            tone={payloadMoved ? 'alarm' : 'render'}
          />
        </div>
      </Tip>
      {/* THE WEIGHTS LIVE ON THE RECEIPT, NOT HERE. Printing signal, value and
          weight on one 320px row wrapped every label onto two lines and turned
          four gauges into eight rules. The receipt is the panel whose job is the
          full arithmetic; this one only has to show that the composite is thin
          or thick, which four labelled tracks do at a glance. */}
      {/* FOUR GAUGES IN A COLUMN INVITE EXACTLY ONE READING: down the column.
          They used to be sized to their own label text — the STAND-IN signal,
          the weakest-evidence proxy in the set, drew a track 1.8× longer than a
          component of the same value — which makes the only reading the layout
          invites the wrong one. One shared track, one 0..1 domain, one right
          edge; the CSS beside this file is what enforces it. */}
      <div className="answer__signals" data-disputed={payloadMoved} data-reveal-tier="1">
        {signals.map((s) => (
          <Tip key={s.key} content={`${s.copy.tip} ${COPY.receipt.confidence.note}`} className="u-block">
            <Meter
              className="answer__signal"
              value={payloadMoved ? 0 : s.value}
              max={1}
              tone="dim"
              label={
                <>
                  {s.copy.label}
                  {s.standIn ? <> · {COPY.common.standIn}</> : null}
                </>
              }
              readout={<Num value={payloadMoved ? Number.NaN : s.value} format="float2" tone="dim" />}
            />
          </Tip>
        ))}
      </div>

      {/* ---- the chain ------------------------------------------------------ */}
      <SectionLabel>{COPY.answer.path.title}</SectionLabel>
      {path.length === 0 ? (
        <p className="t-12-5 ink-dim" data-prose>
          {COPY.answer.path.empty}
        </p>
      ) : (
        <ol className="answer__path" data-reveal-tier="1">
          {path.map((step) => (
            <li key={step.edge_id} className="answer__hop">
              <span className="answer__hopn caps ink-faint">
                {COPY.answer.path.hop}
                <Num value={step.index + 1} format="int" tone="faint" />
              </span>
              <button
                type="button"
                className="answer__node"
                onClick={() => useAtlas.getState().selectNode(step.from_id, false)}
              >
                {labels.get(step.from_id) ?? step.from_id}
              </button>
              {/* THE FAMILY IS A CLASSIFICATION, NOT A LIGHT. It wore --render
                  on every hop of every answer, which put two or three teal
                  machine codes in the rail beside the one teal thing the frame
                  is about — the path itself, on the map. The relation between
                  two nodes is named in ink; what is lit is where the engine
                  went. */}
              <span className="answer__family mono ink-dim">{step.family}</span>
              <button
                type="button"
                className="answer__node"
                onClick={() => useAtlas.getState().selectNode(step.to_id, false)}
              >
                {labels.get(step.to_id) ?? step.to_id}
              </button>
              {step.crosses_strait ? (
                <Tip content={COPY.answer.path.straitTip}>
                  {/* A STRAIT CROSSING IS NOT A GAP. Violet in this product
                      means the question and what is not known — staged and
                      unspent, omitted but connected. This is the opposite: it
                      is the strongest thing the answer says about itself, and
                      it was wearing the light for absence. It stands out by
                      LUMINANCE now, against the faint labels either side of
                      it, which is the same move the failure sentence makes. */}
                  <span className="answer__strait caps">{COPY.answer.path.strait}</span>
                </Tip>
              ) : null}
              {step.evidence_passage_ids.length === 0 ? (
                <span className="caps tone-alarm u-tone">{COPY.answer.path.noEvidence}</span>
              ) : (
                <Tip content={COPY.answer.path.evidence}>
                  <Chip
                    tone="evidence"
                    count={step.evidence_passage_ids.length}
                    onClick={() => void useAtlas.getState().openPassage(step.evidence_passage_ids[0])}
                  >
                    {COPY.answer.path.evidence}
                  </Chip>
                </Tip>
              )}
            </li>
          ))}
        </ol>
      )}

      {active.constellation.bridge_entity_id === null ? null : (
        <Tip content={COPY.answer.bridge.tip} className="u-block">
          <Row
            label={COPY.answer.bridge.label}
            value={
              <button
                type="button"
                className="answer__node"
                onClick={() =>
                  useAtlas.getState().selectNode(active.constellation.bridge_entity_id as string, false)
                }
              >
                {labels.get(active.constellation.bridge_entity_id) ??
                  active.constellation.bridge_entity_id}
              </button>
            }
            tone="curiosity"
          />
        </Tip>
      )}

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
