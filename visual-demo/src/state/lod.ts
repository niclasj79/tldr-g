/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE RESOLUTION MAP
 * =============================================================================
 *
 * One function, one output: `node id -> LodState` for everything the terrain is
 * about to draw. The terrain never decides a node's resolution; it is told.
 *
 * -----------------------------------------------------------------------------
 * THE TERRAIN NEVER HAS HOLES
 * -----------------------------------------------------------------------------
 * This is the load-bearing rule and it is why `latent` exists. When the engine
 * declines to spend tokens on a node, that node does NOT disappear from the map
 * — it drops to a 12%-opacity outline and stays exactly where it was. Omission
 * is a budget decision made visible as topology, not a deletion.
 *
 * So the map returned here is TOTAL over `view.nodes`. `lodHoles()` proves it,
 * and the store calls that check in dev on every recompute. A missing entry is a
 * node the renderer would silently skip, which is the one failure mode that
 * would let the picture lie about what the engine knows.
 *
 * -----------------------------------------------------------------------------
 * TWO MAPS, ONE FUNCTION
 * -----------------------------------------------------------------------------
 * RESTING (no active render trace) — resolution is the bake's own budget:
 *   the rung you are standing on is drawn at label resolution, the cross-cutting
 *   layer at whatever the bake budgeted for it, and anything you have selected
 *   is pulled to full verbatim resolution because you asked for it.
 *
 * RENDERED (an active `RenderTraceV1`) — resolution is the ENGINE'S ADMISSION
 * DECISION, read straight off the receipt:
 *   citations                      -> lod-0   (the verbatim guarantee)
 *   AdmissionRecord.lod            -> as admitted (lod-1 summary / lod-2 label)
 *   omitted_but_connected, 1 hop   -> ghost   (connected, not spent on)
 *   omitted_but_connected, deeper  -> latent
 *   everything else in the view    -> latent
 *
 * Nothing here invents a tier. Every value is either a number the engine wrote
 * into the trace, a hint the bake computed, or a direct consequence of the
 * user's own selection.
 * =============================================================================
 */

import { LOD_STATES } from '@/engine';
import type { GraphViewResponse, LayoutBake, LodState, PathStep, RenderTraceV1 } from '@/engine';

/** Sharpness order, sharpest first. Index 0 is fovea, index 4 is the bare outline. */
const RANK: Readonly<Record<LodState, number>> = Object.freeze({
  'lod-0': 0,
  'lod-1': 1,
  'lod-2': 2,
  ghost: 3,
  latent: 4,
});

/** The sharper of two tiers. Used so a rule can raise a node's resolution, never lower it by accident. */
export function sharper(a: LodState, b: LodState): LodState {
  return RANK[a] <= RANK[b] ? a : b;
}

/** The coarser of two tiers. */
export function coarser(a: LodState, b: LodState): LodState {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Runtime guard: is this string one of the five ramp states? */
export function isLodState(value: unknown): value is LodState {
  return typeof value === 'string' && (LOD_STATES as readonly string[]).includes(value);
}

/** Everything the resolution map is derived from. All of it comes from the engine. */
export interface LodInput {
  /** The rung payload about to be drawn. The map is total over `view.nodes`. */
  view: GraphViewResponse | null;
  /** The frozen layout. `NodePosition.lod_hint` is the bake's own budget suggestion. */
  bake: LayoutBake | null;
  /** The active receipt. Present iff a render has been run and not cleared. */
  trace: RenderTraceV1 | null;
  /** The answer path, so its endpoints can never fall below summary resolution. */
  path?: readonly PathStep[] | null;
  /** Nodes the user selected. A real selection is what earns the 6px render glow. */
  selection?: readonly string[];
  /** The single focused node, if any. Always drawn verbatim. */
  focus?: string | null;
}

/**
 * The resolution map for the whole visible set.
 *
 * Also carries entries for trace nodes that are NOT in the current view — an
 * answer can admit a passage while you are standing at the island rung. The
 * terrain ignores ids it does not hold, and a downstream panel that wants to
 * badge a citation with its tier gets the answer without a second derivation.
 */
export function deriveLod(input: LodInput): Record<string, LodState> {
  const { view, bake, trace } = input;
  const out: Record<string, LodState> = {};
  if (view === null) return out;

  const hints = hintIndex(bake);

  /* ---- 1. the floor: every node in the view is present, always ---------- */
  for (const node of view.nodes) {
    if (trace === null) {
      // RESTING. The rung's own bodies carry labels; everything else is drawn at
      // the resolution the bake budgeted for it. Nothing is missing, nothing is
      // shouting.
      const hint = hints.get(node.id) ?? 'latent';
      out[node.id] = node.kind === view.rung ? sharper(hint, 'lod-2') : hint;
    } else {
      // RENDERED. Anything the receipt does not mention was not spent on. It
      // stays on the map as topology at 12% — that is the whole point.
      out[node.id] = 'latent';
    }
  }

  /* ---- 2. the receipt overrides everything it names --------------------- */
  if (trace !== null) {
    // Pointers first, so an admission can always overwrite a pointer for the
    // same node rather than the other way round.
    for (const pointer of trace.omitted_but_connected) {
      out[pointer.node_id] = pointer.hop_distance <= 1 ? 'ghost' : 'latent';
    }
    for (const record of trace.admitted) {
      out[record.node_id] = isLodState(record.lod) ? record.lod : 'lod-2';
    }
    // Citations are the verbatim guarantee. A quote on screen is lod-0 by
    // definition; the trace says so too and the two must not be able to differ.
    for (const citation of trace.citations) {
      out[citation.passage_id] = 'lod-0';
    }
    // The answer path is the sentence the user reads. Its nodes are never below
    // summary resolution, or the chain renders with unlabelled links in it.
    for (const step of input.path ?? []) {
      out[step.from_id] = sharper(out[step.from_id] ?? 'latent', 'lod-1');
      out[step.to_id] = sharper(out[step.to_id] ?? 'latent', 'lod-1');
    }
  }

  /* ---- 3. what the user asked for, last ---------------------------------- */
  for (const id of input.selection ?? []) out[id] = 'lod-0';
  if (input.focus !== null && input.focus !== undefined) out[input.focus] = 'lod-0';

  return out;
}

/**
 * Node ids in the view that the map does not answer for. MUST always be empty.
 * The store calls this in dev after every recompute; the verifier asserts it.
 */
export function lodHoles(
  view: GraphViewResponse | null,
  lod: Readonly<Record<string, LodState>>,
): string[] {
  if (view === null) return [];
  const holes: string[] = [];
  for (const node of view.nodes) {
    if (!isLodState(lod[node.id])) holes.push(node.id);
  }
  return holes;
}

/** How many nodes sit at each tier. The HUD's honest one-line summary of the ramp. */
export function lodHistogram(lod: Readonly<Record<string, LodState>>): Record<LodState, number> {
  const out = { 'lod-0': 0, 'lod-1': 0, 'lod-2': 0, ghost: 0, latent: 0 } as Record<LodState, number>;
  for (const value of Object.values(lod)) {
    if (isLodState(value)) out[value] += 1;
  }
  return out;
}

/** `NodePosition.lod_hint` by node id. Empty when no bake has been fetched yet. */
function hintIndex(bake: LayoutBake | null): Map<string, LodState> {
  const map = new Map<string, LodState>();
  if (bake === null) return map;
  for (const position of bake.positions) {
    if (isLodState(position.lod_hint)) map.set(position.id, position.lod_hint);
  }
  return map;
}
