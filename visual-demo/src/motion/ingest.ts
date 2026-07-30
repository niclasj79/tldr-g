/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — INGEST SETTLING
 * =============================================================================
 *
 * SNOWFALL BECOMING TERRAIN.
 *
 * A corpus does not appear. It accumulates: every new node is present as
 * topology from the first frame — `latent`, in its real place — and then gains
 * resolution, region by region, from the middle of each community outward, on a
 * critically damped spring. What you watch is a world coming into focus, which
 * is exactly what an ingest is.
 *
 * Each node steps LATENT -> GHOST -> LOD-2 -> the tier the store derived for it,
 * and every one of those steps is a crossfade through the resolution ramp rather
 * than a change of value. MOTION LAW 1: resolution steps, it never pops. The
 * three steps are each one `--t-ui` wide, which is why a node's own arrival takes
 * `3 x --t-ui` of the `--ingest-settle` window — the number is derived from the
 * ramp's own crossfade, not chosen to look right.
 *
 * -----------------------------------------------------------------------------
 * NOTHING MOVES, AND THAT IS THE POINT
 * -----------------------------------------------------------------------------
 * Position is BAKED. A node has one place in this world and it is in it from the
 * first frame it exists — that is the guarantee spatial memory is built on, and
 * `scripts/check-discipline.mjs` fails the build if a read path so much as
 * mentions a force layout.
 *
 * So this settle spends its whole budget on RESOLUTION rather than on travel. A
 * node drifting into position would be depicting an arrival the engine never
 * made: the bake did not move it, and the eye would learn a trajectory that is
 * not a fact about the corpus. What the engine actually did is exactly what is
 * animated — it decided, region by region, how much of each node it could
 * afford to resolve.
 *
 * -----------------------------------------------------------------------------
 * IT IS GATED ON REAL WORK
 * -----------------------------------------------------------------------------
 * The store awaits this through `registerSettleGate`, so SETTLING lasts as long
 * as the settling does. It is not a timer the lifecycle waits out: with no
 * renderer attached this resolves immediately and SETTLING is exactly as long as
 * the data work, which is honest and shorter.
 * =============================================================================
 */

import type { LodState } from '@/engine';
import { coarser, useAtlas } from '@/state';

import { readMotionBudget } from './budget';
import { springOver } from './ease';
import { restoreStoreLod } from './lod';
import { terrainSoon } from './terrain';
import { runMotion } from './timeline';

interface Arrival {
  id: string;
  /** 0..1 — where in the settle this node's own three steps begin. */
  rank: number;
}

/**
 * Rank every arriving node by how far it sits from the CENTRE OF ITS OWN
 * COMMUNITY, normalised inside that community.
 *
 * Per community, not globally, and the difference is the whole read: ranked
 * globally, one region resolves completely before the next has started and the
 * ingest looks like a wipe. Ranked within each, every region thickens from its
 * own core outward at once — which is what a corpus of eight communities
 * materialising actually is, and it is why the hue families are legible before
 * a single label has been placed.
 */
function rankArrivals(ids: readonly string[]): Arrival[] {
  const bake = useAtlas.getState().bake;
  if (bake === null) return ids.map((id) => ({ id, rank: 0 }));

  const want = new Set(ids);
  const byCommunity = new Map<string, { id: string; x: number; y: number }[]>();
  for (const p of bake.positions) {
    if (!want.has(p.id)) continue;
    const list = byCommunity.get(p.community_id) ?? [];
    list.push({ id: p.id, x: p.x, y: p.y });
    byCommunity.set(p.community_id, list);
  }

  const out: Arrival[] = [];
  for (const list of byCommunity.values()) {
    let cx = 0;
    let cy = 0;
    for (const p of list) {
      cx += p.x;
      cy += p.y;
    }
    cx /= list.length;
    cy /= list.length;
    /* RANK, not raw distance. One outlying node in a community would otherwise
       own the last third of the settle on its own and nothing would be visible
       moving through the middle of it. */
    const ranked = [...list].sort(
      (a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2),
    );
    ranked.forEach((p, i) => {
      out.push({ id: p.id, rank: ranked.length <= 1 ? 0 : i / (ranked.length - 1) });
    });
  }

  // Anything the bake does not place yet still has to arrive; it arrives first,
  // because a node with no position is topology and topology is what latent is.
  const placed = new Set(out.map((a) => a.id));
  for (const id of ids) if (!placed.has(id)) out.push({ id, rank: 0 });
  return out;
}

