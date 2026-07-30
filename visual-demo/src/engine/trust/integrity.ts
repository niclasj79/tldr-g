/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE TRUTH GATE'S REPORT CARD
 * =============================================================================
 *
 * `GET /integrity`. Real counts over the real edge set: what the extractor
 * produced, what the gate admitted, what it rejected and why, and how many edges
 * were never gated at all because the structural sigma-class is exempt.
 *
 * This ships in the UI because AN ENGINE THAT ONLY REPORTS ITS SUCCESSES IS NOT
 * AN INSTRUMENT, IT IS AN ADVERTISEMENT. The quarantined edges are not deleted;
 * they stay in the payload and render `latent`, so a user can go and look at
 * exactly what was thrown away and disagree with it. `example_edge_ids` exists
 * so that looking is one click, not a database query.
 *
 * THE EXEMPTION IS REPORTED SEPARATELY, ON PURPOSE. Roughly half of this
 * corpus's edges are the underscore-prefixed reading-order skeleton, and they
 * are exempt from the gate because they describe the artifact rather than the
 * world — `_follows` says "this passage came after that one", which is a fact
 * about a file, not a claim to be verified. Folding them into the admitted count
 * would advertise a pass rate that was never earned. So: admitted counts them,
 * because they are in the graph; `truth_gate_exempt_structural` says how many of
 * them there were, so the reader can compute the honest denominator
 * (`total_edges - truth_gate_exempt_structural`) themselves.
 * =============================================================================
 */

import { CORPUS_PROVENANCE, isStructural } from '@/engine/types';
import type { Edge, IntegrityReason, IntegrityResponse } from '@/engine/types';

/**
 * The only thing `computeIntegrity()` needs. Typed structurally rather than as
 * the corpus's `World` so the trust layer never has to be rebuilt when the
 * generator changes shape — a `World` satisfies this, and so does a live
 * engine's edge page.
 */
export interface EdgeSource {
  readonly edges: readonly Edge[];
}

export interface IntegrityOptions {
  /** How many example edge ids to carry per reason. Enough to click into, not a dump. */
  readonly examples_per_reason?: number;
}

const DEFAULT_EXAMPLES_PER_REASON = 4;

/**
 * Count the truth gate's work.
 *
 * Every number returned is counted from `world.edges` at call time. Nothing is
 * cached, nothing is asserted, and the reasons are whatever the extractor
 * actually wrote into `Edge.quarantine_reason` — this function never invents a
 * category or maps an unfamiliar reason onto a tidier one.
 *
 * Two contract violations are reported to the console rather than silently
 * absorbed, because both of them mean the payload is lying about itself:
 *   - a structural edge that was quarantined (the class is exempt: gating it
 *     would disconnect the terrain's own skeleton), and
 *   - a quarantine flag and a quarantine reason that disagree.
 */
export function computeIntegrity(world: EdgeSource, options: IntegrityOptions = {}): IntegrityResponse {
  const limit = options.examples_per_reason ?? DEFAULT_EXAMPLES_PER_REASON;

  let quarantined = 0;
  let truth_gate_exempt_structural = 0;
  const reasons = new Map<string, { count: number; examples: string[] }>();

  const structuralButQuarantined: string[] = [];
  const inconsistent: string[] = [];

  for (const edge of world.edges) {
    if (isStructural(edge.family)) truth_gate_exempt_structural++;

    if (edge.quarantined) {
      quarantined++;
      if (isStructural(edge.family)) structuralButQuarantined.push(edge.id);

      const reason = edge.quarantine_reason;
      if (reason === null || reason.length === 0) {
        inconsistent.push(`${edge.id} is quarantined with no reason`);
        continue;
      }
      const bucket = reasons.get(reason) ?? { count: 0, examples: [] };
      bucket.count++;
      if (bucket.examples.length < limit) bucket.examples.push(edge.id);
      reasons.set(reason, bucket);
    } else if (edge.quarantine_reason !== null) {
      inconsistent.push(`${edge.id} carries a quarantine reason but was admitted`);
    }
  }

  if (structuralButQuarantined.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[trust/integrity] ${structuralButQuarantined.length} structural edge(s) are quarantined, ` +
        `but the structural sigma-class is EXEMPT from the truth gate. Quarantining the ` +
        `reading-order fiber disconnects the terrain. First: ${structuralButQuarantined.slice(0, 5).join(', ')}`,
    );
  }
  if (inconsistent.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[trust/integrity] ${inconsistent.length} edge(s) disagree with their own quarantine flag: ` +
        inconsistent.slice(0, 5).join('; '),
    );
  }

  const by_reason: IntegrityReason[] = [...reasons.entries()]
    .map(([reason, bucket]) => ({
      reason,
      count: bucket.count,
      example_edge_ids: bucket.examples,
    }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));

  const total_edges = world.edges.length;

  return {
    total_edges,
    admitted: total_edges - quarantined,
    quarantined,
    by_reason,
    truth_gate_exempt_structural,
    corpus_provenance: CORPUS_PROVENANCE,
  };
}

/**
 * The honest denominator: edges that were actually subject to the gate, and the
 * share of them that failed it.
 *
 * `IntegrityResponse` has no field for this because it is derivable, and the
 * contract does not carry derivable numbers. It is derived HERE, once, so that
 * two panels cannot disagree about what "quarantine rate" means.
 */
export function truthGatedRate(report: IntegrityResponse): { gated: number; rate: number } {
  const gated = report.total_edges - report.truth_gate_exempt_structural;
  return { gated, rate: gated === 0 ? 0 : report.quarantined / gated };
}
