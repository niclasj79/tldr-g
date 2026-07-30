/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE WORLD-MAP STRIP
 * =============================================================================
 *
 * A 160×90 ghost of the WHOLE terrain with the current frustum drawn on it,
 * docked top-right inside the viewport.
 *
 * -----------------------------------------------------------------------------
 * IT EARNS ITS PLACE, AND ONLY WHEN IT HAS EARNED IT
 * -----------------------------------------------------------------------------
 * AT THE CONTINENT RUNG IT IS ABSENT. You are looking at the whole world; a
 * second, smaller picture of the whole world next to it is decoration, and this
 * product does not ship decoration. It appears at island depth and below, where
 * the frame is a window onto something larger and knowing where the window is has
 * a real answer.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS ACTUALLY DRAWN
 * -----------------------------------------------------------------------------
 * The bake's FULL-EXTENT positions — every continent, island, asset, entity and
 * passage, not just the rung you are standing on — because the point of the strip
 * is that the rest of the world did not go away when you descended into a
 * document. Regions are washed in their community hue at `--wash-continent`;
 * leaves are single pixels at `--latent-opacity`. Those two tokens are not
 * arbitrary: the strip IS the terrain at its lowest resolution tier, so it is
 * drawn at the tier's own strength.
 *
 * The frustum is a 1px `--render` rectangle. Render light is the engine's
 * attention, and the frustum is literally where the engine is currently spending
 * it. Nothing else on the strip is that bright.
 *
 * -----------------------------------------------------------------------------
 * COST
 * -----------------------------------------------------------------------------
 * The 4,406-position ghost is rasterised ONCE per bake into an offscreen canvas
 * and blitted after that, so a frame costs one `drawImage` and one `strokeRect`.
 * The redraw is driven by the terrain's own frame callback, which fires only when
 * the terrain actually drew — an idle map costs nothing at all.
 * ========================================================================== */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { COPY } from '@/copy';
import { RUNG_DEPTH } from '@/engine';
import type { Bounds, LayoutBake } from '@/engine';
import { readPalette } from '@/graph';
import { useAtlasStore } from '@/state';
import { hueIndexForCommunity, readTokens } from '@/styles/tokens';

import { clampCameraToWorld } from '@/interaction/camera-control';
import { readTuning } from '@/interaction/tuning';
import { useTerrain } from '@/interaction/useTerrain';

import '@/interaction/worldmap.css';

export interface WorldMapStripProps {
  className?: string;
}

/** Inset in strip pixels, so a node at the world edge is not clipped by the border. */
const INSET = 3;

interface Fit {
  scale: number;
  offX: number;
  offY: number;
  w: number;
  h: number;
}

/** Contain the world rectangle inside the strip, preserving aspect. */
function fitWorld(bounds: Bounds, w: number, h: number): Fit {
  const worldW = Math.max(1e-6, bounds.max_x - bounds.min_x);
  const worldH = Math.max(1e-6, bounds.max_y - bounds.min_y);
  const scale = Math.min((w - INSET * 2) / worldW, (h - INSET * 2) / worldH);
  return {
    scale,
    offX: (w - worldW * scale) / 2 - bounds.min_x * scale,
    // World y is UP, canvas y is DOWN. The flip lives here and nowhere else.
    offY: (h + worldH * scale) / 2 + bounds.min_y * scale,
    w,
    h,
  };
}

const toStripX = (fit: Fit, x: number): number => x * fit.scale + fit.offX;
const toStripY = (fit: Fit, y: number): number => fit.offY - y * fit.scale;
const toWorldX = (fit: Fit, sx: number): number => (sx - fit.offX) / fit.scale;
const toWorldY = (fit: Fit, sy: number): number => (fit.offY - sy) / fit.scale;

