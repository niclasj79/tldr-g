/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE RUNG ATLAS BARREL
 * =============================================================================
 *
 * `import { AtlasMode, Breadcrumb, RungLegend, descend, ascend } from '@/ui/atlas';`
 *
 * The zoom narrative: four rungs, one continuous camera, and an ontology that
 * changes when you descend rather than a picture that gets bigger.
 *
 * -----------------------------------------------------------------------------
 * WHAT THE SHELL HAS TO DO, IN FOUR LINES
 * -----------------------------------------------------------------------------
 *   1. `installDescentChoreography()` once, next to the other terrain wiring.
 *      It adopts every rung change the keyboard, semantic zoom or a shared link
 *      makes, so the descent has its beats no matter who started it. Returns an
 *      unsubscribe.
 *
 *   2. Prefer this module's `descend` / `ascend` / `goToRung` over the store's
 *      wherever the shell navigates directly. Same actions underneath — these
 *      add the camera, the ramp and the interruption handling around them.
 *
 *   3. Mount `<Breadcrumb/>` in the top bar, `<RungLegend/>` over the terrain,
 *      and `<AtlasMode/>` inside the positioned stage that holds the canvas —
 *      it docks itself to the right edge of its offset parent. All three take a
 *      `className`; none of them positions the shell.
 *
 *   4. Optional but free: skip pushing `store.lod` into `terrain.setLod` while
 *      `isDescending()` is true. The choreography re-asserts its own map every
 *      frame, so the worst a stray push can do is one partially-advanced
 *      crossfade — but not pushing is cleaner than winning the race.
 * =============================================================================
 */

import './atlas.css';

/* -----------------------------------------------------------------------------
 * 1. THE CHOREOGRAPHY
 * -------------------------------------------------------------------------- */
export {
  activeDescent,
  ascend,
  cancelDescent,
  descend,
  goToRung,
  installDescentChoreography,
  isDescending,
  subscribeDescent,
} from './descent';
export type { DescentFrame, DescentPhase, DescentResult } from './descent';

/* -----------------------------------------------------------------------------
 * 2. THE ALTITUDE GEOMETRY — pure, testable without a DOM
 * -------------------------------------------------------------------------- */
export {
  bandPosition,
  bandWidth,
  createRungGate,
  crossingFor,
  depthOf,
  invalidateAtlasMotion,
  readAtlasMotion,
  readAtlasNaming,
  readRungBand,
  rungAbove,
  rungBelow,
  MAX_DEPTH,
} from './rungGeometry';
export type {
  AtlasMotion,
  AtlasNaming,
  CrossingPermissions,
  RungBand,
  RungCrossing,
  RungGate,
  RungGateState,
} from './rungGeometry';

/* -----------------------------------------------------------------------------
 * 3. THE COMPONENTS
 * -------------------------------------------------------------------------- */
export { Breadcrumb, type BreadcrumbProps } from './Breadcrumb';
export { RungLegend, type RungLegendProps } from './RungLegend';
export { RungLedger, LEDGER_ROW_CAP, type RungLedgerProps } from './RungLedger';
export { AtlasMode, type AtlasModeProps } from './AtlasMode';
