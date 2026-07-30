/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE BOTTOM HUD
 * =============================================================================
 *
 * 40px, always on, never modal, entirely monospaced.
 *
 * THIS IS THE PRODUCT'S CONSCIENCE. Every other panel can be closed; this one
 * cannot, and everything on it is a number the engine or the renderer actually
 * measured. It is what proves the interface is not lying: if the terrain shows a
 * constellation, this row says how many relations were stroked out of how many
 * shipped. If a render happened, this row says what it cost against what the
 * naive alternative would have cost. If nothing has been rendered, this row says
 * so with an EM DASH — never with a zero, because a zero is a measurement and
 * "we have not measured this" is not.
 *
 * -----------------------------------------------------------------------------
 * THE HUD OWNS MEASUREMENT. THE RUNG LEGEND OWNS MEANING.
 * -----------------------------------------------------------------------------
 * Two instruments 100px apart printing one reading is worse than either of them
 * alone, because the reader stops to check that they agree. So the split is
 * absolute and it is stated here:
 *
 *   the legend  what this rung IS — the ontology, the corridors that only exist
 *               at a region rung, and the NAME of the rule that chose what is
 *               stroked ("Trade routes", "Answer constellation").
 *   the HUD     every FIGURE. Tokens, savings, latency, cache, nodes, stroked,
 *               relations, withheld, labels placed, the resolution partition,
 *               the frame budget, and the depth gauge.
 *
 * -----------------------------------------------------------------------------
 * A DRAW COUNT AND A PAYLOAD COUNT NEVER SHARE A LABEL
 * -----------------------------------------------------------------------------
 * This row printed `STROKED 254 / 262` at the world rung while the renderer's
 * own `FrameStats.edges` said it had laid down 38 strokes. Both numbers were
 * real; the label was not. `edges_drawn` is the payload minus what the truth
 * gate rejected — an ENGINE figure — and it was being shown under a word that
 * describes what the RENDERER did, in the one instrument whose whole job is to
 * prove that the interface does not lie about the engine. A 6.7× overstatement
 * in the conscience of the product is the worst possible place for one.
 *
 * So there are two cells now and each owns one fact:
 *
 *   STROKED    `frame.edges`, straight off the renderer. What is on the glass.
 *   RELATIONS  `edges_drawn / edge_count`. What the engine shipped, and how
 *              much of it the gate admitted.
 *
 * They are allowed to disagree, and at every rung they do: 38 strokes carrying
 * 254 admitted relations at the island rung, because relations bundle into
 * corridors and the rung's edge budget keeps only the busiest of those. With an
 * answer on screen the inequality flips — 9 strokes over 7 relations — because
 * each hop is drawn a second time as a road over its own relation. Both are the
 * truth about two different things, and the tooltips say which is which.
 *
 * Three things left this row when that line was drawn: the raw `drawn_reason`
 * code (the legend says it in words), the scope name (the breadcrumb in the top
 * bar is the thing you can click) and the whole Analyst strip, whose six figures
 * were verbatim copies of six that were already here. Analyst Mode now thickens
 * THIS row instead of stacking a second one over the terrain.
 *
 * -----------------------------------------------------------------------------
 * THE RESOLUTION RAMP IS A PARTITION, NOT A SAMPLE
 * -----------------------------------------------------------------------------
 * It is computed over `view.nodes` — the payload on screen — rather than over
 * the store's whole LOD map, which also holds tiers for nodes belonging to rungs
 * you have already left. The five figures therefore sum to NODES exactly, which
 * is the only way a reader who adds them up finds the instrument agreeing with
 * itself.
 *
 * -----------------------------------------------------------------------------
 * WHY THERE ARE TWO CACHE COUNTERS IN THIS PRODUCT AND ONLY ONE HERE
 * -----------------------------------------------------------------------------
 * `engine.cacheStats()` is the CLIENT's response cache, keyed by bake. The
 * receipt's `cache_hits` is the ENGINE's render memo for one query. They count
 * different work and must never be added together or presented as one number, so
 * the HUD prints the client's and the receipt prints the engine's, and both say
 * which in their tooltip.
 * =============================================================================
 */

