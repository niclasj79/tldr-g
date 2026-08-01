/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE BOTTOM HUD
 * =============================================================================
 *
 * 40px, always on, never modal, entirely monospaced.
 *
 * THIS IS THE PRODUCT'S CONSCIENCE. Every other panel can be closed; this one
 * cannot, and everything on it is a number the engine or the renderer actually
 * measured. It is what proves the interface is not lying: if a render happened,
 * this row says what it cost against what the naive alternative would have cost.
 * If nothing has been rendered, this row says so with an EM DASH — never with a
 * zero, because a zero is a measurement and "we have not measured this" is not.
 *
 * -----------------------------------------------------------------------------
 * A CELL PRINTS WHEN ITS SUBJECT EXISTS. THIS IS THE CHANGE.
 * -----------------------------------------------------------------------------
 * A UX review found this row reading as "permanent debug instrumentation", and
 * the count is the argument: FIFTEEN CELLS before a question had been asked, of
 * which the first two printed em dashes, the fourth printed an em dash inside a
 * fraction, and one printed a figure that was simply WRONG.
 *
 * The em-dash law above is right and is not being weakened. What was missing is
 * the step before it: a cell whose subject does not yet EXIST should not be on
 * the row at all. `RENDERED — / — tok` is not an honest instrument at rest, it
 * is a promise that something will appear there, made fifteen times, at the one
 * moment the user has no way to evaluate any of it. The em dash is for a figure
 * that has a subject and has not been measured — `FPS` before the first frame of
 * a live terrain. It is not for a token count belonging to a render nobody has
 * asked for.
 *
 * So:
 *
 *   no corpus        one sentence. Nothing on this row has a subject.
 *   corpus, no query DESCENT · NODES · RESOLUTION · RENDER `not run`
 *   a render landed  the same four, plus the budget the render actually spent
 *   Analyze lens     all of the above, plus the renderer and graph-policy cells
 *
 * -----------------------------------------------------------------------------
 * THE BUG THIS ROW WAS PRINTING: `LAST CALL 0 ms` ON A COLD SESSION
 * -----------------------------------------------------------------------------
 * `engine.lastLatency` is a plain field that initialises to `0` and is written
 * at the end of `send()`. Before the first call there is nothing to report and
 * the field says `0`, so this row printed `0 ms` — a MEASUREMENT, of a call that
 * had never been made, in the instrument whose stated law two paragraphs up is
 * that a zero is never a stand-in for silence. It also falsified the empty
 * screen's own claim about this row.
 *
 * THE SUBJECT TEST IS WHAT FIXED IT, AND A SECOND GATE WAS WRITTEN THAT NEVER
 * FIRED. That gate was `cache.lookups === 0`, and the argument for it was sound
 * — every `send()` performs exactly one cache lookup before anything else, so
 * the counter is an exact "has any call ever been made". The argument is also
 * what proves it dead: the only reader was the `Last call` cell, which renders
 * inside `stats !== null`, which requires `query.active`, which requires a
 * `send()`. And `view !== null` — everything below the early return — already
 * requires one, because every view arrives through `getGraphView`. `clear()`
 * empties the map and leaves the counters, so `lookups` never returns to zero.
 * There is no state in which the gate changed a pixel. Deleted under INV-3: an
 * unreachable branch is not caution, it is an affordance the next reader has to
 * disprove. The real zero the gate was written to protect — a cache hit that
 * legitimately measures `0.00` — is still printed, because it is a measurement.
 *
 * -----------------------------------------------------------------------------
 * WHAT MOVED BEHIND THE ANALYZE LENS, AND WHAT DELIBERATELY DID NOT
 * -----------------------------------------------------------------------------
 * MOVED — every figure that describes HOW THE PICTURE WAS PRODUCED rather than
 * what the answer cost: stroked, relations, withheld, corridors, labels, points,
 * draw calls, FPS, frame time, and the client's response cache. Not one of them
 * changes what a reader should do next; all of them are how you audit a frame
 * once you have decided to audit a frame. That is a workspace, and the product
 * already has one, and it is now the only place they appear.
 *
 * STAYED — NODES and the RESOLUTION partition, and the reason is not
 * sentimental. They are the two halves of the sentence the terrain is making:
 * how much is here, and how much of it the engine has spent on. A reader looking
 * at a constellation and asking "is this everything?" is answered by those two
 * cells and by nothing else on the screen.
 *
 * They also carry a load nothing else can: `audit()` reads `[data-hud="nodes"]`
 * and `[data-hud="ramp"]` BACK OFF THE SCREEN and asserts that the five
 * resolution chips sum to the printed node count. That check is worth more than
 * the cells cost — it is the one assertion in the product that two visible
 * figures agree, rather than that two copies of one expression agree — and it
 * can only be made against figures a person can actually see. Hiding them behind
 * a lens while leaving them in the DOM would keep the audit green by measuring
 * pixels nobody is looking at, which is worse than deleting the check.
 *
 * -----------------------------------------------------------------------------
 * THE HUD OWNS MEASUREMENT. THE RUNG LEGEND OWNS MEANING.
 * -----------------------------------------------------------------------------
 * Two instruments 100px apart printing one reading is worse than either of them
 * alone, because the reader stops to check that they agree. So the split is
 * absolute: the legend says what a rung IS, this row says every FIGURE. The
 * failure BAND owns failure — this row does not carry a fifth `RENDER` reading
 * for it, because a full-width alarm in --alarm is not a state a 40px cell needs
 * to also mention.
 *
 * AND THE TERRAIN OWNS THE SELECTION COUNT — THIS ROW BROKE ITS OWN LAW.
 * A `SELECTED` cell was added here while `InteractionSurface` was already
 * printing `.ix-selection` over the terrain, from the same `hud.selectionLabel`,
 * measured live at 0.4% of the stage at 1920 and 0.8% at 1280. Two owners, and
 * they did not even agree in SHAPE: the chip prints `n of total` when the
 * marquee capped, this row printed only `n`, so a capped selection put two
 * different-looking figures for one fact on one screen.
 *
 * THE CHIP WINS AND THE CELL IS GONE, on three grounds and not on seniority.
 * It is beside the nodes it counts rather than at the far end of the frame; it
 * is the only one of the two that can report the cap, which is the half of the
 * fact that says something was left out; and it costs nothing at rest, because
 * it renders only above zero while this row is furniture that would have printed
 * `Selected 0` through every session that never selected anything.
 *
 * The row is measurably better for it: at 1280px the four remaining default
 * cells plus the resolution partition come to 1206px of a 1280px row, so the
 * partition no longer has to shed at the laptop width — and `audit()`'s ramp
 * assertion, which is vacuous whenever the partition is off screen, is a real
 * assertion again at the width `verify-shell.mjs` tests. Deleting a duplicate
 * bought back the row's one cross-surface check.
 *
 * -----------------------------------------------------------------------------
 * A DRAW COUNT AND A PAYLOAD COUNT NEVER SHARE A LABEL
 * -----------------------------------------------------------------------------
 * This row printed `STROKED 254 / 262` at the world rung while the renderer's
 * own `FrameStats.edges` said it had laid down 38 strokes. Both numbers were
 * real; the label was not. `edges_drawn` is the payload minus what the truth
 * gate rejected — an ENGINE figure — and it was being shown under a word that
 * describes what the RENDERER did. A 6.7× overstatement in the conscience of the
 * product is the worst possible place for one. STROKED is now `frame.edges`
 * straight off the renderer, RELATIONS is `edges_drawn / edge_count` off the
 * payload, and both live in the Analyze lens where a frame audit belongs.
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
 *
 * -----------------------------------------------------------------------------
 * NO FIGURE ON THIS ROW IS DECORATIVE — AND NEITHER IS ITS LABEL
 * -----------------------------------------------------------------------------
 * Four `<Num>`s here carried `tone="faint"` — the denominator of the cache hit
 * rate, the relation total, the whole withheld count, and the rung total. Faint
 * is the DECORATION step at 3:1 and is not allowed to carry text that states a
 * value; the withheld figure in particular was the only statement anywhere on
 * screen of how much legibility cost, rendered at the least legible step the
 * product has. They are all `dim` now. `check-discipline.mjs` §12 fails the
 * build on the pattern, which is how three of them were found.
 *
 * THE CHECK CANNOT SEE A LABEL, AND EVERY LABEL ON THIS ROW WAS FAINT. §12 tests
 * a Num carrying the faint tone; `.hud__label` is a span, so all seven labels in
 * the default row — eighteen with the appendix open — sat at --ink-faint, the
 * third ink step, at 11px, measured at 3.25:1 against this row's ground against a
 * 4.5:1 floor for text. The word `RENDER` is what identifies `not run` as a
 * RENDER state rather than a rung name, and it was two full steps less legible
 * than the reading it governs (6.07:1). The whole class moved to --ink-dim in
 * `instruments.css` §1 — the class, not the one new cell that exposed it, because
 * a per-cell override fixes one label and leaves six wrong. `.hud__sep` stays
 * faint by the same rule read the other way: a `/` between two figures is
 * punctuation, not a statement of a value.
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

