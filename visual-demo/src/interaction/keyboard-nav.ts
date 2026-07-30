/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — KEYBOARD TRAVERSAL OF THE GRAPH
 * =============================================================================
 *
 * Arrow keys move focus to the nearest node IN THAT DIRECTION. Pure geometry over
 * the baked positions, no DOM, no store — so it is testable and so the same rule
 * governs the terrain and the world-map strip.
 *
 * WHY NOT "NEAREST NODE, FULL STOP". Because a hand on the arrow keys is asking a
 * directional question, and a nearest-neighbour search answers a different one:
 * press Right on a node whose closest neighbour happens to sit up and slightly
 * right, and focus goes up. Do that twice and the user has lost their place on a
 * map whose whole purpose is that you never do.
 *
 * So a candidate must lie inside a cone around the axis, and candidates are
 * ranked by distance PENALISED BY ANGLE: a node dead ahead beats a nearer one off
 * to the side. `cos(θ)^2` is the penalty — sharp enough that the cone edge is not
 * competitive, gentle enough that a perfect grid is not required.
 * ========================================================================== */

export type Direction = 'up' | 'down' | 'left' | 'right';

/** The minimum a node needs to be a candidate: an id and a world position. */
export interface NavNode {
  id: string;
  x: number;
  y: number;
}

/**
 * The half-angle of the cone, in radians. 60° each side: wide enough that a
 * sparse terrain still has a candidate in every direction, narrow enough that
 * "right" never means "up".
 */
const CONE = Math.PI / 3;

/** World-space unit vector for each arrow. Y is UP in world space, as in the bake. */
const AXIS: Readonly<Record<Direction, readonly [number, number]>> = Object.freeze({
  up: [0, 1],
  down: [0, -1],
  left: [-1, 0],
  right: [1, 0],
});

/**
 * The node a press of `dir` should move focus to, or `null` when the cone is
 * empty — which is a real answer about the terrain, and the right moment to do
 * nothing rather than to wrap around to the far side of the world.
 */
export function nearestInDirection(
  from: NavNode,
  candidates: readonly NavNode[],
  dir: Direction,
): NavNode | null {
  const [ax, ay] = AXIS[dir];
  let best: NavNode | null = null;
  let bestCost = Infinity;

  for (const c of candidates) {
    if (c.id === from.id) continue;
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) continue;
    const cos = (dx * ax + dy * ay) / dist;
    if (cos <= Math.cos(CONE)) continue;
    // Distance, penalised by how far off-axis it is.
    const cost = dist / (cos * cos);
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best;
}

/**
 * Where to start when nothing is focused: the node nearest the centre of the
 * frustum, so the first arrow press lands on something the user can already see.
 */
export function nearestToPoint(
  x: number,
  y: number,
  candidates: readonly NavNode[],
): NavNode | null {
  let best: NavNode | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** True when a world point sits inside the visible rectangle, with a margin. */
export function insideFrustum(
  x: number,
  y: number,
  f: { x: number; y: number; w: number; h: number },
  marginFraction = 0.12,
): boolean {
  const mx = (f.w / 2) * (1 - marginFraction);
  const my = (f.h / 2) * (1 - marginFraction);
  return Math.abs(x - f.x) <= mx && Math.abs(y - f.y) <= my;
}
