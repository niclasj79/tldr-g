/**
 * =============================================================================
 * THE TRACE PING — provenance watched happening
 * =============================================================================
 *
 * Clicking a citation does not open a drawer that reports where the quote came
 * from. It sends a luminous dot down the citation edge, from the node on the
 * answer path to the passage that evidences it, leaving a 1px --evidence
 * hairline behind. Then the map goes there.
 *
 * That is not decoration and it is not a flourish over a fetch. The dot travels
 * between two REAL node ids on a REAL edge that the receipt already names — the
 * path step's endpoint and the passage in its `evidence_passage_ids`. If the
 * terrain cannot find those nodes, nothing is drawn: this module never invents a
 * journey to have something to animate.
 *
 * -----------------------------------------------------------------------------
 * THE SEAM
 * -----------------------------------------------------------------------------
 * `src/ui/provenance/**` does not own the renderer, and a trust panel that
 * cannot be rendered without a WebGL context is a trust panel nobody can test.
 * So the terrain is reached through a resolver:
 *
 *   1. an override installed by `setTracePing()` — used by the harness, which
 *      records every ping instead of drawing it, and by any host that wants to
 *      drive its own renderer;
 *   2. otherwise `getTerrain()` from `@/graph`, imported DYNAMICALLY so that
 *      importing a receipt panel does not pull three.js into the module graph;
 *   3. otherwise nothing. `firePings` reports `fired: 0` and the caller shows
 *      the truth — the terrain is not attached — rather than a silent no-op that
 *      looks like a working feature.
 *
 * -----------------------------------------------------------------------------
 * THE TIMINGS ARE TOKENS, NOT NUMBERS
 * -----------------------------------------------------------------------------
 * The ping runs for `--t-ui` and consecutive pings are offset by a third of it.
 * Both are read from the stylesheet through `readTokens()` at call time, so
 * `prefers-reduced-motion` shortens them with everything else and no duration is
 * restated in TypeScript.
 * =============================================================================
 */

import { readTokens } from '@/styles/tokens';
import type { Citation, PathStep } from '@/engine';

/** The renderer method this module needs, and nothing more of the renderer. */
export type TracePingFn = (fromId: string, toId: string, delayMs?: number) => Promise<void>;

let override: TracePingFn | null = null;

/**
 * Install a ping implementation, or clear it with `null`.
 *
 * The harness installs a recorder here so that "did the citation actually fire a
 * ping, and between which two ids" is an assertion rather than an impression.
 */
export function setTracePing(fn: TracePingFn | null): void {
  override = fn;
}

/** True when an override is installed. Distinct from "a terrain exists". */
export function hasTracePingOverride(): boolean {
  return override !== null;
}

/**
 * Resolve the ping function: the override, else the live terrain, else `null`.
 *
 * The `@/graph` import is dynamic on purpose — see the header. A failure to load
 * it is not an error to surface: it means the renderer is not part of this page,
 * which is a legitimate configuration (the trust harness is exactly that).
 */
export async function resolveTracePing(): Promise<TracePingFn | null> {
  if (override !== null) return override;
  try {
    const graph = await import('@/graph');
    const terrain = graph.getTerrain();
    if (terrain === null) return null;
    return (fromId, toId, delayMs) => terrain.tracePing(fromId, toId, delayMs);
  } catch {
    return null;
  }
}

/** Offset between consecutive pings: one third of `--t-ui`. Read, never typed. */
export function pingStaggerMs(): number {
  return Math.round(readTokens().ms.ui / 3);
}

/** One dot's journey: two real node ids the receipt already relates. */
export interface PingEdge {
  /** The node on the answer path — where the claim is made. */
  from_id: string;
  /** The passage that evidences it — where the claim comes from. */
  to_id: string;
}

/**
 * `why_admitted` code whose own wording names the edge the dot may travel.
 *
 * A citation admitted to resolve a coreference ON THE BRIDGE ENTITY is, by the
 * code's own statement, evidence about that entity — so the bridge entity is a
 * real endpoint for it, not a guess. This is the ONLY code that earns a
 * fallback: for anything else, an uncited passage gets no dot.
 */
const BRIDGE_CODE = 'resolves_coreference_on_bridge_entity';

/**
 * The citation edges for one quote: every hop of the answer path that names this
 * passage as its evidence.
 *
 * Returns `[]` when no hop cites it and no fallback applies. That happens — a
 * citation admitted as `mentions_focus_entity` evidences the subject rather than
 * a hop — and the caller must treat an empty list as "there is no edge to
 * travel", not as a reason to point the dot somewhere plausible.
 *
 * @param bridgeEntityId the constellation's bridge entity, used ONLY for the one
 *        `why_admitted` code that names it. Pass `null` to disable the fallback.
 */
export function citationEdges(
  citation: Citation,
  path: readonly PathStep[],
  bridgeEntityId: string | null = null,
): PingEdge[] {
  const edges: PingEdge[] = [];
  for (const step of path) {
    if (!step.evidence_passage_ids.includes(citation.passage_id)) continue;
    /* The dot leaves the hop's SUBJECT. Either endpoint is on the answer path,
       but the subject is what the sentence is about — and on the hop that
       produces the answer (`Rimsdal Group acquired Tollstrand Battery`) the
       subject is the answer itself, so the dot leaves the answer and lands on
       the bytes. That is the reading of "from answer to source" that survives
       being looked at. */
    edges.push({ from_id: step.from_id, to_id: citation.passage_id });
  }
  if (edges.length === 0 && bridgeEntityId !== null && citation.why_admitted === BRIDGE_CODE) {
    edges.push({ from_id: bridgeEntityId, to_id: citation.passage_id });
  }
  return edges;
}

/** What actually happened, so the interface can say it rather than assume it. */
export interface PingResult {
  /** Pings the renderer accepted. `0` means the terrain was not attached. */
  fired: number;
  /** Edges that were asked for. `fired < requested` only when there is no renderer. */
  requested: number;
  /** True when a ping function was resolved at all. */
  attached: boolean;
}

/**
 * Fire a staggered volley and resolve when the last dot lands.
 *
 * Every ping is awaited, so the caller's "in flight" state ends when the motion
 * ends rather than after a duration somebody typed. A renderer that rejects one
 * ping (an id that is not in the current view is the ordinary case) does not
 * abort the volley — the others are still real.
 */
export async function firePings(edges: readonly PingEdge[]): Promise<PingResult> {
  const ping = await resolveTracePing();
  if (ping === null) return { fired: 0, requested: edges.length, attached: false };

  const stagger = pingStaggerMs();
  const flights = edges.map((edge, i) =>
    ping(edge.from_id, edge.to_id, i * stagger).catch(() => undefined),
  );
  await Promise.all(flights);
  return { fired: edges.length, requested: edges.length, attached: true };
}
