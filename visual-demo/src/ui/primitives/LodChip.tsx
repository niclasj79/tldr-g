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
 */

import type { ReactNode } from 'react';
import type { LodState } from '@/engine';
import { cx, toneClass, type Tone } from './tone';

export interface LodChipProps {
  state: LodState;
  /** Defaults to the state token itself, which is usually the right label. */
  label?: ReactNode;
  tone?: Tone;
  className?: string;
}

export function LodChip({ state, label, tone = 'render', className }: LodChipProps): JSX.Element {
  return (
    <span className={cx('lodchip', `lodchip-${state}`, toneClass(tone), className)} title={state}>
      {label ?? state}
    </span>
  );
}
