/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE MARKS A TRACE LEAVES
 * =============================================================================
 *
 * The comet is the renderer's. What it LEAVES is this module's: a 1px --evidence
 * hairline along the chord it travelled, and an evidence ring on the source it
 * landed on.
 *
 * -----------------------------------------------------------------------------
 * WHY THE MARKS ARE DOM AND THE COMET IS NOT
 * -----------------------------------------------------------------------------
 * The comet is a moving thing among four thousand other moving things, and it
 * belongs in the buffer they are in. The marks are two static primitives that
 * have to be exactly one CSS pixel and exactly the --evidence token, at any
 * altitude, on any DPR — which is what the DOM is good at and what a 1px line in
 * a WebGL buffer is famously bad at.
 *
 * They agree with the comet because they are placed by the SAME camera: both
 * endpoints are world positions from the bake, projected every frame, so the
 * marks track a pan or a flight rather than smearing across it.
 *
 * -----------------------------------------------------------------------------
 * THE PROJECTION IS SOLVED, NEVER ASSUMED
 * -----------------------------------------------------------------------------
 * WORLD Y IS UP AND DOM Y IS DOWN, and a mark drawn one sign error out of true
 * is a trust annotation pointing at the wrong node — which is the worst thing
 * this part of the product could do, because it is a lie told confidently. The
 * first version of this file took the renderer's `worldToScreen` at face value
 * and drew the ring mirrored about the horizontal axis; it LOOKED plausible,
 * because both endpoints were mirrored together and the chord still connected
 * two dots. A zoomed screenshot is what caught it.
 *
 * So the convention is DERIVED: both signs are tried and the winner is the one
 * whose projected point round-trips back through the camera's own
 * `screenToWorld` to within two pixels of the world point it started from. If
 * neither does, nothing is drawn. The technique is
 * `@/ui/provenance/mapProbe.ts`'s, which established it for exactly this reason;
 * it is re-derived here rather than imported so the motion layer does not take a
 * dependency on a layer above it.
 *
 * -----------------------------------------------------------------------------
 * THEY DO NOT OUTLIVE WHAT THEY DEPICT
 * -----------------------------------------------------------------------------
 * A mark is cleared when the run that drew it ends, and the run is cancelled the
 * moment the place changes — which is exactly what opening the cited passage
 * does. There is no mark in this product that can still be on screen after the
 * thing it points at has left the frame.
 * =============================================================================
 */

import { useAtlas } from '@/state';

import { terrainNow } from './terrain';

/** A point in world units, from the bake. Never a layout, never a guess. */
export interface WorldPoint {
  x: number;
  y: number;
}

let layer: HTMLElement | null = null;
const hairs: HTMLElement[] = [];
const rings: HTMLElement[] = [];

function canvasEl(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLCanvasElement>('.shell__stage canvas, .shell--bare canvas');
}

/**
 * The element the marks are drawn in, created on first use.
 *
 * Mounted as a SIBLING of the terrain canvas so it shares the canvas's box. When
 * there is no canvas there is nothing to annotate and this returns `null` — the
 * state change still happened, the picture is what is missing, which is the
 * correct failure everywhere in this layer.
 */
function ensureLayer(): HTMLElement | null {
  if (layer !== null && layer.isConnected) return layer;
  const host = canvasEl()?.parentElement ?? null;
  if (host === null) return null;
  layer = document.createElement('div');
  layer.className = 'mo-layer';
  layer.setAttribute('aria-hidden', 'true');
  host.appendChild(layer);
  return layer;
}

/** How far a round-trip may miss, in CSS pixels, before the convention is rejected. */
const TOLERANCE_PX = 2;

interface Frame {
  /** Canvas box relative to the mark layer's own box. */
  dx: number;
  dy: number;
  width: number;
  height: number;
  cam: { x: number; y: number; zoom: number };
  /** +1 or -1: which way world y runs on this screen. Solved, not assumed. */
  sign: number;
}

/**
 * Solve the projection for this frame, or return `null` and draw nothing.
 *
 * The probe point is deliberately the one FURTHEST off the camera's centre line:
 * a point sitting on the centre round-trips under both conventions and would let
 * a sign error through unnoticed.
 */
