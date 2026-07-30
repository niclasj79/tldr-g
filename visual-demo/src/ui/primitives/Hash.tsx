/**
 * HASH — a checkable thing, rendered in old light.
 *
 * Amber (--evidence) because a content hash is EVIDENCE: its authority predates
 * this session. It is the object that lets a third party go back to the source
 * bytes and check the quote without trusting this application at all, so the
 * component is built around taking it away:
 *
 *   - truncated for the eye, complete in `title`, complete on the clipboard
 *   - a dotted --evidence underline, the affordance for "this is meant to be
 *     copied and checked"
 *   - the copied confirmation is a real state transition, held for --t-scene
 *     and then dropped. It is not a toast and it does not queue.
 *
 * Truncation shows the LEADING characters of the DIGEST. Two details, both
 * learned by looking at the specimen sheet:
 *
 *   - An algorithm prefix (`sha256:`, `did:web:`) is split off and set in
 *     --ink-faint. It is not part of the value you compare, and left inside the
 *     budget it ate seven of twelve visible characters — the component was
 *     showing five real hex digits and calling it a hash.
 *   - Leading characters, not a middle ellipsis. A middle ellipsis makes two
 *     different digests look alike at a glance, which is the one thing a hash
 *     must never do.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { readTokens } from '@/styles/tokens';
import { cx } from './tone';

export interface HashProps {
  /** The full digest / signature / id. Never pre-truncate at the call site. */
  value: string;
  /** Leading characters to show. 12 is enough to compare, short enough to scan. */
  chars?: number;
  /** Micro-label rendered before the value, e.g. `payload`. */
  label?: string;
  className?: string;
}

export function Hash({ value, chars = 12, label, className }: HashProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(() => {
    const write = navigator.clipboard?.writeText(value);
    Promise.resolve(write)
      .then(() => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), readTokens().ms.scene);
      })
      .catch(() => {
        /* Clipboard denied. The full value is still in `title`. Say nothing. */
      });
  }, [value]);

  // `sha256:abc…` / `did:web:host#key` — the scheme is context, not the value
  // being compared, so it never spends any of the character budget.
  const cut = value.lastIndexOf(':');
  const prefix = cut > 0 ? value.slice(0, cut + 1) : '';
  const digest = cut > 0 ? value.slice(cut + 1) : value;

  const shown = digest.length > chars ? digest.slice(0, chars) : digest;
  const truncated = digest.length > chars;

  return (
    <button
      type="button"
      className={cx('hash', copied && 'is-copied', className)}
      title={value}
      onClick={copy}
    >
      {label ? <span className="hash-label">{label}</span> : null}
      {prefix ? <span className="hash-prefix">{prefix}</span> : null}
      <span className="hash-v">{shown}</span>
      {truncated && !copied ? (
        <span className="hash-ell" aria-hidden="true">
          …
        </span>
      ) : null}
      {copied ? <span className="hash-copied">copied</span> : null}
    </button>
  );
}
