/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — RUNG ATLAS HARNESS (development entry, never shipped)
 * =============================================================================
 *
 * Its own Vite entry (`atlas-harness.html`). It exists because the four rung
 * scenes have to be JUDGED SIDE BY SIDE, and the only honest way to do that is
 * to photograph the real store driving the real renderer through the real
 * actions long before there is a shell to hang them in.
 *
 * It does the shell's wiring exactly as `@/ui/atlas` asks for it — settle gate,
 * idle probe, scene, LOD, selection, perf, the keymap, and
 * `installDescentChoreography()` — so anything that works here works there.
 *
 * ONE DELIBERATE DIFFERENCE FROM THE INTERACTION HARNESS: while a descent is in
 * flight this harness does NOT push `store.lod` into `terrain.setLod`. That is
 * the guard `@/ui/atlas` documents for the shell, implemented here so the
 * choreography can be photographed as designed rather than as a race.
 *
 * `window.__atlas` is the store's own scene hook (installed by `boot()`), so the
 * four `atlas-*` scenes here are literally the ones `scripts/shoot.mjs` will
 * drive in the product. `window.__rung` adds the descent-specific probes the
 * shot script needs to catch a transition mid-flight.
 * ========================================================================== */

import '@/styles/base.css';
import '@/styles/primitives.css';

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { COPY } from '@/copy';
import { TerrainCanvas, getTerrain, subscribeTerrain, type Terrain } from '@/graph';
import {
  createPerfSampler,
  registerIdleProbe,
  registerSettleGate,
  useAtlas,
  useAtlasStore,
} from '@/state';
import { Num } from '@/ui/primitives';

import {
  AtlasMode,
  Breadcrumb,
  RungLegend,
  activeDescent,
  ascend,
  descend,
  installDescentChoreography,
  isDescending,
} from '@/ui/atlas';

import './harness.css';

/* =============================================================================
 * THE DESCENT PROBE
 * ========================================================================== */

declare global {
  interface Window {
    __rung?: {
      ready(): boolean;
      /** Start a real descent into the most central body and DO NOT await it. */
      startDescent(): boolean;
      startAscent(): boolean;
      /** The live choreography frame, or null. Read straight off the module. */
      frame(): unknown;
      /** The result of the last descent, once it has finished. */
      lastResult(): unknown;
      descending(): boolean;
      /** Camera altitude, read off the renderer. */
      zoom(): number;
      /** Labels the renderer actually placed on the last frame it drew. */
      labels(): number;
      place(): { app: string; rung: string; stack: number; nodes: number; bodies: number };
    };
  }
}

function mostCentral(): string | null {
  const s = useAtlas.getState();
  let best: { id: string; c: number } | null = null;
  for (const n of s.view?.nodes ?? []) {
    if (n.kind !== s.rung) continue;
    if (best === null || n.centrality > best.c) best = { id: n.id, c: n.centrality };
  }
  return best?.id ?? null;
}

let lastResult: unknown = null;

function installProbe(): void {
  window.__rung = {
    ready: () => getTerrain() !== null && useAtlas.getState().view !== null,
    startDescent: () => {
      const id = mostCentral();
      if (id === null) return false;
      lastResult = null;
      void descend(id).then((r) => {
        lastResult = r;
      });
      return true;
    },
    startAscent: () => {
      lastResult = null;
      void ascend().then((r) => {
        lastResult = r;
      });
      return true;
    },
    frame: () => activeDescent(),
    lastResult: () => lastResult,
    descending: () => isDescending(),
    zoom: () => getTerrain()?.camera.get().zoom ?? Number.NaN,
    labels: () => getTerrain()?.perf().labels ?? Number.NaN,
    place: () => {
      const s = useAtlas.getState();
      return {
        app: s.app,
        rung: s.rung,
        stack: s.stack.length,
        nodes: s.view?.nodes.length ?? 0,
        bodies: s.view?.nodes.filter((n) => n.kind === s.rung).length ?? 0,
      };
    },
  };
}

