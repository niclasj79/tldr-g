/**
 * SCRIMOVERLAY — for the rare full-bleed state.
 *
 * FIRST-RUN, the help/glossary sheet, a DEGRADED stop. Not for confirmations and
 * never for anything the terrain could have said in place.
 *
 * The ground is --scrim (a 70% void wash), never pure black: the terrain stays
 * faintly visible underneath, because the user has not left the map — the map is
 * just being spoken over.
 *
 * PORTALLED TO <body>, AND IT HAS TO BE. Panel carries `backdrop-filter`, and
 * backdrop-filter makes an element a containing block for fixed-position
 * descendants — exactly like `transform` does. A scrim rendered inside a Panel
 * therefore covers THAT PANEL and nothing else, which looks almost right in a
 * screenshot and is completely wrong. Caught by opening one and looking at it.
 */

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './tone';

export interface ScrimOverlayProps {
  children?: ReactNode;
  /** Called on Escape and on a click landing on the scrim itself. */
  onDismiss?: () => void;
  className?: string;
}

export function ScrimOverlay({
  children,
  onDismiss,
  className,
}: ScrimOverlayProps): JSX.Element | null {
  useEffect(() => {
    if (!onDismiss) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={cx('scrim', className)}
      onClick={(e) => {
        if (onDismiss && e.target === e.currentTarget) onDismiss();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
