/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE SHELL
 * =============================================================================
 *
 * The whole product, assembled.
 *
 *   top bar      48px   identity · breadcrumb · command bar · status · switches
 *   alarm bar    auto   only when something actually failed
 *   viewport     1fr    THE TERRAIN. >= 70% of the window, always.
 *   rail        320px   the only place dense detail lives. Right, collapsible.
 *   bottom HUD   40px   always on, never modal, entirely monospaced
 *
 * -----------------------------------------------------------------------------
 * THE FRAME IS FIXED AND THE SCREENS ARE NOT
 * -----------------------------------------------------------------------------
 * Every lifecycle state renders INTO this frame rather than replacing it, with
 * exactly one exception: FIRST-RUN, which has no measurements to instrument and
 * so has no instruments. Everything else — EMPTY, INGESTING, SETTLING, QUERYING,
 * DEGRADED — keeps the top bar, keeps the HUD, and adds a plate over the
 * terrain. That is what makes the product read as one instrument in several
 * conditions rather than as several screens sharing a colour scheme.
 *
 * -----------------------------------------------------------------------------
 * THE MOUNTING RULE THE INTERACTION LAYER ASKED FOR
 * -----------------------------------------------------------------------------
 * `InteractionLayer` must be an `inset: 0` SIBLING of `<TerrainCanvas/>` inside
 * the same positioned stage. Its bounding rect anchors every zoom; a surface
 * offset from the canvas zooms about the wrong point. `.shell__stage` is that
 * stage and every floating instrument is a sibling inside it.
 * =============================================================================
 */

import { useEffect } from 'react';

import { COPY } from '@/copy';
import { TerrainCanvas } from '@/graph';
import { InteractionLayer } from '@/interaction';
import { RungLegend } from '@/ui/atlas';
import { useAtlas, useAtlasStore } from '@/state';

import { BottomHUD } from './BottomHUD';
import { DegradedBar } from './DegradedBar';
import { HelpOverlay } from './HelpOverlay';
import { Walkthrough } from './Walkthrough';
import { InspectorRail } from './InspectorRail';
import { TimelineDock } from './TimelineDock';
import { TopBar } from './TopBar';
import { EmptyScreen } from './screens/EmptyScreen';
import { FirstRun } from './screens/FirstRun';
import { IngestScreen } from './screens/IngestScreen';
import { installShellHook } from './hook';
import { useKeyboard, useSavedViewHash, useShellWiring, useTerrainInstance } from './wiring';

import './shell.css';

