/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE SHELL'S WIRING
 * =============================================================================
 *
 * The integration seam. Everything the store knows becomes something the
 * renderer does, and everything the renderer measures becomes something the HUD
 * prints — in one place, so a missing wire is a missing line here rather than a
 * mystery three modules away.
 *
 * FIVE THINGS THE WAVE-A MODULES ASKED FOR BY NAME, AND WHY EACH ONE MATTERS:
 *
 *   1. `registerSettleGate` — without it SETTLING ends when the DATA lands, not
 *      when the MOTION does, and the screenshot catches a terrain mid-flight.
 *   2. `registerIdleProbe` — without it `settled()` cannot wait for a camera
 *      flight, and every scene is photographed during a transition.
 *   3. `installDescentChoreography()` — it adopts every rung change, whoever
 *      started it (keyboard, semantic zoom, a shared link), so the descent has
 *      the same beats from every direction.
 *   4. `autoFrame: false` on the terrain, because the ATLAS owns the camera. With
 *      the renderer's own auto-frame on, every rung arrives framed on the whole
 *      payload — entity layer included, which is spread across the world by
 *      construction — and all four rungs look like the same nebula.
 *   5. NOT wiring `view.stats.drawn_reason` into `setEdgePolicy`. The terrain
 *      already falls back to the view's own reason when the override is null,
 *      and the override belongs to the hover layer. Wiring it twice lets a view
 *      change stamp on a live hover policy.
 *
 * ONE THING THIS FILE REFUSES TO DO: fly the camera because somebody clicked a
 * node. A selection that ARRIVES AS A SET is a constellation and gets framed; a
 * selection that grows one node at a time is a person pointing at things, and
 * the map must hold still while they do it.
 * =============================================================================
 */

import { useEffect, useRef, useState } from 'react';

import { engine } from '@/engine';
import type { CacheStats } from '@/engine';
import { subscribeTerrain, type FrameStats, type Terrain } from '@/graph';
import { installDescentChoreography, isDescending } from '@/ui/atlas';
import { installMotion, motionIdle, motionOwnsLod, settleIngest } from '@/motion';
import { stopMomentum } from '@/interaction';
import {
  createPerfSampler,
  readSavedViewFromHash,
  registerCameraProbe,
  registerFrameGate,
  registerIdleProbe,
  registerSettleGate,
  useAtlas,
  useAtlasStore,
} from '@/state';

/* =============================================================================
 * 1. THE RENDERER HANDLE
 * ========================================================================== */

/** The live `Terrain`, or `null` before the canvas has a GL context. */
export function useTerrainInstance(): Terrain | null {
  const [terrain, setTerrain] = useState<Terrain | null>(null);
  useEffect(() => subscribeTerrain(setTerrain), []);
  return terrain;
}

/* =============================================================================
 * 2. STORE -> RENDERER
 * ========================================================================== */

/**
 * Push every piece of store state the renderer needs, and lend the store the
 * renderer's clock in return.
 *
 * Each `useEffect` below is one wire. They are separate on purpose: a hover
 * moving 4,406 nodes must not re-run the scene builder, and a filter change must
 * not re-frame the camera.
 */
