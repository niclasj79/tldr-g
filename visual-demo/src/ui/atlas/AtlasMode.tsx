/**
 * =============================================================================
 * ATLAS MODE — the guided four-rung descent
 * =============================================================================
 *
 * The screen that sells the idea: zoom in this product does not magnify pixels,
 * it CHANGES WHAT THINGS ARE. Continents become islands become documents become
 * verbatim spans, under one continuous camera, and Atlas Mode walks a stranger
 * down that spine one rung at a time with one calm line of copy per stop.
 *
 * -----------------------------------------------------------------------------
 * IT IS A PANEL IN THE RAIL, NOT A SECOND COLUMN OVER THE MAP
 * -----------------------------------------------------------------------------
 * This mode used to float its own 300px column on top of the terrain, beside a
 * rail that was already 368px wide. Two columns of chrome, and one of them was
 * standing on the subject: with Atlas Mode open the honest unobstructed-terrain
 * figure was 69.3–69.7%, under the product's own 70% floor, while `audit()`
 * measured the canvas rect and certified 80.4%.
 *
 * A mode whose entire argument is that the map is the product may not take a
 * sixth of the map to say so. It renders in the rail now — same panel, same
 * ledger, same altimeter, at the width that column already had — so opening it
 * costs the terrain nothing at all and the audit's true reading and its
 * certified reading are the same number.
 *
 * -----------------------------------------------------------------------------
 * THE ALTIMETER IS A REAL GAUGE
 * -----------------------------------------------------------------------------
 * The four stops on the left are the spine. The band under them is the live
 * altitude of the camera, measured as a ratio against the zoom the current rung
 * was framed at, with the two thresholds that decide a rung change drawn on it.
 * Every number in it comes off `terrain.camera` or off design-tokens.css §15 —
 * there is no invented scale and no decorative needle. It is also the only place
 * in the product where the HYSTERESIS is visible: you can watch the altitude
 * travel a factor of six and a half between the two thresholds and see for
 * yourself why the boundary does not flicker.
 *
 * -----------------------------------------------------------------------------
 * WHY THE JOURNEY DOES NOT START ITSELF
 * -----------------------------------------------------------------------------
 * Opening Atlas Mode arms the descent; it does not run it. A panel that starts
 * flying the camera the instant it mounts makes every `atlas-*` screenshot a
 * photograph of a transition, and a visual-QA pass that cannot bring the product
 * to rest certifies nothing. So the mode opens at rest, showing where you are,
 * what is below you and what one press will do — and the press runs the whole
 * journey from there, resting `--atlas-dwell` on each rung.
 *
 * ESCAPING LEAVES YOU WHERE YOU ARE. Not where you started. Taking manual
 * control — Descend, Ascend, or closing the panel — stops the guided run
 * immediately and hands the camera back at the rung currently on screen. There
 * is no snap-back, because a snap-back would throw away the place the user
 * stopped at to look at something.
 * =============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { RUNGS, RUNG_DEPTH } from '@/engine';
import type { GraphNode, Rung } from '@/engine';
import { COPY, rungCopy } from '@/copy';
import { subscribeTerrain, type Terrain } from '@/graph';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Glyph, Meter, Num, Panel, SectionLabel, Tip, cx } from '@/ui/primitives';

import { RungLedger } from './RungLedger';
import {
  ascend,
  descend,
  goToRung,
  isDescending,
  subscribeDescent,
  type DescentFrame,
} from './descent';
import {
  createRungGate,
  readAtlasMotion,
  rungAbove,
  rungBelow,
  type RungBand,
} from './rungGeometry';

/* =============================================================================
 * THE ALTITUDE READING
 * ========================================================================== */

interface Altitude {
  /** camera zoom / the zoom this rung was framed at. `NaN` before it settles. */
  ratio: number;
  /** 0..1 across the band, in log space. */
  position: number;
  band: RungBand;
  anchored: boolean;
}

/**
 * Watch the camera and report where it sits inside the current rung's band.
 *
 * SAMPLED, NOT PER FRAME. The renderer runs its own loop at 60fps and React is
 * deliberately not in it; a gauge that re-reconciled a panel on every frame
 * would repaint the ledger underneath a pan. Ten samples a second is more than
 * the eye can read off a two-digit ratio, and the needle carries a `--t-fast`
 * transition so the motion between samples is continuous.
 */
