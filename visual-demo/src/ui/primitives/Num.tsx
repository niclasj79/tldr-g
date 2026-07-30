/**
 * =============================================================================
 * NUM — THE MONO NUMERIC PRIMITIVE
 * =============================================================================
 *
 * EVERY measured number in the entire product renders through this component and
 * through nothing else. Token counts, latency, degrees, cache hits, percentages,
 * confidences, counts, ids. If the figure came out of the engine, it comes out
 * of here.
 *
 * That single mechanical rule does more for instrument-grade credibility than
 * any other styling choice in the build, for three reasons:
 *
 *   1. TABULAR, MONOSPACED FIGURES. A column of readouts lines up as a column.
 *      Digits never change width, so a number that updates does not shove the
 *      row it lives in.
 *   2. THE UNIT RECEDES. The figure is set at full size in the tone colour; the
 *      unit is 0.72em in --ink-faint. You read `5 040` and then, if you care,
 *      `tok`. A unit at the same weight as its figure is a label competing with
 *      its own reading.
 *   3. NOTHING ELSE MAY FORMAT A NUMBER. `scripts/check-discipline.mjs` fails
 *      any component that formats a measured quantity without routing it here.
 *
 * FORMATS ARE GENUINELY DISTINCT — they are not `toFixed` with a different arg:
 *
 *   int      1204            plain count. No grouping: counts are small and a
 *                            separator inside a 3-digit number is noise.
 *   tokens   21 044          thousands separated by a HAIRLINE GAP, not a comma.
 *                            A comma is prose punctuation; the gap is how a
 *                            meter reads. The gap is a styled span of fixed
 *                            width, so it can never depend on whether the font
 *                            happens to ship U+2009 — and copying the figure
 *                            yields `21044`, which is what you actually want.
 *   ms       412 ms          integer milliseconds, hairline unit.
 *   pct1     76.1 %          ALWAYS one decimal, even for a round number, so the
 *                            figure does not change width while it animates.
 *   float1   0.9  /  float2  0.87
 *   ratio    4.18×           the multiple, with a true multiplication sign.
 *
 * A NON-FINITE VALUE RENDERS AS AN EM DASH, never as `0` and never as a spinner.
 * "If you cannot source a number from the engine, do not display a number."
 *
 * ON `countFrom` — the one animation this component is allowed:
 *   design-tokens.css is explicit that gauges never tween, because a gauge that
 *   lies for 240ms is a broken gauge. `countFrom` is not a gauge tween. It is
 *   opt-in, it never fires unless a caller passes it, and it exists for exactly
 *   one thing: The Receipt, where the counterfactual token count is counted DOWN
 *   to the rendered token count. That descent IS the state transition — the
 *   engine spending 5 040 tokens where a naive retrieval would have spent
 *   21 044. Under `prefers-reduced-motion` it snaps, and the figure's width is
 *   locked to the wider of the two endpoints before the first frame so nothing
 *   on the row reflows mid-count.
 *
 * Duration and easing are READ FROM THE TOKENS at run time (`--t-scene`,
 * `--ease-camera`). No duration and no bezier is restated in this file.
 * =============================================================================
 */

import { useEffect, useRef, useState } from 'react';
import { readTokens } from '@/styles/tokens';
import { cx, toneClass, type Tone } from './tone';

export type NumFormat = 'int' | 'float1' | 'float2' | 'pct1' | 'ms' | 'tokens' | 'ratio';

export interface NumProps {
  /** The measured value. Non-finite renders as an em dash. */
  value: number;
  /** How to render the figure. Defaults to `int`. */
  format?: NumFormat;
  /** Overrides the format's implicit unit. Pass `''` to suppress it entirely. */
  unit?: string;
  /** Semantic colour of the FIGURE. The unit always stays --ink-faint. */
  tone?: Tone;
  /** Tabular figures. On by default; turn off only for a number inside prose. */
  tabular?: boolean;
  /**
   * Count from this value to `value` on mount, or whenever this prop changes.
   * Opt-in only — see the note above. Snaps under reduced motion.
   */
  countFrom?: number;
  /** Native title. Defaults to the plain-text `figure + unit`. */
  title?: string;
  className?: string;
}

/* ---------------------------------------------------------------------------
 * Formatting. Pure, testable, no DOM.
 * ------------------------------------------------------------------------- */

/**
 * Units that belong to a format rather than to a call site.
 *
 * `ratio` is NOT in this table. Its × is appended to the figure instead, at the
 * figure's own size and with no gap, because `4.18×` is one reading rather than
 * a value with a unit hanging off it. Set as a unit it came out as a detached
 * speck two thirds the size of the digits and read as a stray mark.
 */
const IMPLICIT_UNIT: Partial<Record<NumFormat, string>> = {
  pct1: '%',
  ms: 'ms',
};

/**
 * Internal thousands marker: ASCII UNIT SEPARATOR. A control character cannot
 * occur inside a formatted number, so splitting on it is unambiguous. It becomes
 * a fixed-width span at render time and a real space in `figureText`; it never
 * reaches the DOM as a character.
 */
const SEP = '\u001F';

