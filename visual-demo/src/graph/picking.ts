/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — PICKING
 * =============================================================================
 *
 * Hover and click resolve through the ENGINE'S OWN spatial index — the
 * hierarchical spatial hash in `@/engine/layout/bake.ts`, which the bake layer
 * already built and benchmarked at 1.7µs per pick over 100,000 nodes.
 *
 * The two things this file exists to NOT do:
 *
 *   NO LINEAR SCAN. At 100k nodes a scan is ~10ms, which is a dropped frame on
 *   every single mousemove. The terrain would feel like it was thinking about
 *   whether to notice the pointer.
 *
 *   NO GPU READBACK. `readPixels` on an id buffer stalls the pipeline: the CPU
 *   waits for every queued draw call to retire before it gets one pixel back.
 *   It is the classic way to turn a 120fps renderer into a 30fps one, and it
 *   would do it during the one interaction that must feel instantaneous.
 *
 * `pickAt` returns the MOST SPECIFIC disc containing the point, not the nearest
 * centre — with four nested rungs the pointer is inside four discs at once, and
 * the one the user means is the smallest.
 * ========================================================================== */

import { buildSpatialIndex, pickAt, queryRect } from '@/engine';
import type { Bounds, NodePosition, SpatialIndex, Vec2 } from '@/engine';

export class PickIndex {
  private index: SpatialIndex | null = null;
  private scratch: number[] = [];
  /** The ids currently pickable. A node not in the view payload is not a target. */
  size = 0;

  /**
   * Rebuild over the nodes the current view actually admits.
   *
   * Deliberately NOT the whole bake: at the island rung the passages are on
   * screen as `latent` topology, but clicking one would descend three rungs
   * from a dot the user could not have aimed at. What is pickable is what is
   * addressable at this altitude, which is what the payload contains.
   */
  rebuild(positions: readonly NodePosition[]): void {
    this.index = positions.length === 0 ? null : buildSpatialIndex(positions);
    this.size = positions.length;
  }

  /** The most specific node under a world point, or `null`. `slop` is in world units. */
  pick(worldX: number, worldY: number, slop = 0): string | null {
    if (this.index === null) return null;
    const i = pickAt(this.index, worldX, worldY, slop);
    return i < 0 ? null : this.index.ids[i];
  }

  /** Every node whose centre falls inside a world rectangle. Marquee selection. */
  rect(a: Vec2, b: Vec2): string[] {
    if (this.index === null) return [];
    const bounds: Bounds = {
      min_x: Math.min(a[0], b[0]),
      min_y: Math.min(a[1], b[1]),
      max_x: Math.max(a[0], b[0]),
      max_y: Math.max(a[1], b[1]),
    };
    const hits = queryRect(this.index, bounds, this.scratch);
    const out: string[] = new Array(hits.length);
    for (let i = 0; i < hits.length; i++) out[i] = this.index.ids[hits[i]];
    return out;
  }
}