export function useShellWiring(terrain: Terrain | null): void {
  const {
    view,
    bake,
    rung,
    parentId,
    lod,
    hover,
    selection,
    selectionFramed,
    constellation,
    filters,
    dimmed,
    camera,
  } = useAtlasStore((s) => ({
    view: s.view,
    bake: s.bake,
    rung: s.rung,
    parentId: s.stack.length === 0 ? null : s.stack[s.stack.length - 1].id,
    lod: s.lod,
    hover: s.hover,
    selection: s.selection,
    selectionFramed: s.selectionFramed,
    constellation: s.query.active?.constellation ?? null,
    filters: s.filters,
    /* THE WORLD IS NOT RESOLVED WHILE IT IS ARRIVING.
       The ingest card claims documents are landing; behind it sat the finished,
       fully-labelled map, which refutes the claim in the same frame that makes
       it. INGESTING now dims the terrain for the same reason QUERYING does —
       what is on screen has not been spent on yet. */
    dimmed: s.app === 'QUERYING' || s.app === 'INGESTING',
    camera: s.camera,
  }));

  /* ---- the scene ------------------------------------------------------- */
  useEffect(() => {
    if (terrain === null || view === null || bake === null) return;
    terrain.setScene({ view, bake, rung, parentId });
  }, [terrain, view, bake, rung, parentId]);

  /* ---- the resolution map ----------------------------------------------
   * THE GUARD. While a descent, a render reveal or an ingest settle owns the
   * ramp it re-asserts its own map every frame; the worst a stray push can do is
   * one partially-advanced crossfade, but not pushing is cleaner than winning
   * the race. Each of those runs hands the map back verbatim when it ends.   */
  useEffect(() => {
    if (terrain === null || isDescending() || motionOwnsLod()) return;
    terrain.setLod(lod);
  }, [terrain, lod]);

  /* ---- pointer and selection ------------------------------------------- */
  useEffect(() => terrain?.setHover(hover), [terrain, hover]);
  useEffect(() => terrain?.setSelection(selection), [terrain, selection]);
  useEffect(() => terrain?.setConstellation(constellation), [terrain, constellation]);
  useEffect(
    () => terrain?.setFilters({ sigma: filters.sigma, showQuarantined: filters.showQuarantined }),
    [terrain, filters],
  );
  useEffect(() => terrain?.setDimmed(dimmed), [terrain, dimmed]);

  /* ---- frame a selection that arrived as a SET --------------------------
   * ...UNLESS A LENS PUT IT THERE. A constellation arriving as a set is a
   * result and deserves the camera; 162 nodes arriving because a date window
   * was dragged is a filter, and flying to its bounding box is what turned the
   * timeline into a machine for losing your place. `selectionFramed` is the
   * store saying which of the two just happened.                            */
  const seen = useRef<string[]>([]);
  useEffect(() => {
    const arrived = selection.filter((id) => !seen.current.includes(id)).length;
    seen.current = [...selection];
    if (terrain === null || arrived < 2 || isDescending() || !selectionFramed) return;
    // Momentum outlives the hand. A fling still travelling cancels a flight
    // frame by frame and the camera simply never arrives.
    stopMomentum();
    void terrain.camera.fitTo([...selection], 96);
  }, [terrain, selection, selectionFramed]);

  /* ---- the camera TARGET ------------------------------------------------
   * `camera` in the store is a target and a version counter, never a position.
   * Only a real `setCamera()` — a shared link, a focus action — moves it, and
   * `version` is what says a real one happened rather than an object identity
   * change.                                                                 */
  const cameraVersion = useRef(camera.version);
  useEffect(() => {
    if (terrain === null || camera.version === cameraVersion.current) return;
    cameraVersion.current = camera.version;
    stopMomentum();
    void terrain.camera.moveTo(camera.x, camera.y, camera.zoom, undefined, 'camera');
  }, [terrain, camera]);

  /* ---- the settle gate and the idle probe -------------------------------
   * THE SETTLE IS THE MOTION LAYER'S. It steps every arriving node through the
   * ramp — latent, ghost, lod-2, admitted — from the middle of each community
   * outward on a critically damped spring, and it resolves when the world has
   * stopped arriving. SETTLING lasts exactly that long.
   *
   * THE IDLE PROBE NOW ASKS ALL THREE. `settled()` used to know about camera
   * flights and nothing else, so a reveal or a settle could still be mid-stagger
   * when the shutter fired.                                                  */
  useEffect(() => {
    if (terrain === null) return;
    registerSettleGate((ids) => settleIngest([...ids]));
    registerIdleProbe(() => terrain.camera.idle() && !isDescending() && motionIdle());
    /* ---- the viewpoint, both directions -----------------------------------
     * THE STORE'S `camera` IS A TARGET AND THE USER'S HAND IS NOT. A pan or a
     * wheel-zoom moves the renderer's camera and writes nothing back, so a scene
     * saved from the store field would save the last place the STORE pointed the
     * camera — and `Back` would land somewhere the user never stood. The probe
     * reads the live one; the framer is the same fit the descent uses, so a
     * result and a rung arrive framed by one piece of code.                   */
    registerCameraProbe(() => terrain.camera.get());
    registerFrameGate(async (ids, pad) => {
      stopMomentum();
      await terrain.camera.fitTo([...ids], pad);
    });
    return () => {
      registerSettleGate(null);
      registerIdleProbe(null);
      registerCameraProbe(null);
      registerFrameGate(null);
    };
  }, [terrain]);

  /* ---- the frame budget -------------------------------------------------
   * The HUD prints the renderer's own numbers, accumulated at 4Hz. Nothing here
   * smooths, rounds up or flatters them.                                     */
  useEffect(() => {
    if (terrain === null) return;
    const sampler = createPerfSampler((p) => useAtlas.getState().setPerf(p));
    return terrain.onFrame(sampler.push);
  }, [terrain]);

  /* ---- the descent choreography ----------------------------------------- */
  useEffect(() => installDescentChoreography(), []);

  /* ---- the motion layer --------------------------------------------------
   * One call. It primes the renderer seam, installs the render reveal (which is
   * a store subscription for the same reason the descent's is: a render can be
   * asked for by the command bar, a shared link or the scene driver, and the
   * reveal must not be a property of whichever panel happens to be mounted), the
   * trace cleanup, and `window.__atlas.motion` for the visual-QA pass. */
  useEffect(() => installMotion(), []);
}

