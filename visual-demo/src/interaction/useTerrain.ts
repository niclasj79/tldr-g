/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE TERRAIN HANDLE
 * =============================================================================
 *
 * `TerrainCanvas` has a fixed `{ className? }` signature, so it cannot reach into
 * the store and the store cannot reach into it. The renderer publishes its
 * instance through `subscribeTerrain()`; this is the React side of that, plus the
 * two small readers every interaction component needs.
 *
 * `useTerrain()` returns `null` until the canvas has mounted, and every consumer
 * has to handle that — a terrain that has not created its GL context yet is a
 * real state, not an impossible one.
 * ========================================================================== */

import { useEffect, useState } from 'react';

import { subscribeTerrain, type Terrain } from '@/graph';
import type { GraphNode, Rung } from '@/engine';
import { RUNG_DEPTH } from '@/engine';

/** The live terrain, re-rendering the caller when it appears or goes away. */
export function useTerrain(): Terrain | null {
  const [terrain, setTerrain] = useState<Terrain | null>(null);
  useEffect(() => subscribeTerrain(setTerrain), []);
  return terrain;
}

/**
 * Is this node descendable FROM the rung we are standing on?
 *
 * Only the rung's own bodies are: entities are cross-cutting and are opened, not
 * entered, and a passage has nothing below it — its verbatim source segment is
 * not a fifth rung. The store enforces the same rule and logs when it is broken;
 * this is the check that stops us breaking it in the first place.
 */
export function canDescend(node: GraphNode | undefined, rung: Rung): boolean {
  if (node === undefined) return false;
  if (rung === 'passage') return false;
  return node.kind === rung && RUNG_DEPTH[rung] < RUNG_DEPTH.passage;
}