import { useMemo } from 'react';

import { COPY } from '@/copy';
import { LOD_STATES, RUNGS, RUNG_DEPTH, RUNG_GLYPH } from '@/engine';
import type { LodState } from '@/engine';
import type { Terrain } from '@/graph';
import { useAtlasStore } from '@/state';
import { LodChip, Num, Tip } from '@/ui/primitives';

import { frameStatsOf, useEngineTelemetry } from './wiring';

/** A figure that has not been measured yet. `<Num>` renders non-finite as an em dash. */
const UNMEASURED = Number.NaN;

function Group({
  label,
  tip,
  children,
  className,
  hud,
}: {
  label: string;
  tip: string;
  children: React.ReactNode;
  className?: string;
  /** A stable hook so `audit()` can read this cell back off the screen. */
  hud?: string;
}): JSX.Element {
  return (
    <Tip content={tip}>
      <span className={['hud__group', className].filter(Boolean).join(' ')} data-hud={hud}>
        <span className="hud__label caps ink-faint">{label}</span>
        <span className="hud__value">{children}</span>
      </span>
    </Tip>
  );
}

export interface BottomHUDProps {
  /**
   * The live renderer, for the four figures only IT can measure.
   *
   * The store's `perf` slice is a 4Hz MEAN that a watchdog zeroes when frames
   * stop arriving, which is why this row printed two em dashes in twenty of
   * twenty-one captures while `window.__atlas.perf()` — the renderer's own
   * rolling stats, the ones the harness writes into report.json — held real
   * numbers the whole time. Two instruments, one reading, and the visible one
   * was blank. The HUD now reads the same object the harness reads, so the
   * screenshot and the report can no longer disagree.
   */
  terrain?: Terrain | null;
  className?: string;
}

