/**
 * =============================================================================
 * THE REPUDIATION LAYER — the map stops vouching, too
 * =============================================================================
 *
 * `verify-valid` and `verify-invalid` used to be byte-identical above the rail.
 * The rail struck the answer through, named which half failed and printed both
 * hashes side by side — and four feet away on the same screen the terrain went
 * on drawing the answer path at full attention with its evidence intact, as if
 * nothing had been disproved. The receipt was repudiated; the picture was not.
 *
 * That is the governing principle failing in the one place it is most expensive.
 * The map is the product's primary claim surface: if the constellation still
 * looks receipted after the receipt has been shown to be false, the interface is
 * lying about the engine in the largest type it has.
 *
 * So the repudiation reaches the map:
 *
 *   THE PATH IS STRUCK.        Every hop the answer walked is hatched across in
 *                              --alarm and cancelled at its midpoint. The teal is
 *                              NOT removed and not one pixel of it is covered —
 *                              the engine really did walk that path, and erasing
 *                              it would be a second lie. What the marks remove is
 *                              its standing as evidence.
 *   THE EVIDENCE RINGS GO.     Each node on the path wears a BROKEN ring in
 *                              --alarm where a receipted node wears a closed
 *                              one, its gap always at twelve o'clock. A ring
 *                              with a break in it is the oldest available way to
 *                              draw "this seal is not intact".
 *   THE VERDICT IS ON THE MAP. The engine's own two-word badge, anchored above
 *                              the constellation, so a reader who never looks at
 *                              the rail still learns the answer is unreceipted.
 *                              The SENTENCE stays in the rail: it already has an
 *                              owner, and one fact with three owners in a single
 *                              frame is the defect next door.
 *
 * -----------------------------------------------------------------------------
 * IT DRAWS NOTHING IT CANNOT LOCATE
 * -----------------------------------------------------------------------------
 * Every mark sits on a REAL baked position, projected through the terrain's own
 * camera and verified by round-tripping it back (see `mapProbe`). If the
 * projection cannot be verified, if there is no canvas, if the bake has no
 * position for a node, or if the node is off-frame — that mark is not drawn. A
 * red mark in the wrong place would be worse than no mark at all.
 *
 * The layer is `pointer-events: none` and sits at `--z-labels`: it annotates the
 * terrain, it never intercepts it, and it never occupies a pixel the audit could
 * mistake for chrome.
 *
 * -----------------------------------------------------------------------------
 * ONE LAYER, WHICHEVER SURFACES ARE MOUNTED
 * -----------------------------------------------------------------------------
 * Every provenance surface renders it — the receipt, the signature panel, the
 * quarantine panel and the Inspector body — because the map's honesty must not
 * depend on which tab happens to be open. Tampering the trace and then switching
 * to the Inspector left the terrain vouching for a receipt the store had already
 * disproved; that is the same defect as the original one, one click away.
 *
 * They arbitrate through a module-scoped registry, so exactly one instance ever
 * draws and mounting four of them costs one SVG.
 * =============================================================================
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { verifyCopy } from '@/copy';
import type { NodePosition, PathStep, VerifyResult } from '@/engine';
import { useAtlasStore } from '@/state';
import { cx } from '@/ui/primitives';

import { subscribeMapProbe, type MapProbe, type Projection, type WorldPoint } from './mapProbe';

/* =============================================================================
 * 1. ONE LAYER AT A TIME
 * ========================================================================== */

const holders: symbol[] = [];
const watchers = new Set<() => void>();

function announce(): void {
  for (const w of watchers) w();
}

/** True for exactly one mounted instance: the first one that claimed. */
function usePrimary(): boolean {
  const tag = useRef<symbol | null>(null);
  if (tag.current === null) tag.current = Symbol('pv-repudiation');
  const [primary, setPrimary] = useState(false);

  useEffect(() => {
    const me = tag.current as symbol;
    holders.push(me);
    const sync = (): void => setPrimary(holders[0] === me);
    watchers.add(sync);
    announce();
    return () => {
      watchers.delete(sync);
      const at = holders.indexOf(me);
      if (at >= 0) holders.splice(at, 1);
      announce();
    };
  }, []);

  return primary;
}

/* =============================================================================
 * 2. THE GEOMETRY
 * ========================================================================== */

