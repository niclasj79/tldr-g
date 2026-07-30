/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE LATENT FIELD
 * =============================================================================
 *
 * What the terrain looks like when there is nothing loaded: outline only, at
 * `--latent-opacity`, in the void.
 *
 * THIS IS NOT A PLACEHOLDER GRAPHIC. `latent` is a real tier of the resolution
 * ramp and it is the load-bearing one — it exists so the terrain never has
 * holes. Before there is anything to draw, the ABSENCE is drawn as topology,
 * which is the same claim the ramp makes everywhere else in the product: content
 * the engine has not spent on is still present, in its real position, at its
 * real size.
 *
 * -----------------------------------------------------------------------------
 * TWO SOURCES, AND THE SCREEN SAYS WHICH
 * -----------------------------------------------------------------------------
 *   'bake'  the REAL baked positions, when the corpus has been materialised in
 *           this session and then closed. This is the honest EMPTY state: the
 *           engine knows the shape of the world, it simply is not loaded. The
 *           ghost of what will appear is literally what will appear.
 *   'grid'  `gridSnapForLatent()` — the engine's own deterministic hex lattice,
 *           when nothing has ever been built. Hex rather than square because a
 *           square grid reads as a spreadsheet and has long diagonals the eye
 *           mistakes for structure.
 *
 * The caller picks by asking `latentSource()`, and the copy next to the field
 * states which one is on screen. A field that silently swaps a real layout for a
 * lattice would be the exact failure this product is built against.
 *
 * -----------------------------------------------------------------------------
 * WHY CANVAS AND NOT SVG
 * -----------------------------------------------------------------------------
 * The bake carries thousands of positions. Four thousand `<circle>` elements is
 * four thousand layout boxes for the browser to keep, on a screen whose entire
 * job is to be quiet. One canvas is one element.
 *
 * Zero colour literals: every value is read back through `readTokens()`, which
 * is the only bridge from the token file into a 2D context.
 * =============================================================================
 */

import { useEffect, useRef } from 'react';

import { fixturesReady, getFixtures, gridSnapForLatent, readTokens } from '@/engine';
import type { Bounds, NodePosition } from '@/engine';

/* =============================================================================
 * WHERE THE SHAPE COMES FROM
 * ========================================================================== */

export type LatentSource = 'bake' | 'grid';

/**
 * Which source is available RIGHT NOW.
 *
 * Never forces a build: `getFixtures()` would synthesise the whole corpus on the
 * spot, which is a 600ms stall on a screen that is supposed to be empty.
 */
export function latentSource(): LatentSource {
  return fixturesReady() ? 'bake' : 'grid';
}

/** The positions to draw, and the bounds they are expressed in. */
function fieldFor(source: LatentSource, count: number): { positions: NodePosition[]; bounds: Bounds } {
  if (source === 'bake' && fixturesReady()) {
    const { bake } = getFixtures();
    return { positions: bake.positions, bounds: bake.bounds };
  }
  const extent = 1000;
  const bounds: Bounds = { min_x: -extent / 2, min_y: -extent / 2, max_x: extent / 2, max_y: extent / 2 };
  return { positions: gridSnapForLatent(count, { bounds }), bounds };
}

/* =============================================================================
 * THE ONE CONSTELLATION
 * -----------------------------------------------------------------------------
 * FIRST-RUN draws exactly one shape, and it is the shape of the product's whole
 * claim: two clusters that share nothing except a single node between them, and
 * the one hairline that crosses. That is a bridge entity and a strait, drawn at
 * the tier where nothing has been resolved yet.
 *
 * Its geometry is the engine's own lattice, filtered to two discs. Nothing about
 * it is hand-placed, nothing about it is labelled, and it carries no figure — it
 * is a diagram of a topology, drawn in the product's own latent tier.
 * ========================================================================== */

interface Constellation {
  nodes: NodePosition[];
  links: [number, number][];
  bounds: Bounds;
}

