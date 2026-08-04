/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE DESCENT
 * =============================================================================
 *
 * The signature moment of the product, and the reason this is an ATLAS rather
 * than a graph viewer: DESCENDING A RUNG IS A CAMERA MOVE, NOT A PAGE LOAD.
 *
 * Four beats, one scene duration, always reversible:
 *
 *   1. APPROACH   the target region scales up under a continuous camera while
 *                 the attention narrows onto it and its siblings fall to
 *                 `latent`. It stops being a node and becomes the GROUND: once
 *                 the new rung lands it is no longer in the view at all, and the
 *                 renderer washes its hue as the focus region underneath its own
 *                 children. Nothing cuts. Nothing fades to black.
 *
 *   2. RESOLVE    the children sharpen FOVEA-FIRST FROM THE CENTROID OUTWARD,
 *                 one ring per `--rung-stagger`. This is the resolution ramp's
 *                 own vocabulary made temporal — fovea, then penumbra, then
 *                 periphery — and the terminal frame is byte-for-byte the map
 *                 the store derived. The stagger changes WHEN a node reaches its
 *                 tier, never WHICH tier it reaches.
 *
 *   3. PUSH       the breadcrumb gains a level. That is the store's own `stack`,
 *                 which `descend()` grew; the component animates the fact.
 *
 *   4. FLIP       the rung glyph turns over. Also a real state change: `rung`.
 *
 * The ascent is the TRUE REVERSE. The attention narrows onto the region you are
 * standing inside, then blooms outward into its siblings as the camera pulls
 * back — the same two beats, mirrored, so that going up feels like undoing the
 * descent rather than like pressing Back.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS AND IS NOT INVENTED HERE
 * -----------------------------------------------------------------------------
 * NOTHING about resolution is invented. Every LOD value this module writes is
 * either `latent` (the load-bearing tier that exists precisely so the terrain
 * never has holes while something is arriving) or a value read straight out of
 * `useAtlas.getState().lod`, which the store derived from the bake and the
 * receipt. This module decides ORDER and TIME. It never decides a tier.
 *
 * The camera targets are computed from the BAKE, never from a layout run. The
 * children of the node you are diving into are named on the node itself
 * (`island_ids` / `asset_ids` / `passage_ids`), so the approach can aim at
 * exactly where the next rung will settle before the fetch has even returned.
 *
 * -----------------------------------------------------------------------------
 * INTERRUPTIBLE, BY CONSTRUCTION
 * -----------------------------------------------------------------------------
 * A user who descends twice quickly gets ONE continuous camera move, not two
 * queued ones. Every run takes a ticket; a newer ticket makes the older loop
 * stand down and its promise RESOLVE (never reject) with `interrupted: true`.
 * The camera itself retargets rather than queueing — see `@/graph/camera.ts` —
 * so the flight bends toward the new destination from wherever it actually is.
 *
 * -----------------------------------------------------------------------------
 * ONE NOTE FOR THE SHELL
 * -----------------------------------------------------------------------------
 * While a descent is running this module is the authority on `terrain.setLod`.
 * It re-asserts its map every frame, so a shell effect that pushes `store.lod`
 * on commit cannot do worse than one frame of a partially advanced crossfade.
 * `isDescending()` is exported so the shell can skip that push entirely and make
 * even that impossible.
 * =============================================================================
 */

import { RUNG_DEPTH } from '@/engine';
import type { GraphNode, LodState, Rung } from '@/engine';
import { getTerrain, type Terrain } from '@/graph';
import { beginRungMotion } from '@/motion';
import { useAtlas } from '@/state';

import { readAtlasMotion, readAtlasNaming, rungAbove, rungBelow } from './rungGeometry';

/* =============================================================================
 * 1. THE PUBLIC SHAPE
 * ========================================================================== */

/** Which beat the descent is on. `resolve` is the staggered ramp. */
export type DescentPhase = 'approach' | 'resolve' | 'settle';

/** What a descent is doing right now. Every field is measured, none is decorative. */
export interface DescentFrame {
  direction: 'descend' | 'ascend' | 'jump';
  from: Rung;
  to: Rung;
  /** The body being entered, or the scope being jumped to. `null` for a whole rung. */
  targetId: string | null;
  phase: DescentPhase;
  /** Resolve waves completed / waves total, 0..1. Real, not a timer animation. */
  resolved: number;
  /** How many waves this descent was cut into. `1` under reduced motion. */
  waves: number;
  startedAt: number;
}

/** The outcome. `interrupted` means a newer descent took the camera. */
export interface DescentResult {
  from: Rung;
  to: Rung;
  targetId: string | null;
  /** Wall-clock ms the whole choreography took. Measured, never rounded up. */
  ms: number;
  interrupted: boolean;
  /** True when the store refused the move (wrong kind, nothing below, a failure). */
  refused: boolean;
}

/* =============================================================================
 * 2. MODULE STATE
 * ========================================================================== */

/**
 * The shaping this module hands the camera. Structurally the renderer's own
 * `FitFrame` — restated rather than imported so the atlas layer depends on the
 * camera's BEHAVIOUR and not on its module graph.
 */
interface AtlasFrame {
  scale?: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  /**
   * Frame what these ids CONTAIN rather than where they are — the renderer's
   * own `FitFrame.discs`. Used at exactly one rung; see `frameRung`.
   */
  discs?: boolean;
}