export function Shell(): JSX.Element {
  const terrain = useTerrainInstance();
  useShellWiring(terrain);
  useKeyboard();
  useSavedViewHash();

  const { app, lens, reducedMotion, railOpen, busy } = useAtlasStore((s) => ({
    app: s.app,
    lens: s.lens,
    reducedMotion: s.reducedMotion,
    /* THE RAIL IS OPEN WHENEVER THERE IS A CORPUS, because the composer lives in
       it now. A collapsible question is a question that can be lost, and this is
       the one control the product cannot afford to hide behind a toggle. */
    railOpen: s.view !== null && s.app !== 'INGESTING' && s.app !== 'SETTLING',
    busy: s.app === 'QUERYING',
  }));

  /* The visual-QA surface. Installed on mount so a scene driver can reach it
     immediately, and again once `boot()` has run — `installAtlasTestHook()`
     MERGES, so whichever lands second keeps the other's fields. */
  useEffect(() => {
    installShellHook(() => terrain);
    void useAtlas
      .getState()
      .boot()
      .then(() => installShellHook(() => terrain));
  }, [terrain]);

  /* CLOSING THE CORPUS CLOSES THE INSTRUMENTS OVER IT.
     `unload()` clears every measurement in the store and leaves the panel
     layout alone, so an Atlas rail, a timeline axis and a quarantine report
     opened against one corpus survived into the next — which is why five
     captures in a row carried a timeline panel reading `Timeline not loaded.`
     over a scene that had nothing to do with the clock, and why the failure
     scene arrived wearing four instruments it never opened.

     A panel is a reading of a corpus. When there is no corpus there is no
     reading, so the panels go with it. The Inspector stays: it is the rail
     itself, and it is where the next question will be staged. */
  useEffect(() => {
    // A STORE SUBSCRIPTION, NOT AN EFFECT ON `app`. An unload is immediately
    // followed by the next ingest, so React frequently never renders the EMPTY
    // frame in between and an effect keyed on `app` would miss the transition
    // entirely. The store's own event cannot be missed.
    //
    // MOST OF WHAT THIS USED TO DO IS `unload()`'s JOB NOW: the lens, the tab,
    // the history and the result scene are reset where the corpus is closed,
    // which is the only place that can know they belong to it. What is left here
    // is the two transient overlays that are not corpus state at all.
    let last = useAtlas.getState().app;
    return useAtlas.subscribe((s) => {
      const now = s.app;
      if (now === last) return;
      last = now;
      if (now !== 'EMPTY' && now !== 'FIRST-RUN') return;
      queueMicrotask(() => {
        const st = useAtlas.getState();
        for (const panel of ['quarantine', 'help', 'search'] as const) {
          if (st.ui[panel]) st.toggle(panel);
        }
      });
    });
  }, []);

  if (app === 'FIRST-RUN') {
    return (
      <div className="shell shell--bare" data-app={app} data-reduced-motion={reducedMotion}>
        <FirstRun />
      </div>
    );
  }

  return (
    <div
      className="shell"
      data-app={app}
      data-reduced-motion={reducedMotion}
      data-rail={railOpen}
    >
      <TopBar />

      {/* THE FAILURE INSTRUMENT IS FURNITURE, NOT AN ANNOTATION.
          It is a band of the frame directly under the top bar, spanning the
          whole window — rail included — because DEGRADED is a condition of the
          instrument rather than a note about the map. Its grid row is `auto`, so
          it is exactly zero pixels tall until something has actually failed and
          the frame is identical to the one above until then. */}
      <DegradedBar />

      <div className="shell__body">
        {/* THE STAGE. The canvas and every layer anchored to it are siblings
            inside one positioned box, which is what makes anchored zoom land on
            the point under the pointer. */}
        <main
          className="shell__stage"
          data-lens={lens}
          aria-label={busy ? COPY.a11y.terrainBusy : COPY.a11y.terrain}
        >
          <TerrainCanvas options={{ autoFrame: false }} />
          <InteractionLayer />

          {/* ATLAS MODE IS NOT HERE ANY MORE. It used to float a 300px column on
              top of the terrain beside the 368px rail — a second column of
              chrome, and the reason the honest unobstructed-terrain figure was
              69.7% while `audit()` was still certifying 80.4%. It now lives
              INSIDE the rail (see InspectorRail), which costs the terrain
              nothing at all: one column of chrome, at the width it already had.
              The camera's own occlusion probe in `@/ui/atlas` measures `.am`
              against the stage and now correctly finds no overlap. */}

          {/* THE FAILURE INSTRUMENT IS NOT HERE ANY MORE. It floated over this
              stage for one round so that raising it would not cost the terrain
              any height. The price was that the one failure state in the machine
              was reported by a card lying on top of the map, in a softer colour
              than the state it was reporting. It is a band of the frame now; see
              above, and DegradedBar.tsx for the whole argument. */}

          {/* THE DOCK. ONE COLUMN, AND AT MOST TWO THINGS IN IT.
              It used to stack four ranked-equal horizontal bars over the bottom
              third of the terrain — the timeline, an analyst strip, the rung
              legend and the HUD beneath them — none of which owned a story and
              three of which printed the same six figures.

              The analyst strip is gone: its four unique readouts moved into the
              HUD, which already carried the other six. The legend's resolution
              ramp is gone the same way, for the same reason. What is left is one
              optional axis and one small key that says what this rung MEANS. */}
          <div className="shell__dock">
            {/* THE AXIS BELONGS TO ITS LENS. It used to be a panel that could be
                left open over any workspace — including one it had nothing to do
                with — which is how five captures in a row carried a timeline
                slab over a scene about something else. */}
            {lens === 'timeline' ? <TimelineDock className="shell__timeline" /> : null}
            {/* ONE OWNER FOR THE RUNG SENTENCE. Atlas Mode prints the ontology of
                the current rung in its own rail; the legend printed the identical
                sentence 800px away at the foot of the same frame, at every rung.
                Two panels reciting one line is the clearest possible signal that
                nobody decided which instrument owns meaning. Atlas Mode is the
                instrument whose subject this is, so while it is open it owns the
                sentence and the legend stands down. */}
            {/* AND THE COLUMN SHEDS WHEN IT GETS TALL. The HUD's rule — drop
                the least load-bearing thing rather than reflow the frame —
                applies to the dock for the same reason: with the axis open
                this column is already 150px of chrome standing on the map, and
                the reading key is the one thing in it that is not the reason
                the mode was opened. */}
            {/* The legend carries MEANING only. The resolution ramp is a
                MEASUREMENT and the HUD owns it forty pixels below — printing it
                in both places is what produced three disagreeing node counts in
                one frame. The grammar of the ramp is taught by the walkthrough
                and the help overlay, which is where an explanation belongs. */}
            {lens === 'explore' ? <RungLegend className="shell__legend" /> : null}
          </div>

          {app === 'EMPTY' ? <EmptyScreen /> : null}
          {app === 'INGESTING' || app === 'SETTLING' ? <IngestScreen /> : null}
        </main>

        <InspectorRail />
      </div>

      <BottomHUD terrain={terrain} />
      <HelpOverlay />
      <Walkthrough />
    </div>
  );
}
