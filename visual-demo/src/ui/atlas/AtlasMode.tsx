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
 * THE ALTIMETER IS A REAL GAUGE, AND ITS STOPS ARE ONE CONTROL
 * -----------------------------------------------------------------------------
 * The four stops on the left are the spine. They used to be four independent
 * `<button>`s in a list — four things you may press — when what they describe is
 * ONE thing with four mutually exclusive positions, the way a lens is. They are
 * a radio group now, and the implementation is shared with the top bar's compact
 * strip (`<LevelSelector>` in ./Breadcrumb.tsx) so the level selector is
 * reachable and operable at every width and cannot disagree with itself about
 * which level is current.
 *
 * A stop also no longer discards where you are. Pressing `Assets` from inside
 * one island used to draw all 521 assets in the corpus; it now descends into the
 * selection, the breadcrumb scope, or the answer's own place — see
 * `scopeForLevel()`.
 *
 * The band under the stops is the live altitude of the camera, measured as a
 * ratio against the zoom the current rung was framed at, with the two thresholds
 * that decide a rung change drawn on it. Every number in it comes off
 * `terrain.camera` or off design-tokens.css §15 — there is no invented scale and
 * no decorative needle. It is also the only place in the product where the
 * HYSTERESIS is visible: you can watch the altitude travel a factor of six and a
 * half between the two thresholds and see for yourself why the boundary does not
 * flicker.
 *
 * -----------------------------------------------------------------------------
 * THE PANEL DOES NOT OWN A SECOND COPY OF A NAVIGATION CONTROL
 * -----------------------------------------------------------------------------
 * It used to carry `Ascend` — 'Return to the containing rung' — while the
 * navigation row pinned at the top of this same column carried `Up` — 'Up one
 * detail level'. One move, two names, two tooltips, in one column. The reverse
 * actions belong to the navigation stack, which renders them whenever there is a
 * corpus and disables rather than hides the ones that would do nothing; this
 * panel points at them instead of restating them.
 *
 * What survives here is the one control that is genuinely this panel's own: the
 * guided run, and the `Stop` that ends it.
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
 * control — Descend, Stop, a level stop, a ledger row, the navigation row's Up,
 * or closing the panel — stops the guided run and hands the camera back at the
 * rung currently on screen. There is no snap-back, because a snap-back would
 * throw away the place the user stopped at to look at something.
 * =============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { RUNG_DEPTH } from '@/engine';
import type { GraphNode, Rung } from '@/engine';
import { COPY, dual, rungCopy } from '@/copy';
import { subscribeTerrain, type Terrain } from '@/graph';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Glyph, Meter, Num, Panel, SectionLabel, Tip, cx } from '@/ui/primitives';

import { LevelSelector } from './Breadcrumb';
import { RungLedger } from './RungLedger';
import { descend, isDescending, subscribeDescent, type DescentFrame } from './descent';
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

/**
 * The place, as one comparable string — the level plus its scope.
 *
 * THE GUIDED RUN USES THIS TO NOTICE THAT SOMEBODY ELSE TOOK THE WHEEL. It used
 * to stop only on controls it owned, and removing its private `Ascend` in favour
 * of the navigation row's `Up` would otherwise have left the tour narrating on
 * over a move it did not make: the reader presses Up, the dwell finishes, and
 * the panel dives back into a level they had just climbed out of. Comparing
 * where the store actually is against where the last step left it is cheap,
 * synchronous, and catches every external move — Up, Back, Home, a ledger row, a
 * level stop, a keyboard shortcut — with one test instead of one hook per
 * control.
 */
function placeOf(s: { rung: Rung; stack: readonly { id: string }[] }): string {
  return `${s.rung}|${s.stack.length === 0 ? '' : s.stack[s.stack.length - 1].id}`;
}