let ticket = 0;
let frame: DescentFrame | null = null;
/**
 * The place the run in flight is TAKING THE USER TO, as a `placeKey`.
 *
 * Load-bearing, and the absence of it was the single worst defect in the atlas
 * captures. `installDescentChoreography` used to skip any place change that
 * arrived while a descent was in flight, on the reasoning that an in-flight
 * descent is one of ours and is already being choreographed. That is only true
 * while the place has not changed AGAIN. A guided run — or the scene driver, or
 * a user pressing Descend three times — issues the next store `descend()` the
 * moment the previous one has COMMITTED, long before its choreography has
 * finished; every one of those changes was silently dropped, so the camera never
 * flew, the label budget was never spent and the resolve ramp never ran for two
 * of the four rungs. The measured consequence: 'atlas-continent' and
 * 'atlas-island' were photographed from the identical camera, and so were
 * 'atlas-asset' and 'atlas-passage'.
 *
 * So the test is not "is something in flight" but "is the thing in flight going
 * where the store has just gone". If it is not, the new place supersedes it —
 * which is the same interruption path a second user click takes, and lands one
 * continuous camera move rather than two queued ones.
 */
let claimed: string | null = null;
const watchers = new Set<(f: DescentFrame | null) => void>();

function publish(next: DescentFrame | null): void {
  frame = next;
  for (const w of watchers) w(next);
}

/** True while a rung change is in the air. The shell may use it to stand off LOD. */
export function isDescending(): boolean {
  return frame !== null;
}

/** The live descent, or `null`. Read-only — mutating it changes nothing. */
export function activeDescent(): Readonly<DescentFrame> | null {
  return frame;
}

/** Called immediately with the current value, then on every change. */
export function subscribeDescent(cb: (f: DescentFrame | null) => void): () => void {
  watchers.add(cb);
  cb(frame);
  return () => watchers.delete(cb);
}

/**
 * Stand the current descent down.
 *
 * It does NOT undo anything: the store has already navigated or it has not, and
 * pretending otherwise would leave the breadcrumb disagreeing with the terrain.
 * The loop stops re-asserting its map and the store's own resolution map takes
 * over on the next frame, which is the correct resting state either way.
 */
export function cancelDescent(): void {
  ticket++;
  claimed = null;
  restoreLod();
  if (frame !== null) publish(null);
}

/**
 * Hand the resolution map back to the store, immediately.
 *
 * Called whenever a run ends WITHOUT a successor taking over — a cancellation or
 * a move the store refused. The approach narrows the attention onto one body by
 * writing `latent` over its siblings, and leaving that in place would be the
 * interface claiming the engine had stopped spending on a rung it is standing
 * on. An interrupted run deliberately does NOT restore: its successor owns the
 * map within the same frame, and restoring first would be one frame of flicker.
 */
function restoreLod(): void {
  getTerrain()?.setLod(useAtlas.getState().lod);
}

/* =============================================================================
 * 3. GEOMETRY HELPERS — all of them read the BAKE, none of them computes one
 * ========================================================================== */

/** The ids one rung below a spine body, named on the body itself. */
function childIdsOf(node: GraphNode): string[] {
  switch (node.kind) {
    case 'continent':
      return node.island_ids;
    case 'island':
      return node.asset_ids;
    case 'asset':
      return node.passage_ids;
    default:
      return [];
  }
}

interface Point {
  x: number;
  y: number;
}

/** Baked position by id, or `null`. The bake is the only source of position. */
function positionOf(id: string): Point | null {
  const bake = useAtlas.getState().bake;
  if (bake === null) return null;
  const p = bake.positions.find((q) => q.id === id);
  return p === undefined ? null : { x: p.x, y: p.y };
}

/** Baked positions for a set of ids, keyed. One pass over the bake, not n. */
function positionsFor(ids: Iterable<string>): Map<string, Point> {
  const want = new Set(ids);
  const out = new Map<string, Point>();
  const bake = useAtlas.getState().bake;
  if (bake === null) return out;
  for (const p of bake.positions) {
    if (want.has(p.id)) out.set(p.id, { x: p.x, y: p.y });
  }
  return out;
}

/**
 * WHAT THE ATLAS'S OWN PANELS ARE COVERING, in CSS pixels.
 *
 * The camera fits its subject to the CANVAS, and anything drawn ON TOP of the
 * canvas rather than beside it makes the usable frame smaller than the canvas
 * rect. Framing to the whole canvas parks part of the rung's bodies under the
 * chrome that names them and leaves the same area of empty sea on the other
 * side — which is exactly what the asset capture showed.
 *
 * ATLAS MODE NO LONGER APPEARS IN THIS SUM, AND THAT IS THE POINT. It used to
 * float a second 300px column over the terrain beside the rail; that column was
 * why the honest unobstructed-terrain figure sat at 69.3–69.7% while `audit()`
 * was still certifying 80.4%. It now renders INSIDE the rail, so it is beside
 * the canvas rather than on it and this probe correctly finds zero overlap. The
 * `.am` term is kept rather than deleted because a probe that measures the live
 * DOM cannot be wrong about a future remount, and a hardcoded zero could.
 *
 * Measured off the live DOM rather than read off a width token, because the
 * panels are `max-width`-clamped on a narrow window and a token that says 300px
 * would be wrong on the one screen where the occlusion actually hurts. When the
 * panels are closed there is nothing over the canvas and this returns nothing.
 */
