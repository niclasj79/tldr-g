/**
 * DISCLOSURE — progressive detail on native semantics.
 *
 * Built on <details>/<summary>, so keyboard operation, the accessibility tree
 * and find-in-page all work without a single line of JavaScript. The caret is a
 * `›` rotated 90° over --t-fast: the only thing that moves, and it moves because
 * the open state actually changed.
 *
 * `open` is the INITIAL state, not a controlled prop. A disclosure that fights
 * the user for its own open state is a worse component than a <div>.
 */

import type { ReactNode } from 'react';
import { cx } from './tone';

export interface DisclosureProps {
  summary: ReactNode;
  /** Initially open. Uncontrolled thereafter — the user owns it. */
  open?: boolean;
  children?: ReactNode;
  className?: string;
}

export function Disclosure({
  summary,
  open = false,
  children,
  className,
}: DisclosureProps): JSX.Element {
  return (
    <details className={cx('disc', className)} open={open}>
      <summary className="disc-sum">
        <span className="disc-caret" aria-hidden="true">
          ›
        </span>
        <span>{summary}</span>
      </summary>
      <div className="disc-body">{children}</div>
    </details>
  );
}