/** How far outside the terrain frame a mark may sit before it is dropped. */
const EDGE_MARGIN_PX = 24;
/** The broken ring's radius. An annotation size, not a claim about node size. */
const RING_R = 21;
/** The gap in the broken ring, as a fraction of its circumference. */
const RING_GAP = 0.3;
/** Spacing of the hatch ticks along a struck hop, in CSS pixels. */
const TICK_SPACING = 58;
/** Half-length of one tick. Long enough to read at 1440p from across the room. */
const TICK_HALF = 8;
/** Ticks nearer the midpoint than this collide with the cancel mark. */
const TICK_CLEAR = 26;
/**
 * Half the verdict tag's own width, which its stylesheet caps at 320px, plus the
 * clearances that keep it inside the terrain rather than under the top bar or
 * behind the legend. Stated here because this is the only place that has to
 * reconcile a projected world position with a laid-out DOM box; everything else
 * about the tag is CSS.
 */
const TAG_HALF_W = 160;
const TAG_LIFT = 18;
const TAG_TOP_CLEAR = 64;
const TAG_BOTTOM_CLEAR = 24;

interface Strike {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Midpoint, where the cancel mark sits. */
  mx: number;
  my: number;
  /** Degrees, so the cancel mark crosses the hop rather than the screen. */
  angle: number;
}

interface Geometry {
  frame: Projection['frame'];
  rings: { id: string; x: number; y: number }[];
  strikes: Strike[];
  tag: { x: number; y: number };
}

/**
 * The hatch across one hop: short ticks perpendicular to the corridor, spaced
 * along it, clear of the cancel mark at its midpoint.
 *
 * A dashed line drawn ALONG the path read, at 1440p, as a red core inside a teal
 * tube — decoration, not cancellation. Ticks across it are the mark every reader
 * already knows, and they leave the rendered corridor completely intact, which
 * is the point: the engine really did walk this path.
 */
function hatch(s: Strike): { x1: number; y1: number; x2: number; y2: number }[] {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len = Math.hypot(dx, dy);
  if (len < TICK_SPACING) return [];
  const nx = (-dy / len) * TICK_HALF;
  const ny = (dx / len) * TICK_HALF;
  /* Walked OUT FROM THE MIDPOINT at a fixed pixel spacing, not divided into a
     whole number of parts. Dividing gave each hop its own rhythm — a short hop
     ticked every 55px and a long one every 47px — and two hops of the same
     annotation beating at two different rates reads as an accident. */
  const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let d = TICK_CLEAR; d <= len / 2; d += TICK_SPACING) {
    for (const side of d === 0 ? [0] : [-1, 1]) {
      const t = 0.5 + (side * d) / len;
      const cx = s.x1 + dx * t;
      const cy = s.y1 + dy * t;
      out.push({ x1: cx - nx, y1: cy - ny, x2: cx + nx, y2: cy + ny });
    }
  }
  return out;
}

function inFrame(p: { x: number; y: number }, f: Projection['frame']): boolean {
  return (
    p.x >= f.left - EDGE_MARGIN_PX &&
    p.x <= f.left + f.width + EDGE_MARGIN_PX &&
    p.y >= f.top - EDGE_MARGIN_PX &&
    p.y <= f.top + f.height + EDGE_MARGIN_PX
  );
}

function buildGeometry(
  projection: Projection,
  path: readonly PathStep[],
  ringIds: readonly string[],
): Geometry | null {
  const at = new Map(projection.points.map((p) => [p.id, p]));
  const frame = projection.frame;

  const rings = ringIds
    .map((id) => at.get(id))
    .filter((p): p is NonNullable<typeof p> => p !== undefined && inFrame(p, frame))
    .map((p) => ({ id: p.id, x: p.x, y: p.y }));

  const strikes: Strike[] = [];
  for (const step of path) {
    const a = at.get(step.from_id);
    const b = at.get(step.to_id);
    if (a === undefined || b === undefined) continue;
    if (!inFrame(a, frame) && !inFrame(b, frame)) continue;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    strikes.push({
      key: `${step.index}:${step.edge_id}`,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      mx,
      my,
      angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
    });
  }

  if (rings.length === 0 && strikes.length === 0) return null;

  /* The verdict is anchored ABOVE the constellation's own bounding box, then
     clamped inside the terrain frame. It follows the answer rather than sitting
     in a corner, because what it repudiates is the answer. */
  const xs = [...rings.map((r) => r.x), ...strikes.flatMap((s) => [s.x1, s.x2])];
  const ys = [...rings.map((r) => r.y), ...strikes.flatMap((s) => [s.y1, s.y2])];
  const cx0 = (Math.min(...xs) + Math.max(...xs)) / 2;
  const top = Math.min(...ys);
  const tag = {
    x: Math.min(
      Math.max(cx0, frame.left + TAG_HALF_W),
      frame.left + frame.width - TAG_HALF_W,
    ),
    y: Math.min(
      Math.max(top - RING_R - TAG_LIFT, frame.top + TAG_TOP_CLEAR),
      frame.top + frame.height - TAG_BOTTOM_CLEAR,
    ),
  };

  return { frame, rings, strikes, tag };
}

