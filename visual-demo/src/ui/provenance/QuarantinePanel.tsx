/**
 * =============================================================================
 * QUARANTINE — the truth gate's own report card
 * =============================================================================
 *
 * This panel exists to be read by somebody who is deciding whether to trust the
 * system, and the thing that should make them relax is not a low number. It is
 * that the number is here at all, grouped by reason, with example ids they can
 * go and look at.
 *
 * AN ENGINE THAT ONLY REPORTS ITS SUCCESSES IS NOT AN INSTRUMENT, IT IS AN
 * ADVERTISEMENT. So: every relation the extractor produced, how many passed the
 * gate, how many did not, why, and — reported separately and never folded in —
 * how many were never gated at all because the structural class is exempt.
 *
 * -----------------------------------------------------------------------------
 * THE DENOMINATOR IS THE HONEST PART, AND IT IS PRINTED
 * -----------------------------------------------------------------------------
 * Roughly half this corpus's relations are the underscore-prefixed reading-order
 * skeleton, and they are exempt: `_follows` says "this passage came after that
 * one", which is a fact about a file, not a claim to verify. Dividing rejections
 * by the whole edge set would advertise a pass rate nobody earned. So the rate
 * comes from `truthGatedRate()`, which divides by
 * `total_edges - truth_gate_exempt_structural`.
 *
 * That was correct and unreadable. `2.8 %` sat under `Quarantined 182` and
 * `Relations extracted 12 910`, and 182/12 910 is 1.4% — so the honest figure
 * looked like a broken one, and the only denominator that reconciled it (6 613)
 * appeared nowhere in the frame. A reader who checks the arithmetic and finds it
 * failing stops trusting the whole instrument, which is the exact opposite of
 * what this panel is for. The rate now prints its own fraction beside it:
 *
 *     Rejection rate      2.8 %   182 / 6 613
 *
 * No sentence, no invented word — the two numbers that produce the percentage,
 * on the same line as the percentage.
 *
 * -----------------------------------------------------------------------------
 * VIOLET, NOT RED
 * -----------------------------------------------------------------------------
 * A rejected claim is not a failure of the system; it is the system working. Red
 * is fail-loud only. Quarantined relations are things the engine could not
 * substantiate — the frontier where what is known stops — which is exactly what
 * --curiosity marks everywhere else in the product. They render `latent` in the
 * terrain for the same reason: present as topology, not spent on, not deleted.
 * =============================================================================
 */

import { useState } from 'react';

import { COPY, quarantineReasonCopy } from '@/copy';
import { CONFIDENCE_FLOOR, truthGatedRate } from '@/engine';
import type { IntegrityResponse } from '@/engine';
import { useAtlas, useAtlasStore } from '@/state';
import {
  Btn,
  Divider,
  Meter,
  Num,
  Panel,
  Row,
  SectionLabel,
  Tip,
  cx,
} from '@/ui/primitives';

import { RepudiationLayer } from './RepudiationLayer';
import { Code, Fact, Note, ProvenanceChip, Why } from './bits';

export interface QuarantinePanelProps {
  integrity?: IntegrityResponse | null;
  showQuarantined?: boolean;
  /** Defaults to the store's `toggleQuarantined`. */
  onToggleQuarantined?: () => void;
  /**
   * Select the example relations in the terrain. Defaults to resolving the edge
   * ids against the current view and selecting both endpoints of each.
   * Returns how many were found, so the panel can say when none were.
   */
  onShowExamples?: (edgeIds: readonly string[]) => number;
  className?: string;
}

/**
 * Select the endpoints of the example relations, and stroke rejected claims so
 * the selection is actually visible.
 *
 * Edges are not nodes: the terrain's selection is a set of node ids, so the
 * honest translation of "show me this relation" is "select both of its ends".
 * When the edge is not in the current view there is nothing to select, and the
 * count returned says so rather than the control appearing to have worked.
 */
function selectExampleEndpoints(edgeIds: readonly string[]): number {
  const state = useAtlas.getState();
  const view = state.view;
  if (view === null) return 0;
  const wanted = new Set(edgeIds);
  const endpoints: string[] = [];
  for (const edge of view.edges) {
    if (!wanted.has(edge.id)) continue;
    endpoints.push(edge.from_id, edge.to_id);
  }
  const unique = [...new Set(endpoints)];
  if (unique.length === 0) return 0;
  if (!state.filters.showQuarantined) state.toggleQuarantined();
  unique.forEach((id, i) => state.selectNode(id, i > 0));
  return unique.length;
}

