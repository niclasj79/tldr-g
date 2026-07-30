/**
 * CHIP — a filter state you can read from across the room.
 *
 * Inactive is a hairline on the void. Active is the tone at 12% fill and 40%
 * border — enough to be unmistakable in peripheral vision, nowhere near enough
 * to compete with the terrain.
 *
 * `count` goes through <Num>, like every other measured number in the product.
 * A chip is one of the places it would be most tempting to "just print the
 * number"; that is exactly why it does not.
 *
 * With no `onClick` a chip is a <span>: a static state readout, not a control
 * that quietly does nothing when you press it.
 */

import type { ReactNode } from 'react';
import { Num } from './Num';
import { cx, toneClass, type Tone } from './tone';

export interface ChipProps {
  active?: boolean;
  tone?: Tone;
  /** A measured count. Rendered through the mono numeric primitive. */
  count?: number;
  onClick?: () => void;
  children?: ReactNode;
  title?: string;
  className?: string;
}

export function Chip({
  active = false,
  tone = 'render',
  count,
  onClick,
  children,
  title,
  className,
}: ChipProps): JSX.Element {
  const cls = cx('chip', toneClass(tone), active && 'is-active', className);
  const body = (
    <>
      <span className="chip-body">{children}</span>
      {count === undefined ? null : (
        <Num value={count} format="int" tone={active ? tone : 'faint'} className="chip-count" />
      )}
    </>
  );

  if (!onClick) {
    return (
      <span className={cls} title={title}>
        {body}
      </span>
    );
  }
  return (
    <button type="button" className={cls} title={title} aria-pressed={active} onClick={onClick}>
      {body}
    </button>
  );
}