function atlasOcclusion(): AtlasFrame {
  if (typeof document === 'undefined') return {};
  const canvas = document.querySelector<HTMLCanvasElement>('.shell__stage canvas');
  if (canvas === null) return {};
  const stage = canvas.getBoundingClientRect();
  if (stage.width <= 0) return {};

  const overlap = (selector: string, edge: 'right' | 'bottom'): number => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el === null || el.offsetParent === null) return 0;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return 0;
    const px = edge === 'right' ? stage.right - r.left : stage.bottom - r.top;
    // A panel that has scrolled off, or one that is not actually over the
    // canvas, occludes nothing. Never let it eat more than half the frame.
    return Math.max(0, Math.min(px, edge === 'right' ? stage.width / 2 : stage.height / 2));
  };

  const right = overlap('.am', 'right');
  const bottom = overlap('.rl', 'bottom');
  const out: AtlasFrame = {};
  if (right > 0) out.right = right;
  if (bottom > 0) out.bottom = bottom;
  return out;
}

/**
 * How far a frame has to open up to reach the COASTLINES of what it is framing.
 *
 * `fitTo` frames node CENTRES and pads by six tenths of the median containment
 * radius, which is the right rule wherever the bodies are things. At the top of
 * the world it is the wrong rule: what you are looking at there is not the six
 * bodies, it is the land they are the centroids of. Framing the points crops the
 * map through its own coasts — under which "no labels are needed to tell them
 * apart: the hue is the region" is a sentence printed over a picture that does
 * not show the regions.
 *
 * So the multiplier is DERIVED from the bake: it is exactly the factor that
 * turns the box `fitTo` would build into the union of the given containment
 * discs, on whichever axis needs more. Nothing is invented and nothing is
 * rounded up for looks — and it is capped by `--atlas-world-scale-max` so one
 * oversized region can never fly the camera out into empty sea.
 */
function coastlineScale(ids: readonly string[]): number {
  const bake = useAtlas.getState().bake;
  if (bake === null) return 1;
  const want = new Set(ids);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let discMinX = Infinity;
  let discMinY = Infinity;
  let discMaxX = -Infinity;
  let discMaxY = -Infinity;
  const radii: number[] = [];

  for (const p of bake.positions) {
    if (!want.has(p.id)) continue;
    const r = p.r || 0;
    radii.push(r);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.x - r < discMinX) discMinX = p.x - r;
    if (p.x + r > discMaxX) discMaxX = p.x + r;
    if (p.y - r < discMinY) discMinY = p.y - r;
    if (p.y + r > discMaxY) discMaxY = p.y + r;
  }
  if (radii.length === 0) return 1;

  radii.sort((a, b) => a - b);
  // The same expansion `fitTo` applies: six tenths of the MEDIAN radius, which
  // is robust to the one oversized region that would otherwise set the altitude.
  const pad = (radii[Math.floor(radii.length / 2)] ?? 0) * 0.6;
  const fitW = maxX - minX + pad * 2;
  const fitH = maxY - minY + pad * 2;
  if (!(fitW > 0) || !(fitH > 0)) return 1;

  const reach = Math.max((discMaxX - discMinX) / fitW, (discMaxY - discMinY) / fitH);
  if (!Number.isFinite(reach)) return 1;
  return Math.min(readAtlasNaming().worldScaleMax, Math.max(1, reach));
}

/**
 * Frame the rung's OWN BODIES, and set the rung's label budget.
 *
 * THE CAMERA MUST NOT FRAME THE ENTITY LAYER. At the asset and passage rungs the
 * payload includes the cross-cutting entities, and those are spread across the
 * whole world BY CONSTRUCTION — an entity mentioned on two islands is what a
 * bridge IS. Framing them means every rung arrives at the same altitude looking
 * at the same nebula, and the four rungs stop being four kinds of place.
 *
 * An entity that leaves the frame is not hidden. Its relations still run off the
 * edge of the screen toward wherever it went, which is the true thing about it.
 *
 * THE MIDDLE OF THE SPINE FRAMES ITS CONTENTS; THE TWO ENDS FRAME THEIR
 * CONTAINER, AND THE SPLIT IS THE ONTOLOGY.
 *
 *   ◆ CONTINENT — THE WORLD. There is nothing above it, so the subject is the
 *     land itself and the frame reaches the coastlines and the sea outside them.
 *
 *   ⬢ ISLAND, ▮ ASSET — WHAT YOU DESCENDED INTO. The subject is the bodies,
 *     framed tight, and what they sit in falls off the edge. That is what makes
 *     arriving somewhere feel like arriving rather than like a label swap.
 *
 *   · PASSAGE — THE DOCUMENT, WHOLE, BOUNDARY INCLUDED. This one is the other
 *     end of the world and it is framed like the other end of the world: the
 *     subject is the container, not the five things in it.
 *
 *     It used to frame the spans and let the boundary run off every edge, on the
 *     reasoning that the boundary was a hairline the eye would not find. That
 *     stopped being true the moment the renderer started laying the spans on the
 *     document's own byte axis — a READING SPINE inscribed in the containment
 *     radius the asset declared. Framing the marks and cropping the page they
 *     are marks ON photographs five specks and four long wires leaving the
 *     screen: a scatter on a void, which is precisely what the passage rung was
 *     criticised for. Framing the page composes the emptiness instead — the
 *     boundary closes, the spine runs edge to edge inside it, span 1 is left of
 *     span 2 is left of span 3, and the ledger's ranges are checkable against it.
 *
 *     `discs: true` is the renderer's own affordance for exactly this case (see
 *     `FitFrame.discs`) and this is the only call site in the product that uses
 *     it. Nothing is invented: the disc is the containment radius the bake gave
 *     the asset, and the spine is inscribed in that same radius.
 *
 * Returns the ids it framed, or `[]` when the rung has no bodies to frame.
 */
