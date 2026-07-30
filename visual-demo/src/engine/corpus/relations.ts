/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — RELATION VOCABULARY ACCESS LAYER
 * =============================================================================
 *
 * The vocabulary itself is declared, frozen and inverse-checked in
 * `@/engine/types`. THAT FILE IS AUTHORITATIVE. Nothing here redeclares a
 * family token, a sigma-class, an inverse or a truth-gate flag — this module
 * only indexes what the contract already froze and adds the deterministic
 * pickers the corpus generator needs.
 *
 * If you find yourself typing a relation family as a string literal in a
 * generator, import it from here instead: the union is derived from the table,
 * so a typo is a compile error rather than an edge nobody can traverse.
 * =============================================================================
 */

import {
  RELATION_FAMILIES,
  SIGMA_CLASSES,
  assertInverseConsistency,
  byFamily,
  isStructural,
  isTruthGated,
} from '@/engine/types';
import type { RelationFamily, RelationFamilyDef, SigmaClass } from '@/engine/types';

/* Re-exported unchanged so a generator never has to reach past this module.
   These are the SAME bindings — not copies, not widenings. */
export {
  RELATION_FAMILIES,
  SIGMA_CLASSES,
  assertInverseConsistency,
  byFamily,
  isStructural,
  isTruthGated,
};
export type { RelationFamily, RelationFamilyDef, SigmaClass };

/* =============================================================================
 * 1. INDEXES
 * ========================================================================== */

/**
 * The five TRUTH-GATED sigma-classes, in declaration order. `structural` is
 * excluded by the same predicate the gate uses, so this list can never drift
 * from the policy: a class is semantic iff its families are truth-gated.
 */
export const SEMANTIC_SIGMA_CLASSES: readonly SigmaClass[] = Object.freeze(
  SIGMA_CLASSES.filter((s) => s !== 'structural'),
);

/** Every family token, grouped by sigma-class. Frozen; index, do not mutate. */
export const FAMILIES_BY_SIGMA: Readonly<Record<SigmaClass, readonly RelationFamily[]>> =
  Object.freeze(
    SIGMA_CLASSES.reduce(
      (acc, sigma) => {
        acc[sigma] = Object.freeze(
          RELATION_FAMILIES.filter((d) => d.sigma === sigma).map((d) => d.family),
        );
        return acc;
      },
      {} as Record<SigmaClass, readonly RelationFamily[]>,
    ),
  );

/** The seven underscore-prefixed structural tokens. Truth-gate exempt. */
export const STRUCTURAL_FAMILIES: readonly RelationFamily[] = FAMILIES_BY_SIGMA.structural;

/** Every semantic (truth-gated) family token, in declaration order. */
export const SEMANTIC_FAMILIES: readonly RelationFamily[] = Object.freeze(
  RELATION_FAMILIES.filter((d) => d.truthGated).map((d) => d.family),
);

/* =============================================================================
 * 2. LOOKUPS
 * ========================================================================== */

/** The sigma-class of a family. Denormalised onto every `Edge` by the generator. */
export function sigmaOf(family: RelationFamily): SigmaClass {
  return byFamily[family].sigma;
}

/** The family you get by reversing the edge, or `null` when reversal is meaningless. */
export function inverseOf(family: RelationFamily): RelationFamily | null {
  return byFamily[family].inverse;
}

/** The human label for legends, edge tooltips and the path readout. Lowercase. */
export function labelOf(family: RelationFamily): string {
  return byFamily[family].label;
}

/** True when the family names itself as its own inverse (`same_as`, `_co_doc`, ...). */
export function isSelfInverse(family: RelationFamily): boolean {
  return byFamily[family].inverse === family;
}

/* =============================================================================
 * 3. DETERMINISTIC PICKERS
 * -----------------------------------------------------------------------------
 * `rng` is always a seeded stream supplied by the caller. Nothing in this file
 * calls Math.random(); a corpus that is not byte-identical between two runs
 * makes every content hash and every signature downstream meaningless.
 * ========================================================================== */