/**
 * THE FLEX ITEMS OF THIS ROW ARE THE TOOLTIP ANCHORS, NOT THE CELLS.
 *
 * `<Tip>` wraps whatever it is given in its own `.tip-anchor` span, so every
 * layout property that has to act on a child of `.hud` — `margin-left: auto`,
 * `display: none` for the shed breakpoints — belongs on the ANCHOR. Put on the
 * inner `.hud__group` it is either inert or half-effective:
 *
 *   `.hud--descent { margin-left: auto }` in shell.css §5 never did anything.
 *   The gauge only LOOKED right-aligned because it was last in source order in
 *   a row that happened to be full; at any narrower payload it simply sat after
 *   the previous cell.
 *
 *   `.hud--wide { display: none }` hides the cell and leaves the anchor, which
 *   is a zero-width flex item that still collects a `--gap-section` on each
 *   side. A row that sheds four cells that way sheds their content and keeps
 *   128px of their whitespace.
 *
 * So `className` here lands on the anchor, and the shed ladder was rewritten
 * against `.hud__cell--wide` / `--xwide` in `instruments.css` at the SAME two
 * breakpoints — a relocation, not a re-tuning. It had to move rather than merely
 * be re-pointed: `.tip-anchor { display: inline-flex }` in primitives.css lands
 * after shell.css at equal specificity, so shell.css's own shed rules cannot win
 * on an anchor. Measured at 1440px with the Analyze lens open before the move:
 * six cells that should have shed were all still on the row, which overflowed by
 * 532px and clipped the render budget off the right-hand edge.
 */
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
  /** Goes on the tooltip ANCHOR — the actual flex item. See above. */
  className?: string;
  /** A stable hook so `audit()` can read this cell back off the screen. */
  hud?: string;
}): JSX.Element {
  return (
    <Tip content={tip} className={['hud__cell', className].filter(Boolean).join(' ')}>
      <span className="hud__group" data-hud={hud}>
        {/* NO INK CLASS. `.hud__label` is coloured once in `instruments.css` §1,
            because every label on this row is functional text and the step it
            was on is the decoration step. See the header. */}
        <span className="hud__label caps">{label}</span>
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
  /* NO `selection` HERE. The terrain's own chip owns that count — see the header
     — and not subscribing to it also means a marquee drag no longer repaints
     this row. */
  const { app, rung, view, active, perf, running, lod, analyst } = useAtlasStore((s) => ({
    app: s.app,
    rung: s.rung,
    view: s.view,
    active: s.query.active,
    perf: s.perf,
    running: s.query.running,
    lod: s.lod,
    /* THE LENS, NOT THE DERIVED FLAG. `ui.analyst` is a mirror the store keeps in
       step with `lens`; reading the mirror means this row can disagree with the
       segmented control in the top bar for exactly one render if the two ever
       fall out of step. There is one primary and this reads it. */
    analyst: s.lens === 'analyze',
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
     NODES figure immediately to its left. A node with no tier recorded has not
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

  /* THE RENDER'S OWN STATE, IN THREE READINGS AND NOT FOUR.
     There is no `failed` reading, and that is deliberate: a failure raises the
     full-width alarm band directly above this row, in --alarm, naming the code
     and the remedy. A 40px cell repeating it in one lowercase word would be the
     second owner of the loudest fact on the screen. */
  const renderState = running ? 'running' : active === null ? 'not-run' : 'done';

  /* NOTHING HAS A SUBJECT YET. Before a corpus there is no rung worth reporting,
     nothing to hold, nothing to count and nothing to have rendered — so the row
     states that in one sentence instead of printing five labels over five em
     dashes, which is a row of promises rather than a row of readings. */
  if (view === null) {
    return (
      <footer className={['hud', 'hud--quiet', className].filter(Boolean).join(' ')} data-app={app}>
        <span className="hud__idle t-11 ink-dim" data-prose>
          {COPY.instruments.hud.noSubject}
        </span>
      </footer>
    );
  }

  return (
    <footer className={['hud', className].filter(Boolean).join(' ')} data-app={app} data-analyst={analyst}>
      {/* ---- WHERE YOU ARE, AS A DEPTH GAUGE -------------------------------
              It used to sit at the far right behind `margin-left: auto`, after
              eleven figures about the render. It is the cell a reader consults
              most and the one that says what everything to its right is a
              measurement OF, so it leads.

              The NAME of the place is the top bar's clickable breadcrumb. This
              is the DEPTH, which is a measurement, which is why it is here. */}
      <Tip content={COPY.topbar.breadcrumb.tip} className="hud__cell hud__cell--level">
        <span className="hud__group">
          <span className="hud__label caps">{COPY.topbar.breadcrumb.label}</span>
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
            <Num value={RUNGS.length} format="int" tone="dim" />
          </span>
        </span>
      </Tip>

      {/* THERE IS NO `SELECTED` CELL. `InteractionSurface` prints that count
          over the terrain, beside the nodes it counts and carrying the marquee
          cap this row could not — see the header for the three grounds. */}

      {/* ---- HOW MUCH IS HERE, AND HOW MUCH OF IT WAS SPENT ON --------------
              Kept out of the Analyze lens on purpose; see the header. `audit()`
              reads both of these back off the screen and asserts the five chips
              sum to the node count, which is only a real check while both are
              visible to a person. */}
      <Group label={COPY.analyst.readouts.nodes.label} tip={COPY.analyst.readouts.nodes.tip} hud="nodes">
        <Num value={view.nodes.length} format="int" tone="dim" />
      </Group>

      {ramp === null ? null : (
        <Tip content={COPY.ramp.subtitle} className="hud__cell hud__cell--ramp">
          <span className="hud__group hud--ramp" data-hud="ramp">
            <span className="hud__label caps">{COPY.ramp.title}</span>
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
                <Num value={ramp[state]} format="int" tone="dim" />
              </span>
            ))}
          </span>
        </Tip>
      )}

      {/* ================= THE ANALYZE APPENDIX =============================
          Everything from here to the render group describes HOW THE PICTURE WAS
          PRODUCED. It used to be unconditional, which is what made this row read
          as debug instrumentation bolted to a product: nine figures about the
          renderer and the edge policy, at equal rank with the answer's cost,
          permanently, for a reader who has not asked a question yet.

          It is one workspace's appendix now. Analyst Mode still THICKENS THIS
          ROW rather than stacking a second one over the terrain — that argument
          has not changed and the floating strip is not coming back.
          =================================================================== */}
      {analyst ? (
        <>
          <Tip content={COPY.instruments.hud.analyst.tip} className="hud__cell hud__cell--seam">
            <span className="hud__group">
              <span className="hud__label caps ink-dim">{COPY.instruments.hud.analyst.label}</span>
            </span>
          </Tip>

          {/* THE DRAW COUNT AND THE PAYLOAD COUNT ARE TWO DIFFERENT NUMBERS —
              see the header. Both are here and each carries its own noun. */}
          <Group label={COPY.hud.strokes.label} tip={COPY.hud.strokes.tip} hud="strokes">
            <Num value={strokes} format="int" tone="dim" />
          </Group>

          <Group label={COPY.hud.relations.label} tip={COPY.hud.relations.tip} hud="relations">
            <Num value={view.stats.edges_drawn} format="int" tone="dim" />
            <span className="hud__sep ink-faint">/</span>
            <Num value={view.stats.edge_count} format="int" tone="dim" />
          </Group>

          <Group label={COPY.analyst.readouts.withheld.label} tip={COPY.analyst.readouts.withheld.tip}>
            <Num value={withheld} format="int" tone="dim" />
          </Group>

          <Group
            label={COPY.analyst.readouts.labels.label}
            tip={COPY.analyst.readouts.labels.tip}
            className="hud__cell--wide"
          >
            <Num value={frame.labels} format="int" tone="dim" />
          </Group>

          <Group
            label={COPY.analyst.readouts.bundles.label}
            tip={COPY.analyst.readouts.bundles.tip}
            className="hud__cell--wide"
          >
            <Num value={view.bundles.length} format="int" tone="dim" />
          </Group>

          <Group
            label={COPY.analyst.perf.points.label}
            tip={COPY.analyst.perf.points.tip}
            className="hud__cell--wide"
          >
            <Num value={frame.points} format="int" tone="dim" />
          </Group>

          <Group
            label={COPY.analyst.perf.drawCalls.label}
            tip={COPY.analyst.perf.drawCalls.tip}
            className="hud__cell--wide"
          >
            <Num value={frame.drawCalls} format="int" tone="dim" />
          </Group>

          {/* THE SAME DEAD GATE STOOD ON THE HIT RATE, and it goes for the same
              reason: this cell is below the `view === null` return, and a view
              only ever arrives through a `send()`, which looks the cache up
              first. `lookups` is never zero here, and a counter that cannot be
              zero does not get a zero branch. */}
          <Group label={COPY.topbar.cache.label} tip={COPY.topbar.cache.tip} className="hud__cell--xwide">
            <Num value={cache.hits} format="int" tone="dim" />
            <span className="hud__sep ink-faint">/</span>
            <Num value={cache.lookups} format="int" tone="dim" />
            <Num value={cache.hit_rate * 100} format="pct1" tone="dim" />
          </Group>

          {/* THE RENDERER DRAWS ON DEMAND, so these are the rate and cost of the
              LAST SECOND OF RENDERING — which is exactly what the tooltip claims,
              and exactly what `window.__atlas.perf()` returns. Before any frame
              has been drawn there is no rate, and that reads as an em dash: not
              measured. It never reads as `0.0`, which would say the renderer had
              stalled rather than that it was still. */}
          <Group label={COPY.analyst.perf.fps.label} tip={COPY.analyst.perf.fps.tip}>
            <Num value={frame.fps > 0 ? frame.fps : UNMEASURED} format="float1" tone="dim" />
          </Group>

          <Group
            label={COPY.analyst.perf.frameMs.label}
            tip={COPY.analyst.perf.frameMs.tip}
            className="hud__cell--xwide"
          >
            <Num value={frame.fps > 0 ? frame.frameMs : UNMEASURED} format="ms" tone="dim" />
          </Group>
        </>
      ) : null}

      {/* ---- THE RENDER, AND WHAT IT SPENT ---------------------------------
              The one group that is about the ANSWER rather than about the
              picture, so it holds the right end of the row where the rail and
              the answer are. The status word is always here; the budget figures
              arrive with the render that produced them and are absent before it,
              which is the whole of the "no em dashes before data exists" fix. */}
      <Tip content={COPY.instruments.hud.render.tip} className="hud__cell hud__cell--render">
        <span className="hud__group" data-hud="render">
          <span className="hud__label caps">{COPY.instruments.hud.render.label}</span>
          <span
            className={`hud__state ${renderState === 'running' ? 'ink' : 'ink-dim'}`}
            data-state={renderState}
          >
            {COPY.instruments.hud.render.states[renderState]}
          </span>
        </span>
      </Tip>

      {stats === null ? null : (
        <>
          <Group
            label={COPY.receipt.budget.rows.tokens_rendered.label}
            tip={`${COPY.receipt.budget.rows.tokens_rendered.tip} ${COPY.receipt.budget.rows.counterfactual_tokens.tip}`}
            hud="budget"
          >
            <Num value={stats.tokens_rendered} format="tokens" tone="render" />
            <span className="hud__sep ink-faint">/</span>
            <Num
              value={stats.counterfactual_tokens}
              format="tokens"
              tone="dim"
              unit={COPY.common.units.tokens}
            />
          </Group>

          <Group
            label={COPY.receipt.budget.rows.savings_pct.label}
            tip={COPY.receipt.budget.rows.savings_pct.tip}
          >
            <Num value={stats.savings_pct} format="pct1" tone="render" />
          </Group>

          {/* WHAT THE WAIT ACTUALLY WAS. An em dash only while a render is in
              flight, because then it is the CURRENT call's latency that has not
              been measured. There is no second gate for "no call has ever been
              made": this cell only exists inside `stats !== null`, which cannot
              be reached without one. See the header. */}
          <Group label={COPY.topbar.latency.label} tip={COPY.topbar.latency.tip} className="hud__cell--wide">
            <Num value={running ? UNMEASURED : lastLatencyMs} format="ms" tone="dim" />
          </Group>
        </>
      )}
    </footer>
  );
}
