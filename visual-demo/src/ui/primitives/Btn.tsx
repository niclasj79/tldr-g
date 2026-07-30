/**
 * BTN — three weights of intent, none of them loud.
 *
 *   ghost    no chrome at all until you hover it. For repeated, low-stakes
 *            controls docked in a panel header.
 *   quiet    glass: --panel-bg-2, 1px --line, inset top-edge light. The default
 *            for anything that is a real action but not THE action.
 *   primary  the tone at 12% fill and 40% border. Tinted, never a filled slab —
 *            a saturated button on a dark instrument reads as a web page.
 *
 * `primary` defaults to the RENDER light, because the primary action in this
 * product is almost always "make the engine attend to something". A primary in
 * --alarm is legitimate exactly once: the remedy button on a DEGRADED state.
 */

import type { ReactNode } from 'react';
import { cx, toneClass, type Tone } from './tone';

export interface BtnProps {
  variant?: 'ghost' | 'quiet' | 'primary';
  size?: 'sm' | 'md';
  tone?: Tone;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  children?: ReactNode;
  className?: string;
}

export function Btn({
  variant = 'quiet',
  size = 'md',
  tone = 'render',
  onClick,
  disabled = false,
  title,
  type = 'button',
  children,
  className,
}: BtnProps): JSX.Element {
  return (
    <button
      type={type}
      className={cx(
        'btn',
        `btn-${variant}`,
        size === 'sm' && 'btn-sm',
        toneClass(tone),
        className,
      )}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