function frameFor(host: HTMLElement, points: readonly WorldPoint[]): Frame | null {
  const terrain = terrainNow();
  const canvas = canvasEl();
  if (terrain === null || canvas === null || points.length === 0) return null;
  const cam = terrain.camera.get();
  if (!(cam.zoom > 0) || !Number.isFinite(cam.x) || !Number.isFinite(cam.y)) return null;

  const canvasRect = canvas.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  if (canvasRect.width < 2 || canvasRect.height < 2) return null;

  let probe = points[0];
  for (const p of points) {
    if (Math.abs(p.y - cam.y) > Math.abs(probe.y - cam.y)) probe = p;
  }

  const tolerance = TOLERANCE_PX / cam.zoom;
  let sign = 0;
  for (const candidate of [-1, 1]) {
    const sx = canvasRect.width / 2 + (probe.x - cam.x) * cam.zoom;
    const sy = canvasRect.height / 2 + candidate * (probe.y - cam.y) * cam.zoom;
    const back = terrain.camera.screenToWorld(sx, sy);
    if (Math.hypot(back[0] - probe.x, back[1] - probe.y) <= tolerance) {
      sign = candidate;
      break;
    }
  }
  if (sign === 0) return null;

  return {
    dx: canvasRect.left - hostRect.left,
    dy: canvasRect.top - hostRect.top,
    width: canvasRect.width,
    height: canvasRect.height,
    cam,
    sign,
  };
}

function project(frame: Frame, p: WorldPoint): { x: number; y: number } {
  return {
    x: frame.dx + frame.width / 2 + (p.x - frame.cam.x) * frame.cam.zoom,
    y: frame.dy + frame.height / 2 + frame.sign * (p.y - frame.cam.y) * frame.cam.zoom,
  };
}

/**
 * Draw one edge's marks for a given travel progress.
 *
 * @param i        which mark slot — one per cited edge in the volley
 * @param from     world position the claim is made at
 * @param to       world position the evidence is at
 * @param travel   0..1 along the chord. The hairline is drawn BEHIND the comet.
 * @param landed   0..1 how far the ring has come up. 0 until the dot arrives.
 * @param fade     0..1 overall opacity of both marks
 */
export function drawTraceMark(
  i: number,
  from: WorldPoint,
  to: WorldPoint,
  travel: number,
  landed: number,
  fade: number,
): void {
  const host = ensureLayer();
  if (host === null) return;
  const frame = frameFor(host, [from, to]);
  if (frame === null) return;
  const a = project(frame, from);
  const b = project(frame, to);

  let hair = hairs[i];
  if (hair === undefined || !hair.isConnected) {
    hair = document.createElement('div');
    hair.className = 'mo-hair';
    host.appendChild(hair);
    hairs[i] = hair;
  }
  let ring = rings[i];
  if (ring === undefined || !ring.isConnected) {
    ring = document.createElement('div');
    ring.className = 'mo-ring';
    host.appendChild(ring);
    rings[i] = ring;
  }

  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  /* TRANSFORM ONLY. The element's LAYOUT size is one stroke square and its whole
     length is a scale, so a frame of this costs a composite and never a reflow.
     The scale is divided by the element's own measured width rather than by an
     assumed 1: the hairline's weight is a token, and a token that changed to
     1.5px would otherwise silently make every mark half again too long. */
  const unit = hair.offsetWidth || 1;
  hair.style.transform = `translate(${a.x}px, ${a.y}px) rotate(${deg}deg) scaleX(${
    (Math.max(0, travel) * len) / unit
  })`;
  hair.style.opacity = String(fade * Math.min(1, travel * 4));

  ring.style.transform = `translate(${b.x}px, ${b.y}px) scale(${0.72 + landed * 0.28})`;
  ring.style.opacity = String(fade * landed);
}

/** Remove every mark. Called when the run that drew them ends, and only then. */
export function clearTraceMarks(): void {
  for (const el of hairs) el.remove();
  for (const el of rings) el.remove();
  hairs.length = 0;
  rings.length = 0;
}

/** The baked world position of a node id, or `null`. The bake is the only source. */
export function bakedPoint(id: string): WorldPoint | null {
  const bake = useAtlas.getState().bake;
  if (bake === null) return null;
  const p = bake.positions.find((q) => q.id === id);
  return p === undefined ? null : { x: p.x, y: p.y };
}
