/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE HOVER LAYER
 * =============================================================================
 *
 * Everything that changes when the pointer moves, isolated into one component so
 * that a sweep across 4,406 nodes re-renders THIS and nothing else. The surface
 * above it selects no pointer state at all and therefore never reconciles while
 * the hand is moving.
 *
 * It also owns the hover edge policy, and it is deliberate about when it engages
 * it — see `engagePolicy`.
 * ========================================================================== */

import { useEffect, useLayoutEffect, useMemo, type MutableRefObject } from 'react';

import { useAtlasStore } from '@/state';
import type { GraphNode } from '@/engine';

import { HoverCard, placeHoverCard } from '@/interaction/HoverCard';
import { useHoverNeighborhood } from '@/interaction/useHoverNeighborhood';
import { useTerrain } from '@/interaction/useTerrain';

export interface HoverLayerProps {
  /** The card element, so the surface can move it at pointer rate. */
  cardRef: MutableRefObject<HTMLDivElement | null>;
  /** The last client-space pointer position, written by the surface. */
  pointRef: MutableRefObject<{ x: number; y: number }>;
  /** Fetch the one-hop neighbourhood at all. */
  enabled: boolean;
  /**
   * Switch the renderer to `hover-neighborhood`.
   *
   * FALSE AT THE REGION RUNGS ON PURPOSE. There the terrain draws bundled
   * corridors, and this policy makes it draw the two exemplar relations shipped
   * with each corridor instead. That is not "the neighbourhood revealed", it is
   * the corridors disappearing — and the corridors are what is true up there.
   */
  engagePolicy: boolean;
}

export function HoverLayer({ cardRef, pointRef, enabled, engagePolicy }: HoverLayerProps): JSX.Element | null {
  const terrain = useTerrain();
  const { hover, node, lod } = useAtlasStore((s) => ({
    hover: s.hover,
    node: s.hover === null ? null : (s.view?.nodes.find((n) => n.id === s.hover) ?? null),
    lod: s.hover === null ? undefined : s.lod[s.hover],
  }));

  const neighborhood = useHoverNeighborhood(enabled ? hover : null);

  // Seat the card where the pointer already is, before the browser paints it, so
  // it never flashes at the origin on its way to the cursor.
  useLayoutEffect(() => {
    if (node === null) return;
    placeHoverCard(cardRef.current, pointRef.current.x, pointRef.current.y);
  }, [cardRef, node, pointRef, neighborhood]);

  useEffect(() => {
    if (terrain === null) return;
    const live = engagePolicy && hover !== null && neighborhood !== null && neighborhood.nodeId === hover;
    terrain.setEdgePolicy(live ? 'hover-neighborhood' : null);
  }, [terrain, engagePolicy, hover, neighborhood]);

  // Releasing the policy on unmount matters: a panel that mounts over the
  // terrain must not leave it stuck in a rule nobody is asking for any more.
  useEffect(() => {
    return () => terrain?.setEdgePolicy(null);
  }, [terrain]);

  const target = useMemo<GraphNode | null>(() => node, [node]);
  if (target === null) return null;

  return <HoverCard ref={cardRef} node={target} lod={lod} neighborhood={neighborhood} />;
}