/**
 * The tiers a node PASSES THROUGH on its way in, in the ramp's own order.
 *
 * It starts at `latent` — where every un-arrived node sits — and it ends at the
 * tier the store derived for it, which is not listed here because this module
 * does not get to decide it. These two are the steps in between, so a node makes
 * three ramp crossfades in total: latent -> ghost -> lod-2 -> admitted.
 */
const STEPS: readonly LodState[] = ['ghost', 'lod-2'];

/**
 * Settle the nodes an ingest just admitted, and resolve when the world has
 * stopped arriving.
 *
 * @param ids the ids the STORE says are new. Never a set this module derived.
 */
export async function settleIngest(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const terrain = await terrainSoon();
  if (terrain === null) return;

  const budget = readMotionBudget();
  const arrivals = rankArrivals(ids);
  const admitted = useAtlas.getState().lod;

  /* HOW LONG ONE NODE'S OWN ARRIVAL TAKES, as a fraction of the whole settle.
     Three ramp crossfades, each `--t-ui`. Derived, never chosen: if the ramp's
     crossfade changes, the shape of the settle follows it automatically. */
  const arrivalWindow = Math.min(
    0.9,
    ((STEPS.length + 1) * budget.uiMs) / Math.max(1, budget.ingestMs),
  );
  const duration = budget.ingestMs;
  const seconds = duration / 1000;

  const mapAt = (p: number): Record<string, LodState> => {
    const store = useAtlas.getState().lod;
    const out: Record<string, LodState> = { ...store };
    for (const a of arrivals) {
      const local = (p - a.rank * (1 - arrivalWindow)) / arrivalWindow;
      if (local >= 1) continue; // arrived: exactly the tier the store derived
      if (local <= 0) {
        out[a.id] = 'latent';
        continue;
      }
      // Three sub-steps of equal width: ghost, lod-2, and then the tier the
      // store derived. The last one lands INSIDE the window, so its crossfade is
      // finished by the time the run resolves and `settled()` lets the shutter
      // fire — a settle that ends mid-crossfade would be photographed as one.
      const step = Math.floor(local * (STEPS.length + 1));
      if (step >= STEPS.length) continue;
      /* A STEP MAY DELAY A RESOLUTION. IT MAY NOT INVENT ONE. `coarser` is the
         store's own comparator: a node the engine admitted at `ghost` is drawn
         at ghost or below on its way in, never at lod-2 for 240ms because the
         choreography wanted a step there. */
      out[a.id] = coarser(STEPS[step], admitted[a.id] ?? 'latent');
    }
    return out;
  };

  await runMotion({
    name: 'ingest',
    witness: { of: 'ingest', ids },
    durationMs: duration,
    ease: 'linear',
    onFrame: (f) => {
      /* THE SPRING IS THE SCHEDULE, NOT THE VALUE. It decides WHEN each region's
         next ring of nodes starts resolving — fast at first, decelerating into
         the last few — and it is critically damped, so nothing ever overshoots
         the tier the engine admitted.

         UNDER REDUCED MOTION THERE IS NO SCHEDULE. Every node is already where
         it is going on the first frame, and the whole ingest is the single
         `--t-fast` crossfade the ramp gives it. */
      const p = budget.reduced ? 1 : springOver(f.t, budget.ingestOmega, seconds);
      terrain.setLod(mapAt(p));
    },
    onEnd: () => {
      restoreStoreLod();
    },
  }).done;
}
