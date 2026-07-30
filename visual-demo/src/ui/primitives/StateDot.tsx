/**
 * STATEDOT — machine condition. Four states, no motion.
 *
 *   on       filled, in the tone. The thing is live / valid / present.
 *   pending  a RING, not a pulse. Work is in flight.
 *   off      filled at --ink-a20. Present, not running.
 *   fail     filled --alarm. Something is actually wrong.
 *
 * `pending` is deliberately not animated. A pulsing dot is decorative motion
 * wearing an information costume: it tells you nothing the open ring does not,
 * and it keeps moving whether or not anything is happening — which is exactly
 * the class of interface that lies about its engine.
 */

import type { ReactNode } from 'react';
import { cx, toneClass, type Tone } from './tone';

/** The four machine conditions a dot can report. */
export type DotState = 'on' | 'off' | 'pending' | 'fail';

export interface StateDotProps {
  state: DotState;
  /** Overrides the default tone. `fail` is always --alarm regardless. */
  tone?: Tone;
  label?: ReactNode;
  className?: string;
}

const DEFAULT_TONE: Record<DotState, Tone> = {
  on: 'render',
  off: 'faint',
  pending: 'warn',
  fail: 'alarm',
};

export function StateDot({ state, tone, label, className }: StateDotProps): JSX.Element {
  return (
    <span
      className={cx('dot', `dot-${state}`, toneClass(tone ?? DEFAULT_TONE[state]), className)}
      title={typeof label === 'string' ? `${label} — ${state}` : state}
    >
      <span className="dot-mark" aria-hidden="true" />
      {label !== undefined ? <span className="dot-label">{label}</span> : null}
    </span>
  );
}