function constellation(): Constellation {
  const extent = 1000;
  const field: Bounds = { min_x: -extent / 2, min_y: -extent / 2, max_x: extent / 2, max_y: extent / 2 };
  /* DENSE ENOUGH TO BE A MASS.
     At fifteen hundred points filtered to two small ellipses the shape was three
     hundred specks at 12% opacity: at 1440p it read as noise and at 4K it read
     as nothing, so the first frame a viewer ever sees asserted the thesis in
     words over an empty rectangle instead of showing it. Density is what makes a
     body a body — the tier it is drawn at has not changed. */
  const lattice = gridSnapForLatent(5200, { bounds: field, seed: 'first-run' });

  /* Two bodies, wide apart on the long axis. ELLIPSES rather than discs: two
     circles side by side in a 16:9 frame letterbox badly, and an island is not
     a circle anyway. Everything inside one of them belongs to that body;
     everything else is not drawn at all. */
  const rx = extent * 0.2;
  const ry = rx * 1.1;
  const left = { x: -extent * 0.28, y: 0 };
  const right = { x: extent * 0.28, y: 0 };
  const inside = (p: NodePosition, c: { x: number; y: number }): boolean =>
    ((p.x - c.x) / rx) ** 2 + ((p.y - c.y) / ry) ** 2 <= 1;

  const a = lattice.filter((p) => inside(p, left));
  const b = lattice.filter((p) => inside(p, right));
  const nodes = [...a, ...b];

  /* A CONSTELLATION IS A STAR CHART, NOT A WIREFRAME.
     The first attempt joined every node to its two nearest neighbours, which
     over a jittered lattice produces a field of long thin triangles: it reads as
     abstract geometry rather than as two bodies of knowledge, and it buries the
     one line that matters. So the bodies are carried by the DENSITY OF POINTS,
     and only the shortest quarter of the nearest-neighbour edges are drawn —
     enough lines to say "these are joined", few enough that the eye still sees
     two masses and one crossing. */
  const links: [number, number][] = [];
  const joinWithin = (offset: number, group: NodePosition[]): void => {
    const seen = new Set<string>();
    const candidates: { i: number; j: number; d: number }[] = [];
    for (let i = 0; i < group.length; i++) {
      let best = -1;
      let bestD = Infinity;
      for (let j = 0; j < group.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(group[i].x - group[j].x, group[i].y - group[j].y);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      if (best < 0) continue;
      const key = i < best ? `${i}:${best}` : `${best}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ i, j: best, d: bestD });
    }
    candidates.sort((p, q) => p.d - q.d);
    for (const c of candidates.slice(0, Math.round(group.length / 4))) {
      links.push([offset + c.i, offset + c.j]);
    }
  };
  joinWithin(0, a);
  joinWithin(a.length, b);

  // THE STRAIT. One link, between the pair that face each other across the gap,
  // and it is the only thing joining the two sides. Pushed LAST so it is drawn
  // last; it is the only line on this screen that crosses empty space, which is
  // what makes it readable without ever being brighter than anything else.
  let bridge: [number, number] = [0, a.length];
  let bridgeD = Infinity;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const d = Math.hypot(a[i].x - b[j].x, a[i].y - b[j].y);
      if (d < bridgeD) {
        bridgeD = d;
        bridge = [i, a.length + j];
      }
    }
  }
  links.push(bridge);

  /* THE SHAPE'S OWN BOUNDS, not the lattice's. Scaling to the lattice would
     frame a mostly-empty square and leave the constellation a smudge in the
     middle of it. */
  const pad = extent * 0.04;
  const xs = nodes.map((p) => p.x);
  const ys = nodes.map((p) => p.y);
  const bounds: Bounds = {
    min_x: Math.min(...xs) - pad,
    min_y: Math.min(...ys) - pad,
    max_x: Math.max(...xs) + pad,
    max_y: Math.max(...ys) + pad,
  };

  return { nodes, links, bounds };
}

/* =============================================================================
 * THE COMPONENT
 * ========================================================================== */

export interface LatentFieldProps {
  /**
   * 'field'         the whole terrain, latent. EMPTY uses this.
   * 'constellation' exactly one shape. FIRST-RUN uses this and nothing else.
   */
  shape: 'field' | 'constellation';
  /** Lattice density when there is no bake to draw. Ignored for the bake source. */
  count?: number;
  className?: string;
}

export function LatentField({ shape, count = 1400, className }: LatentFieldProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;

    const draw = (): void => {
      const parent = canvas.parentElement;
      if (parent === null) return;
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const tokens = readTokens();
      const source = shape === 'constellation' ? null : latentSource();
      const field =
        shape === 'constellation' ? constellation() : fieldFor(source ?? 'grid', count);
      const bounds = field.bounds;

      // Contain, not cover: the whole shape has to be on screen, and a latent
      // field cropped at the edges reads as a texture rather than as a world.
      const bw = Math.max(1e-6, bounds.max_x - bounds.min_x);
      const bh = Math.max(1e-6, bounds.max_y - bounds.min_y);
      const pad = shape === 'constellation' ? 0.86 : 0.94;
      const scale = Math.min(w / bw, h / bh) * pad;
      const cx = w / 2 - ((bounds.min_x + bounds.max_x) / 2) * scale;
      const cy = h / 2 + ((bounds.min_y + bounds.max_y) / 2) * scale;
      // y is flipped: the bake is y-up, a canvas is y-down.
      const sx = (x: number): number => cx + x * scale;
      const sy = (y: number): number => cy - y * scale;

      ctx.globalAlpha = tokens.lod.latent.opacity;
      ctx.strokeStyle = tokens.hex['ink-faint'];
      ctx.lineWidth = 1;

      if (shape === 'constellation') {
        const c = field as Constellation;
        /* THE LINES STAY AT `latent`. They are the whisper: enough to say the
           points inside a body are joined, never enough to be looked at. */
        ctx.beginPath();
        for (const [i, j] of c.links) {
          ctx.moveTo(sx(c.nodes[i].x), sy(c.nodes[i].y));
          ctx.lineTo(sx(c.nodes[j].x), sy(c.nodes[j].y));
        }
        ctx.stroke();

        /* THE POINTS CARRY THE BODIES, so they are drawn at `ghost` — present,
           not spent on. Both are real tiers of the same ramp and the difference
           between them is what makes two masses and one crossing legible instead
           of a uniform haze. Nothing here is at a resolved tier: no label, no
           fill, no figure. */
        ctx.globalAlpha = tokens.lod.ghost.opacity;
        ctx.strokeStyle = tokens.hex['ink-dim'];
        ctx.beginPath();
        for (const p of c.nodes) {
          // Outline only — that is what an unresolved node looks like.
          const r = 1.9;
          ctx.moveTo(sx(p.x) + r, sy(p.y));
          ctx.arc(sx(p.x), sy(p.y), r, 0, Math.PI * 2);
        }
        ctx.stroke();
        return;
      }

      const positions = (field as { positions: NodePosition[] }).positions;
      ctx.beginPath();
      for (const p of positions) {
        // The bake's own radius, clamped into the same screen-space window the
        // renderer uses, so a latent world is the size the real one will be.
        const r = Math.min(4, Math.max(1.1, p.r * scale));
        ctx.moveTo(sx(p.x) + r, sy(p.y));
        ctx.arc(sx(p.x), sy(p.y), r, 0, Math.PI * 2);
      }
      ctx.stroke();
    };

    draw();
    const ro = new ResizeObserver(draw);
    if (canvas.parentElement !== null) ro.observe(canvas.parentElement);
    return () => ro.disconnect();
  }, [shape, count]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
