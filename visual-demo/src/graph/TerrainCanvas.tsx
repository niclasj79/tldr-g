/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE REACT HOST
 * =============================================================================
 *
 * A thin, dumb shell around `createTerrain`. Its entire job is to own a canvas
 * with the right backing-store size and to hand the `Terrain` instance to
 * whoever asked for it.
 *
 * -----------------------------------------------------------------------------
 * THIS COMPONENT NEVER RE-RENDERS PER FRAME
 * -----------------------------------------------------------------------------
 * The store holds the camera TARGET; the renderer owns the CURRENT camera and
 * interpolates it. If React re-rendered on camera motion, a 60fps pan would be
 * 60 reconciliations a second and the panels would repaint underneath it. So
 * every scene input arrives through an imperative `useEffect` that calls a
 * method on the terrain, and the component body runs only when the terrain has
 * to be created or destroyed.
 *
 * -----------------------------------------------------------------------------
 * WIRING, AND WHY IT IS DELIBERATELY BOTH WAYS
 * -----------------------------------------------------------------------------
 * The module contract fixes this component's signature at `{ className? }`, so
 * it cannot reach into the store itself without taking a dependency on another
 * agent's module. Instead it offers two equivalent, additive routes:
 *
 *   DECLARATIVE   pass `view` / `bake` / `rung` / `lod` / ... as optional props
 *                 and the effects below drive the terrain for you.
 *   IMPERATIVE    pass `onReady`, or call `getTerrain()` / `subscribeTerrain()`
 *                 from `@/graph`, and drive it yourself from the store.
 *
 * Both are safe to use at once. Neither changes the required signature.
 * ========================================================================== */

import './terrain.css';

import { useEffect, useMemo, useRef, useState } from 'react';

import { createTerrain, type ConstellationInput, type Terrain, type TerrainOpts } from '@/graph/terrain';
import type {
  AssetTiling,
  DrawnReason,
  GraphViewResponse,
  LayoutBake,
  LodState,
  Rung,
  SigmaClass,
} from '@/engine';

/* -----------------------------------------------------------------------------
 * The instance registry. One terrain per document in practice, but keyed so a
 * side-by-side comparison view is possible without a rewrite.
 * -------------------------------------------------------------------------- */

let current: Terrain | null = null;
const watchers = new Set<(t: Terrain | null) => void>();

/** The live terrain, or `null` before the canvas has mounted. */
export function getTerrain(): Terrain | null {
  return current;
}

/** Called immediately with the current value, then on every change. Returns an unsubscribe. */
export function subscribeTerrain(cb: (t: Terrain | null) => void): () => void {
  watchers.add(cb);
  cb(current);
  return () => watchers.delete(cb);
}

function publish(t: Terrain | null): void {
  current = t;
  for (const w of watchers) w(t);
}

/* -------------------------------------------------------------------------- */

export interface TerrainCanvasProps {
  className?: string;
  /** Renderer options. Read once, at creation. */
  options?: TerrainOpts;
  /** Called with the instance on mount and with `null` on unmount. */
  onReady?: (terrain: Terrain | null) => void;

  /* --- the optional declarative surface -------------------------------- */
  view?: GraphViewResponse | null;
  bake?: LayoutBake | null;
  rung?: Rung;
  parentId?: string | null;
  /** The asset being stood ON, or null. See `SceneInput.assetId`. */
  assetId?: string | null;
  /** Which covering of `assetId` to draw. Defaults to the declared one. */
  tiling?: AssetTiling;
  lod?: Record<string, LodState>;
  hover?: string | null;
  selection?: string[];
  constellation?: ConstellationInput | null;
  filters?: { sigma: SigmaClass[]; showQuarantined: boolean };
  edgePolicy?: DrawnReason | null;
  dimmed?: boolean;
  labelDensity?: number;
}

/**
 * WebGL2 is a hard requirement for the terrain, and a black rectangle is not an
 * error message. If the context cannot be created the host renders the three
 * fields of a `DegradedReason` — what failed, and exactly what to do — because
 * "something went wrong" is an apology, not a message.
 */