export function frameRung(terrain: Terrain, ms?: number): string[] {
  const state = useAtlas.getState();
  const nodes = state.view?.nodes ?? [];
  if (nodes.length === 0) return [];
  const frame = atlasOcclusion();

  // THE PAGE, NOT THE MARKS ON IT. Only when the document is actually baked —
  // without a position there is no disc to frame and the spans are the honest
  // fallback rather than a camera aimed at nothing.
  /* THE ASSET YOU ARE STANDING ON, in either covering. `scopeId(stack)` gave
     the same answer while the passage was a rung; `assetId` says it directly,
     and says it in the graph tiling too, where there is no passage rung to
     infer it from.

     TESTED BEFORE THE BODIES GUARD, and that ordering is the whole fix. While
     the passage was a rung the guard was harmless: `bodies` meant "the spans",
     the floor payload is full of them, and the guard never fired. Standing on a
     floor the rung is `asset` and the floor's own payload contains no asset
     body at all — so the guard returned early and the camera never framed the
     document. Symptom: arriving on a floor left the whole island on screen with
     the page a speck in the middle of it. The floor knows what it wants framed
     without consulting the rung's bodies, so it asks first. */
  const document = state.assetId;
  if (document !== null && positionOf(document) !== null) {
    frame.discs = true;
    /* AND NO ROOM AROUND IT. While an answer is on screen the renderer sets a
     * standing framing rule of `scale: 2.1` — right for a constellation, whose
     * whole meaning is the ground it crosses, and wrong for this: the page IS
     * the container, and there is nothing outside its boundary that explains
     * what is inside it. Inheriting the rule shrank the document to 40% of the
     * frame and pushed the five marks into each other's labels — the same
     * defect the spine was built to fix, arriving from the other direction.
     * `scale` is stated here rather than left to the merge so the page frames
     * identically whether or not a render happens to be on screen. */
    frame.scale = 1;
    void terrain.camera.fitTo([document], 88, ms, frame);
    return [document];
  }

  const bodies = nodes.filter((n) => n.kind === state.rung).map((n) => n.id);
  if (bodies.length === 0) return [];
  if (state.rung === 'continent') frame.scale = coastlineScale(bodies);
  void terrain.camera.fitTo(bodies, 72, ms, frame);
  return bodies;
}

/** The body the current rung is scoped INSIDE, or `null` at the top of the world. */
function scopeId(stack: readonly { id: string }[]): string | null {
  return stack.length === 0 ? null : stack[stack.length - 1].id;
}

/** The rung's label ceiling, for the current view. See `labelBudget`. */
export function labelCeilingFor(): number {
  const state = useAtlas.getState();
  const nodes = state.view?.nodes ?? [];
  const bodies = nodes.filter((n) => n.kind === state.rung).length;
  return labelBudget(state.rung, bodies, nodes.length);
}

/**
 * How many labels a rung may place. THIS IS PART OF THE ONTOLOGY, not a density
 * setting — it is the difference between naming places and naming things.
 *
 * AT ALTITUDE YOU NAME PLACES. The region rungs spend the whole budget on their
 * own bodies and nothing else: six continents, six names. A continent with four
 * thousand dot-labels over it is a label storm, not a map.
 *
 * UP CLOSE YOU NAME THINGS, AND THERE ARE FAR TOO MANY OF THEM. At the asset
 * rung the candidate set is twenty-four documents plus the forty entities
 * extracted inside them, and naming all sixty-four produced precisely the frame
 * the brief bans: a column of forty names, four of them the identical truncated
 * string. So the fine rungs are capped at `--atlas-label-fine` and the label
 * layer spends that ceiling on its highest-ranked candidates.
 *
 * A CEILING, NOT A TARGET. The layer places what fits without colliding, so a
 * budget of six on a rung with six bodies means six names and no dot-labels at
 * all, and the analyst readout reports placed against possible — the budget is a
 * stated policy rather than a silent crop.
 */
export function labelBudget(rung: Rung, bodies: number, total: number): number {
  if (rung === 'continent' || rung === 'island') return bodies;
  return Math.min(Math.max(bodies, total), readAtlasNaming().fineCeiling);
}

function centroidOf(points: Iterable<Point>): Point | null {
  let n = 0;
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
    n++;
  }
  return n === 0 ? null : { x: x / n, y: y / n };
}

/**
 * Assign every id a wave, by distance from the fovea, 0 = first.
 *
 * The radial cut is by RANK, not by raw distance: a rung whose bodies cluster in
 * one corner and put a single outlier across the map would otherwise spend every
 * wave but the last on that one node, and the ripple would not be visible at
 * all. Rank ordering guarantees each wave carries a real share of the children.
 */