export function AtlasMode({ className }: AtlasModeProps): JSX.Element | null {
  // NEVER `s.view?.nodes ?? []` in a selector. `useShallow` compares the
  // selector's RESULT shallowly, so a fresh `[]` on every call is a new value on
  // every store write and the component re-renders itself into an infinite loop.
  // Select the payload; derive from it where it is needed.
  const { open, app, rung, stack, assetId, assetTiling } = useAtlasStore((s) => ({
    /* THE MOUNT DECIDES, NOT A FLAG NOTHING SETS.
       This read `s.ui.atlas`, which was a top-bar toggle until the five
       equal-rank switches became three lenses — and then nothing set it, ever.
       The component mounted and returned null: the altimeter, the rung ledger
       and the guided descent were unreachable in the shipped build, which is why
       an adversarial pass could find no control, no key and no scene that opened
       them. A component that gates itself on state its host does not own will
       eventually gate itself on state nobody owns.

       The gate is now the lens, which is the thing the rail already uses to
       decide whether to mount this at all — one fact, read in one place. */
    open: s.lens === 'explore',
    app: s.app,
    rung: s.rung,
    stack: s.stack,
    assetId: s.assetId,
    assetTiling: s.assetTiling,
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

    /** Where the last step left the store. `null` before the first step. */
    let expected: string | null = null;

    for (;;) {
      const state = useAtlas.getState();
      if (mine !== generation.current) return;
      if (state.app !== 'READY') break;
      // SOMEBODY ELSE MOVED US. Hand the wheel over rather than diving again
      // from a place the reader chose. See `placeOf`.
      if (expected !== null && placeOf(state) !== expected) break;

      const target = guidedTarget(state.view?.nodes ?? [], state.rung);
      if (target === null || rungBelow(state.rung) === null) break;

      const result = await descend(target);
      // A NEWER GENERATION OWNS THE FLAGS, SO THIS ONE LEAVES THEM ALONE.
      if (mine !== generation.current) return;
      /* BUT AN INTERRUPTED DESCENT IS STILL THIS GENERATION'S TO CLEAN UP.
         This used to `return` on `interrupted` / `refused` as well, which left
         `touring` true and `dwell` running with no tour behind either of them.
         Any external move mid-choreography bumps the ticket in descent.ts and
         comes back `interrupted: true` — and since this panel gave up its
         private `Ascend`, the reverse move now arrives from a control the tour
         does not own, which made that interleaving ordinary rather than rare.
         The residue was not cosmetic: `touring` is the render gate for the
         `Stop` button and the dwell Meter below, and it routes the primary
         `Descend` into its stop-then-single-step branch — so the panel offered
         to stop a tour that had already ended and then spent a press doing it.
         Breaking runs the same cleanup every other exit from this loop runs. */
      if (result.interrupted || result.refused) break;
      expected = placeOf(useAtlas.getState());
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

  const close = useCallback(() => {
    stopTour();
    useAtlas.getState().toggle('atlas');
  }, [stopTour]);

  if (!open) return null;

  const here = rungCopy(rung);
  const below = rungBelow(rung);
  const above = rungAbove(rung);
  /* THE GROUND. `rungBelow('asset')` is null and the gauge used to draw nothing
     there — an empty slot where the spine ends, which reads as a missing glyph
     rather than as a floor. There IS something below the asset; it is just not a
     rung. The band says so in the one place the reader is already asking "how
     much further down does this go". */
  const onFloor = assetId !== null;
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
        {depth === 0 ? <p className="am-sub t-13 ink-dim">{COPY.atlas.note}</p> : null}

        {/* ---- THE ALTIMETER ------------------------------------------- *
         * The four stops are the spine, and each one carries the NOUN FOR WHAT
         * IS INSIDE IT. Read down the column and the ontology ladder is legible
         * without descending at all — continents contain islands, islands
         * contain assets, assets contain passages, passages contain mentions —
         * which is the difference between a depth gauge and a zoom slider.
         *
         * The stops themselves are `<LevelSelector>`, the same radio group the
         * top bar renders in its compact form. One implementation, one scope
         * rule, one keyboard model: two copies of a selector are two chances for
         * the rail and the bar to disagree about which level is current. */}
        <div className="am-alt">
          <LevelSelector variant="rail" className="am-stops" onJump={stopTour} />

          {/* The live altitude, inside the band that owns this rung.
              THE LABEL IS THE DUAL-LAYER PAIR, not `Rung`. `Rung` is the
              engine's word for the thing this gauge measures, and it was
              leading — on a gauge a first-time reader meets before anything has
              explained the spine. The plain name leads and the technical term
              follows, exactly as the deck's vocabulary table has it; the figure
              is a ratio and renders with its × so it cannot be misread as an
              index into four levels. */}
          <div className="am-band" aria-label={dual('lod')}>
            <Tip content={COPY.topbar.rung.tip}>
              <span className="am-band-hd">
                <span className="caps ink-dim">{dual('lod')}</span>
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
                {above === null ? null : <Glyph kind={above} tone="dim" />}
                <Num value={altitude.band.out} format="ratio" tone="dim" />
              </span>
              <span className="am-band-end is-right">
                <Num value={altitude.band.in} format="ratio" tone="dim" />
                {below === null ? null : <Glyph kind={below} tone="dim" />}
              </span>
            </span>
          </div>

          {/* ---- THE GROUND ------------------------------------------- *
            * Drawn as a PLANE seen edge-on, not as a fourth stop on the ladder,
            * because that is the claim: the ladder has three rungs and then it
            * stands on something. It appears at the asset rung — where the
            * descent runs out of rungs — and lights when you are standing on it.
            * A reader who has just been told there is nothing below the document
            * needs the same surface to say what "nothing below" means. */}
          {rung === 'asset' ? (
            <Tip content={COPY.navigation.tiling.tip}>
              <div className={cx('am-ground', onFloor && 'is-on')} aria-hidden="true">
                <span className="am-ground-line" />
                <span className="am-ground-label caps">
                  {onFloor ? COPY.navigation.ground.on : COPY.navigation.ground.below}
                </span>
              </div>
            </Tip>
          ) : null}
        </div>

        {/* ---- ONE CALM LINE ------------------------------------------- *
         * The ontology at this depth, and the whole reason the zoom is worth
         * performing. While this panel is open it is the ONE place the sentence
         * appears — the shell stands the rung legend down rather than reciting
         * it a second time 800px away at the foot of the same frame. */}
        {/* ON A FLOOR THE CAPTION IS ABOUT THE COVERING, not about the rung.
            Standing inside a document while the one calm line says "Documents
            with declared boundaries" describes the level you LEFT — the reader is
            past that sentence and is now looking at one of two tilings, which is
            the thing that needs naming. */}
        <div className="am-caption">
          <SectionLabel>{onFloor ? COPY.navigation.tiling[assetTiling].label : here.label}</SectionLabel>
          <p
            className="am-caption-line t-14"
            title={onFloor ? COPY.navigation.tiling[assetTiling].long : here.long}
          >
            {onFloor ? COPY.navigation.tiling[assetTiling].long : COPY.atlas.captions[rung]}
          </p>
        </div>

        {/* ---- WHAT IS AT THIS RUNG ------------------------------------ */}
        <RungLedger className="am-ledger" />

        {/* ---- THE FOOT ------------------------------------------------- *
         * Docked to the bottom of the scrolling body. At the asset rung the
         * ledger is twenty documents long, and all three of the things down here
         * have to survive that: a primary action that scrolls out of reach is a
         * primary action nobody presses, a corpus disclosure that scrolls out of
         * reach is a disclosure that has been hidden, and a pointer to the
         * reverse actions is only useful where the descent controls are. */}
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

            {/* WHERE `ASCEND` USED TO BE. Not a replacement for it — the reverse
                of a descent is the navigation row's `Up`, and this panel does
                not own a second copy of that. This ends a NARRATION, which is
                the one thing on screen that only this panel can start. */}
            {touring ? (
              <Btn
                variant="quiet"
                tone="dim"
                onClick={stopTour}
                title={COPY.navigation.tour.stop.title}
              >
                {COPY.navigation.tour.stop.label}
              </Btn>
            ) : null}

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

          {/* THE REVERSE ACTIONS HAVE ONE HOME AND IT IS NOT THIS PANEL. */}
          <p className="am-reverse t-13 ink-dim">{COPY.navigation.reverse.note}</p>
        </div>
      </Panel>
    </aside>
  );
}
