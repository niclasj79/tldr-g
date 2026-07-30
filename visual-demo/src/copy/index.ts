/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — COPY
 * =============================================================================
 *
 *   import { COPY, GLOSSARY } from '@/copy';
 *
 * `COPY` is every user-visible string in the product. `GLOSSARY` is the product's
 * vocabulary. Nothing else in `src/` is allowed to author prose: a sentence typed
 * inside a component is a sentence no reviewer will ever find, and the product
 * stops speaking with one voice the moment there are two places to write.
 *
 * -----------------------------------------------------------------------------
 * THE CODE TRANSLATORS
 * -----------------------------------------------------------------------------
 * The engine speaks in machine codes on purpose: `budget_exhausted`,
 * `confidence_below_floor`, `on_answer_path_hop_1`. Those codes are the truth and
 * the interface shows them — but a stranger reading a receipt should not have to
 * decode snake_case to learn why a quote was admitted.
 *
 * So this module ships translators. They follow three rules:
 *
 *   1. NEVER INVENT. A translator returns a sentence for a code this deck knows,
 *      and a mechanically de-underscored version of the code for one it does not.
 *      It never guesses at meaning it was not given.
 *   2. NEVER REPLACE. Callers are expected to show the machine code alongside the
 *      translation, not instead of it. The code is what you would grep for.
 *   3. NEVER APOLOGISE. There is no "unknown reason" string here. An unrecognised
 *      code still says something specific; it just says it in the engine's words.
 * =============================================================================
 */

import { COPY } from '@/copy/deck';
import { GLOSSARY, GLOSSARY_BY_TERM, glossaryFor } from '@/copy/glossary';

import type { ActionCopy, FailureCopy, GlossaryEntry, RowCopy, StateCopy, TermCopy } from '@/copy/types';
import type { Copy } from '@/copy/deck';

import type {
  DrawnReason,
  LodState,
  PassageResolution,
  QueryIntent,
  QueryMode,
  Rung,
  SigmaClass,
  VerifyResult,
} from '@/engine';

export { COPY, GLOSSARY, GLOSSARY_BY_TERM, glossaryFor };
export type { ActionCopy, Copy, FailureCopy, GlossaryEntry, RowCopy, StateCopy, TermCopy };

/* =============================================================================
 * 1. THE HONEST FALLBACK
 * ========================================================================== */

/**
 * Turn a machine code into readable words WITHOUT adding meaning.
 *
 * `budget_exhausted` -> `budget exhausted`. That is the entire transformation:
 * underscores become spaces and a leading structural underscore is kept as a
 * marker, because `_follows` and `follows` are different things and collapsing
 * them would be a small lie told very often.
 */
export function humaniseCode(code: string): string {
  if (code.startsWith('_')) return `_${code.slice(1).replace(/_/g, ' ')}`;
  return code.replace(/_/g, ' ');
}

/* =============================================================================
 * 2. TYPED ACCESSORS
 * -----------------------------------------------------------------------------
 * Thin, but they stop a component from indexing the deck with a loose string and
 * shipping `undefined` into the DOM.
 * ========================================================================== */

export const lodCopy = (lod: LodState): TermCopy => COPY.ramp.states[lod];
export const sigmaCopy = (sigma: SigmaClass): TermCopy => COPY.sigma.classes[sigma];
export const rungCopy = (rung: Rung): Copy['rungs']['levels'][Rung] => COPY.rungs.levels[rung];
export const intentCopy = (intent: QueryIntent): TermCopy => COPY.intents[intent];
export const modeCopy = (mode: QueryMode): TermCopy => COPY.modes[mode];
export const resolutionCopy = (r: PassageResolution): TermCopy => COPY.trust.disclosure.levels[r];
export const drawnReasonCopy = (r: DrawnReason): TermCopy => COPY.analyst.edgePolicy.reasons[r];

/* =============================================================================
 * 3. FAILURES
 * ========================================================================== */

/**
 * The human headline for a degraded state.
 *
 * The engine's own `what_failed` and `exact_remedy` are rendered underneath this
 * and are NOT restated here — a second copy of a sentence is a second copy that
 * can drift out of step with the first.
 */
export function degradedCopy(code: string): FailureCopy {
  const known = (COPY.degraded.byCode as Record<string, FailureCopy>)[code];
  return known ?? COPY.degraded.unknown;
}