function wavesByRadius(
  ids: readonly string[],
  fovea: Point | null,
  positions: Map<string, Point>,
  waves: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (ids.length === 0 || waves <= 1 || fovea === null) {
    for (const id of ids) out.set(id, 0);
    return out;
  }
  const ranked = [...ids].sort((a, b) => {
    const pa = positions.get(a);
    const pb = positions.get(b);
    if (pa === undefined) return pb === undefined ? 0 : 1;
    if (pb === undefined) return -1;
    const da = (pa.x - fovea.x) ** 2 + (pa.y - fovea.y) ** 2;
    const db = (pb.x - fovea.x) ** 2 + (pb.y - fovea.y) ** 2;
    return da - db;
  });
  for (let i = 0; i < ranked.length; i++) {
    out.set(ranked[i], Math.min(waves - 1, Math.floor((i / ranked.length) * waves)));
  }
  return out;
}

/* =============================================================================
 * 4. THE RESOLVE LOOP
 * ========================================================================== */

/**
 * Ramp a view in from `latent`, fovea-outward, and resolve when it is whole.
 *
 * `terminal()` is read fresh on every wave rather than captured once, because a
 * selection or a query landing mid-descent legitimately changes what the engine
 * is spending on — and the picture must end up agreeing with the store, not with
 * a snapshot of the store from 400ms ago.
 */
