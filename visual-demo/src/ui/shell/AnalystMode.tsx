/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — ANALYST MODE
 * =============================================================================
 *
 * `G` THICKENS THE SAME SCREEN. It does not navigate anywhere, it does not open
 * a workspace, and it does not rearrange a single thing that was already on
 * screen. It adds instrumentation to the rail and one strip of live readouts
 * over the terrain, and `G` again takes them away.
 *
 * That is the whole design principle: DENSITY AVAILABLE ON DEMAND, NEVER FORCED.
 * The resting product is legible to somebody who has never seen it; the same
 * product with `G` held down is legible to somebody who is auditing it. If those
 * had to be two screens, the second one would be where the truth lives and the
 * first one would be the brochure.
 *
 * -----------------------------------------------------------------------------
 * EVERY READOUT HERE IS A DIFFERENCE, NOT A TOTAL
 * -----------------------------------------------------------------------------
 * Totals flatter. `4,406 nodes` says nothing; `431 stroked of 1,204 shipped,
 * under trade-route-skeleton` says the renderer made a choice and names it. So
 * the readouts are paired: drawn against payload, labels placed against labels
 * possible, quarantined against truth-gated. The gap is the product's argument.
 * =============================================================================
 */

import { useMemo } from 'react';

import { COPY, quarantineReasonCopy, sigmaCopy } from '@/copy';
import { CONFIDENCE_FLOOR, DENSITY_MODES, RELATION_FAMILIES, truthGatedRate } from '@/engine';
import type { DensityMode, SigmaClass } from '@/engine';
import { SigmaFilters } from '@/interaction';
import { useAtlas, useAtlasStore } from '@/state';
import { Chip, Disclosure, Num, Panel, Row, SectionLabel, Tip } from '@/ui/primitives';

/* =============================================================================
 * THERE IS NO ANALYST STRIP ANY MORE
 * -----------------------------------------------------------------------------
 * `G` used to bolt a full-width row of readouts over the terrain, and six of its
 * nine cells — nodes, relations, stroked, withheld, corridors, points — were
 * printed verbatim in the HUD about a hundred pixels below it. In Timeline Mode
 * that made four ranked-equal horizontal bars across the bottom of the frame,
 * none of which owned a story, while the terrain lost a quarter of the canvas
 * for the privilege.
 *
 * So Analyst Mode no longer adds a bar. It THICKENS THE ROW THAT IS ALREADY
 * THERE: the HUD grows labels-placed, corridors, points and draw calls while `G`
 * is on, and gives them back when it is off. Same figures, same source, one
 * instrument — which is what "density available on demand" was supposed to mean
 * in the first place.
 *
 * What remains here is the RAIL half, which is the half that carries controls
 * rather than duplicated readouts.
 * ========================================================================== */

