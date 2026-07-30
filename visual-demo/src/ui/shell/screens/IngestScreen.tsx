/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — INGESTING / SETTLING
 * =============================================================================
 *
 * THERE IS NO PROGRESS BAR ON THIS SCREEN AND THERE NEVER WILL BE.
 *
 * A progress bar is a promise about the future made by a component that cannot
 * keep it. What this screen shows instead is a LEDGER OF COMPLETED WORK: five
 * named phases of the real corpus build, each with the real elapsed milliseconds
 * the engine measured for it, appearing as they land. A phase with no figure has
 * not finished; it shows a pending dot and NO NUMBER, because a number that is
 * not a measurement is the thing this whole product is against.
 *
 *   build      buildWorld        corpus generation
 *   validate   validateWorld     every passage hash re-checked against bytes
 *   bake       the layout bake   positions frozen once, for the whole session
 *   integrity  computeIntegrity  the truth gate's report card
 *   index      positions, spatial index, precomputed corridors
 *
 * -----------------------------------------------------------------------------
 * TWO PHASES, TWO LEDGERS, NO OVERLAP
 * -----------------------------------------------------------------------------
 * Both cards used to print all five timings and the same total, which made two
 * named sequential states show one identical dataset — in a product whose one
 * differentiator is that its numbers are real. They are now split by WHAT THE
 * WORK IS, and neither card carries the other's figures:
 *
 *   INGESTING   build · validate · integrity — the corpus. Bytes read, passage
 *               hashes re-checked, the truth gate's pass over the relations.
 *   SETTLING    bake · index — the layout. Plus the total, the anchor drift and
 *               the count of nodes this ingest put on screen.
 *
 * The anchor drift is the instrument confessing how much your spatial memory
 * actually broke. A first bake has no previous layout to anchor against, so
 * there is nothing to measure and it prints an em dash — the same mark every
 * unmeasured figure in this product prints — rather than the word "none", which
 * a reader cannot tell from a measurement of zero.
 *
 * Nothing here is a `setTimeout`. Every phase figure comes from
 * `getFixtureTimings()`, which is populated by the engine as the work completes.
 * =============================================================================
 */

import { COPY } from '@/copy';
import { meanDriftPercent } from '@/engine';
import type { FixtureTimings } from '@/engine';
import { useAtlasStore } from '@/state';
import { Meter, Num, Panel, Row, StateDot, Tip } from '@/ui/primitives';

/**
 * The five phases, in the order the engine performs them.
 *
 * The row label is the ENGINE'S OWN FIELD NAME with its unit suffix taken off —
 * `build_ms` reads `build` — rather than a phrase written here. It is a machine
 * name, it is monospaced like one, and it cannot drift from the field it reports
 * because it IS the field.
 */
const CORPUS_PHASES = ['build_ms', 'validate_ms', 'integrity_ms'] as const;
const LAYOUT_PHASES = ['bake_ms', 'index_ms'] as const;

type PhaseKey = (typeof CORPUS_PHASES)[number] | (typeof LAYOUT_PHASES)[number];

function phaseName(key: keyof FixtureTimings): string {
  return key.replace(/_ms$/, '');
}

export function IngestScreen(): JSX.Element {
  const { app, timings, bake, ingested } = useAtlasStore((s) => ({
    app: s.app,
    timings: s.timings,
    bake: s.bake,
    ingested: s.ingestedIds.length,
  }));

  const settling = app === 'SETTLING';
  const state = settling ? COPY.states.SETTLING : COPY.states.INGESTING;
  const total = timings?.total_ms ?? Number.NaN;
  const drift =
    bake === null || bake.anchor_alignment === null
      ? null
      : meanDriftPercent(bake.anchor_alignment, bake.bounds);

  return (
    <div className="ingest">
      <Panel title={state.title} className="ingest__plate" tone="render">
        <p className="t-14 ink-dim" data-prose>
          {state.body}
        </p>
        <p className="t-11 ink-faint" data-prose>
          {state.note}
        </p>

        {/* EACH CARD OWNS ITS OWN WORK. See the header: the ingest ledger is the
            corpus, the settle ledger is the layout, and neither prints the
            other's milliseconds. */}
        <ol className="ingest__ledger">
          {((settling ? LAYOUT_PHASES : CORPUS_PHASES) as readonly PhaseKey[]).map((key) => {
            const ms = timings === null ? null : timings[key];
            const done = ms !== null && Number.isFinite(ms);
            return (
              <li key={key} className="ingest__phase" data-done={done}>
                <StateDot state={done ? 'on' : 'pending'} />
                <span className="ingest__pname mono">{phaseName(key)}</span>
                {/* No figure until the engine has one. Never a placeholder. */}
                {done ? (
                  <Num value={ms} format="ms" tone="dim" />
                ) : (
                  <span className="ingest__pending caps ink-faint">{COPY.common.notRun}</span>
                )}
                {done && Number.isFinite(total) && total > 0 ? (
                  <Meter value={ms} max={total} tone="render" />
                ) : (
                  <span />
                )}
              </li>
            );
          })}
          {settling ? (
            <li className="ingest__phase ingest__phase--total" data-done={Number.isFinite(total)}>
              <StateDot state={Number.isFinite(total) ? 'on' : 'pending'} />
              <span className="ingest__pname mono">{phaseName('total_ms')}</span>
              <Num value={total} format="ms" tone="render" />
              <span />
            </li>
          ) : null}
        </ol>

        {settling ? (
          <>
            <Tip content={COPY.topbar.bake.drift.tip} className="u-block">
              <Row
                label={COPY.topbar.bake.drift.label}
                value={
                  /* NO PREVIOUS BAKE, NO MEASUREMENT. An em dash, which is what
                     every unmeasured figure in this product prints — not the
                     word "none", which reads as a measured zero. */
                  <Num
                    value={drift ?? Number.NaN}
                    format="pct1"
                    tone={drift !== null && drift > 5 ? 'warn' : 'dim'}
                  />
                }
              />
            </Tip>
            {/* `ingestedIds` is every node id this ingest put on screen for the
                first time — not passages, not documents. It is labelled with the
                readout that means exactly that, because the first version of
                this row called them passages and they are not. */}
            <Tip content={COPY.analyst.readouts.nodes.tip} className="u-block">
              <Row
                label={COPY.analyst.readouts.nodes.label}
                value={<Num value={ingested} format="int" tone="dim" />}
              />
            </Tip>
            {bake === null ? null : (
              <Row
                label={COPY.topbar.bake.label}
                value={<span className="mono ink-faint">{bake.bake_id}</span>}
                mono
              />
            )}
          </>
        ) : (
          /* WHAT HAS ACTUALLY ARRIVED, while it is arriving. The ingest card's
             own claim is that nothing on it is a progress animation — so it
             counts the nodes that have landed, which is a measurement, instead
             of quoting a bake that has not happened yet. */
          <Tip content={COPY.analyst.readouts.nodes.tip} className="u-block">
            <Row
              label={COPY.analyst.readouts.nodes.label}
              value={<Num value={ingested} format="int" tone="render" />}
            />
          </Tip>
        )}
      </Panel>
    </div>
  );
}