/* =============================================================================
 * 3. THE KEYBOARD
 * ========================================================================== */

/**
 * One listener for the whole product, dispatching through the store's own table.
 *
 * `KEYMAP` is the single source for the handler, the help overlay and every
 * `<KeyHint>` chip, so the glyph on screen and the branch taken can never drift.
 */
export function useKeyboard(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (useAtlas.getState().handleKey(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/* =============================================================================
 * 4. THE SHAREABLE SCENE STATE
 * ========================================================================== */

/**
 * Keep `location.hash` and the store in step.
 *
 * `boot()` already reads the hash on the way up and `saveView()` already writes
 * it, so the only wire missing is the BACK BUTTON: a hash that changed without
 * this session writing it is a different scene being asked for, and it is
 * reconstructed through the real `loadView` rather than by patching state.
 */
export function useSavedViewHash(): void {
  useEffect(() => {
    const onHash = (): void => {
      const s = useAtlas.getState();
      const token = readSavedViewFromHash();
      if (token === null || token === s.savedView) return;
      void s.loadView(token);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
}

/* =============================================================================
 * 5. ENGINE TELEMETRY
 * ========================================================================== */

export interface EngineTelemetry {
  /** The CLIENT's response cache. A different counter from the receipt's. */
  cache: CacheStats;
  /** Wall-clock ms around the most recent engine call, measured by the client. */
  lastLatencyMs: number;
}

/**
 * The client's own counters, sampled where they actually change.
 *
 * NO TIMER. Every engine call in this application is followed by a store write,
 * so subscribing to the store samples the counters exactly as often as they can
 * have moved — and never once more, which is what keeps the HUD from repainting
 * four times a second to display the same figure.
 */
export function useEngineTelemetry(): EngineTelemetry {
  const [telemetry, setTelemetry] = useState<EngineTelemetry>(() => ({
    cache: engine.cacheStats(),
    lastLatencyMs: engine.lastLatency,
  }));

  useEffect(() => {
    const sample = (): void => {
      const cache = engine.cacheStats();
      const lastLatencyMs = engine.lastLatency;
      setTelemetry((prev) =>
        prev.cache.hits === cache.hits &&
        prev.cache.lookups === cache.lookups &&
        prev.lastLatencyMs === lastLatencyMs
          ? prev
          : { cache, lastLatencyMs },
      );
    };
    sample();
    return useAtlas.subscribe(sample);
  }, []);

  return telemetry;
}

/* =============================================================================
 * 6. THE RENDERER'S OWN FRAME STATS
 * ========================================================================== */

/** The terrain's full `FrameStats`, for `window.__atlas.perf()`. */
export function frameStatsOf(terrain: Terrain | null): FrameStats {
  return (
    terrain?.perf() ?? { fps: 0, frameMs: 0, points: 0, edges: 0, drawCalls: 0, labels: 0 }
  );
}