function groupThousands(digits: string): string {
  const neg = digits.startsWith('-');
  const body = neg ? digits.slice(1) : digits;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (i > 0 && (body.length - i) % 3 === 0) out += SEP;
    out += body[i];
  }
  return (neg ? '-' : '') + out;
}

/**
 * The figure, as a string that may contain SEP markers. Exported so a test can
 * assert the format table without mounting React.
 */
export function formatFigure(value: number, format: NumFormat = 'int'): string {
  if (!Number.isFinite(value)) return '—';
  switch (format) {
    case 'tokens':
    case 'ms':
      return groupThousands(String(Math.round(value)));
    case 'float1':
      return value.toFixed(1);
    case 'float2':
      return value.toFixed(2);
    case 'pct1':
      return value.toFixed(1);
    case 'ratio':
      // MULTIPLICATION SIGN, attached. Never the letter x, never a unit slot.
      return `${value.toFixed(2)}×`;
    case 'int':
    default:
      return String(Math.round(value));
  }
}

/** Plain-text form (real spaces), for `title`, copy and assistive tech. */
export function figureText(value: number, format: NumFormat = 'int'): string {
  return formatFigure(value, format).split(SEP).join(' ');
}

/* ---------------------------------------------------------------------------
 * Easing, read from --ease-camera rather than restated here.
 * ------------------------------------------------------------------------- */

function bezierAxis(a: number, b: number, t: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * t * a + 3 * mt * t * t * b + t * t * t;
}

/** Solve a CSS `cubic-bezier(x1,y1,x2,y2)` for y at a given x. */
function makeBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = bezierAxis(x1, x2, t) - x;
      if (Math.abs(err) < 1e-5) break;
      const mt = 1 - t;
      const d = 3 * mt * mt * x1 + 6 * mt * t * (x2 - x1) + 3 * t * t * (1 - x2);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    return bezierAxis(y1, y2, t);
  };
}

const LINEAR = (x: number): number => x;

/** Read `--ease-camera` and turn it into a function. Falls back to linear. */
function cameraEase(): (x: number) => number {
  if (typeof document === 'undefined') return LINEAR;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--ease-camera').trim();
  const m = /^cubic-bezier\(([^)]+)\)$/.exec(raw);
  if (!m) return LINEAR;
  const n = m[1].split(',').map((s) => Number(s.trim()));
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return LINEAR;
  return makeBezier(n[0], n[1], n[2], n[3]);
}

/* ---------------------------------------------------------------------------
 * The count. One rAF loop, cancelled on unmount, snapping under reduced motion.
 * ------------------------------------------------------------------------- */

function useCount(target: number, from: number | undefined): number {
  const [shown, setShown] = useState(from ?? target);
  const raf = useRef(0);

  useEffect(() => {
    if (from === undefined || !Number.isFinite(from) || !Number.isFinite(target)) {
      setShown(target);
      return;
    }
    const tokens = readTokens();
    if (tokens.reducedMotion || from === target) {
      setShown(target);
      return;
    }
    const ease = cameraEase();
    const dur = tokens.ms.scene;
    const t0 = performance.now();
    setShown(from);
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / dur);
      setShown(from + (target - from) * ease(p));
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, from]);

  return shown;
}

/* ---------------------------------------------------------------------------
 * The component.
 * ------------------------------------------------------------------------- */

/** Render a formatted figure as spans, with SEP turned into a fixed-width gap. */
function figureSpans(figure: string): JSX.Element[] {
  const parts = figure.split(SEP);
  const out: JSX.Element[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(<span key={`s${i}`} className="num-sep" aria-hidden="true" />);
    out.push(<span key={`d${i}`}>{p}</span>);
  });
  return out;
}

/** Split a formatted figure into mono advances and hairline gaps. */
function measure(s: string): { chars: number; seps: number } {
  const seps = s.split(SEP).length - 1;
  return { chars: s.length - seps, seps };
}

export function Num({
  value,
  format = 'int',
  unit,
  tone = 'neutral',
  tabular = true,
  countFrom,
  title,
  className,
}: NumProps): JSX.Element {
  const shown = useCount(value, countFrom);
  const counting = countFrom !== undefined;
  const figure = formatFigure(counting ? shown : value, format);
  const nil = !Number.isFinite(value);

  const u = unit ?? IMPLICIT_UNIT[format] ?? '';
  const plain = `${figureText(value, format)}${u ? ` ${u}` : ''}`;

  // Lock the figure box to the wider of the two endpoints BEFORE the first
  // frame, so a count-down cannot reflow the row it lives in.
  let figureStyle: React.CSSProperties | undefined;
  if (counting) {
    const a = measure(formatFigure(value, format));
    const b = measure(formatFigure(countFrom, format));
    const chars = Math.max(a.chars, b.chars);
    const seps = Math.max(a.seps, b.seps);
    figureStyle = { minWidth: `calc(${chars}ch + ${seps} * var(--num-sep-w))` };
  }

  return (
    <span
      className={cx('num', toneClass(tone), counting && 'is-counting', nil && 'is-nil', className)}
      title={title ?? plain}
      style={tabular ? undefined : { fontVariantNumeric: 'normal' }}
    >
      <span className="num-f" style={figureStyle}>
        {figureSpans(figure)}
      </span>
      {u ? <span className="num-u">{u}</span> : null}
    </span>
  );
}