/** Rasterise the ghost once. Returns null when there is nothing to draw yet. */
function renderGhost(bake: LayoutBake, w: number, h: number, dpr: number): HTMLCanvasElement | null {
  if (bake.positions.length === 0) return null;
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.round(w * dpr));
  off.height = Math.max(1, Math.round(h * dpr));
  const ctx = off.getContext('2d');
  if (ctx === null) return null;
  ctx.scale(dpr, dpr);

  const tokens = readTokens();
  const palette = readPalette();
  const fit = fitWorld(bake.bounds, w, h);
  const dot = readTuning().worldMap.dot;

  // 1. The regions, as community-hue washes. Continents first so islands sit on
  //    top of their own landmass rather than under it.
  for (const pass of ['continent', 'island'] as const) {
    ctx.globalAlpha = palette.wash.continent;
    for (const p of bake.positions) {
      if (p.kind !== pass) continue;
      const r = Math.max(1, p.r * fit.scale);
      ctx.fillStyle = tokens.hueHex[hueIndexForCommunity(p.community_id)];
      ctx.beginPath();
      ctx.arc(toStripX(fit, p.x), toStripY(fit, p.y), r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 2. The leaves, at the latent tier. This is the terrain at its lowest
  //    resolution — present, unspent, never a hole.
  ctx.globalAlpha = tokens.lod.latent.opacity;
  for (const p of bake.positions) {
    if (p.kind === 'continent' || p.kind === 'island') continue;
    ctx.fillStyle = tokens.hueHex[hueIndexForCommunity(p.community_id)];
    ctx.fillRect(toStripX(fit, p.x) - dot / 2, toStripY(fit, p.y) - dot / 2, dot, dot);
  }

  ctx.globalAlpha = 1;
  return off;
}

export function WorldMapStrip({ className }: WorldMapStripProps): JSX.Element | null {
  const terrain = useTerrain();
  const { rung, bake, cameraVersion } = useAtlasStore((s) => ({
    rung: s.rung,
    bake: s.bake,
    cameraVersion: s.camera.version,
  }));

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ghostRef = useRef<HTMLCanvasElement | null>(null);
  const fitRef = useRef<Fit | null>(null);
  const draggingRef = useRef(false);

  // The strip is absent at the top of the world. Hooks above this line only.
  const visible = RUNG_DEPTH[rung] >= 1 && bake !== null;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ghost = ghostRef.current;
    const fit = fitRef.current;
    if (canvas === null || ghost === null || fit === null || terrain === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, fit.w, fit.h);
    ctx.drawImage(ghost, 0, 0, fit.w, fit.h);

    const f = terrain.camera.frustum();
    const x = toStripX(fit, f.x - f.w / 2);
    const y = toStripY(fit, f.y + f.h / 2);
    const w = f.w * fit.scale;
    const h = f.h * fit.scale;

    const tokens = readTokens();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, fit.w, fit.h);
    ctx.clip();
    ctx.strokeStyle = tokens.hex.render;
    ctx.lineWidth = 1;
    // Half-pixel offset so a 1px stroke lands on a pixel instead of straddling two.
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.max(2, w), Math.max(2, h));
    ctx.restore();
  }, [terrain]);

  // Rasterise the ghost when the bake (or the device pixel ratio) changes.
  useLayoutEffect(() => {
    if (!visible || bake === null) return;
    const { w, h } = readTuning().worldMap;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = canvasRef.current;
    if (canvas !== null) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ghostRef.current = renderGhost(bake, w, h, dpr);
    fitRef.current = fitWorld(bake.bounds, w, h);
    draw();
  }, [visible, bake, draw]);

  // The terrain's own frame callback. It fires when the terrain actually drew,
  // so an idle map costs nothing and a moving one is always in step.
  useEffect(() => {
    if (!visible || terrain === null) return;
    draw();
    return terrain.onFrame(draw);
  }, [visible, terrain, draw]);

  useEffect(() => {
    if (visible) draw();
  }, [visible, cameraVersion, draw]);

  /* --- drag to pan ------------------------------------------------------- */

  const panTo = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const fit = fitRef.current;
      if (canvas === null || fit === null || terrain === null || bake === null) return;
      const r = canvas.getBoundingClientRect();
      const wx = toWorldX(fit, clientX - r.left);
      const wy = toWorldY(fit, clientY - r.top);
      const cur = terrain.camera.get();
      terrain.camera.set(wx, wy, cur.zoom);
      clampCameraToWorld(terrain.camera, bake.bounds, readTuning().overscroll);
      draw();
    },
    [bake, draw, terrain],
  );

  if (!visible) return null;

  const { w, h } = readTuning().worldMap;

  return (
    <div
      className={className ? `ix-worldmap ${className}` : 'ix-worldmap'}
      style={{ width: `${w}px`, height: `${h}px` }}
    >
      <canvas
        ref={canvasRef}
        className="ix-worldmap__canvas"
        style={{ width: `${w}px`, height: `${h}px` }}
        role="img"
        /* The canvas has no DOM to read, so it needs an accessible name. It is
           the same terrain at its lowest tier, which is what that name says. */
        aria-label={COPY.a11y.terrain}
        onPointerDown={(e) => {
          draggingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          panTo(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) panTo(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
      />
    </div>
  );
}