export function QuarantinePanel({
  integrity,
  showQuarantined,
  onToggleQuarantined,
  onShowExamples,
  className,
}: QuarantinePanelProps): JSX.Element {
  const store = useAtlasStore((s) => ({
    integrity: s.integrity,
    showQuarantined: s.filters.showQuarantined,
  }));

  const report = integrity !== undefined ? integrity : store.integrity;
  const stroking = showQuarantined !== undefined ? showQuarantined : store.showQuarantined;
  const [notFound, setNotFound] = useState<string | null>(null);

  if (report === null) {
    return (
      <Panel title={COPY.quarantine.title} className={cx('pv-panel', className)}>
        <Note>{COPY.common.notLoaded}</Note>
      </Panel>
    );
  }

  const { gated, rate } = truthGatedRate(report);
  const toggle = COPY.quarantine[stroking ? 'hide' : 'show'];

  const showExamples = (edgeIds: readonly string[]): void => {
    const found = onShowExamples ? onShowExamples(edgeIds) : selectExampleEndpoints(edgeIds);
    setNotFound(found === 0 ? edgeIds.join(' ') : null);
  };

  return (
    <>
    {/* The map's half of the repudiation, carried by every provenance surface so
        it never depends on which panel a host mounted. See `RepudiationLayer`. */}
    <RepudiationLayer />
    <Panel
      title={COPY.quarantine.title}
      tone="curiosity"
      className={cx('pv-panel', className)}
      /* ONE CORPUS MARKER, NOT FOUR. The badge was on every trust panel, which
         is three more than it needs to be to mean anything and enough to push
         this panel's own title into an ellipsis. It stays on the render trace —
         the panel that actually prints generated text — and the top bar carries
         the global one. */
      actions={
        <Btn
          variant="quiet"
          size="sm"
          tone="neutral"
          onClick={() => (onToggleQuarantined ? onToggleQuarantined() : useAtlas.getState().toggleQuarantined())}
          title={toggle.title}
        >
          {toggle.label}
        </Btn>
      }
      scroll
    >
      {/* The subtitle is a CLAIM ABOUT THE GRAPH — rejected relations are still
          in it — so it stays printed. The argument for why an engine should
          report its rejections at all is an argument, and it lives on the
          heading of the counts it is arguing for. */}
      <Note>{COPY.quarantine.subtitle}</Note>

      {/* ---- the counts ---------------------------------------------------
          THE FINDING LEADS; THE POPULATION FOLLOWS.

          These five figures were five `<Row>`s of identical weight with a
          hairline between each — the shape of a compliance form, in the one
          panel whose whole purpose is to be read voluntarily by a sceptic. And
          the shape inverted the argument: the rate, which is the finding, sat
          fifth, under four counts that only exist to explain its denominator.

          So the rate is a figure with its own fraction beside it and the gauge
          directly under it, and the four counts drop to a fact strip: a
          population, stated once, in two ink steps and one --curiosity for the
          frontier. ADMITTED IS NOT A GAUGE CONDITION — it was --ok, which spent
          the pass/fail light on a count that neither passes nor fails. */}
      <section className="pv-sec">
        <Why note={COPY.integrity.note}>
          <SectionLabel>{COPY.integrity.title}</SectionLabel>
        </Why>

        {/* THE RATE CARRIES ITS OWN FRACTION. See the header: the denominator
            is the whole argument of this panel and it was the one number not on
            screen. */}
        <Tip content={COPY.integrity.rows.rate.tip} className="pv-gate-tip">
          <span className="pv-gate-hd">
            <span className="pv-gate-l">{COPY.integrity.rows.rate.label}</span>
            <span className="pv-rate">
              <Num value={rate * 100} format="pct1" tone="neutral" className="pv-gate-v" />
              <span className="pv-rate-of">
                <Num value={report.quarantined} format="tokens" tone="faint" />
                <span className="pv-rate-slash">/</span>
                <Num value={gated} format="tokens" tone="faint" />
              </span>
            </span>
          </span>
        </Tip>
        {/* The gauge reads against the HONEST denominator, not the whole set:
            quarantined over `total_edges - truth_gate_exempt_structural`.
            Deliberately unlabelled — every figure it could print is on the line
            above it, and a gauge that repeats the number beside it is an
            instrument saying the same thing twice. */}
        <Meter value={report.quarantined} max={gated} tone="curiosity" />

        <div className="pv-facts pv-gate-pop">
          <Fact
            label={COPY.integrity.rows.total_edges.label}
            tip={COPY.integrity.rows.total_edges.tip}
          >
            <Num value={report.total_edges} format="tokens" tone="dim" />
          </Fact>
          <Fact label={COPY.integrity.rows.admitted.label} tip={COPY.integrity.rows.admitted.tip}>
            <Num value={report.admitted} format="tokens" tone="dim" />
          </Fact>
          <Fact
            label={COPY.integrity.rows.quarantined.label}
            tip={COPY.integrity.rows.quarantined.tip}
          >
            <Num value={report.quarantined} format="tokens" tone="curiosity" />
          </Fact>
          <Fact
            label={COPY.integrity.rows.truth_gate_exempt_structural.label}
            tip={COPY.integrity.rows.truth_gate_exempt_structural.tip}
          >
            <Num value={report.truth_gate_exempt_structural} format="tokens" tone="faint" />
          </Fact>
        </div>
      </section>

      <Divider />

      {/* ---- the rule -----------------------------------------------------
          The rule itself is a DEFINITION and stays. The paragraph explaining why
          structural relations are exempt is an argument for the definition, and
          it moves onto the exemption row it argues about — which is directly
          above, in the counts. */}
      <section className="pv-sec">
        <Why note={COPY.quarantine.gate.exemption}>
          <SectionLabel>{COPY.quarantine.gate.title}</SectionLabel>
        </Why>
        <Note>{COPY.quarantine.gate.rule}</Note>
        <Row
          label={COPY.quarantine.gate.floor.label}
          title={COPY.quarantine.gate.floor.tip}
          value={<Num value={CONFIDENCE_FLOOR} format="float2" tone="dim" />}
        />
        <Note>{COPY.quarantine.never}</Note>
      </section>

      <Divider />

      {/* ---- by reason ---------------------------------------------------- */}
      <section className="pv-sec">
        <Why note={COPY.integrity.byReason.note}>
          <SectionLabel>{COPY.integrity.byReason.title}</SectionLabel>
        </Why>
        {report.by_reason.length === 0 ? (
          <Note>{COPY.quarantine.empty}</Note>
        ) : (
          <ul className="pv-reasons">
            {report.by_reason.map((group) => {
              const copy = quarantineReasonCopy(group.reason);
              return (
                <li key={group.reason} className="pv-reason">
                  <div className="pv-reason-hd">
                    <Tip
                      content={
                        <>
                          <span className="pv-tip-title">{copy.short}</span>
                          <span className="pv-tip-body">{copy.long}</span>
                        </>
                      }
                    >
                      <span className="pv-reason-label">{copy.label}</span>
                    </Tip>
                    <Num value={group.count} format="int" tone="curiosity" />
                  </div>
                  <Meter value={group.count} max={report.quarantined} tone="curiosity" />
                  <Code code={group.reason} />
                  <div className="pv-examples">
                    <span className="pv-examples-l">{COPY.integrity.examples.label}</span>
                    {group.example_edge_ids.map((id) => (
                      <button
                        key={id}
                        type="button"
                        className="pv-edge-id"
                        title={COPY.integrity.examples.action.title}
                        onClick={() => showExamples([id])}
                      >
                        {id}
                      </button>
                    ))}
                    <Btn
                      variant="ghost"
                      size="sm"
                      tone="neutral"
                      onClick={() => showExamples(group.example_edge_ids)}
                      title={COPY.integrity.examples.action.title}
                    >
                      {COPY.integrity.examples.action.label}
                    </Btn>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {notFound === null ? null : (
          <div className="pv-notfound">
            <Note>{COPY.hud.emptyRung}</Note>
            <Code code={notFound} />
          </div>
        )}
      </section>
    </Panel>
    </>
  );
}
