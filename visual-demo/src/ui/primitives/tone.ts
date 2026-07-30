/**
 * =============================================================================
 * TONE — the semantic colour channel of the chrome
 * =============================================================================
 *
 * A tone is a MEANING, not a colour. Reaching for `tone="render"` because cyan
 * looks good is the one way to break the instrument: the three lights only work
 * as a language if each is spent on exactly one job.
 *
 *   render     the engine's ATTENTION — selection, focus, active, the thing
 *              being computed right now
 *   evidence   OLD LIGHT from the sources — citations, hashes, signatures,
 *              anything whose authority predates this session
 *   curiosity  the QUESTION light — gaps, suggestions, omitted-but-connected
 *   ok/warn    gauge conditions
 *   alarm      FAIL-LOUD ONLY. Never a hover state, never an accent.
 *   neutral/dim/faint  the three-step ink ramp, for everything that is chrome
 *
 * Every toned primitive emits exactly one `tone-*` class, always — the default
 * is `neutral`. That stops a toned Panel from silently tinting the numbers
 * inside it: tone is declared where it is meant, never inherited by accident.
 * =============================================================================
 */

export type Tone =
  | 'neutral'
  | 'dim'
  | 'faint'
  | 'render'
  | 'evidence'
  | 'curiosity'
  | 'ok'
  | 'warn'
  | 'alarm';

/** The class that sets `--tone` / `--tone-rgb` for a subtree. Always emitted. */
export function toneClass(tone: Tone = 'neutral'): string {
  return `tone-${tone}`;
}

/** Join class names, dropping falsy entries. No dependency, no cleverness. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