/* =============================================================================
 * THE SHELL'S WIRING
 * ========================================================================== */

function useShellWiring(terrain: Terrain | null): void {
  const { view, bake, rung, parentId, lod, selection, dimmed, filters } = useAtlasStore((s) => ({
    view: s.view,
    bake: s.bake,
    rung: s.rung,
    parentId: s.stack.length === 0 ? null : s.stack[s.stack.length - 1].id,
    lod: s.lod,
    selection: s.selection,
    dimmed: s.app === 'QUERYING',
    filters: s.filters,
  }));

  useEffect(() => {
    if (terrain === null || view === null || bake === null) return;
    terrain.setScene({ view, bake, rung, parentId });
  }, [terrain, view, bake, rung, parentId]);

  // THE GUARD. While the descent owns the ramp, the shell stands off.
  useEffect(() => {
    if (terrain === null || isDescending()) return;
    terrain.setLod(lod);
  }, [terrain, lod]);

  useEffect(() => terrain?.setSelection(selection), [terrain, selection]);
  useEffect(
    () => terrain?.setFilters({ sigma: filters.sigma, showQuarantined: filters.showQuarantined }),
    [terrain, filters],
  );
  useEffect(() => terrain?.setDimmed(dimmed), [terrain, dimmed]);

  useEffect(() => {
    if (terrain === null) return;
    registerSettleGate((ids) => terrain.settleIngest([...ids]));
    registerIdleProbe(() => terrain.camera.idle() && !isDescending());
    return () => {
      registerSettleGate(null);
      registerIdleProbe(null);
    };
  }, [terrain]);

  useEffect(() => {
    if (terrain === null) return;
    const sampler = createPerfSampler((p) => useAtlas.getState().setPerf(p));
    return terrain.onFrame(sampler.push);
  }, [terrain]);

  useEffect(() => installDescentChoreography(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (useAtlas.getState().handleKey(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/* =============================================================================
 * THE HARNESS
 * ========================================================================== */

function useTerrainInstance(): Terrain | null {
  const [terrain, setTerrain] = useState<Terrain | null>(null);
  useEffect(() => subscribeTerrain(setTerrain), []);
  return terrain;
}

function Harness(): JSX.Element {
  const terrain = useTerrainInstance();
  useShellWiring(terrain);

  const { app, perf, atlasOpen } = useAtlasStore((s) => ({
    app: s.app,
    perf: s.perf,
    atlasOpen: s.ui.atlas,
  }));

  useEffect(() => {
    installProbe();
    void useAtlas.getState().boot({ auto: true });
  }, []);

  return (
    <div className="ax">
      <header className="ax-bar">
        <span className="ax-brand caps ink-faint">{COPY.product.short}</span>
        <Breadcrumb className="ax-crumbs" />
        <span className="ax-readouts">
          <span className="ax-ro">
            <span className="caps ink-faint">{COPY.analyst.perf.fps.label}</span>
            <Num value={perf.fps} format="float1" tone="dim" />
          </span>
          <span className="ax-ro">
            <span className="caps ink-faint">{COPY.analyst.perf.frameMs.label}</span>
            <Num value={perf.frameMs} format="ms" tone="dim" />
          </span>
          <span className="ax-ro">
            <span className="caps ink-faint">{COPY.states[app].title}</span>
          </span>
        </span>
      </header>

      <main className="ax-stage">
        {/* THE ATLAS OWNS THE CAMERA. With the renderer's own auto-frame on, every
            rung arrives framed on the whole payload — including the entity layer,
            which is spread across the world by construction — and all four rungs
            look like the same nebula. See `frameRung` in ./descent.ts. */}
        <TerrainCanvas options={{ autoFrame: false }} />
        <RungLegend className="ax-legend" showRamp={!atlasOpen} />
        <AtlasMode />
      </main>
    </div>
  );
}

const host = document.getElementById('harness');
if (host !== null) createRoot(host).render(<Harness />);
