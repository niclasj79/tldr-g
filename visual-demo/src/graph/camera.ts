/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE ORTHOGRAPHIC CAMERA
 * =============================================================================
 *
 * ONE CONTINUOUS CAMERA. There are no cuts in this product. Panning, zooming and
 * descending a rung are the same operation at different magnitudes, and every
 * one of them is a flight the eye can follow. A cut would save 700ms and cost
 * the user the thing the terrain exists to give them: knowing where they are.
 *
 * TOP-DOWN AND ORTHOGRAPHIC, ALWAYS. There is no perspective camera in this
 * renderer and there never will be — a knowledge terrain read at an angle makes
 * distance mean two things at once (semantic distance and depth), and the map
 * stops being measurable. Depth separates layers; it never separates places.
 *
 * -----------------------------------------------------------------------------
 * THE UNITS
 * -----------------------------------------------------------------------------
 * `zoom` is CSS PIXELS PER WORLD UNIT. That single choice removes every
 * conversion bug in the renderer: `worldToScreen` is one multiply-add, the
 * shaders take the same number (times DPR) as `uCam.z`, and a "1.5px stroke"
 * means 1.5px at every altitude in every layer.
 *
 * -----------------------------------------------------------------------------
 * WHY ZOOM IS INTERPOLATED IN LOG SPACE
 * -----------------------------------------------------------------------------
 * Linear interpolation of a zoom factor is perceptually wrong: half way through
 * a 1x -> 100x flight you are at 50x, which is visually 85% of the way there,
 * so the flight appears to stop early and then crawl. Interpolating log(zoom)
 * makes every equal slice of the flight cover an equal RATIO, which is how
 * scale is actually perceived. The pan is carried in the same normalised time,
 * with the token easing, so the two never disagree about when they arrive.
 * ========================================================================== */

import { ease, readPalette, type Bezier, type Palette } from '@/graph/palette';
import type { Bounds, Vec2 } from '@/engine';

/**
 * The camera surface, exactly as the module contract fixes it, plus the three
 * DIRECT-MANIPULATION methods below.
 *
 * Those three are additive and they are here on purpose. Drag and wheel-zoom are
 * not flights — they have to track the pointer with zero interpolation, and
 * anchored zoom in particular ("keep the world point under the cursor fixed") is
 * a two-line transform that is subtly wrong in a dozen ways if each caller
 * rebuilds it. Leaving the interaction layer to reconstruct it out of
 * `screenToWorld` + `moveTo` guarantees exactly that. Everything the contract
 * declares is unchanged.
 */
export interface TerrainCamera {
  moveTo(x: number, y: number, zoom: number, ms?: number, ease?: 'ui' | 'camera' | 'none'): Promise<void>;
  get(): { x: number; y: number; zoom: number };
  frustum(): { x: number; y: number; w: number; h: number };
  worldToScreen(x: number, y: number): Vec2;
  screenToWorld(sx: number, sy: number): Vec2;
  fitTo(ids: string[], padding?: number, ms?: number, frame?: FitFrame): Promise<void>;
  idle(): boolean;

  /** Drag by a CSS-pixel delta. DOM convention: positive `dy` is downward. */
  panByPixels(dx: number, dy: number): void;
  /** Wheel-zoom about a screen anchor, keeping the world point under it fixed. */
  zoomAt(sx: number, sy: number, factor: number): void;
  /** Apply a camera target with no flight. Cancels any flight in progress. */
  set(x: number, y: number, zoom: number): void;
}

/** Where a node is, for `fitTo`. The camera never reads the graph itself. */
export interface PositionLookup {
  (id: string): { x: number; y: number; r: number } | undefined;
}

/**
 * Optional shaping for a `fitTo`.
 *
 * `scale` is how much bigger than the subject the frame should be. A two-hop
 * answer path framed tight is a line across an empty screen; the context it
 * crosses is the reason the crossing means anything.
 *
 * `right` / `bottom` are OCCLUSION, in CSS px: the rail and the dock are drawn
 * over the terrain, so the usable frame is smaller than the canvas. An answer
 * whose terminal lands under the panel that names it is worse than no move.
 */
export interface FitFrame {
  scale?: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  /**
   * FRAME WHAT THESE NODES CONTAIN, not where they are.
   *
   * Off by default, and that default is right almost everywhere: a region's
   * containment radius is three times the terrain at the island rung, so fitting
   * the discs would arrive at a map the size of a coin. It is on for exactly one
   * case — the passage rung, where the subject IS a declared boundary and the
   * frame has to hold the whole document, edge included, or the boundary that
   * makes five spans read as one page is drawn a thousand pixels off-screen.
   */
  discs?: boolean;
}