/** True when two geometries differ by enough to be worth a re-render. */
function moved(a: Geometry | null, b: Geometry | null): boolean {
  if (a === null || b === null) return a !== b;
  if (a.rings.length !== b.rings.length || a.strikes.length !== b.strikes.length) return true;
  const far = (p: number, q: number): boolean => Math.abs(p - q) > 0.5;
  if (far(a.tag.x, b.tag.x) || far(a.tag.y, b.tag.y)) return true;
  for (let i = 0; i < a.rings.length; i++) {
    if (far(a.rings[i].x, b.rings[i].x) || far(a.rings[i].y, b.rings[i].y)) return true;
  }
  for (let i = 0; i < a.strikes.length; i++) {
    const p = a.strikes[i];
    const q = b.strikes[i];
    if (far(p.x1, q.x1) || far(p.y1, q.y1) || far(p.x2, q.x2) || far(p.y2, q.y2)) return true;
  }
  return (
    far(a.frame.left, b.frame.left) ||
    far(a.frame.top, b.frame.top) ||
    far(a.frame.width, b.frame.width) ||
    far(a.frame.height, b.frame.height)
  );
}

/* =============================================================================
 * 3. THE LAYER
 * ========================================================================== */

export interface RepudiationLayerProps {
  /** Defaults to `tampered || verify.valid === false`. */
  repudiated?: boolean;
  /** Defaults to the store's verdict. Supplies the badge and the sentence. */
  verify?: VerifyResult | null;
  /** Defaults to the active constellation's path. */
  path?: readonly PathStep[];
  /** Marked with a broken ring. Defaults to the path's nodes plus the bridge. */
  ringIds?: readonly string[];
  /** Defaults to the store's bake. */
  positions?: readonly NodePosition[] | null;
  className?: string;
}

