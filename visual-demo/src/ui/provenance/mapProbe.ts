/**
 * =============================================================================
 * THE MAP PROBE — where a node actually is on screen, right now
 * =============================================================================
 *
 * The trust surface has one thing it needs from the renderer that the renderer's
 * own interface does not offer: the SCREEN POSITION of a node it is already
 * drawing. `tracePing` asks the terrain to draw something; this asks it where
 * something already is, so that provenance can annotate the map without owning
 * a pixel of it.
 *
 * -----------------------------------------------------------------------------
 * IT SOLVES FOR THE CONVENTION RATHER THAN ASSUMING IT
 * -----------------------------------------------------------------------------
 * A projection written from the outside is one sign error away from putting a
 * red mark on the wrong node — which is the worst thing this section of the
 * product could possibly do, because a trust annotation in the wrong place is a
 * lie told loudly. So nothing here is assumed:
 *
 *   1. the canvas is found by MEASUREMENT, not by class name — every canvas in
 *      the document is a candidate;
 *   2. both y conventions are tried;
 *   3. every candidate is CHECKED by round-tripping the projected point back
 *      through the terrain's own `screenToWorld` and comparing it to the world
 *      point we started from.
 *
 * The first candidate that round-trips inside two CSS pixels wins. If none does,
 * `project()` returns `null` and the caller draws NOTHING. A mark this module
 * cannot verify the position of is a mark that does not get drawn.
 *
 * -----------------------------------------------------------------------------
 * THE SEAM, SAME SHAPE AS THE TRACE PING
 * -----------------------------------------------------------------------------
 * `@/graph` is imported dynamically, so a trust panel still renders on a page
 * with no WebGL context, and a harness can install its own probe with
 * `setMapProbe()` and assert on the geometry instead of photographing it.
 * =============================================================================
 */

/** A baked position: the world coordinates the layout actually holds. */
export interface WorldPoint {
  id: string;
  x: number;
  y: number;
}

/** A projected position, in CSS pixels, in VIEWPORT coordinates. */
export interface ScreenPoint {
  id: string;
  x: number;
  y: number;
}

/** The terrain's rectangle in viewport coordinates, so an overlay can clip to it. */
export interface ScreenFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Projection {
  frame: ScreenFrame;
  /** Only the points that projected AND verified. Never a guess. */
  points: ScreenPoint[];
}

export interface MapProbe {
  /** `null` when the projection could not be verified — draw nothing. */
  project(world: readonly WorldPoint[]): Projection | null;
  /** Fires after every frame the terrain draws. Returns an unsubscribe. */
  onFrame(cb: () => void): () => void;
}

let override: MapProbe | null = null;

/** Install a probe, or clear it with `null`. Used by the harness. */
export function setMapProbe(probe: MapProbe | null): void {
  override = probe;
}

/** True when an override is installed. Distinct from "a terrain exists". */
export function hasMapProbeOverride(): boolean {
  return override !== null;
}

/** How far a round-trip may miss, in CSS pixels, before the candidate is rejected. */
const TOLERANCE_PX = 2;

/** The minimal slice of the renderer this module touches. Nothing else of it. */
interface CameraLike {
  get(): { x: number; y: number; zoom: number };
  screenToWorld(sx: number, sy: number): [number, number] | { 0: number; 1: number };
}
interface TerrainLike {
  camera: CameraLike;
  onFrame(cb: (stats: unknown) => void): () => void;
}

/**
 * Project world points into viewport pixels against one candidate canvas.
 *
 * Returns `null` unless the round-trip check passes, which is what makes this
 * safe to run against a renderer this module does not own.
 */
function projectAgainst(
  terrain: TerrainLike,
  canvas: HTMLCanvasElement,
  world: readonly WorldPoint[],
): Projection | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;

  const cam = terrain.camera.get();
  if (!(cam.zoom > 0) || !Number.isFinite(cam.x) || !Number.isFinite(cam.y)) return null;

  /* The probe point is the one FURTHEST off the camera's own centre line. A
     point sitting exactly on the centre round-trips under both conventions and
     would let a sign error through unnoticed. */
  let probe = world[0];
  for (const p of world) {
    if (Math.abs(p.y - cam.y) > Math.abs(probe.y - cam.y)) probe = p;
  }

  const tolerance = TOLERANCE_PX / cam.zoom;
  const local = (p: WorldPoint, sign: number): [number, number] => [
    rect.width / 2 + (p.x - cam.x) * cam.zoom,
    rect.height / 2 + sign * (p.y - cam.y) * cam.zoom,
  ];

  let convention = 0;
  for (const sign of [-1, 1]) {
    const [sx, sy] = local(probe, sign);
    const back = terrain.camera.screenToWorld(sx, sy);
    const dx = back[0] - probe.x;
    const dy = back[1] - probe.y;
    if (Math.hypot(dx, dy) <= tolerance) {
      convention = sign;
      break;
    }
  }
  if (convention === 0) return null;

  const points: ScreenPoint[] = [];
  for (const p of world) {
    const [sx, sy] = local(p, convention);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
    points.push({ id: p.id, x: rect.left + sx, y: rect.top + sy });
  }

  return {
    frame: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    points,
  };
}

/** Every canvas in the document, largest first — the terrain owns the horizontal. */
function candidates(): HTMLCanvasElement[] {
  if (typeof document === 'undefined') return [];
  return [...document.querySelectorAll('canvas')].sort(
    (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
  );
}

function fromTerrain(terrain: TerrainLike): MapProbe {
  /* The canvas that last verified. `project` runs on every frame the terrain
     draws, and re-scanning the document for canvases sixty times a second to
     re-discover the same one is exactly the kind of per-frame allocation the
     renderer next door refuses to make. It is a cache, not a promise: the
     round-trip check still runs every call, and a miss falls back to the scan. */
  let known: HTMLCanvasElement | null = null;

  return {
    project(world) {
      if (world.length === 0) return null;
      if (known !== null && known.isConnected) {
        const hit = projectAgainst(terrain, known, world);
        if (hit !== null) return hit;
      }
      for (const canvas of candidates()) {
        const hit = projectAgainst(terrain, canvas, world);
        if (hit !== null) {
          known = canvas;
          return hit;
        }
      }
      known = null;
      return null;
    },
    onFrame(cb) {
      return terrain.onFrame(() => cb());
    },
  };
}

/**
 * Resolve a probe: the override, else the live terrain, else `null`.
 *
 * A `null` here is a legitimate configuration — a page with no canvas — and the
 * caller reports it by drawing nothing rather than by drawing something wrong.
 */
export async function resolveMapProbe(): Promise<MapProbe | null> {
  if (override !== null) return override;
  try {
    const graph = await import('@/graph');
    const terrain = graph.getTerrain();
    if (terrain === null) return null;
    return fromTerrain(terrain as unknown as TerrainLike);
  } catch {
    return null;
  }
}

/**
 * Track the probe across terrain mounts.
 *
 * A panel can outlive a canvas and vice versa, and an annotation that keeps
 * drawing after the renderer it was measured against has gone is exactly the
 * failure this whole section exists to prevent. Called immediately with the
 * current value, then on every change.
 */
export async function subscribeMapProbe(cb: (probe: MapProbe | null) => void): Promise<() => void> {
  if (override !== null) {
    cb(override);
    return () => undefined;
  }
  try {
    const graph = await import('@/graph');
    return graph.subscribeTerrain((terrain) =>
      cb(terrain === null ? null : fromTerrain(terrain as unknown as TerrainLike)),
    );
  } catch {
    cb(null);
    return () => undefined;
  }
}
