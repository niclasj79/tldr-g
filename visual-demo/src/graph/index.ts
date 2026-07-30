/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — GRAPH BARREL
 * =============================================================================
 *
 * `import { createTerrain, TerrainCanvas, type Terrain } from '@/graph';`
 *
 * Everything the shell, the interaction layer and the Atlas mode need from the
 * renderer, and nothing else. The internals — the shaders, the bundler, the
 * field builder, the picker — are deliberately not re-exported: they are how
 * the terrain is drawn, not what it promises.
 *
 * TWO THINGS ARE EXPORTED THAT ARE NOT ON THE `Terrain` INTERFACE, and both are
 * wiring rather than rendering:
 *
 *   getTerrain() / subscribeTerrain()  — the instance registry. `TerrainCanvas`
 *     has a fixed `{ className? }` signature, so it cannot reach into the store
 *     itself without this module taking a dependency on another agent's module.
 *     The shell grabs the instance from here (or passes `onReady`) and does the
 *     wiring in one effect, in the module that already owns both sides.
 *
 *   NODE_FLAG / EDGE_FLAG              — the two bitfields, so a caller reading
 *     `FrameStats` or debugging a scene can name what it is looking at instead
 *     of counting bits.
 * ========================================================================== */

export { createTerrain } from '@/graph/terrain';
export type {
  ConstellationInput,
  FrameStats,
  SceneInput,
  Terrain,
  TerrainOpts,
} from '@/graph/terrain';

export type { TerrainCamera } from '@/graph/camera';

export { TerrainCanvas, getTerrain, subscribeTerrain } from '@/graph/TerrainCanvas';
export type { TerrainCanvasProps } from '@/graph/TerrainCanvas';

export { NODE_FLAG } from '@/graph/points';
export { EDGE_FLAG, SIGMA_CODE } from '@/graph/edges';

/** The renderer's half of the token bridge, exported for a shell that themes. */
export { invalidatePalette, readPalette } from '@/graph/palette';
export type { Palette } from '@/graph/palette';
