/**
 * SPARKLINE — small, no axes, no grid, no legend, no tooltip.
 *
 * A sparkline is a shape, not a chart. It answers "which way and how steadily",
 * and anything that would let it answer a second question makes it a bad chart
 * instead of a good shape. The only chrome is a --line baseline at the series
 * minimum, so a flat series still reads as flat rather than as missing.
 *
 * `vector-effect: non-scaling-stroke` keeps the stroke exactly 1px however the
 * viewBox is scaled. A sparkline with a 1.4px stroke on one panel and 0.8px on
 * another is how an instrument stops looking machined.
 *
 * It never labels its own values. If one of those values matters, put a <Num>
 * beside the shape — measured figures live on the mono rail, not inside an SVG.
 */

import { cx, toneClass, type Tone } from './tone';

export interface SparklineProps {
  /** The series, in order. Fewer than two points renders nothing. */
  points: number[];
  tone?: Tone;
  width?: number;
  height?: number;
  className?: string;
  /** Accessible summary. The shape is decorative without one. */
  label?: string;
}

export function Sparkline({
  points,
  tone = 'render',
  width = 72,
  height = 18,
  className,
  label,
}: SparklineProps): JSX.Element | null {
  const finite = points.filter((p) => Number.isFinite(p));
  if (finite.length < 2) return null;

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const stepX = width / (finite.length - 1);

  const d = finite
    .map((p, i) => {
      const x = i * stepX;
      const y = height - ((p - min) / span) * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg
      className={cx('spark', toneClass(tone), className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? 'img' : 'presentation'}
      aria-label={label}
    >
      <line
        className="spark-base"
        x1={0}
        y1={height - 0.5}
        x2={width}
        y2={height - 0.5}
        vectorEffect="non-scaling-stroke"
      />
      <path className="spark-line" d={d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
