/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE HOVER NEIGHBOURHOOD
 * =============================================================================
 *
 * Pointing at a node asks the engine a real question: `GET /graph/neighborhood/
 * {id}?hops=1`. That is a request, and a pointer sweeping across 4,406 nodes
 * would fire one per node per frame, so:
 *
 *   DEBOUNCED by `--hover-request-debounce`. The pick and the card are immediate
 *   — they read fields that are already in the view payload. Only the fetch
 *   waits, and it waits for the hand to actually rest on something.
 *
 *   ABORTED on change. The in-flight request is cancelled with a real
 *   `AbortSignal`, which the engine client threads all the way into `fetch` on
 *   the HTTP transport and checks either side of the wire model on the fixture
 *   one. A cancelled request is not "ignored on arrival": it is stopped.
 *
 *   NEVER A SPINNER. Until the payload lands there is nothing to say, so nothing
 *   is said. The card shows the fields it already has and grows the neighbourhood
 *   rows when they are real. No skeleton shimmer, no fake progress.
 *
 * Every number this returns comes from the response's own `stats` or from
 * counting its own `edges` array. Nothing here is estimated.
 * ========================================================================== */

import { useEffect, useRef, useState } from 'react';

import { SIGMA_CLASSES, engine } from '@/engine';
import type { GraphViewResponse, SigmaClass } from '@/engine';
import { readTuning } from '@/interaction/tuning';

export interface HoverNeighborhood {
  /** The node this describes. Never out of step with `view`. */
  nodeId: string;
  view: GraphViewResponse;
  /** Relations touching the node, counted by σ-class. Real counts, from `edges`. */
  sigmaMix: { sigma: SigmaClass; count: number }[];
  /** Relations in the payload that the truth gate had rejected. */
  quarantined: number;
  /** Hops the closure was taken over. Stated so the counts can be read honestly. */
  hops: number;
}

const HOPS = 1;

function summarise(nodeId: string, view: GraphViewResponse): HoverNeighborhood {
  const counts = new Map<SigmaClass, number>();
  let quarantined = 0;
  for (const edge of view.edges) {
    if (edge.from_id !== nodeId && edge.to_id !== nodeId) continue;
    counts.set(edge.sigma, (counts.get(edge.sigma) ?? 0) + 1);
    if (edge.quarantined) quarantined += 1;
  }
  const sigmaMix = SIGMA_CLASSES.map((sigma) => ({ sigma, count: counts.get(sigma) ?? 0 })).filter(
    (row) => row.count > 0,
  );
  return { nodeId, view, sigmaMix, quarantined, hops: HOPS };
}

/**
 * The neighbourhood of `nodeId`, or `null` when nothing is hovered, the hand has
 * not rested yet, or the request has not landed.
 */
export function useHoverNeighborhood(nodeId: string | null): HoverNeighborhood | null {
  const [result, setResult] = useState<HoverNeighborhood | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    if (nodeId === null) {
      setResult(null);
      return;
    }
    // Keep whatever is on screen until the new one lands, unless it is stale.
    setResult((prev) => (prev !== null && prev.nodeId === nodeId ? prev : null));

    const timer = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;
      engine
        .getNeighborhood(nodeId, HOPS, { signal: controller.signal })
        .then((view) => {
          if (controller.signal.aborted) return;
          setResult(summarise(nodeId, view));
        })
        .catch(() => {
          // An aborted hover is the normal case, not a failure worth degrading
          // the whole application over. A genuine engine failure surfaces on the
          // next deliberate action, which carries a remedy the user can act on.
        });
    }, readTuning().hoverDebounceMs);

    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [nodeId]);

  return result;
}