interface Flight {
  fromX: number;
  fromY: number;
  fromLogZoom: number;
  toX: number;
  toY: number;
  toLogZoom: number;
  start: number;
  duration: number;
  curve: Bezier;
  resolve: () => void;
}

export class TerrainCameraImpl implements TerrainCamera {
  private x = 0;
  private y = 0;
  private zoom = 1;

  /** CSS pixels. The renderer keeps this in step with the canvas. */
  private width = 1;
  private height = 1;

  private minZoom = 1e-4;
  private maxZoom = 1e4;

  private flight: Flight | null = null;
  private palette: Palette;

  /**
   * THE SUBJECT FRAME, and why it lives on the camera rather than at one call
   * site.
   *
   * When an answer is on screen, `fitTo` should frame it the same way NO MATTER
   * WHO CALLS IT — the renderer reacting to the constellation, or the shell
   * reacting to the selection that arrived with it. Both were calling `fitTo`
   * with the same three node ids a few milliseconds apart, and whichever ran
   * last decided the picture. The result was a frame that cropped the answer
   * against the right rail and left no terrain around the path it crosses.
   *
   * So the framing RULE is set once, here, and every `fitTo` obeys it unless a
   * caller overrides a field explicitly.
   */
  private defaultFrame: FitFrame | null = null;

  /** Bumped on any change, so the renderer knows whether a frame is needed. */
  version = 0;

  /**
   * Ask the renderer for a frame.
   *
   * LOAD-BEARING, and it is the reason this hook exists at all. The render loop
   * is on demand: it stops when nothing is animating. A `moveTo` issued while it
   * is stopped starts a flight that nothing will ever tick, so the promise it
   * returns never resolves — every `await camera.fitTo(...)` and every scene
   * hook waiting on `settled()` deadlocks, silently, forever. The camera must be
   * able to wake the loop it depends on.
   */
  private wake: () => void = () => {};

  setWake(cb: () => void): void {
    this.wake = cb;
  }

  constructor(
    private readonly lookup: PositionLookup,
    palette: Palette = readPalette(),
  ) {
    this.palette = palette;
  }

  setPalette(p: Palette): void {
    this.palette = p;
  }

  /** Set (or clear) the framing rule every `fitTo` obeys. See `defaultFrame`. */
  setDefaultFrame(frame: FitFrame | null): void {
    this.defaultFrame = frame;
  }

