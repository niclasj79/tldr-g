/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE RENDERER SEAM
 * =============================================================================
 *
 * `src/motion/**` does not own the renderer, and it must not drag three.js into
 * every module that imports a motion primitive — a receipt panel that cannot be
 * mounted without a WebGL context is a receipt panel nobody can test. So the
 * terrain is reached exactly the way `@/ui/provenance/tracePing.ts` reaches it:
 *
 *   1. an override installed by `setMotionTerrain()` — for a harness that wants
 *      to record what the motion asked the renderer to do instead of drawing it;
 *   2. otherwise `getTerrain()` from `@/graph`, imported DYNAMICALLY;
 *   3. otherwise nothing, and every primitive here degrades to the STATE change
 *      alone. That is the correct failure: the place still changes, the render
 *      still lands, the receipt still counts. It is the picture that is optional.
 *
 * The module is PRIMED on import so the dynamic import has resolved long before
 * the first animation needs a synchronous handle inside a frame callback.
 * =============================================================================
 */

import type { LodState } from '@/engine';

/** Exactly what this layer needs of the renderer, and nothing more of it. */
export interface MotionTerrain {
  /** The resolution override map. The only channel this layer writes tiers on. */
  setLod(lod: Record<string, LodState>): void;
  /** The renderer's own comet, along the chord between two real node ids. */
  tracePing(fromId: string, toId: string, delayMs?: number): Promise<void>;
  camera: {
    /** Where the camera is. An overlay projects from this, never from a guess. */
    get(): { x: number; y: number; zoom: number };
    /**
     * CSS px -> world, y DOWN as a pointer event carries it.
     *
     * The overlay uses this to VERIFY its own projection rather than to build
     * one: both y conventions are tried and the one that round-trips wins. See
     * the header of `./overlay.ts` for why that is not paranoia.
     */
    screenToWorld(sx: number, sy: number): readonly [number, number] | number[];
    idle(): boolean;
  };
}

type GraphModule = { getTerrain(): MotionTerrain | null };

let override: MotionTerrain | null = null;
let graph: GraphModule | null = null;
let priming: Promise<void> | null = null;

/** Install a terrain implementation, or clear it with `null`. Harness only. */
export function setMotionTerrain(t: MotionTerrain | null): void {
  override = t;
}

/** Load `@/graph` once. Failure means the renderer is not part of this page. */
export function primeMotionTerrain(): Promise<void> {
  if (graph !== null) return Promise.resolve();
  if (priming !== null) return priming;
  priming = import('@/graph')
    .then((m) => {
      graph = m as unknown as GraphModule;
    })
    .catch(() => {
      /* No renderer here. Every primitive degrades to the state change alone. */
    });
  return priming;
}

/**
 * The live terrain, synchronously, or `null`.
 *
 * Safe to call inside a frame callback: the dynamic import is primed on module
 * load and `getTerrain()` itself is a module-level read.
 */
export function terrainNow(): MotionTerrain | null {
  if (override !== null) return override;
  return graph === null ? null : graph.getTerrain();
}

/** The live terrain, waiting for the dynamic import if it has not landed yet. */
export async function terrainSoon(): Promise<MotionTerrain | null> {
  if (override !== null) return override;
  await primeMotionTerrain();
  return terrainNow();
}

void primeMotionTerrain();
