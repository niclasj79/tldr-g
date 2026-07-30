/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE SHAREABLE SCENE
 * =============================================================================
 *
 * `saveView()` encodes the rung, the scope, the camera, the selection, the
 * filters and the density into `location.hash`. This control does that and then
 * puts the resulting URL on the clipboard.
 *
 * TOAST-FREE, as the brief asks. A toast is a notification about a thing that
 * happened somewhere else; this happened HERE, so the confirmation happens here
 * too — the control states what it did, in place, and goes back to being a
 * control. Nothing slides in, nothing covers anything, nothing has to be
 * dismissed.
 *
 * IT ALSO TELLS THE TRUTH WHEN THE CLIPBOARD REFUSES. A headless browser, an
 * insecure origin or a denied permission all make `writeText` reject, and a
 * control that says "Copied." when nothing was copied is a small lie of exactly
 * the kind this product is built against. On failure the URL is shown instead,
 * selectable, so the user can take it by hand.
 * =============================================================================
 */

import { useEffect, useRef, useState } from 'react';

import { COPY } from '@/copy';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Tip } from '@/ui/primitives';

type Outcome = 'idle' | 'copied' | 'manual';

export interface ShareControlProps {
  className?: string;
}

export function ShareControl({ className }: ShareControlProps): JSX.Element | null {
  const app = useAtlasStore((s) => s.app);
  const [outcome, setOutcome] = useState<Outcome>('idle');
  const [url, setUrl] = useState('');
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (app === 'FIRST-RUN' || app === 'EMPTY') return null;

  const share = (): void => {
    // The hash is written by the store, synchronously, whether or not the
    // clipboard cooperates. The link exists either way.
    useAtlas.getState().saveView();
    const href = window.location.href;
    setUrl(href);
    window.clearTimeout(timer.current);

    const settle = (next: Outcome): void => {
      setOutcome(next);
      if (next === 'copied') {
        timer.current = window.setTimeout(() => setOutcome('idle'), 2400);
      }
    };

    const clipboard = navigator.clipboard;
    if (clipboard === undefined) {
      settle('manual');
      return;
    }
    void clipboard.writeText(href).then(
      () => settle('copied'),
      () => settle('manual'),
    );
  };

  return (
    <span className={['share', className].filter(Boolean).join(' ')}>
      <Tip content={COPY.savedView.note}>
        <Btn variant="ghost" size="sm" onClick={share} title={COPY.savedView.action.title}>
          {outcome === 'copied' ? COPY.savedView.copied : COPY.savedView.action.label}
        </Btn>
      </Tip>
      {outcome === 'manual' ? (
        <input className="share__url mono" readOnly value={url} onFocus={(e) => e.target.select()} />
      ) : null}
    </span>
  );
}