function useAltitude(rung: Rung, parentId: string | null): Altitude {
  const gate = useRef(createRungGate()).current;
  const [alt, setAlt] = useState<Altitude>(() => ({
    ratio: Number.NaN,
    position: 0,
    band: gate.state().band,
    anchored: false,
  }));

  useEffect(() => {
    // A new place needs a new anchor: the altitude a rung is measured against is
    // whatever its own auto-frame settles at, never a constant.
    gate.release();
    gate.refresh();
  }, [gate, rung, parentId]);

  useEffect(() => {
    let raf = 0;
    let stopFrames: (() => void) | null = null;
    let disposed = false;

    const unsubscribe = subscribeTerrain((terrain: Terrain | null) => {
      stopFrames?.();
      stopFrames = null;
      cancelAnimationFrame(raf);
      if (terrain === null) return;

      // REST IS TWO CONDITIONS, NOT ONE. `camera.idle()` reports flights, and
      // there is a gap between the store committing a new rung and the flight
      // for it starting. Anchoring in that gap pins the reference to the OLD
      // rung's altitude, which is why the passage rung once read 36x on arrival.
      const atRest = (): boolean => terrain.camera.idle() && !isDescending();

      const sample = (): void => {
        const zoom = terrain.camera.get().zoom;
        if (atRest() && !gate.anchored()) gate.anchor(rung, zoom);
        setAlt({
          ratio: gate.ratio(zoom),
          position: gate.position(zoom),
          band: gate.state().band,
          anchored: gate.anchored(),
        });
      };

      // The renderer's loop is ON DEMAND: it stops when nothing is animating, so
      // the last frame of a flight is the last callback there will ever be and
      // the anchor would never be taken. This poll covers exactly the unsettled
      // window and terminates itself the moment the place is at rest — at rest
      // it costs nothing, which is the only acceptable price for a gauge.
      const poll = (): void => {
        if (disposed) return;
        sample();
        if (atRest() && gate.anchored()) return;
        raf = requestAnimationFrame(poll);
      };

      let last = 0;
      stopFrames = terrain.onFrame(() => {
        const now = performance.now();
        if (now - last < 100) return;
        last = now;
        sample();
      });
      raf = requestAnimationFrame(poll);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      stopFrames?.();
      unsubscribe();
    };
  }, [gate, rung, parentId]);

  return alt;
}

/* =============================================================================
 * THE PANEL
 * ========================================================================== */

export interface AtlasModeProps {
  className?: string;
}

/** The scope a rung jump should keep: the ancestor already on the breadcrumb. */
function scopeFor(rung: Rung, stack: readonly { id: string }[]): string | null {
  return stack[RUNG_DEPTH[rung] - 1]?.id ?? null;
}

/**
 * The body a guided descent should enter: the most central one at this rung.
 *
 * Centrality is a real field the bake computed, and the most central body is the
 * one with the most to show inside it. Ties break on id so the journey is
 * reproducible — a demo that visits a different island every time cannot be
 * rehearsed.
 */
function guidedTarget(nodes: readonly GraphNode[], rung: Rung): string | null {
  let best: GraphNode | null = null;
  for (const n of nodes) {
    if (n.kind !== rung) continue;
    if (best === null || n.centrality > best.centrality) best = n;
    else if (n.centrality === best.centrality && n.id < best.id) best = n;
  }
  return best?.id ?? null;
}

export function AtlasMode({ className }: AtlasModeProps): JSX.Element | null {
  // NEVER `s.view?.nodes ?? []` in a selector. `useShallow` compares the
  // selector's RESULT shallowly, so a fresh `[]` on every call is a new value on
  // every store write and the component re-renders itself into an infinite loop.
  // Select the payload; derive from it where it is needed.
  const { open, app, rung, stack } = useAtlasStore((s) => ({
    open: s.ui.atlas,
    app: s.app,
    rung: s.rung,
    stack: s.stack,
  }));

  const parentId = stack.length === 0 ? null : stack[stack.length - 1].id;
  const altitude = useAltitude(rung, parentId);

  const [frame, setFrame] = useState<DescentFrame | null>(null);
  useEffect(() => subscribeDescent(setFrame), []);

  /* ---- the guided run --------------------------------------------------- */
  const [touring, setTouring] = useState(false);
  const [dwell, setDwell] = useState(0);
  const generation = useRef(0);

  const stopTour = useCallback(() => {
    generation.current++;
    setTouring(false);
    setDwell(0);
  }, []);

  // Closing the panel is leaving the mode, and leaving the mode must never keep
  // flying the camera behind a panel that is no longer there.
  useEffect(() => {
    if (!open) stopTour();
  }, [open, stopTour]);
  useEffect(() => stopTour, [stopTour]);

  const runTour = useCallback(async () => {
    const mine = ++generation.current;
    setTouring(true);
    const motion = readAtlasMotion();

    for (;;) {
      const state = useAtlas.getState();
      if (mine !== generation.current) return;
      if (state.app !== 'READY') break;

      const target = guidedTarget(state.view?.nodes ?? [], state.rung);
      if (target === null || rungBelow(state.rung) === null) break;

      const result = await descend(target);
      if (mine !== generation.current || result.interrupted || result.refused) return;
      if (rungBelow(useAtlas.getState().rung) === null) break;

      // The dwell. A reading pause, driven by a real clock and reported as one.
      const started = performance.now();
      const rested = await new Promise<boolean>((resolve) => {
        const tick = (): void => {
          if (mine !== generation.current) return resolve(false);
          const elapsed = performance.now() - started;
          setDwell(Math.min(1, elapsed / motion.dwellMs));
          if (elapsed >= motion.dwellMs) return resolve(true);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      if (!rested) return;
      setDwell(0);
    }

    if (mine === generation.current) {
      setTouring(false);
      setDwell(0);
    }
  }, []);

  const onDescend = useCallback(() => {
    if (touring) {
      // The user took the wheel mid-journey. Stop narrating; do the one step
      // they asked for and leave them in control.
      stopTour();
      const target = guidedTarget(useAtlas.getState().view?.nodes ?? [], useAtlas.getState().rung);
      if (target !== null) void descend(target);
      return;
    }
    void runTour();
  }, [touring, runTour, stopTour]);

  const onAscend = useCallback(() => {
    stopTour();
    void ascend();
  }, [stopTour]);

  const close = useCallback(() => {
    stopTour();
    useAtlas.getState().toggle('atlas');
  }, [stopTour]);

  if (!open) return null;

  const here = rungCopy(rung);
  const below = rungBelow(rung);
  const above = rungAbove(rung);
  const depth = RUNG_DEPTH[rung];
  const busy = frame !== null;

  return (
    <aside className={cx('am', className)} aria-label={COPY.atlas.title}>
      <Panel
        title={COPY.atlas.title}
        glyph={rung}
        tone="render"
        scroll
        className="am-panel"
        actions={
          <Btn variant="ghost" size="sm" tone="dim" onClick={close} title={COPY.help.close.title}>
            {COPY.help.close.label}
          </Btn>
        }
      >
        {/* ONE SENTENCE OF PROSE IN THIS PANEL, AND IT CHANGES AT EVERY RUNG.
            There used to be three: the mode's own thesis, the rung's ontology
            and the rung's long-form rationale, stacked as three grey paragraphs
            at the top of a 300px rail — identical in two of the three captures
            and design-doc voice in all of them. The rail is for reporting, not
            for arguing.

            What survives is an INVITATION at the top of the world, where the
            reader has not descended yet and the sentence is about something
            that is going to happen to them, and nothing once they are
            travelling. `here.long` moves to the caption's own title, one hover
            away and out of the frame. */}
        {depth === 0 ? <p className="am-sub t-12-5 ink-dim">{COPY.atlas.note}</p> : null}

        {/* ---- THE ALTIMETER ------------------------------------------- *
         * The four stops are the spine, and each one carries the NOUN FOR WHAT
         * IS INSIDE IT. Read down the column and the ontology ladder is legible
         * without descending at all — continents contain islands, islands
         * contain assets, assets contain passages, passages contain mentions —
         * which is the difference between a depth gauge and a zoom slider. It is
         * also the claim the whole mode makes, stated in four words rather than
         * in a paragraph. */}
        <div className="am-alt">
          <ol className="am-stops" aria-label={COPY.rungs.title}>
            {RUNGS.map((r) => {
              const state =
                r === rung ? 'here' : RUNG_DEPTH[r] < depth ? 'above' : 'below';
              return (
                <li key={r} className={cx('am-stop', `is-${state}`)}>
                  <button
                    type="button"
                    className="am-stop-btn"
                    onClick={() => {
                      stopTour();
                      void goToRung(r, scopeFor(r, stack));
                    }}
                    title={rungCopy(r).short}
                    aria-current={r === rung ? 'true' : undefined}
                  >
                    <Glyph rung={r} tone={r === rung ? 'render' : 'faint'} />
                    <span className="am-stop-name">{rungCopy(r).plural}</span>
                    {/* Not on the stop you are standing on: the caption below
                        already says what is here, and the two together elided
                        each other into `Passag… mentio… YOU ARE HERE`. */}
                    {r === rung ? (
                      <span className="am-here caps">{COPY.atlas.here}</span>
                    ) : (
                      <span className="am-stop-holds ink-faint">{rungCopy(r).contains}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>

          {/* The live altitude, inside the band that owns this rung. */}
          <div className="am-band" aria-label={COPY.topbar.rung.label}>
            <Tip content={COPY.topbar.rung.tip}>
              <span className="am-band-hd">
                <span className="caps ink-faint">{COPY.topbar.rung.label}</span>
                <Num
                  value={altitude.anchored ? altitude.ratio : Number.NaN}
                  format="ratio"
                  tone="render"
                />
              </span>
            </Tip>
            <span className="am-band-track">
              <span
                className="am-needle"
                style={{ ['--am-pos' as string]: String(altitude.position) }}
                aria-hidden="true"
              />
            </span>
            {/* The two thresholds, each labelled with the rung it leads to. A
                threshold with no rung beyond it is drawn without a glyph rather
                than with the current one: there is nothing above a continent and
                nothing below a passage, and saying otherwise would be the gauge
                claiming a direction the spine does not have. */}
            <span className="am-band-ends">
              <span className="am-band-end">
                {above === null ? null : <Glyph rung={above} tone="faint" />}
                <Num value={altitude.band.out} format="ratio" tone="faint" />
              </span>
              <span className="am-band-end is-right">
                <Num value={altitude.band.in} format="ratio" tone="faint" />
                {below === null ? null : <Glyph rung={below} tone="faint" />}
              </span>
            </span>
          </div>
        </div>

        {/* ---- ONE CALM LINE ------------------------------------------- *
         * The ontology at this depth, and the whole reason the zoom is worth
         * performing. While this panel is open it is the ONE place the sentence
         * appears — the shell stands the rung legend down rather than reciting
         * it a second time 800px away at the foot of the same frame. */}
        <div className="am-caption">
          <SectionLabel>{here.label}</SectionLabel>
          <p className="am-caption-line t-14" title={here.long}>
            {COPY.atlas.captions[rung]}
          </p>
        </div>

        {/* ---- WHAT IS AT THIS RUNG ------------------------------------ */}
        <RungLedger className="am-ledger" />

        {/* ---- THE FOOT ------------------------------------------------- *
         * Docked to the bottom of the scrolling body. At the asset rung the
         * ledger is twenty documents long, and both of the things down here have
         * to survive that: a primary action that scrolls out of reach is a
         * primary action nobody presses, and a corpus disclosure that scrolls
         * out of reach is a disclosure that has been hidden. */}
        <div className="am-foot">
          <div className="am-provenance" title={COPY.provenance.long}>
            <SectionLabel>{COPY.provenance.field}</SectionLabel>
            <span className="mono t-11">{COPY.provenance.value}</span>
          </div>

          <div className="am-controls">
            <Btn
              variant="primary"
              tone="render"
              onClick={onDescend}
              disabled={below === null || busy || app !== 'READY'}
              title={below === null ? COPY.rungs.note : here.descend}
            >
              {COPY.atlas.descend.label}
            </Btn>
            <Btn
              variant="quiet"
              tone="dim"
              onClick={onAscend}
              disabled={depth === 0 || busy}
              title={COPY.atlas.ascend.title}
            >
              {COPY.atlas.ascend.label}
            </Btn>

            {/* The dwell. A real clock, reported as one: it is how much of the
                reading pause is left before the guided run moves to the next
                rung, and taking manual control stops it dead. */}
            {touring ? (
              <Meter
                value={dwell}
                max={1}
                tone="render"
                className="am-dwell"
                readout={<Num value={RUNG_DEPTH[rung] + 1} format="int" tone="dim" />}
              />
            ) : null}
          </div>
        </div>
      </Panel>
    </aside>
  );
}
