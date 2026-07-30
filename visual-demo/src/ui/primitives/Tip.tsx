/**
 * TIP — a tooltip. Never a modal, never a popover with actions in it.
 *
 * Opens on hover AND on keyboard focus, at --t-fast. It flips above the anchor
 * when there is no room below, and it is clamped to the viewport horizontally.
 *
 * THE POPUP IS PORTALLED TO <body>. `position: fixed` alone is not enough:
 * Panel carries `backdrop-filter`, and backdrop-filter makes an element a
 * containing block for fixed descendants exactly the way `transform` does. A
 * tooltip inside a panel would be positioned against the PANEL while being
 * measured against the viewport — so it would land in a plausible-looking wrong
 * place and get clipped by the panel's own scroll box.
 *
 * `pointer-events: none` is deliberate: a tooltip you can put the cursor inside
 * is a menu that has not admitted it yet.
 */

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './tone';

export interface TipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
}

interface Pos {
  left: number;
  top: number;
}

/** Distance from the anchor, on the 4px ruler. */
const OFFSET = 8;

export function Tip({ content, children, className }: TipProps): JSX.Element {
  const anchor = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [pos, setPos] = useState<Pos>({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open || !anchor.current || !pop.current) return;
    const a = anchor.current.getBoundingClientRect();
    const p = pop.current.getBoundingClientRect();
    const below = a.bottom + OFFSET;
    const fitsBelow = below + p.height <= window.innerHeight;
    const top = fitsBelow ? below : Math.max(OFFSET, a.top - p.height - OFFSET);
    const left = Math.min(
      Math.max(OFFSET, a.left + a.width / 2 - p.width / 2),
      Math.max(OFFSET, window.innerWidth - p.width - OFFSET),
    );
    setPos({ left, top });
    // One frame later so the transition has an initial state to run from.
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [open, content]);

  const close = useCallback(() => {
    setShown(false);
    setOpen(false);
  }, []);

  return (
    <span
      ref={anchor}
      className={cx('tip-anchor', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={close}
      onFocus={() => setOpen(true)}
      onBlur={close}
    >
      {children}
      {open && typeof document !== 'undefined'
        ? createPortal(
            <span
              ref={pop}
              className="tip-pop"
              role="tooltip"
              data-shown={shown ? '1' : '0'}
              style={{ left: pos.left, top: pos.top }}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
