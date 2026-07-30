/**
 * METER — an instrument bar. Never a progress toy.
 *
 * 3px tall, square ends, --line track, tone fill. No rounded caps, no gradient,
 * no stripes, no shimmer. A rounded, animated bar is the visual grammar of "we
 * are loading something and would rather you did not notice how long it takes";
 * this is the grammar of a panel gauge that is reading a real quantity.
 *
 * The fill transitions over --t-ui ONLY when the value behind it changes. There
 * is no mount animation: a bar that sweeps up on first paint is telling you
 * about a page load, not about a measurement.
 *
 * With a `label`, the meter grows a header row and states its own reading as a
 * percentage through <Num>. That percentage is derived from `value / max` — the
 * two numbers the caller already handed over — so the meter can never display a
 * figure that disagrees with its own fill.
 */

import type { ReactNode } from 'react';
import { Num } from './Num';
import { cx, toneClass, type Tone } from './tone';

export interface MeterProps {
  value: number;
  max: number;
  tone?: Tone;
  /** Micro-label. Its presence also turns on the derived percentage readout. */
  label?: ReactNode;
  /** Replaces the derived percentage with your own readout. */
  readout?: ReactNode;
  className?: string;
}

export function Meter({
  value,
  max,
  tone = 'render',
  label,
  readout,
  className,
}: MeterProps): JSX.Element {
  const usable = Number.isFinite(value) && Number.isFinite(max) && max > 0;
  const ratio = usable ? Math.min(1, Math.max(0, value / max)) : 0;

  return (
    <div
      className={cx('meter', toneClass(tone), className)}
      role="meter"
      aria-valuenow={usable ? value : undefined}
      aria-valuemin={0}
      aria-valuemax={usable ? max : undefined}
    >
      {label !== undefined || readout !== undefined ? (
        <div className="meter-hd">
          <span className="meter-label">{label}</span>
          {readout ?? <Num value={usable ? ratio * 100 : NaN} format="pct1" tone="dim" />}
        </div>
      ) : null}
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${(ratio * 100).toFixed(2)}%` }} />
      </div>
    </div>
  );
}