function contextFailure(): { code: string; what_failed: string; exact_remedy: string } {
  return {
    code: 'WEBGL_UNAVAILABLE',
    what_failed:
      'The terrain could not create a WebGL2 context, so no knowledge terrain can be drawn on this display.',
    exact_remedy:
      'Enable hardware acceleration in your browser settings and reload. If you are on a remote session, ' +
      'launch the browser with a software GL backend (--use-gl=angle --use-angle=swiftshader).',
  };
}

export function TerrainCanvas(props: TerrainCanvasProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const terrainRef = useRef<Terrain | null>(null);
  const [failed, setFailed] = useState(false);

  // Read once. Changing renderer options after creation is not a thing — it
  // would mean tearing down the GL context, and the caller should remount.
  const options = useMemo(() => props.options ?? {}, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onReady = props.onReady;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    let terrain: Terrain;
    try {
      terrain = createTerrain(canvas, options);
    } catch (err) {
      // Fail loud, and say what to do about it.
      // eslint-disable-next-line no-console
      console.error('[graph/TerrainCanvas]', contextFailure(), err);
      setFailed(true);
      return;
    }

    terrainRef.current = terrain;
    publish(terrain);
    onReady?.(terrain);

    const host = hostRef.current;
    const ro = new ResizeObserver(() => terrain.resize());
    if (host) ro.observe(host);
    terrain.resize();

    return () => {
      ro.disconnect();
      terrainRef.current = null;
      publish(null);
      onReady?.(null);
      terrain.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  /* --- the declarative surface. Each effect is one imperative call. ------ */

  const { view, bake, rung, parentId, assetId, tiling } = props;
  useEffect(() => {
    const t = terrainRef.current;
    if (t === null || view == null || bake == null) return;
    /* A VIEW KEY IS NOT A RUNG. `view.rung` may be `passage` — that is the
       reading tiling's fetch key — and the scene wants the rung you are
       STANDING on, which for that payload is always the asset. */
    const viewRung: Rung = view.rung === 'passage' ? 'asset' : view.rung;
    t.setScene({
      view,
      bake,
      rung: rung ?? viewRung,
      parentId: parentId ?? view.parent_id,
      assetId: assetId ?? (view.rung === 'passage' ? view.parent_id : null),
      tiling: tiling ?? 'reading',
    });
  }, [view, bake, rung, parentId, assetId, tiling]);

  const lod = props.lod;
  useEffect(() => {
    if (lod !== undefined) terrainRef.current?.setLod(lod);
  }, [lod]);

  const hover = props.hover;
  useEffect(() => {
    if (hover !== undefined) terrainRef.current?.setHover(hover);
  }, [hover]);

  const selection = props.selection;
  useEffect(() => {
    if (selection !== undefined) terrainRef.current?.setSelection(selection);
  }, [selection]);

  const constellation = props.constellation;
  useEffect(() => {
    if (constellation !== undefined) terrainRef.current?.setConstellation(constellation);
  }, [constellation]);

  const filters = props.filters;
  useEffect(() => {
    if (filters !== undefined) terrainRef.current?.setFilters(filters);
  }, [filters]);

  const edgePolicy = props.edgePolicy;
  useEffect(() => {
    if (edgePolicy !== undefined) terrainRef.current?.setEdgePolicy(edgePolicy);
  }, [edgePolicy]);

  const dimmed = props.dimmed;
  useEffect(() => {
    if (dimmed !== undefined) terrainRef.current?.setDimmed(dimmed);
  }, [dimmed]);

  const labelDensity = props.labelDensity;
  useEffect(() => {
    if (labelDensity !== undefined) terrainRef.current?.labels.setDensity(labelDensity);
  }, [labelDensity]);

  const failure = contextFailure();

  return (
    <div ref={hostRef} className={props.className ? `tg-terrain ${props.className}` : 'tg-terrain'}>
      <canvas ref={canvasRef} className="tg-terrain__canvas" />
      {failed ? (
        <div className="tg-terrain__degraded" role="alert">
          <strong>{failure.code}</strong>
          <span>{failure.what_failed}</span>
          <code>{failure.exact_remedy}</code>
        </div>
      ) : null}
    </div>
  );
}
