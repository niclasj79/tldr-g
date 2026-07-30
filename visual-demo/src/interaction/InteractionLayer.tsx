/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE INTERACTION LAYER
 * =============================================================================
 *
 * One mount for the whole hand: the input surface, the hover card, the world-map
 * strip and the command palette.
 *
 *   <div className="stage">           // position: relative
 *     <TerrainCanvas />
 *     <InteractionLayer />            // must be the terrain's inset:0 sibling
 *   </div>
 *
 * The palette and the hover card portal to `<body>`, so mounting them here is a
 * convenience rather than a layout decision — they end up in the same place
 * wherever this component sits.
 *
 * The filter chips and the path readout are NOT here on purpose: they are panel
 * content, and where a panel goes is the shell's decision, not this module's.
 * Import `SigmaFilters` and `PathExplain` from `@/interaction` and place them.
 * ========================================================================== */

import { CommandPalette } from '@/interaction/CommandPalette';
import { InteractionSurface, type InteractionSurfaceProps } from '@/interaction/InteractionSurface';
import { WorldMapStrip } from '@/ui/WorldMapStrip';

export interface InteractionLayerProps extends InteractionSurfaceProps {
  /** The 160×90 ghost. Absent at the continent rung whatever this says. */
  worldMap?: boolean;
  /** The `/` palette. Set false if the shell mounts it itself. */
  palette?: boolean;
}

export function InteractionLayer({
  worldMap = true,
  palette = true,
  ...surface
}: InteractionLayerProps): JSX.Element {
  return (
    <>
      <InteractionSurface {...surface} />
      {worldMap ? <WorldMapStrip /> : null}
      {palette ? <CommandPalette /> : null}
    </>
  );
}
