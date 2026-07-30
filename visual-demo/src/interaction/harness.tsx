/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — INTERACTION HARNESS (development entry, not shipped in the app)
 * =============================================================================
 *
 * VERIFY WITH THE HANDS, NOT WITH THE HEAD.
 *
 * Its own Vite entry (`interaction-harness.html`). It touches neither
 * `src/main.tsx` nor `src/App.tsx`, so the pointer, the wheel, the keyboard, the
 * palette, the path readout and the world-map strip can be driven and measured
 * long before there is a shell to put them in.
 *
 * It wires the REAL store to the REAL renderer exactly the way the shell is
 * asked to — settle gate, idle probe, scene, LOD, selection, constellation, perf
 * — so anything that works here works there, and anything that needs the shell
 * to do something is visible here as a missing wire rather than as a surprise
 * during integration.
 *
 * ONE DELIBERATE OMISSION, AND IT IS A NOTE FOR THE SHELL: this harness does NOT
 * push `view.stats.drawn_reason` into `terrain.setEdgePolicy`. The terrain already
 * falls back to the view's own `drawn_reason` when the override is null, and the
 * override belongs to the hover layer. Wiring it in the shell as well would let a
 * view change stamp on a live hover policy.
 *
 * `window.__ix` is the measurement surface `scripts/verify-interaction.mjs`
 * drives. Every value it returns is read straight off the camera or the store —
 * there is no shadow copy of anything in this file.
 * ========================================================================== */

import '@/styles/base.css';
import '@/styles/primitives.css';
import './harness.css';

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { COPY, rungCopy } from '@/copy';
import { RUNGS } from '@/engine';
import type { Rung } from '@/engine';
import { TerrainCanvas, getTerrain, type Terrain } from '@/graph';
import {
  createPerfSampler,
  registerIdleProbe,
  registerSettleGate,
  useAtlas,
  useAtlasStore,
} from '@/state';
import { Btn, Chip, Num } from '@/ui/primitives';

import { InteractionLayer, PathExplain, SigmaFilters, useTerrain } from '@/interaction';
import { debugCameraControl } from '@/interaction/InteractionSurface';

/* =============================================================================
 * THE MEASUREMENT SURFACE
 * ========================================================================== */

declare global {
  interface Window {
    __ix?: {
      ready(): boolean;
      camera(): { x: number; y: number; zoom: number };
      /** The STORE's camera target, which is a different thing from the renderer's. */
      storeCamera(): { x: number; y: number; zoom: number; version: number };
      frustum(): { x: number; y: number; w: number; h: number };
      bounds(): { min_x: number; min_y: number; max_x: number; max_y: number } | null;
      /** The baked position of a node, or null. Read-only view of the bake. */
      pos(id: string): { x: number; y: number } | null;
      screenToWorld(sx: number, sy: number): [number, number];
      worldToScreen(x: number, y: number): [number, number];
      canvasRect(): { left: number; top: number; width: number; height: number };
      idle(): boolean;
      /** Why the last pointer release did or did not throw the terrain. */
      release(): unknown;
      /** Frame the whole current view. The rig needs a known camera to test from. */
      frame(): Promise<void>;
      /**
       * Turn semantic zoom off. The anchored-zoom measurement has to be taken
       * WITHOUT it: crossing a rung re-frames the camera by design, so measuring
       * the anchor across a descent measures the descent, not the anchor.
       */
      setSemanticZoom(on: boolean): void;
      state(): {
        app: string;
        rung: Rung;
        stack: number;
        focus: string | null;
        selection: string[];
        hover: string | null;
        search: boolean;
        nodes: number;
        sigma: string[];
      };
      settle(): Promise<void>;
    };
  }
}

let semanticZoomEnabled = true;
const semanticZoomWatchers = new Set<(on: boolean) => void>();