/** True when this build has a headline for the code. Useful for a `title` fallback. */
export function knowsFailure(code: string): boolean {
  return code in COPY.degraded.byCode;
}

/* =============================================================================
 * 4. THE TRUTH GATE
 * ========================================================================== */

/**
 * The human reading of a quarantine reason.
 *
 * Unrecognised codes come back as themselves, de-underscored, with the honest
 * `short` the gate can always promise: it was rejected, and this is what it was
 * rejected for.
 */
export function quarantineReasonCopy(reason: string): TermCopy {
  const known = (COPY.quarantine.reasons as Record<string, TermCopy>)[reason];
  if (known !== undefined) return known;
  const words = humaniseCode(reason);
  return {
    label: words,
    short: `Rejected by the truth gate: ${words}.`,
    long: `The gate rejected this claim under the code \`${reason}\`. This build has no longer explanation for that code; the code itself is the engine's word for what happened.`,
  };
}

/* =============================================================================
 * 5. RECEIPT REASON CODES
 * -----------------------------------------------------------------------------
 * `why_admitted`, `AdmissionRecord.reason` and `Pointer.why_omitted` are open
 * vocabularies — the engine mints hop-indexed codes at render time. These
 * translators handle the shapes this build produces and de-underscore the rest.
 * ========================================================================== */

/** `on_answer_path_hop_2` -> the hop index, or `null` when the code carries none. */
function hopIndex(code: string, prefix: string): number | null {
  if (!code.startsWith(prefix)) return null;
  const digits = /^(\d+)/.exec(code.slice(prefix.length));
  return digits === null ? null : Number(digits[1]);
}

/** Why a quote was admitted to the render. */
export function citationReasonText(code: string): string {
  const onPath = hopIndex(code, 'on_answer_path_hop_');
  if (onPath !== null) return `Evidence for hop ${onPath + 1} of the answer path`;

  const evidences = hopIndex(code, 'evidences_hop_');
  if (evidences !== null) {
    const family = code.slice(`evidences_hop_${evidences}_`.length);
    return family.length > 0
      ? `Evidence for hop ${evidences + 1}, the ${humaniseCode(family)} relation`
      : `Evidence for hop ${evidences + 1}`;
  }

  const corroborates = hopIndex(code, 'corroborates_hop_');
  if (corroborates !== null) {
    return `A second, independent source for hop ${corroborates + 1}`;
  }

  switch (code) {
    case 'resolves_coreference_on_bridge_entity':
      return 'Names the bridge entity a pronoun elsewhere refers to';
    case 'boundary_declaration':
      return 'The document’s own opening span, where it declares what it is';
    case 'mentions_focus_entity':
      return 'Names the entity the question is about';
    default:
      return humaniseCode(code);
  }
}

/** Why a node was admitted to the rendered context. */
export function admissionReasonText(code: string): string {
  switch (code) {
    case 'on_answer_path':
      return 'On the answer path';
    case 'bridge_neighbor':
      return 'Neighbour of a bridge entity';
    case 'constellation_neighbor':
      return 'Neighbour inside the constellation';
    default:
      return humaniseCode(code);
  }
}

/** Why a connected node was left out. The vocabulary of the honesty mechanism. */
export function omissionReasonText(code: string): string {
  switch (code) {
    case 'budget_exhausted':
      return 'The budget ran out before it';
    case 'below_threshold':
      return 'Scored below the admission threshold';
    case 'structural_link_only':
      return 'Reachable only through a structural link';
    case 'reached_only_through_quarantined_edge':
      return 'Reachable only through a rejected claim';
    default:
      return humaniseCode(code);
  }
}

/* =============================================================================
 * 6. VERIFICATION
 * ========================================================================== */

/**
 * The badge and prose for a verification result.
 *
 * BOTH HALVES ARE READ. Collapsing `valid` into one message would throw away the
 * distinction the verifier exists to make: a mutated quote breaks the payload
 * hash while the signature still verifies, and a mutated signature does the
 * opposite. Which half failed is the diagnosis.
 */
export function verifyCopy(
  result: Pick<VerifyResult, 'valid' | 'payload_hash_matches' | 'signature_valid'> | null,
): { badge: string; title: string; body: string } {
  if (result === null) return COPY.trust.verify.unchecked;
  if (result.valid) return COPY.trust.verify.valid;
  if (!result.signature_valid) return COPY.trust.verify.invalidSignature;
  return COPY.trust.verify.invalidPayload;
}