  /** Called by the renderer on resize. Keeps the world point under the centre fixed. */
  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.version++;
    this.wake();
  }

  /**
   * Bound the altitude range to the world being shown.
   *
   * Not a UX nicety: without a floor the user can zoom out until the terrain is
   * a single pixel and there is no gesture that gets them back, and without a
   * ceiling the float precision of the world-to-screen multiply gives out and
   * nodes start jittering. Both failures look like bugs in the data.
   */
  setWorldBounds(b: Bounds): void {
    const w = Math.max(1e-6, b.max_x - b.min_x);
    const h = Math.max(1e-6, b.max_y - b.min_y);
    const fit = Math.min(this.width / w, this.height / h);
    this.minZoom = fit * 0.35;
    this.maxZoom = fit * 900;
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom));
  }

  /** The zoom that exactly frames `b` inside the viewport, with `padding` CSS px. */
  zoomToFit(b: Bounds, padding = 48): number {
    const w = Math.max(1e-6, b.max_x - b.min_x);
    const h = Math.max(1e-6, b.max_y - b.min_y);
    const availW = Math.max(32, this.width - padding * 2);
    const availH = Math.max(32, this.height - padding * 2);
    return Math.min(availW / w, availH / h);
  }

  get(): { x: number; y: number; zoom: number } {
    return { x: this.x, y: this.y, zoom: this.zoom };
  }

  /** The visible world rectangle. `x`/`y` are the CENTRE, matching the store's camera. */
  frustum(): { x: number; y: number; w: number; h: number } {
    return { x: this.x, y: this.y, w: this.width / this.zoom, h: this.height / this.zoom };
  }

  /** World -> CSS pixels, y UP in both. The identical expression the shaders use. */
  worldToScreen(x: number, y: number): Vec2 {
    return [(x - this.x) * this.zoom + this.width / 2, (y - this.y) * this.zoom + this.height / 2];
  }

  /**
   * CSS pixels -> world. Note the caller passes a DOM coordinate (y DOWN, which
   * is what a pointer event carries), so the flip lives here — in exactly one
   * place — rather than being re-derived at every call site.
   */
  screenToWorld(sx: number, sy: number): Vec2 {
    return [
      (sx - this.width / 2) / this.zoom + this.x,
      (this.height / 2 - sy) / this.zoom + this.y,
    ];
  }

  /** Same as `screenToWorld` for a y-UP screen coordinate. */
  screenToWorldUp(sx: number, sy: number): Vec2 {
    return [(sx - this.width / 2) / this.zoom + this.x, (sy - this.height / 2) / this.zoom + this.y];
  }

  idle(): boolean {
    return this.flight === null;
  }

  /**
   * Fly to a target. Resolves when the camera arrives.
   *
   * A moveTo issued mid-flight does NOT cancel and does NOT queue: it retargets
   * from wherever the camera currently is, and the superseded promise resolves
   * rather than rejecting. That is what makes the camera continuous — the user
   * clicking a second destination should bend the flight, not stop it dead and
   * start again, and a caller awaiting the first move should not have to handle
   * an exception for having been overtaken.
   */
  moveTo(x: number, y: number, zoom: number, ms?: number, easing: 'ui' | 'camera' | 'none' = 'camera'): Promise<void> {
    const targetZoom = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
    const duration = this.palette.reducedMotion
      ? this.palette.ms.fast
      : (ms ?? (easing === 'ui' ? this.palette.ms.ui : this.palette.ms.scene));

    // Settle the superseded flight before retargeting.
    if (this.flight) {
      const done = this.flight.resolve;
      this.flight = null;
      done();
    }

    const near =
      Math.abs(x - this.x) * this.zoom < 0.5 &&
      Math.abs(y - this.y) * this.zoom < 0.5 &&
      Math.abs(Math.log(targetZoom) - Math.log(this.zoom)) < 1e-4;

    if (easing === 'none' || duration <= 0 || near) {
      this.x = x;
      this.y = y;
      this.zoom = targetZoom;
      this.version++;
      this.wake();
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.flight = {
        fromX: this.x,
        fromY: this.y,
        fromLogZoom: Math.log(this.zoom),
        toX: x,
        toY: y,
        toLogZoom: Math.log(targetZoom),
        start: performance.now(),
        duration,
        curve: easing === 'ui' ? this.palette.easeUi : this.palette.easeCamera,
        resolve,
      };
      this.version++;
      this.wake();
    });
  }

  /**
   * Frame a set of nodes. `[]` is a no-op, never a jump to the origin.
   *
   * Fitted to the node CENTRES, then expanded by the MEDIAN containment radius.
   * Neither half of that is optional:
   *
   *   Fitting to the discs alone frames the largest containment radius in the
   *   set. On the island rung that is a circle three times the terrain, and the
   *   map arrives as a small dot in a large void.
   *
   *   Fitting to centres alone frames the centroids. On the continent rung that
   *   is six points in the middle of a world that extends far past all of them,
   *   and the map arrives cropped through its own coastlines.
   *
   * The median radius is what each node actually CONTAINS, and it is robust to
   * the one oversized region that would otherwise decide the altitude.
   */
  async fitTo(ids: string[], padding = 64, ms?: number, explicit?: FitFrame): Promise<void> {
    const frame: FitFrame = { ...(this.defaultFrame ?? {}), ...(explicit ?? {}) };
    const discs = frame.discs === true;
    const b = this.boundsOfIds(ids, discs);
    if (b === null) return;
    // 0.6 of the median: a region's disc is a containment radius and its
    // contents do not fill it, so padding by the whole radius leaves the world
    // sitting in a frame half again too large. When the discs ARE the subject
    // they are already in the bounds, so a second radius of padding would put
    // the boundary back off the edge it was widened to include.
    const pad = discs ? 0 : this.medianRadius(ids) * 0.6;
    b.min_x -= pad;
    b.min_y -= pad;
    b.max_x += pad;
    b.max_y += pad;

    // Room around the subject, so what it sits IN is in frame too.
    const scale = Math.max(1, frame.scale ?? 1);
    if (scale > 1) {
      const gx = ((b.max_x - b.min_x) * (scale - 1)) / 2;
      const gy = ((b.max_y - b.min_y) * (scale - 1)) / 2;
      b.min_x -= gx;
      b.max_x += gx;
      b.min_y -= gy;
      b.max_y += gy;
    }

    /* OCCLUSION IS NOT PADDING. The rail and the dock are drawn ON TOP of the
     * terrain, so fitting to the whole canvas puts part of the subject
     * underneath them. Shrinking the target rectangle by the occluded strips and
     * then re-centring on what is left keeps the subject inside the part of the
     * canvas a person can actually see. */
    const left = frame.left ?? 0;
    const right = frame.right ?? 0;
    const top = frame.top ?? 0;
    const bottom = frame.bottom ?? 0;
    const availW = Math.max(32, this.width - left - right - padding * 2);
    const availH = Math.max(32, this.height - top - bottom - padding * 2);
    const w = Math.max(1e-6, b.max_x - b.min_x);
    const h = Math.max(1e-6, b.max_y - b.min_y);
    const zoom = Math.min(availW / w, availH / h);

    // The centre of the VISIBLE rectangle, expressed back in world units. y is
    // up in world space and the insets are named in screen terms, so `bottom`
    // pushes the camera down and `top` pushes it up.
    const cx = (b.min_x + b.max_x) / 2 + (right - left) / 2 / zoom;
    const cy = (b.min_y + b.max_y) / 2 - (bottom - top) / 2 / zoom;
    await this.moveTo(cx, cy, zoom, ms, 'camera');
  }

  /** The median baked radius over `ids`. 0 when none of them are known. */
  private medianRadius(ids: readonly string[]): number {
    const rs: number[] = [];
    for (const id of ids) {
      const p = this.lookup(id);
      if (p !== undefined) rs.push(p.r || 0);
    }
    if (rs.length === 0) return 0;
    rs.sort((a, b) => a - b);
    return rs[Math.floor(rs.length / 2)];
  }

  /** Bounds of `ids`, with or without their discs. `null` when none are known. */
  boundsOfIds(ids: readonly string[], includeRadius = true): Bounds | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let seen = false;
    for (const id of ids) {
      const p = this.lookup(id);
      if (p === undefined) continue;
      seen = true;
      const r = includeRadius ? p.r || 0 : 0;
      if (p.x - r < minX) minX = p.x - r;
      if (p.x + r > maxX) maxX = p.x + r;
      if (p.y - r < minY) minY = p.y - r;
      if (p.y + r > maxY) maxY = p.y + r;
    }
    if (!seen) return null;
    return { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY };
  }

  /* -------------------------------------------------------------------------
   * Direct manipulation. Pan and wheel-zoom are not flights — they must track
   * the pointer exactly, with zero interpolation, or the terrain feels like it
   * is on a rubber band.
   * ---------------------------------------------------------------------- */

  /** Drag by a CSS-pixel delta (DOM convention: dy positive is downward). */
  panByPixels(dx: number, dy: number): void {
    this.cancelFlight();
    this.x -= dx / this.zoom;
    this.y += dy / this.zoom;
    this.version++;
    this.wake();
  }

  /**
   * Zoom about a screen anchor, keeping the world point under the cursor fixed.
   * `sy` is a DOM coordinate (y down).
   */
  zoomAt(sx: number, sy: number, factor: number): void {
    this.cancelFlight();
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before[0] - after[0];
    this.y += before[1] - after[1];
    this.version++;
    this.wake();
  }

  /** Snap without animating. Used when the store's camera target is applied directly. */
  set(x: number, y: number, zoom: number): void {
    this.cancelFlight();
    this.x = x;
    this.y = y;
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
    this.version++;
    this.wake();
  }

  private cancelFlight(): void {
    if (!this.flight) return;
    const done = this.flight.resolve;
    this.flight = null;
    done();
  }

  /**
   * Advance the flight. Returns true when the camera moved this frame, which is
   * what the render-on-demand loop uses to decide whether to schedule another.
   */
  tick(now: number): boolean {
    const f = this.flight;
    if (f === null) return false;
    const p = f.duration <= 0 ? 1 : Math.min(1, (now - f.start) / f.duration);
    const e = ease(f.curve, p);
    this.x = f.fromX + (f.toX - f.fromX) * e;
    this.y = f.fromY + (f.toY - f.fromY) * e;
    this.zoom = Math.exp(f.fromLogZoom + (f.toLogZoom - f.fromLogZoom) * e);
    this.version++;
    if (p >= 1) {
      this.flight = null;
      f.resolve();
    }
    return true;
  }
}