export function RepudiationLayer({
  repudiated,
  verify,
  path,
  ringIds,
  positions,
  className,
}: RepudiationLayerProps): JSX.Element | null {
  const store = useAtlasStore((s) => ({
    verify: s.verify,
    tampered: s.tampered,
    path: s.query.active?.constellation.path ?? null,
    bridge: s.query.active?.constellation.bridge_entity_id ?? null,
    positions: s.bake?.positions ?? null,
  }));

  const primary = usePrimary();

  const v = verify !== undefined ? verify : store.verify;
  const isRepudiated =
    repudiated !== undefined ? repudiated : store.tampered || (v !== null && !v.valid);
  const steps = path ?? store.path ?? [];
  const marks =
    ringIds ??
    [...new Set([...steps.flatMap((s) => [s.from_id, s.to_id]), store.bridge].filter(
      (id): id is string => typeof id === 'string',
    ))];
  const baked = positions !== undefined ? positions : store.positions;

  const [probe, setProbe] = useState<MapProbe | null>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const last = useRef<Geometry | null>(null);

  /* The probe follows the terrain across mounts. A layer that kept drawing
     against a renderer that has gone is the failure this module is about. */
  useEffect(() => {
    if (!primary || !isRepudiated) return;
    let alive = true;
    let unsubscribe: (() => void) | null = null;
    void subscribeMapProbe((p) => {
      if (alive) setProbe(p);
    }).then((off) => {
      if (alive) unsubscribe = off;
      else off();
    });
    return () => {
      alive = false;
      if (unsubscribe !== null) unsubscribe();
      setProbe(null);
    };
  }, [primary, isRepudiated]);

  const world: WorldPoint[] = [];
  if (baked !== null && baked !== undefined && isRepudiated && primary) {
    const wanted = new Set([...marks, ...steps.flatMap((s) => [s.from_id, s.to_id])]);
    for (const p of baked) {
      if (wanted.has(p.id)) world.push({ id: p.id, x: p.x, y: p.y });
    }
  }
  const worldKey = world.map((p) => p.id).join('|');

  /* Re-projected on every frame the terrain draws, which is exactly when a mark
     could go stale, and never on a timer of this component's own invention. */
  useEffect(() => {
    if (probe === null || world.length === 0) {
      last.current = null;
      setGeometry(null);
      return;
    }
    const recompute = (): void => {
      const projection = probe.project(world);
      const next = projection === null ? null : buildGeometry(projection, steps, marks);
      if (!moved(last.current, next)) return;
      last.current = next;
      setGeometry(next);
    };
    recompute();
    const offFrame = probe.onFrame(recompute);
    window.addEventListener('resize', recompute);
    return () => {
      offFrame();
      window.removeEventListener('resize', recompute);
    };
    // `world` and `marks` are rebuilt each render; `worldKey` is their identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe, worldKey, steps]);

  if (!primary || !isRepudiated || geometry === null || typeof document === 'undefined') return null;

  const copy = verifyCopy(v);
  const { frame, rings, strikes, tag } = geometry;
  const circumference = 2 * Math.PI * RING_R;

  return createPortal(
    <div
      className={cx('pv-repud', className)}
      aria-hidden="true"
      style={{
        left: `${frame.left}px`,
        top: `${frame.top}px`,
        width: `${frame.width}px`,
        height: `${frame.height}px`,
      }}
    >
      <svg
        className="pv-repud-svg"
        viewBox={`0 0 ${Math.round(frame.width)} ${Math.round(frame.height)}`}
        width={frame.width}
        height={frame.height}
      >
        {strikes.map((s) => (
          <g key={s.key} transform={`translate(${-frame.left} ${-frame.top})`}>
            {hatch(s).map((t, i) => (
              <line
                key={i}
                className="pv-repud-strike"
                x1={t.x1}
                y1={t.y1}
                x2={t.x2}
                y2={t.y2}
              />
            ))}
            <line
              className="pv-repud-cancel"
              x1={s.mx}
              y1={s.my - 9}
              x2={s.mx}
              y2={s.my + 9}
              transform={`rotate(${s.angle + 45} ${s.mx} ${s.my})`}
            />
            <line
              className="pv-repud-cancel"
              x1={s.mx}
              y1={s.my - 9}
              x2={s.mx}
              y2={s.my + 9}
              transform={`rotate(${s.angle - 45} ${s.mx} ${s.my})`}
            />
          </g>
        ))}
        {rings.map((r) => (
          <circle
            key={r.id}
            className="pv-repud-ring"
            cx={r.x - frame.left}
            cy={r.y - frame.top}
            r={RING_R}
            strokeDasharray={`${circumference * (1 - RING_GAP)} ${circumference * RING_GAP}`}
            /* The gap is placed at TWELVE O'CLOCK, not wherever the dash pattern
               happened to start. An SVG circle begins at three o'clock, so the
               offset that centres the break at the top is C(1/4 - gap/2). A seal
               whose break sits in a different place on every node reads as a
               rendering artefact rather than as a mark. */
            strokeDashoffset={circumference * (0.25 - RING_GAP / 2)}
          />
        ))}
      </svg>
      {/* THE VERDICT WORD, AND NOT THE SENTENCE. `The payload no longer matches
          its signed hash` is already the headline of the signature panel and the
          banner over the answer; a third copy on the map would be the same fact
          with three owners in one frame. The map gets the engine's two-word
          verdict — which is what an annotation on a terrain is for — and the
          diagnosis stays where it can be acted on. */}
      <div
        className="pv-repud-tag tone-alarm"
        style={{ left: `${tag.x - frame.left}px`, top: `${tag.y - frame.top}px` }}
      >
        <span className="pv-repud-badge">{copy.badge}</span>
      </div>
    </div>,
    document.body,
  );
}