/** Uniformly pick one family from a sigma-class. */
export function pickFamily(rng: () => number, sigma: SigmaClass): RelationFamily {
  const pool = FAMILIES_BY_SIGMA[sigma];
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/**
 * Pick a sigma-class by weight. The generator leans factual because a real
 * infrastructure corpus is mostly statements about what is where and who owns
 * it, but every class has to stay well above noise or the sigma legend is
 * decoration.
 */
export function pickSigma(
  rng: () => number,
  weights: Readonly<Partial<Record<SigmaClass, number>>>,
): SigmaClass {
  let total = 0;
  for (const s of SIGMA_CLASSES) total += weights[s] ?? 0;
  let r = rng() * total;
  for (const s of SIGMA_CLASSES) {
    r -= weights[s] ?? 0;
    if (r <= 0) return s;
  }
  return 'factual';
}

/* =============================================================================
 * 4. THE TRUTH GATE'S VOCABULARY
 * -----------------------------------------------------------------------------
 * A quarantine reason is a machine code, never a sentence. `/integrity` groups
 * by these, and the UI turns each group into something the user can click
 * through to and go LOOK at. A generic string here would make the integrity
 * panel an apology instead of an instrument.
 * ========================================================================== */

/** The fixed enum of gate rejections this corpus can produce. */
export const QUARANTINE_REASONS = Object.freeze([
  /** The extractor's character span did not resolve inside the cited source. */
  'span_not_in_source',
  /** An endpoint could not be reconciled to a known entity. */
  'entity_not_grounded',
  /** A higher-confidence edge asserts the inverse of this one. */
  'inverse_conflict',
  /** The asserted ordering contradicts the declared boundary dates. */
  'temporal_paradox',
  /** Extraction confidence fell below `CONFIDENCE_FLOOR`. */
  'confidence_below_floor',
  /** The same subject/family was asserted twice with different objects. */
  'duplicate_assertion_divergent_object',
  /** The source hash on file differs from the hash of the bytes cited. */
  'source_hash_mismatch',
] as const);

/** One of the seven gate rejection codes. */
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

/**
 * The admission threshold. An edge below this is quarantined with
 * `confidence_below_floor`, and — this is the part that matters — the generator
 * keeps the number and the reason consistent, so the integrity panel can be
 * checked against the edge list rather than believed.
 */
export const CONFIDENCE_FLOOR = 0.55;

/** Narrowing guard for reading a `quarantine_reason` back off an edge. */
export function isQuarantineReason(value: string | null): value is QuarantineReason {
  return value !== null && (QUARANTINE_REASONS as readonly string[]).includes(value);
}

/**
 * The gate itself, stated once. Structural edges are EXEMPT — they describe the
 * artifact, not the world, so there is nothing about them to verify. Everything
 * else must clear the floor and carry at least one evidence passage.
 */
export function gateWouldAdmit(input: {
  family: RelationFamily;
  confidence: number;
  evidenceCount: number;
}): boolean {
  if (!isTruthGated(input.family)) return true;
  return input.confidence >= CONFIDENCE_FLOOR && input.evidenceCount > 0;
}

/* =============================================================================
 * 5. VOCABULARY SELF-CHECK
 * ========================================================================== */

/** Family counts per sigma-class. Used by the generator's manifest readout. */
export function familyCountsBySigma(): Record<SigmaClass, number> {
  return SIGMA_CLASSES.reduce(
    (acc, s) => {
      acc[s] = FAMILIES_BY_SIGMA[s].length;
      return acc;
    },
    {} as Record<SigmaClass, number>,
  );
}

/**
 * Every check that can be decided about the vocabulary without a corpus.
 * Returns violations; empty means sound. The generator calls this before it
 * writes a single edge — an inconsistent table produces one-way traversals that
 * look fine on screen and fail silently in the query engine.
 */
export function auditVocabulary(): string[] {
  const errors = assertInverseConsistency();
  const seen = new Set<string>();
  for (const def of RELATION_FAMILIES) {
    if (seen.has(def.family)) errors.push(`duplicate family token "${def.family}"`);
    seen.add(def.family);
    const underscored = def.family.startsWith('_');
    if (underscored !== (def.sigma === 'structural')) {
      errors.push(
        `"${def.family}" is ${underscored ? '' : 'not '}underscore-prefixed but sigma is "${def.sigma}"`,
      );
    }
    if (def.truthGated === (def.sigma === 'structural')) {
      errors.push(
        `"${def.family}" has truthGated=${String(def.truthGated)} with sigma "${def.sigma}"`,
      );
    }
  }
  return errors;
}