function installProbe(): void {
  const rectOf = (): DOMRect => {
    const el = document.querySelector('canvas');
    return el?.getBoundingClientRect() ?? new DOMRect(0, 0, 1, 1);
  };

  window.__ix = {
    ready: () => getTerrain() !== null && useAtlas.getState().view !== null,
    camera: () => getTerrain()?.camera.get() ?? { x: 0, y: 0, zoom: 0 },
    storeCamera: () => ({ ...useAtlas.getState().camera }),
    frustum: () => getTerrain()?.camera.frustum() ?? { x: 0, y: 0, w: 0, h: 0 },
    bounds: () => useAtlas.getState().bake?.bounds ?? null,
    pos: (id) => {
      const p = useAtlas.getState().bake?.positions.find((q) => q.id === id);
      return p === undefined ? null : { x: p.x, y: p.y };
    },
    screenToWorld: (sx, sy) => {
      const r = rectOf();
      const p = getTerrain()?.camera.screenToWorld(sx - r.left, sy - r.top);
      return p === undefined ? [0, 0] : [p[0], p[1]];
    },
    worldToScreen: (x, y) => {
      const r = rectOf();
      const p = getTerrain()?.camera.worldToScreen(x, y);
      // worldToScreen is y-UP in screen space; a client coordinate is y-DOWN.
      return p === undefined ? [0, 0] : [p[0] + r.left, r.top + (r.height - p[1])];
    },
    canvasRect: () => {
      const r = rectOf();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    },
    idle: () => getTerrain()?.camera.idle() ?? true,
    release: () => debugCameraControl()?.lastRelease() ?? null,
    frame: async () => {
      const t = getTerrain();
      const view = useAtlas.getState().view;
      if (t === null || view === null) return;
      await t.camera.fitTo(view.nodes.map((n) => n.id), 72);
    },
    setSemanticZoom: (on) => {
      semanticZoomEnabled = on;
      for (const w of semanticZoomWatchers) w(on);
    },
    state: () => {
      const s = useAtlas.getState();
      return {
        app: s.app,
        rung: s.rung,
        stack: s.stack.length,
        focus: s.focus,
        selection: [...s.selection],
        hover: s.hover,
        search: s.ui.search,
        nodes: s.view?.nodes.length ?? 0,
        sigma: [...s.filters.sigma],
      };
    },
    settle: async () => {
      const started = performance.now();
      // Real quiescence: the camera stopped flying and nothing is in the air.
      // No sleep, no fixed delay.
      while (performance.now() - started < 5000) {
        const t = getTerrain();
        if (t !== null && t.camera.idle() && useAtlas.getState().app !== 'QUERYING') return;
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      }
    },
  };
}

/* =============================================================================
 * THE SHELL'S WIRING, DONE HERE SO IT CAN BE JUDGED
 * ========================================================================== */

