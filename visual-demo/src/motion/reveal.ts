/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE RENDER REVEAL
 * =============================================================================
 *
 * An answer does not appear. It LANDS, in three tiers, in two places at once.
 *
 *   t+0     FOVEA       the answer sentence, and the passages carried verbatim
 *   t+120   PENUMBRA    the confidence composite, the chain of hops, lod-1
 *   t+240   PERIPHERY   the re-derivation, the context, lod-2
 *
 * Each tier fades up over `--t-ui`, so the whole arrival is 480ms and the last
 * thing to land is the least attended thing on screen. That order is not a
 * flourish: it is the resolution ramp itself, read as a sequence, and it tells
 * the reader what the engine spent on before they have read a word of it.
 *
 * -----------------------------------------------------------------------------
 * ONE TIMELINE DRIVES THE TEXT AND THE MAP. THIS IS THE WHOLE POINT.
 * -----------------------------------------------------------------------------
 * The rail and the terrain are not two animations that were given similar
 * numbers. They are one run on one clock: the same `stage` that reveals the
 * answer sentence in the panel is the `stage` that lights the fovea on the map,
 * written on the same frame from the same callback. A reader watching either one
 * is watching the same render arrive, and looking from one to the other costs
 * them nothing — which is the entire argument for a spatial interface over a
 * chat log.
 *
 * Two timelines "that happen to be similar" would drift by a frame on the first
 * slow tick and never re-converge, and the product would quietly stop making
 * that argument.
 *
 * -----------------------------------------------------------------------------
 * WHAT LIGHTS, AND WHAT IS LEFT ALONE
 * -----------------------------------------------------------------------------
 * ONLY WHAT THE RENDER RAISED. A node whose tier the render did not improve is
 * not touched — it keeps exactly the resolution it already had, at exactly the
 * moment it already had it. Dropping the whole world to `latent` and blooming it
 * back would be a beautiful lie: the engine did not un-spend on the terrain in
 * order to answer a question about three nodes of it.
 *
 * So the arriving set is computed by comparing the store's resolution map BEFORE
 * the render with the one derived from the trace AFTER it, and only the nodes
 * that got sharper are held back — each at the tier it already had, never below
 * it — until its own tier lands. The stagger changes WHEN a node reaches its
 * resolution. It never changes WHICH resolution it reaches.
 * =============================================================================
 */

import type { LodState } from '@/engine';
import { useAtlas } from '@/state';

import { readMotionBudget } from './budget';
import { restoreStoreLod, tierOf } from './lod';
import { terrainNow } from './terrain';
import { isRunning, runMotion } from './timeline';

/** The three tiers, in the ramp's own order. */
const TIERS = 3;

/** True while a render is landing. The shell stands off the resolution map. */
export function isRevealing(): boolean {
  return isRunning('reveal');
}

/** The DOM attribute the panels' CSS keys off. Removed the moment the run ends. */
const ATTR = 'data-reveal';

function setStage(stage: number | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (stage === null) root.removeAttribute(ATTR);
  else root.setAttribute(ATTR, String(stage));
}

/**
 * Start the reveal for a render that has just committed.
 *
 * `before` is the resolution map the store held BEFORE the render. It is passed
 * in rather than re-derived because by the time this runs the store already
 * holds the new one, and the difference between the two IS the arriving set.
 */
export function startRenderReveal(
  queryId: string,
  before: Readonly<Record<string, LodState>>,
): void {
  const budget = readMotionBudget();
  const after = useAtlas.getState().lod;

  /* WHAT THE RENDER RAISED, and the tier it raised it from. A node absent from
     `before` was not in the store's map at all: the terrain was drawing it from
     its own ambient policy, so the honest hold is to leave it out of the
     override entirely until its tier lands, rather than to assert a tier for it
     that nobody derived. */
  const holds = new Map<string, LodState | null>();
  const wave = new Map<string, number>();
  for (const [id, next] of Object.entries(after)) {
    const prior = before[id];
    const tier = tierOf(next);
    if (prior !== undefined && tierOf(prior) <= tier) continue; // not raised
    holds.set(id, prior ?? null);
    wave.set(id, tier);
  }

  const mapFor = (stage: number): Record<string, LodState> => {
    const out: Record<string, LodState> = { ...useAtlas.getState().lod };
    for (const [id, held] of holds) {
      if ((wave.get(id) ?? 0) <= stage) continue; // landed: the store's own tier
      if (held === null) delete out[id];
      else out[id] = held;
    }
    return out;
  };

  runMotion({
    name: 'reveal',
    witness: { of: 'render', queryId },
    // The last tier STARTS at 2 * step and still has a full --t-ui to fade up in.
    // A run that ended when the last attribute changed would report 240ms for an
    // animation the eye watches for 480.
    durationMs: budget.stepMs * (TIERS - 1) + budget.uiMs,
    steps: TIERS,
    stepMs: budget.stepMs,
    ease: '--ease-ui',
    onFrame: (f) => {
      /* UNDER REDUCED MOTION THERE IS ONE STEP AND IT IS THE LAST ONE. The
         render still lands and it still lands in both places; what is removed is
         the sequence, not the arrival. Collapsing to stage 0 would reveal the
         fovea and silently withhold the other two thirds of the answer. */
      const stage = f.steps <= 1 ? TIERS - 1 : f.stage;
      setStage(stage);
      /* ONE WRITER ON THE RAMP AT A TIME. A rung change owns the resolution map
         for its whole choreography — it is re-asserting a fovea-outward map
         every frame — and a render that lands mid-descent must not fight it for
         the buffer. The TEXT still reveals: the rail is nobody else's. */
      if (!isRunning('descent')) terrainNow()?.setLod(mapFor(stage));
    },
    onEnd: () => {
      setStage(null);
      // Only if it is ours to give back. See the guard in `onFrame`.
      if (!isRunning('descent')) restoreStoreLod();
    },
  });
}

/**
 * Choreograph every render this session lands, whoever asked for it.
 *
 * A store subscription rather than a component effect, for the same reason the
 * descent's choreography is one: the command bar, a restored share link, the
 * scene driver and a staged-question chip all call `runQuery` directly, and a
 * reveal that only fired when one particular panel happened to be mounted would
 * be a property of the rail rather than of the render.
 *
 * Installed once, by the shell. Returns the unsubscribe.
 */
export function installRenderReveal(): () => void {
  return useAtlas.subscribe((state, prev) => {
    const id = state.query.active?.query_id ?? null;
    if (id === null || id === (prev.query.active?.query_id ?? null)) return;
    startRenderReveal(id, prev.lod);
  });
}
