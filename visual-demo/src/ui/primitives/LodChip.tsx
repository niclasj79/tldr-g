/**
 * LODCHIP — the resolution ramp, as DOM.
 *
 * The terrain renders the five-state ramp in WebGL. Legends, receipts, admission
 * tables and the omitted-but-connected list need the same five states in the
 * DOM, and they must be THE SAME FIVE STATES or the instrument contradicts
 * itself in two places at once. This is the canonical DOM rendering: opacity,
 * stroke weight and the 6px fovea glow all read straight off the ramp tokens.
 *
 *   lod-0   verbatim / fovea     100%  + 6px glow + 1.5px stroke
 *   lod-1   summary / penumbra    85%  crisp, no glow
 *   lod-2   label / periphery     55%  1px stroke
 *   ghost   present, not spent on 28%  blur(1px)
 *   latent  outline only          12%
 *
 * `latent` is LOAD-BEARING. It is how the product says "this exists and I chose
 * not to spend on it" — the reason the terrain never has holes, and the reason
 * an omission is visible as topology rather than as an absence.
 *
 * -----------------------------------------------------------------------------
 * THE DEFAULT LABEL WAS THE MACHINE CODE, AND IT LEAKED EVERYWHERE
 * -----------------------------------------------------------------------------
 * `label` defaulted to the `state` token, so a chip with no label rendered the
 * literal string `lod-0` or `latent` as real 11px mono text. Two call sites
 * passed the translation; SEVEN did not — the receipt's citation rows, the
 * admission table, the omitted list, the inspector header and the empty screen —
 * which made a raw enum value the only ALWAYS-VISIBLE text in the panel a
 * sceptic reads first, with the human reading available on hover only.
 *
 * The deck has translated these five states since it was written
 * (`COPY.ramp.states[state]`), so the default is now the translation and the
 * code is the `title`. The dual-layer rule, applied to the one place it was most
 * expensive: plain name in the chip, machine code one hover away, and neither
 * deleted. A caller that genuinely wants the raw token still passes it.
 */

import type { ReactNode } from 'react';
import { lodCopy } from '@/copy';
import type { LodState } from '@/engine';
import { cx, toneClass, type Tone } from './tone';

export interface LodChipProps {
  state: LodState;
  /**
   * Defaults to the state's HUMAN name from the deck — `Verbatim`, `Latent` —
   * never the raw token. Pass the token explicitly if a surface needs it.
   */
  label?: ReactNode;
  tone?: Tone;
  className?: string;
}

export function LodChip({ state, label, tone = 'render', className }: LodChipProps): JSX.Element {
  const copy = lodCopy(state);
  return (
    <span
      className={cx('lodchip', `lodchip-${state}`, toneClass(tone), className)}
      /* THE MACHINE CODE IS NOT DELETED, IT IS DEMOTED. `lod-0` is what the
         engine calls this and what you would grep a trace for, so it stays one
         hover away rather than being replaced. */
      title={`${copy.label} · ${state} — ${copy.short}`}
    >
      {label ?? copy.label}
    </span>
  );
}
