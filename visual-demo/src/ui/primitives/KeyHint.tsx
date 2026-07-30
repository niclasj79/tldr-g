/**
 * KEYHINT — the keyboard is a first-class input on this instrument.
 *
 * Mono, 11px, glass, on a --s-5 square so a row of hints has a rhythm. Multiple
 * keys render adjacent with a hairline gap and NO plus sign: `⌘ K` reads as a
 * chord without adding a character the user has to mentally discard.
 */

import { cx } from './tone';

export interface KeyHintProps {
  /** The chord, in press order. e.g. `['/']`, `['⇧', 'A']`. */
  keys: string[];
  className?: string;
}

export function KeyHint({ keys, className }: KeyHintProps): JSX.Element {
  return (
    <span className={cx('keys', className)}>
      {keys.map((k, i) => (
        <kbd key={`${k}-${i}`} className="key">
          {k}
        </kbd>
      ))}
    </span>
  );
}