function useShellWiring(terrain: Terrain | null): void {
  const { view, bake, rung, parentId, lod, selection, constellation, filters, dimmed } =
    useAtlasStore((s) => ({
      view: s.view,
      bake: s.bake,
      rung: s.rung,
      parentId: s.stack.length === 0 ? null : s.stack[s.stack.length - 1].id,
      lod: s.lod,
      selection: s.selection,
      constellation: s.query.active?.constellation ?? null,
      filters: s.filters,
      dimmed: s.app === 'QUERYING',
    }));

  useEffect(() => {
    if (terrain === null || view === null || bake === null) return;
    terrain.setScene({ view, bake, rung, parentId });
  }, [terrain, view, bake, rung, parentId]);

  useEffect(() => terrain?.setLod(lod), [terrain, lod]);
  useEffect(() => terrain?.setSelection(selection), [terrain, selection]);
  useEffect(() => terrain?.setConstellation(constellation), [terrain, constellation]);
  useEffect(
    () => terrain?.setFilters({ sigma: filters.sigma, showQuarantined: filters.showQuarantined }),
    [terrain, filters],
  );
  useEffect(() => terrain?.setDimmed(dimmed), [terrain, dimmed]);

  // The settle gate and the idle probe. Without the first, SETTLING ends when the
  // data lands rather than when the motion does; without the second, `settled()`
  // cannot wait for a camera flight.
  useEffect(() => {
    if (terrain === null) return;
    registerSettleGate((ids) => terrain.settleIngest([...ids]));
    registerIdleProbe(() => terrain.camera.idle());
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

  // One listener, the store's own table.
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

function Harness(): JSX.Element {
  const terrain = useTerrain();
  useShellWiring(terrain);

  const [semantic, setSemantic] = useState(semanticZoomEnabled);
  useEffect(() => {
    semanticZoomWatchers.add(setSemantic);
    return () => void semanticZoomWatchers.delete(setSemantic);
  }, []);

  const { app, rung, stack, perf, view, focus, hover } = useAtlasStore((s) => ({
    app: s.app,
    rung: s.rung,
    stack: s.stack,
    perf: s.perf,
    view: s.view,
    focus: s.focus,
    hover: s.hover,
  }));

  const [booted, setBooted] = useState(false);
  useEffect(() => {
    void useAtlas
      .getState()
      .boot({ auto: true })
      .then(() => setBooted(true));
    installProbe();
  }, []);

  return (
    <div className="hx">
      <header className="hx__bar">
        <span className="hx__brand">{COPY.product.short}</span>
        <span className="hx__crumbs">
          {stack.length === 0 ? (
            <span className="ink-faint">{rungCopy(rung).plural}</span>
          ) : (
            stack.map((e) => (
              <button
                key={e.id}
                type="button"
                className="hx__crumb"
                onClick={() => void useAtlas.getState().goToRung(e.rung, null)}
              >
                {e.label}
              </button>
            ))
          )}
        </span>

        <span className="hx__rungs">
          {RUNGS.map((r) => (
            <Chip
              key={r}
              active={r === rung}
              tone={r === rung ? 'render' : 'dim'}
              onClick={() => void useAtlas.getState().goToRung(r, null)}
              title={rungCopy(r).short}
            >
              {rungCopy(r).plural}
            </Chip>
          ))}
        </span>

        <span className="hx__readouts">
          <span className="hx__ro">
            <span className="caps ink-faint">{COPY.analyst.readouts.nodes.label}</span>
            <Num value={view?.stats.node_count ?? 0} format="int" tone="dim" />
          </span>
          <span className="hx__ro">
            <span className="caps ink-faint">{COPY.analyst.readouts.drawn.label}</span>
            <Num value={view?.stats.edges_drawn ?? 0} format="int" tone="dim" />
          </span>
          <span className="hx__ro">
            <span className="caps ink-faint">{COPY.analyst.perf.fps.label}</span>
            <Num value={perf.fps} format="float1" tone="dim" />
          </span>
          <span className="hx__ro">
            <span className="caps ink-faint">{COPY.analyst.perf.frameMs.label}</span>
            <Num value={perf.frameMs} format="ms" tone="dim" />
          </span>
          <Btn
            variant="ghost"
            size="sm"
            onClick={() => useAtlas.getState().toggle('search')}
            title={COPY.search.title}
          >
            {COPY.search.title}
          </Btn>
        </span>
      </header>

      <div className="hx__body">
        <main className="hx__stage">
          <TerrainCanvas />
          <InteractionLayer semanticZoom={semantic} />
        </main>

        <aside className="hx__side u-scroll">
          <SigmaFilters className="hx__filters" />
          <PathExplain />
          <div className="hx__facts">
            <span className="caps ink-faint">{COPY.provenance.badge}</span>
            <span className="hx__fact">
              <span className="ink-faint">{COPY.hud.hoverHint}</span>
            </span>
            <span className="hx__fact">
              <span className="caps ink-faint">{COPY.inspector.title}</span>
              <span className="mono">{focus ?? hover ?? COPY.common.none}</span>
            </span>
            <span className="hx__fact">
              <span className="caps ink-faint">{COPY.states[app].title}</span>
              <span className="mono">{booted ? app : COPY.common.notLoaded}</span>
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}

const host = document.getElementById('harness');
if (host !== null) createRoot(host).render(<Harness />);