/** Which relation families are actually present in the current payload. */
function useFamiliesInView(): { family: string; sigma: SigmaClass; count: number }[] {
  const edges = useAtlasStore((s) => s.view?.edges ?? null);
  return useMemo(() => {
    if (edges === null) return [];
    const counts = new Map<string, number>();
    for (const e of edges) counts.set(e.family, (counts.get(e.family) ?? 0) + 1);
    const sigmaOfFamily = new Map(RELATION_FAMILIES.map((f) => [f.family as string, f.sigma]));
    return [...counts.entries()]
      .map(([family, count]) => ({
        family,
        sigma: sigmaOfFamily.get(family) ?? ('structural' as SigmaClass),
        count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [edges]);
}

export function AnalystRail({ className }: { className?: string }): JSX.Element | null {
  const { open, density, reducedMotion, integrity, families, view, quarantineOpen } = useAtlasStore((s) => ({
    open: s.ui.analyst,
    density: s.density,
    reducedMotion: s.reducedMotion,
    integrity: s.integrity,
    families: s.filters.families,
    view: s.view,
    quarantineOpen: s.ui.quarantine,
  }));
  const present = useFamiliesInView();

  if (!open) return null;

  // `truthGatedRate` returns the honest denominator alongside the ratio:
  // structural relations were never gated and must not inflate the pass rate.
  const gate = integrity === null ? null : truthGatedRate(integrity);

  return (
    <div className={['arail', className].filter(Boolean).join(' ')}>
      {/* ---- the σ-class filter, from the interaction layer ---------------- */}
      <SigmaFilters />

      {/* ---- families actually present, most used first -------------------- */}
      <Panel title={COPY.analyst.familyFilter.title}>
        <p className="t-11 ink-faint" data-prose>
          {COPY.analyst.familyFilter.note}
        </p>
        {present.length === 0 ? (
          <p className="t-12-5 ink-dim" data-prose>
            {COPY.analyst.familyFilter.empty}
          </p>
        ) : (
          <div className="arail__families">
            {present.slice(0, 14).map((f) => (
              <Tip key={f.family} content={`${sigmaCopy(f.sigma).label} — ${sigmaCopy(f.sigma).short}`}>
                {/* A RELATION CLASS IS NOT A LIGHT. These filled with --render
                    when active, so a handful of clicks turned the rail into a
                    field of teal chips competing with the one teal thing that
                    matters, the rendered path on the map. The fill is the
                    state; ink carries it. */}
                <Chip
                  active={families.includes(f.family)}
                  tone={families.includes(f.family) ? 'neutral' : 'dim'}
                  count={f.count}
                  onClick={() => {
                    const s = useAtlas.getState();
                    const next = s.filters.families.includes(f.family)
                      ? s.filters.families.filter((x) => x !== f.family)
                      : [...s.filters.families, f.family];
                    s.setFamilyFilter(next);
                  }}
                >
                  {f.family}
                </Chip>
              </Tip>
            ))}
          </div>
        )}
      </Panel>

      {/* ---- the truth gate's report card ----------------------------------
              ONLY WHEN THE QUARANTINE PANEL IS NOT OPEN. The two printed the
              identical five rows about four hundred pixels apart, which is a
              reader being asked to check that an instrument agrees with itself.
              Quarantine is the panel whose subject this is; when it is open, it
              owns the block. */}
      {quarantineOpen ? null : (
      <Panel title={COPY.integrity.title}>
        <p className="t-11 ink-faint" data-prose>
          {COPY.integrity.note}
        </p>
        {integrity === null ? (
          <p className="t-12-5 ink-dim" data-prose>
            {COPY.common.notLoaded}
          </p>
        ) : (
          <>
            {/* ===============================================================
                FIVE ADJACENT FIGURES USED TO WEAR FOUR DIFFERENT COLOURS.
                Total in ink, admitted in --ok green, quarantined in --warn,
                the rate in --warn again and the exemption in faint — a
                traffic light where there is only one condition being
                reported. A count is not a condition: the number of relations
                the gate admitted is arithmetic, and painting it green says a
                gauge is reading healthy when nothing was being gauged.

                So the block is ink, and exactly ONE figure keeps a condition
                colour: what the gate REFUSED. That is the only line here that
                says something happened.
                =============================================================== */}
            <Tip content={COPY.integrity.rows.total_edges.tip} className="u-block">
              <Row
                label={COPY.integrity.rows.total_edges.label}
                value={<Num value={integrity.total_edges} format="int" tone="dim" />}
              />
            </Tip>
            <Tip content={COPY.integrity.rows.admitted.tip} className="u-block">
              <Row
                label={COPY.integrity.rows.admitted.label}
                value={<Num value={integrity.admitted} format="int" tone="dim" />}
              />
            </Tip>
            <Tip content={COPY.integrity.rows.quarantined.tip} className="u-block">
              <Row
                label={COPY.integrity.rows.quarantined.label}
                value={<Num value={integrity.quarantined} format="int" tone="warn" />}
              />
            </Tip>
            <Tip content={COPY.integrity.rows.rate.tip} className="u-block">
              <Row
                label={COPY.integrity.rows.rate.label}
                value={
                  <>
                    <Num value={(gate?.rate ?? Number.NaN) * 100} format="pct1" tone="dim" />
                    <span className="ink-faint"> {COPY.common.ofLabel} </span>
                    <Num value={gate?.gated ?? Number.NaN} format="int" tone="faint" />
                  </>
                }
              />
            </Tip>
            <Tip content={COPY.integrity.rows.truth_gate_exempt_structural.tip} className="u-block">
              <Row
                label={COPY.integrity.rows.truth_gate_exempt_structural.label}
                value={<Num value={integrity.truth_gate_exempt_structural} format="int" tone="faint" />}
              />
            </Tip>
            <Tip content={COPY.quarantine.gate.floor.tip} className="u-block">
              <Row
                label={COPY.quarantine.gate.floor.label}
                value={<Num value={CONFIDENCE_FLOOR} format="float2" tone="dim" />}
              />
            </Tip>

            <Disclosure summary={<SectionLabel>{COPY.integrity.byReason.title}</SectionLabel>}>
              <p className="t-11 ink-faint" data-prose>
                {COPY.integrity.byReason.note}
              </p>
              {integrity.by_reason.map((r) => (
                <Tip key={r.reason} content={quarantineReasonCopy(r.reason).long}>
                  <Row
                    label={
                      <>
                        {quarantineReasonCopy(r.reason).label}
                        <span className="mono ink-faint"> {r.reason}</span>
                      </>
                    }
                    value={<Num value={r.count} format="int" tone="dim" />}
                  />
                </Tip>
              ))}
            </Disclosure>
          </>
        )}
      </Panel>
      )}

      {/* THE FRAME BUDGET IS NOT HERE. It is on the HUD, which grows points and
          draw calls beside its permanent FPS and FRAME the moment `G` is on. A
          panel restating four figures printed forty pixels below it is the same
          mistake the analyst strip was. */}

      {/* ---- density and motion -------------------------------------------- */}
      <Panel title={COPY.analyst.density.title}>
        <p className="t-11 ink-faint" data-prose>
          {COPY.analyst.density.note}
        </p>
        <div className="arail__density">
          {DENSITY_MODES.map((d: DensityMode) => (
            <Tip key={d} content={COPY.analyst.density.modes[d].long}>
              <Chip
                active={density === d}
                tone={density === d ? 'neutral' : 'dim'}
                onClick={() => useAtlas.getState().setDensity(d)}
              >
                {COPY.analyst.density.modes[d].label}
              </Chip>
            </Tip>
          ))}
        </div>
        <Tip content={COPY.analyst.reducedMotion.tip} className="u-block">
          <Row
            label={COPY.analyst.reducedMotion.label}
            value={<span className="mono ink-dim">{String(reducedMotion)}</span>}
            mono
          />
        </Tip>
        {view === null ? null : (
          <Tip content={COPY.topbar.bake.tip} className="u-block">
            <Row
              label={COPY.topbar.bake.label}
              value={<span className="mono ink-faint">{view.bake_id}</span>}
              mono
            />
          </Tip>
        )}
      </Panel>
    </div>
  );
}

