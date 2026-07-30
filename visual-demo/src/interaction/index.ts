/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — INTERACTION BARREL
 * =============================================================================
 *
 * `import { InteractionLayer, SigmaFilters, PathExplain } from '@/interaction';`
 *
 * Everything the shell needs to make the terrain navigable, and nothing else.
 *
 * THE ONE MOUNTING RULE. `InteractionLayer` (or `InteractionSurface` on its own)
 * must be an `inset: 0` SIBLING of `<TerrainCanvas/>` inside the same positioned
 * stage. Its bounding rect is what anchors every zoom; a surface offset from the
 * canvas zooms about the wrong point. The surface measures the canvas on mount
 * and says so on the console if the two disagree.
 *
 * WHAT THIS MODULE OWNS, IN ONE LINE EACH:
 *   InteractionLayer   surface + hover card + world map + palette, one mount
 *   InteractionSurface pointer and keyboard input over the terrain
 *   CommandPalette     the `/` search, over every label in the bake
 *   SigmaFilters       the σ-class chips and the quarantine toggle
 *   PathExplain        two endpoints in, a chain of typed hops out
 *   WorldMapStrip      the 160×90 ghost, island depth and below
 *
 * The pure parts — the camera control, the fuzzy matcher, the directional
 * traversal — are exported too, because they are testable without a DOM and
 * `scripts/verify-interaction.mjs` is not the only thing that should be able to
 * check them.
 *
 * TWO THINGS THE SHELL SHOULD KNOW:
 *
 *   Call `stopMomentum()` before any camera choreography you start yourself.
 *   Momentum outlives the hand, and a fling still travelling cancels a flight
 *   frame by frame — the camera simply never arrives.
 *
 *   Do NOT wire `view.stats.drawn_reason` into `terrain.setEdgePolicy`. The
 *   terrain already falls back to the view's own `drawn_reason` when the override
 *   is null, and the override belongs to the hover layer; wiring it twice lets a
 *   view change stamp on a live hover policy.
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 * 1. THE MOUNTS
 * -------------------------------------------------------------------------- */
export { InteractionLayer, type InteractionLayerProps } from '@/interaction/InteractionLayer';
export {
  InteractionSurface,
  stopMomentum,
  type InteractionSurfaceProps,
} from '@/interaction/InteractionSurface';
export { CommandPalette } from '@/interaction/CommandPalette';
export { SigmaFilters, type SigmaFiltersProps } from '@/interaction/SigmaFilters';
export { PathExplain, type PathExplainProps } from '@/interaction/PathExplain';
export { WorldMapStrip, type WorldMapStripProps } from '@/ui/WorldMapStrip';

/* -----------------------------------------------------------------------------
 * 2. THE HOVER PATH
 * -------------------------------------------------------------------------- */
export { HoverCard, placeHoverCard, type HoverCardProps } from '@/interaction/HoverCard';
export { HoverLayer, type HoverLayerProps } from '@/interaction/HoverLayer';
export { useHoverNeighborhood, type HoverNeighborhood } from '@/interaction/useHoverNeighborhood';

/* -----------------------------------------------------------------------------
 * 3. DIRECT MANIPULATION, WITHOUT REACT
 * -------------------------------------------------------------------------- */
export {
  clampCameraToWorld,
  createCameraControl,
  type CameraControl,
  type CameraControlOptions,
  type PointerSample,
} from '@/interaction/camera-control';

/* -----------------------------------------------------------------------------
 * 4. THE PURE PARTS
 * -------------------------------------------------------------------------- */
export { fuzzyBest, fuzzyMatch, markRuns, type FuzzyMatch } from '@/interaction/fuzzy';
export {
  insideFrustum,
  nearestInDirection,
  nearestToPoint,
  type Direction,
  type NavNode,
} from '@/interaction/keyboard-nav';
export {
  buildSearchIndex,
  peekSearchIndex,
  resetSearchIndex,
  type IndexItem,
  type SearchIndex,
} from '@/interaction/search-index';

/* -----------------------------------------------------------------------------
 * 5. TOKENS AND THE TERRAIN HANDLE
 * -------------------------------------------------------------------------- */
export { invalidateTuning, readTuning, type Tuning } from '@/interaction/tuning';
export { canDescend, useTerrain } from '@/interaction/useTerrain';
