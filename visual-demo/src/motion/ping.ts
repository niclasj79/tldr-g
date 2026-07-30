/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE TRACE PING
 * =============================================================================
 *
 * PROVENANCE IS WATCHED HAPPENING.
 *
 * Clicking a citation does not open a drawer that reports where the quote came
 * from. A luminous dot leaves the node where the claim is made and travels the
 * citation edge to the passage that evidences it, in 240ms, leaving a 1px
 * --evidence hairline behind it; the source gains an evidence ring as the dot
 * lands. Several citations at once fire 80ms apart, so a volley reads as a
 * sequence of separate claims rather than as a burst.
 *
 * Every one of those numbers is a token: the travel is `--t-ui` and the stagger
 * is a third of it. Nothing here is typed as a millisecond.
 *
 * -----------------------------------------------------------------------------
 * IT CANNOT PING WHAT THE RECEIPT DOES NOT SAY
 * -----------------------------------------------------------------------------
 * The edges are computed by `@/ui/provenance` from the receipt's own citations
 * and the answer path's `evidence_passage_ids`, and they are passed in. This
 * module never derives a journey to have something to animate: an empty edge
 * list fires nothing, reports `fired: 0`, and the caller says so.
 *
 * The witness goes further — the run declares the `trace_id` and the passage it
 * is travelling to, and `checkWitness` fails it if the store's receipt does not
 * cite that passage. A dot that travels to a source the receipt never named is
 * exactly the failure this product exists to make impossible, so it is a
 * measured violation rather than a code-review item.
 *
 * -----------------------------------------------------------------------------
 * THE MARKS ARE HELD, THEN LET GO
 * -----------------------------------------------------------------------------
 * The hairline is evidence, not a flourish, so it stays after the dot lands —
 * for one `--t-scene`, tracking the camera, and then it fades. It is also
 * cancelled outright the moment the place changes, which is what opening the
 * cited passage does. Nothing in this product leaves a mark pointing at
 * something that has left the frame.
 * =============================================================================
 */

import { useAtlas } from '@/state';

import { readMotionBudget } from './budget';
import { bakedPoint, clearTraceMarks, drawTraceMark } from './overlay';
import { terrainSoon } from './terrain';
import { cancelMotion, runMotion } from './timeline';

/** One dot's journey: two real node ids the receipt already relates. */
export interface PingEdge {
  /** The node on the answer path — where the claim is made. */
  from_id: string;
  /** The passage that evidences it — where the claim comes from. */
  to_id: string;
}

/** What actually happened, so the interface can state it rather than assume it. */
export interface PingRun {
  /** Dots the renderer accepted. `0` means the terrain is not attached. */
  fired: number;
  /** Edges that were asked for. */
  requested: number;
  /** True when a renderer was resolved at all. */
  attached: boolean;
  /** MEASURED ms from the first dot leaving to the last one landing. */
  ms: number;
}

/** Offset between consecutive dots: one third of `--t-ui`. Read, never typed. */
export function pingStaggerMs(): number {
  const budget = readMotionBudget();
  return budget.reduced ? 0 : Math.round(budget.uiMs / 3);
}

/**
 * Fire a staggered volley and resolve WHEN THE LAST DOT LANDS.
 *
 * The returned promise deliberately does not wait for the hairline's hold: the
 * caller's next act is usually to open the cited passage, and making a person
 * wait 700ms to see the bytes so that a mark can finish being looked at would be
 * the animation running the product.
 *
 * @param traceId  the receipt the citation came from — the witness.
 */
export async function firePingVolley(
  edges: readonly PingEdge[],
  traceId: string,
): Promise<PingRun> {
  const requested = edges.length;
  if (requested === 0) return { fired: 0, requested: 0, attached: false, ms: 0 };

  const terrain = await terrainSoon();
  if (terrain === null) return { fired: 0, requested, attached: false, ms: 0 };

  const budget = readMotionBudget();
  const travel = budget.reduced ? budget.fastMs : budget.uiMs;
  const stagger = pingStaggerMs();
  const flight = stagger * (requested - 1) + travel;
  /* THE HOLD IS PART OF THE SAME RUN. A mark left on screen by a run that has
     ended is an animation with no end, which is the definition of decorative
     motion here — and `audit()` would be right to report it. */
  const hold = budget.reduced ? 0 : budget.sceneMs;

  const points = edges.map((e) => ({
    from: bakedPoint(e.from_id),
    to: bakedPoint(e.to_id),
  }));

  // The renderer's own comet, one per edge, on the same stagger. Not awaited
  // here: the run below is the clock, and awaiting two clocks is having two.
  let fired = 0;
  for (let i = 0; i < edges.length; i++) {
    void terrain.tracePing(edges[i].from_id, edges[i].to_id, i * stagger).catch(() => undefined);
    fired++;
  }

  let landed: (ms: number) => void = () => {};
  const arrival = new Promise<number>((resolve) => {
    landed = resolve;
  });
  /**
   * THE LANDING IS RESOLVED ONE FRAME LATE, ON PURPOSE.
   *
   * The caller's next act is to open the cited passage, which is a place change,
   * which cancels this run and clears its marks. Resolving on the frame the dot
   * arrives means the terminal state — full hairline, full ring — is written to
   * the DOM and then removed before the compositor ever presents it: the ring
   * was measured peaking at 0.41 of its opacity, i.e. the source was never seen
   * to gain it. Waiting one frame costs 16ms and is the difference between an
   * animation that happened and one that only ran.
   */
  let arrived = false;

  runMotion({
    name: 'trace',
    witness: { of: 'trace', traceId, passageId: edges[0].to_id },
    durationMs: flight + hold,
    ease: 'linear',
    onFrame: (f) => {
      const fade =
        hold <= 0 || f.elapsedMs <= flight
          ? 1
          : Math.max(0, 1 - (f.elapsedMs - flight) / Math.max(1, budget.uiMs));
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p.from === null || p.to === null) continue;
        const t = Math.min(1, Math.max(0, (f.elapsedMs - i * stagger) / Math.max(1, travel)));
        // The ring comes up as the dot arrives, over the last fifth of its
        // travel, so the landing and the mark are one event rather than two.
        const ringUp = Math.min(1, Math.max(0, (t - 0.8) / 0.2));
        drawTraceMark(i, p.from, p.to, t, ringUp, fade);
      }
      if (arrived) landed(Math.round(f.elapsedMs));
      if (f.elapsedMs >= flight) arrived = true;
      if (f.last) landed(Math.round(f.elapsedMs));
    },
    onEnd: () => {
      clearTraceMarks();
      landed(flight);
    },
  });

  const ms = await arrival;
  return { fired, requested, attached: true, ms };
}

/**
 * Cancel any live trace when the place changes.
 *
 * Installed once by the shell. Opening the cited passage IS a place change, so
 * this is the wire that guarantees a hairline never survives into the view it
 * was drawn to send you to.
 */
export function installTraceCleanup(): () => void {
  return useAtlas.subscribe((state, prev) => {
    const moved =
      state.rung !== prev.rung ||
      state.stack.length !== prev.stack.length ||
      (state.trace?.trace_id ?? null) !== (prev.trace?.trace_id ?? null);
    if (moved) cancelMotion('trace');
  });
}