function runResolve(
  terrain: Terrain,
  ids: readonly string[],
  fovea: Point | null,
  labelCeiling: number,
  mine: number,
  onWave: (completed: number, total: number) => void,
): Promise<void> {
  const motion = readAtlasMotion();
  const total = motion.waves;
  const positions = positionsFor(ids);
  const wave = wavesByRadius(ids, fovea, positions, total);

  const terminal = (): Record<string, LodState> => useAtlas.getState().lod;

  const mapFor = (completed: number): Record<string, LodState> => {
    const source = terminal();
    const out: Record<string, LodState> = {};
    for (const id of ids) {
      // Not yet reached by the ramp: present as topology, spent on by nothing.
      // `latent` is a real tier, so the terrain has no hole while it waits.
      out[id] = (wave.get(id) ?? 0) <= completed ? (source[id] ?? 'latent') : 'latent';
    }
    return out;
  };

  return new Promise<void>((resolve) => {
    const started = performance.now();
    let completed = -1;
    let done = false;
    let map: Record<string, LodState> = {};

    const finish = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(bail);
      resolve();
    };

    /* THE LOOP IS rAF-DRIVEN AND rAF STOPS IN A BACKGROUND TAB. Without this the
       promise would never settle for a user who switched tabs mid-descent, the
       choreography would stay "in flight" forever, and `settled()` — which the
       whole visual-QA pass depends on — would time out on every scene after it.
       A timer is the only clock that keeps running when the frames do not. */
    const bail = window.setTimeout(
      () => {
        if (done) return;
        terrain.setLod(terminal());
        terrain.labels.setDensity(labelCeiling);
        finish();
      },
      motion.staggerMs * total + motion.sceneMs * 3,
    );

    const step = (): void => {
      if (ticket !== mine) {
        finish();
        return;
      }
      if (done) return;
      const elapsed = performance.now() - started;
      const next = Math.min(total - 1, Math.floor(elapsed / motion.staggerMs));
      if (next !== completed) {
        completed = next;
        map = mapFor(completed);
        // THE LABEL BUDGET IS SPENT ON THE SAME RAMP. Without this the resolve
        // is invisible at the fine rungs: a document's boundary ring and its
        // name are drawn whatever tier the node is at, so the only thing the
        // LOD ripple moves is a three-pixel capital. Naming is the largest part
        // of what a rung spends, so naming is ramped with everything else — and
        // the ceiling it ramps to is the rung's real budget, reached on the
        // last wave and reported by the analyst readout thereafter.
        terrain.labels.setDensity(Math.ceil((labelCeiling * (completed + 1)) / total));
        onWave(completed + 1, total);
      }
      // Re-asserted every frame, not just on a wave boundary: the shell pushes
      // the store's own map when the view commits, and this is what makes that
      // push cost one partially-advanced crossfade instead of a pop.
      terrain.setLod(map);

      if (completed >= total - 1 && elapsed >= motion.staggerMs * total) {
        // Hand authority back by writing the store's map verbatim. The last
        // frame of the choreography and the resting frame are the same frame.
        terrain.setLod(terminal());
        terrain.labels.setDensity(labelCeiling);
        finish();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * Wait for the camera to come to rest, and never hang.
 *
 * Two clocks on purpose. The rAF poll is the accurate one; the timer is the one
 * that still runs when the tab is in the background and rAF has stopped, so a
 * descent can never leave the app permanently "in flight".
 */
function awaitCameraRest(terrain: Terrain, mine: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const started = performance.now();
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(bail);
      resolve();
    };
    const bail = window.setTimeout(finish, timeoutMs);
    const step = (): void => {
      if (done) return;
      if (ticket !== mine || terrain.camera.idle()) return finish();
      if (performance.now() - started > timeoutMs) return finish();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/* =============================================================================
 * 5. THE CHOREOGRAPHY
 * ========================================================================== */

interface Plan {
  direction: DescentFrame['direction'];
  from: Rung;
  to: Rung;
  /** The body being entered / left / scoped to. */
  targetId: string | null;
  /** What the approach narrows onto and the resolve blooms out of. */
  fovea: Point | null;
  /**
   * Narrow the attention onto `targetId` during the approach.
   *
   * True for a descent and an ascent, where the target is the body the camera is
   * physically moving into or out of and the narrowing is what makes it read as
   * one continuous move. FALSE for a breadcrumb jump: the scope of a jump can be
   * three rungs away and off screen, and lighting a node the user cannot see is
   * a glow that corresponds to nothing they are looking at.
   */
  narrow: boolean;
  /** Where the camera should be when the new rung lands, if it can be known. */
  approachIds: string[];
  /**
   * The `placeKey` this plan is taking the user to, claimed BEFORE `navigate`
   * runs. The store commits synchronously, so the choreography's own subscriber
   * sees the change while this run is still on its first beat — this is how it
   * recognises the move as already spoken for instead of adopting it twice.
   */
  place: string;
  /** The store action that actually changes the place. */
  navigate: () => Promise<void>;
}

/**
 * Run one plan. Everything public in this module funnels through here so that
 * descend, ascend and a breadcrumb jump cannot drift into three different
 * choreographies of the same idea.
 */
async function run(plan: Plan): Promise<DescentResult> {
  const mine = ++ticket;
  // Claimed before anything else, and before `navigate` in particular: the store
  // commit that changes the place fires this module's own subscriber
  // synchronously, and it has to be able to tell "already mine" from "the world
  // moved again under a run that is now stale".
  claimed = plan.place;
  const started = performance.now();
  const terrain = getTerrain();
  const motion = readAtlasMotion();

  const result = (interrupted: boolean, refused = false): DescentResult => ({
    from: plan.from,
    to: plan.to,
    targetId: plan.targetId,
    ms: Math.round(performance.now() - started),
    interrupted,
    refused,
  });

  // No renderer (a headless test, a WebGL failure): the ontology change still
  // has to happen. It is the picture that is optional, never the place.
  if (terrain === null) {
    await plan.navigate();
    return result(false);
  }

  publish({
    direction: plan.direction,
    from: plan.from,
    to: plan.to,
    targetId: plan.targetId,
    phase: 'approach',
    resolved: 0,
    waves: motion.waves,
    startedAt: started,
  });

  /* ---- 1. APPROACH ------------------------------------------------------ *
   * The attention narrows onto the body being entered. Its siblings drop to
   * `latent` — still there, still in place, no longer spent on — and the camera
   * starts moving before the fetch has returned, aimed at where the next rung
   * will actually settle.
   *
   * THE BEAT IS RUN BY `@/motion`, and it is the one beat of this choreography
   * that is pure motion. It used to be a single `setLod` write that pinned the
   * target at `lod-0` for the whole flight: the body you were diving into stayed
   * the sharpest thing on screen right up to the frame it vanished, which reads
   * as a page load with a camera move stapled to it.
   *
   * It now DEFOCUSES down the ramp — lod-0, lod-1, lod-2, ghost — as the camera
   * scales it up, so a continent stops being a thing and becomes the place you
   * are standing in, and the region wash underneath its own children takes over.
   * Ascending runs the identical ramp backwards, which is what makes going up
   * feel like undoing the descent rather than like pressing Back.
   *
   * Registering it here is also what puts a rung change on the same clock as the
   * other four signature animations: `settled()` waits for it, `motionLog()`
   * measures it, and `audit()` fails it if the store never went where it claimed. */
  const outgoing = useAtlas.getState().view?.nodes ?? [];
  const rungMotion = beginRungMotion({
    place: plan.place,
    direction: plan.direction,
    targetId: plan.narrow ? plan.targetId : null,
    narrow: outgoing.filter((n) => n.id !== plan.targetId).map((n) => n.id),
    from: plan.from,
    to: plan.to,
  });
  if (plan.approachIds.length > 0) {
    // Not awaited. A flight is superseded by the auto-frame the instant the new
    // scene lands, which is the whole point of a continuous camera: the eye
    // never sees two moves, only one that changed its mind early.
    void terrain.camera.fitTo(plan.approachIds, 72, motion.sceneMs);
  }

  /* ---- 2. THE PLACE CHANGES -------------------------------------------- */
  await plan.navigate();
  if (ticket !== mine) {
    rungMotion.cancel();
    publish(null);
    return result(true);
  }

  const state = useAtlas.getState();
  if (state.rung !== plan.to) {
    // The store declined — a wrong-kind node, nothing below a passage, or a
    // failure that has already routed itself to DEGRADED with a real remedy.
    // The approach already narrowed the attention; give it straight back.
    rungMotion.cancel();
    restoreLod();
    claimed = null;
    publish(null);
    return result(false, true);
  }
  // Where the store ACTUALLY landed. A breadcrumb jump resolves its ancestry
  // asynchronously, so the claim taken before `navigate` was an intention;
  // this is the fact, and the fact is what the subscriber compares against.
  claimed = placeKey(state.rung, state.stack);

  /* ---- 3. FRAME THE RUNG, NOT THE ENTITY LAYER -------------------------- *
   * The renderer auto-frames the whole payload, and at the fine rungs the
   * payload includes the CROSS-CUTTING entity layer — which is spread across the
   * entire world by construction, because that is what makes an entity a bridge.
   * Framing it means every rung arrives at the same altitude looking at the same
   * nebula, which is precisely the failure mode this Atlas exists to avoid.
   *
   * So the camera frames the rung's OWN BODIES and lets the entity layer fall
   * off the edge. That is not hiding it: an entity that leaves the frame is an
   * entity that leads somewhere else, which is the true thing about it, and the
   * relations drawn to it still run off the edge of the screen toward where it
   * went. */
  const incoming = (state.view?.nodes ?? []).map((n) => n.id);
  /* THE APPROACH STOPS WRITING THE RAMP HERE, and the handover is explicit
     rather than timed. Two writers on the resolution map in one frame is a race
     whose winner is whichever the browser called second, and the loser's map
     would flicker through at whatever rate the two loops beat at. */
  rungMotion.endApproach();
  frameRung(terrain, motion.sceneMs);
  // Nothing at the new rung has been named yet. The resolve spends the naming
  // budget back up over its waves; without this the renderer would rebuild the
  // label layer at the PREVIOUS rung's ceiling and the ramp would start full.
  terrain.labels.setDensity(0);

  /* ---- 4. RESOLVE ------------------------------------------------------- */
  const fovea = plan.fovea ?? centroidOf(positionsFor(incoming).values()) ?? null;

  publish({
    direction: plan.direction,
    from: plan.from,
    to: plan.to,
    targetId: plan.targetId,
    phase: 'resolve',
    resolved: 0,
    waves: motion.waves,
    startedAt: started,
  });

  await runResolve(terrain, incoming, fovea, labelCeilingFor(), mine, (done, total) => {
    if (ticket !== mine || frame === null) return;
    publish({ ...frame, phase: 'resolve', resolved: total === 0 ? 1 : done / total });
  });

  if (ticket !== mine) {
    rungMotion.cancel();
    return result(true);
  }

  /* ---- 5. SETTLE -------------------------------------------------------- *
   * The choreography is only over when the camera has stopped, or `settled()`
   * would let the harness photograph a transition and call it a design.
   *
   * The frame is asserted a SECOND time here, and the repetition is deliberate.
   * A terrain created with the renderer's default `autoFrame` re-frames itself
   * on the whole payload inside `setScene`, which the shell calls from a React
   * effect — i.e. AFTER this module has already aimed. Re-asserting bends that
   * flight back onto the rung's own bodies instead of the entity layer. With
   * `createTerrain(canvas, { autoFrame: false })` the camera was already right
   * and `moveTo` sees it is already there, so this call costs nothing. */
  frameRung(terrain, motion.sceneMs);
  terrain.labels.setDensity(labelCeilingFor());
  if (frame !== null) publish({ ...frame, phase: 'settle', resolved: 1 });
  await awaitCameraRest(terrain, mine, motion.sceneMs * 3);

  if (ticket !== mine) {
    rungMotion.cancel();
    return result(true);
  }
  // The whole choreography is over, and the witness is checked against the
  // store: a rung change that animated its way somewhere the store never went
  // is reported by `audit()` rather than admired.
  rungMotion.finish();
  claimed = null;
  publish(null);
  return result(false);
}

/* =============================================================================
 * 6. THE THREE VERBS
 * ========================================================================== */

/**
 * Dive into a body of the current rung.
 *
 * `id` must be a body of the rung you are standing on — entities are
 * cross-cutting and are opened, not entered. The store enforces that and says so
 * on the console; this returns `refused: true` rather than inventing a place.
 */
export async function descend(id: string): Promise<DescentResult> {
  const state = useAtlas.getState();
  const from = state.rung;
  const to = rungBelow(from);
  if (to === null) {
    return { from, to: from, targetId: id, ms: 0, interrupted: false, refused: true };
  }

  const node = state.view?.nodes.find((n) => n.id === id) ?? null;
  const children = node === null ? [] : childIdsOf(node);

  return run({
    direction: 'descend',
    from,
    to,
    targetId: id,
    // The body you dove into is the fovea of the rung inside it. Its children
    // sharpen outward from where it stood, so the eye keeps its anchor.
    fovea: positionOf(id),
    narrow: true,
    approachIds: children.length > 0 ? children : [id],
    // `descend(id)` pushes `id` onto the stack, so this is where the store will
    // be one microtask from now.
    place: `${to}|${id}`,
    navigate: () => useAtlas.getState().descend(id),
  });
}

/**
 * Rise one rung. The true reverse of `descend`.
 *
 * The fovea is the region you were standing inside, so its siblings bloom
 * outward from it exactly as its children bloomed outward from it on the way
 * down. Going up undoes the descent; it does not navigate Back.
 */
export async function ascend(): Promise<DescentResult> {
  const state = useAtlas.getState();
  const from = state.rung;
  const scope = state.stack.length === 0 ? null : state.stack[state.stack.length - 1];
  const to = scope !== null ? scope.rung : rungAbove(from);
  if (to === null) {
    return { from, to: from, targetId: null, ms: 0, interrupted: false, refused: true };
  }

  const leaving = scope?.id ?? null;
  const siblingScope = state.stack.length >= 2 ? state.stack[state.stack.length - 2].id : null;

  return run({
    direction: 'ascend',
    from,
    to,
    targetId: leaving,
    fovea: leaving === null ? null : positionOf(leaving),
    narrow: true,
    approachIds: siblingsAtRung(to, siblingScope),
    // Ascending pops the stack, so the scope that will be on top is the one
    // BELOW the entry being left.
    place: `${to}|${siblingScope ?? ''}`,
    navigate: () => useAtlas.getState().ascend(),
  });
}

/**
 * Jump straight to a rung, optionally scoped — what a breadcrumb click and the
 * 1-4 keys do.
 *
 * It is choreographed like a descent even when it goes up, because from the
 * user's point of view it is the same event: the ontology changed and the camera
 * carried them there. What differs is only which body is the fovea.
 */
export async function goToRung(rung: Rung, id: string | null = null): Promise<DescentResult> {
  const state = useAtlas.getState();
  const from = state.rung;
  const fovea = id === null ? null : positionOf(id);
  const bodies = siblingsAtRung(rung, id);

  return run({
    direction:
      RUNG_DEPTH[rung] > RUNG_DEPTH[from]
        ? 'descend'
        : RUNG_DEPTH[rung] < RUNG_DEPTH[from]
          ? 'ascend'
          : 'jump',
    from,
    to: rung,
    targetId: id,
    fovea,
    narrow: false,
    approachIds: bodies,
    place: `${rung}|${id ?? ''}`,
    navigate: () => useAtlas.getState().goToRung(rung, id),
  });
}

/* =============================================================================
 * 7. ADOPTING A MOVE SOMEBODY ELSE MADE
 * ========================================================================== */

/** The place, as one comparable string. Rung plus scope is the whole identity. */
function placeKey(rung: Rung, stack: readonly { id: string }[]): string {
  return `${rung}|${stack.length === 0 ? '' : stack[stack.length - 1].id}`;
}

/**
 * Choreograph rung changes this module did not initiate.
 *
 * The keyboard map, semantic zoom and a restored shared link all call the
 * STORE's `descend` / `ascend` / `goToRung` directly — they have to, because the
 * keymap is one table owned by one module and a second table would drift. That
 * would leave three of the four beats missing on a key press: the rung would
 * change and the children would simply appear, which is exactly the page-load
 * feeling this whole file exists to prevent.
 *
 * So the choreography subscribes. A place change with no descent of ours in
 * flight is ADOPTED: the approach is already over (we learn about it after the
 * fact and will not fake a flight backwards), but the fovea-outward resolve, the
 * breadcrumb push and the glyph flip all still happen, and `settled()` still
 * waits for the camera. One install, in the shell. Returns the unsubscribe.
 *
 * THE ONE TEST THAT DECIDES WHETHER A MOVE IS SKIPPED is `claimed`, not
 * `isDescending()`. See the comment on `claimed` — skipping every change that
 * arrived mid-flight is what left two of the four atlas rungs with no camera
 * move, no naming budget and no resolve ramp at all.
 */
export function installDescentChoreography(): () => void {
  return useAtlas.subscribe((state, prev) => {
    // THE FIRST VIEW. An ingest is not a rung change, so it gets no
    // choreography — the terrain's own settle animation owns that moment. But it
    // does need a frame, because a terrain built with `autoFrame: false` starts
    // at the world origin at unit zoom and would otherwise open on empty space.
    if (prev.view === null && state.view !== null) {
      const terrain = getTerrain();
      if (terrain !== null) {
        frameRung(terrain);
        terrain.labels.setDensity(labelCeilingFor());
      }
      return;
    }

    const now = placeKey(state.rung, state.stack);
    if (now === placeKey(prev.rung, prev.stack)) return;
    // Ours, and still going where the store has just gone: already choreographed
    // properly, leave it alone. Anything else — including a run of ours that has
    // been overtaken by a further descent — is adopted, and `run()` supersedes
    // the stale flight rather than queueing behind it.
    if (isDescending() && now === claimed) return;
    if (state.view === null) return;

    const leaving = prev.stack.length === 0 ? null : prev.stack[prev.stack.length - 1].id;
    const entering = state.stack.length === 0 ? null : state.stack[state.stack.length - 1].id;
    const targetId =
      RUNG_DEPTH[state.rung] > RUNG_DEPTH[prev.rung] ? entering : (leaving ?? entering);

    void run({
      direction:
        RUNG_DEPTH[state.rung] > RUNG_DEPTH[prev.rung]
          ? 'descend'
          : RUNG_DEPTH[state.rung] < RUNG_DEPTH[prev.rung]
            ? 'ascend'
            : 'jump',
      from: prev.rung,
      to: state.rung,
      targetId,
      fovea: targetId === null ? null : positionOf(targetId),
      // The move already happened. Narrowing the attention onto a body that is
      // no longer on screen would be an animation of something that is over.
      narrow: false,
      approachIds: [],
      place: now,
      navigate: () => Promise.resolve(),
    });
  });
}

/**
 * The ids that will populate a rung under a scope, read out of the CURRENT
 * view's ancestry where it is knowable and out of the bake otherwise.
 *
 * This is only ever used to aim a camera a few milliseconds early. When it comes
 * back empty the approach simply does not pre-aim and the renderer's own
 * auto-frame does the whole flight — one continuous move either way.
 */
function siblingsAtRung(rung: Rung, scopeId: string | null): string[] {
  const bake = useAtlas.getState().bake;
  if (bake === null) return [];

  if (scopeId !== null) {
    // A scoped rung is exactly the scope's own children, and those are named on
    // the scope itself — no join, no layout, no second fetch. When the scope is
    // not in the current view (an ancestor three rungs up) the honest answer is
    // "I cannot know yet", and the renderer's own auto-frame flies the whole
    // move instead. One continuous camera either way.
    const scoped = useAtlas.getState().view?.nodes.find((n) => n.id === scopeId);
    if (scoped === undefined) return [];
    return childIdsOf(scoped);
  }

  // An unscoped rung is every body of that kind in the world.
  const ids: string[] = [];
  for (const p of bake.positions) {
    if (p.kind === rung) ids.push(p.id);
  }
  return ids;
}