export function BottomHUD({ terrain = null, className }: BottomHUDProps): JSX.Element {
  const { app, rung, view, active, perf, running, lod, analyst } = useAtlasStore((s) => ({
    app: s.app,
    rung: s.rung,
    view: s.view,
    active: s.query.active,
    perf: s.perf,
    running: s.query.running,
    lod: s.lod,
    analyst: s.ui.analyst,
  }));
  const { cache, lastLatencyMs } = useEngineTelemetry();

  const stats = active?.render_stats ?? null;
  const withheld = view === null ? UNMEASURED : view.stats.edge_count - view.stats.edges_drawn;

  /* The renderer's own stats. `perf` is read above purely so this component
     re-renders at the sampler's 4Hz — the FIGURES come from the renderer. */
  void perf;
  const frame = frameStatsOf(terrain);

  /* WHAT THE RENDERER ACTUALLY PUT ON THE SCREEN.
     `frame.edges` is set inside `draw()` and survives after it, so it is the
     count of strokes CURRENTLY on the terrain rather than a rate. Before the
     first draw there is no such count and this reads as an em dash — never as
     a zero, which would say the renderer had drawn nothing rather than that it
     had not yet drawn. `drawCalls` is the renderer's own proof it ran. */
  const strokes = frame.drawCalls > 0 ? frame.edges : UNMEASURED;

  /* THE PARTITION. Over the payload on screen, so the five figures sum to the
     NODES figure four cells to the left. A node with no tier recorded has not
     been spent on, which is exactly what `latent` means — it is not a gap. */
  const ramp = useMemo((): Record<LodState, number> | null => {
    if (view === null) return null;
    const out = { 'lod-0': 0, 'lod-1': 0, 'lod-2': 0, ghost: 0, latent: 0 } as Record<LodState, number>;
    for (const node of view.nodes) {
      const tier = lod[node.id];
      if (tier === 'lod-0' || tier === 'lod-1' || tier === 'lod-2' || tier === 'ghost') out[tier] += 1;
      else out.latent += 1;
    }
    return out;
  }, [view, lod]);

  return (
    <footer className={['hud', className].filter(Boolean).join(' ')} data-app={app} data-analyst={analyst}>
      {/* ---- the render budget. The product's whole claim, in one group. ---- */}
      <Group
        label={COPY.receipt.budget.rows.tokens_rendered.label}
        tip={`${COPY.receipt.budget.rows.tokens_rendered.tip} ${COPY.receipt.budget.rows.counterfactual_tokens.tip}`}
      >
        <Num value={stats?.tokens_rendered ?? UNMEASURED} format="tokens" tone="render" />
        <span className="hud__sep ink-faint">/</span>
        <Num
          value={stats?.counterfactual_tokens ?? UNMEASURED}
          format="tokens"
          tone="dim"
          unit={COPY.common.units.tokens}
        />
      </Group>

      <Group label={COPY.receipt.budget.rows.savings_pct.label} tip={COPY.receipt.budget.rows.savings_pct.tip}>
        <Num value={stats?.savings_pct ?? UNMEASURED} format="pct1" tone={stats === null ? 'dim' : 'render'} />
      </Group>

      {/* ---- what the wait actually was ------------------------------------ */}
      <Group label={COPY.topbar.latency.label} tip={COPY.topbar.latency.tip}>
        <Num value={running ? UNMEASURED : lastLatencyMs} format="ms" tone="dim" />
      </Group>

      <Group label={COPY.topbar.cache.label} tip={COPY.topbar.cache.tip} className="hud--xwide">
        <Num value={cache.hits} format="int" tone="dim" />
        <span className="hud__sep ink-faint">/</span>
        <Num value={cache.lookups} format="int" tone="dim" />
        <Num value={cache.lookups === 0 ? UNMEASURED : cache.hit_rate * 100} format="pct1" tone="faint" />
      </Group>

      {/* ---- graph vitals --------------------------------------------------- */}
      <Group label={COPY.analyst.readouts.nodes.label} tip={COPY.analyst.readouts.nodes.tip} hud="nodes">
        <Num value={view?.nodes.length ?? UNMEASURED} format="int" tone="dim" />
      </Group>

      {/* ===================================================================
          THE DRAW COUNT AND THE PAYLOAD COUNT ARE TWO DIFFERENT NUMBERS.

          This cell used to read `STROKED 254 / 262` at the world rung while
          the renderer's own FrameStats said it had laid down 38 strokes — a
          6.7× overstatement, in the one instrument whose entire job is to
          prove the interface is not lying about the engine. `edges_drawn` is
          computed as "payload minus quarantined": it is a PAYLOAD count, and
          it was being printed under a word that means DRAWN.

          Both numbers are real and both are worth having, so both are here
          and each carries its own noun. STROKED is the renderer's own count
          of what it put on the screen — at a corridor rung far smaller than
          the relation count, because relations bundle into corridors and only
          the highest-traffic corridors survive the rung's edge budget.
          RELATIONS is the payload: admitted over shipped. A reader can add
          254 + 8 = 262 and get the payload, and can count 38 lines on the map
          and get the strokes, and neither figure pretends to be the other.
          =================================================================== */}
      <Group label={COPY.hud.strokes.label} tip={COPY.hud.strokes.tip} hud="strokes">
        <Num value={strokes} format="int" tone="dim" />
      </Group>

      <Group label={COPY.hud.relations.label} tip={COPY.hud.relations.tip} hud="relations">
        <Num value={view?.stats.edges_drawn ?? UNMEASURED} format="int" tone="dim" />
        <span className="hud__sep ink-faint">/</span>
        <Num value={view?.stats.edge_count ?? UNMEASURED} format="int" tone="faint" />
      </Group>

      <Group label={COPY.analyst.readouts.withheld.label} tip={COPY.analyst.readouts.withheld.tip}>
        <Num value={withheld} format="int" tone="faint" />
      </Group>

      {/* ---- the resolution partition. It used to sit in the rung legend, in a
              1000px panel directly above a row that already carried half of it.
              One instrument, one reading: the legend says what a rung MEANS and
              this row says what it COST. --------------------------------- */}
      {ramp === null ? null : (
        <Tip content={COPY.ramp.subtitle}>
          <span className="hud__group hud--ramp hud--xwide" data-hud="ramp">
            <span className="hud__label caps ink-faint">{COPY.ramp.title}</span>
            {LOD_STATES.map((state: LodState) => (
              <span key={state} className="hud__tier" title={COPY.ramp.states[state].short}>
                {/* THE TIER NAME IS NOT A LIGHT.
                    These five chips carried `tone="render"` by default, which
                    put three teal boxes in the HUD of every capture. Teal has
                    exactly one job in this product — the engine's attention:
                    the rendered path, the active selection, the render control
                    — and a permanent row of teal tags for "Verbatim" and
                    "Label" is how teal stops meaning any of them. The ramp is
                    a resolution scale and it already carries its own weight
                    ladder: full at the fovea, 12% at latent. That IS the
                    reading, and in ink it is the only reading. */}
                <LodChip state={state} label={COPY.ramp.states[state].label} tone="neutral" />
                <Num value={ramp[state]} format="int" tone={ramp[state] === 0 ? 'faint' : 'dim'} />
              </span>
            ))}
          </span>
        </Tip>
      )}

      {/* ---- ANALYST MODE THICKENS THIS ROW. It does not stack a second one.
              These four are the only readouts the old floating strip carried
              that were not already here. ---------------------------------- */}
      {analyst ? (
        <>
          <Group
            label={COPY.analyst.readouts.labels.label}
            tip={COPY.analyst.readouts.labels.tip}
            className="hud--analyst"
          >
            <Num value={frame.labels} format="int" tone="dim" />
          </Group>
          <Group
            label={COPY.analyst.readouts.bundles.label}
            tip={COPY.analyst.readouts.bundles.tip}
            className="hud--analyst"
          >
            <Num value={view?.bundles.length ?? UNMEASURED} format="int" tone="dim" />
          </Group>
          <Group
            label={COPY.analyst.perf.points.label}
            tip={COPY.analyst.perf.points.tip}
            className="hud--analyst"
          >
            <Num value={frame.points} format="int" tone="dim" />
          </Group>
          <Group
            label={COPY.analyst.perf.drawCalls.label}
            tip={COPY.analyst.perf.drawCalls.tip}
            className="hud--analyst"
          >
            <Num value={frame.drawCalls} format="int" tone="dim" />
          </Group>
        </>
      ) : null}

      {/* THE RENDERER DRAWS ON DEMAND, so these are the rate and cost of the
          LAST SECOND OF RENDERING — which is exactly what the tooltip claims,
          and exactly what `window.__atlas.perf()` returns. Before any frame has
          been drawn there is no rate, and that reads as an em dash: not
          measured. It never reads as `0.0`, which would say the renderer had
          stalled rather than that it was still. */}
      <Group label={COPY.analyst.perf.fps.label} tip={COPY.analyst.perf.fps.tip} className="hud--wide">
        <Num value={frame.fps > 0 ? frame.fps : UNMEASURED} format="float1" tone="dim" />
      </Group>

      <Group label={COPY.analyst.perf.frameMs.label} tip={COPY.analyst.perf.frameMs.tip} className="hud--wide">
        <Num value={frame.fps > 0 ? frame.frameMs : UNMEASURED} format="ms" tone="dim" />
      </Group>

      {/* ---- the descent breadcrumb, as a depth gauge -----------------------
              The NAME of where you are is the top bar's clickable breadcrumb.
              This is the DEPTH, which is a measurement, and it is the only
              thing left here. */}
      <Tip content={COPY.topbar.breadcrumb.tip}>
        <span className="hud__group hud--descent">
          <span className="hud__label caps ink-faint">{COPY.topbar.breadcrumb.label}</span>
          <span className="hud__rungs">
            {RUNGS.map((r) => (
              <span key={r} className="hud__rung" data-here={r === rung} title={r}>
                {RUNG_GLYPH[r]}
              </span>
            ))}
          </span>
          <span className="hud__value">
            <Num value={RUNG_DEPTH[rung] + 1} format="int" tone="dim" />
            <span className="hud__sep ink-faint">/</span>
            <Num value={RUNGS.length} format="int" tone="faint" />
          </span>
        </span>
      </Tip>
    </footer>
  );
}
