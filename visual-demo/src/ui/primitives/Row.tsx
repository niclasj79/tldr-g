/**
 * ROW / SECTIONLABEL / DIVIDER — the connective tissue of a panel.
 *
 * ROW is a label on the left and a value on the right, on a baseline grid, with
 * a hairline between adjacent rows. That is the whole idea: a stack of Rows is
 * a readout table, and a readout table is what an instrument mostly is.
 *
 * `mono` puts the VALUE on the mono rail — for ids, keys, DIDs and other
 * machine strings. A measured NUMBER does not need `mono`: it needs <Num>,
 * which brings its own rail, its own tabular figures and its own unit
 * treatment. Passing a raw number here is the mistake this note exists for.
 */

import type { ReactNode } from 'react';
import { cx, toneClass, type Tone } from './tone';

export interface RowProps {
  label: ReactNode;
  value?: ReactNode;
  /** Mono rail for a machine STRING. For a measured number, pass a <Num>. */
  mono?: boolean;
  tone?: Tone;
  title?: string;
  className?: string;
}

export function Row({
  label,
  value,
  mono = false,
  tone = 'neutral',
  title,
  className,
}: RowProps): JSX.Element {
  return (
    <div className={cx('row', toneClass(tone), className)} title={title}>
      <span className="row-l">{label}</span>
      {value !== undefined ? (
        <span className={cx('row-v', mono && 'is-mono')}>{value}</span>
      ) : null}
    </div>
  );
}

export interface SectionLabelProps {
  children?: ReactNode;
  className?: string;
}

/** 11px uppercase --ink-faint. The quietest way to name a group of things. */
export function SectionLabel({ children, className }: SectionLabelProps): JSX.Element {
  return <span className={cx('section-label', className)}>{children}</span>;
}

export interface DividerProps {
  vertical?: boolean;
  className?: string;
}

/** One pixel of --line. The only rule this product draws. */
export function Divider({ vertical = false, className }: DividerProps): JSX.Element {
  return <hr className={cx('divider', vertical && 'is-vert', className)} aria-hidden="true" />;
}
