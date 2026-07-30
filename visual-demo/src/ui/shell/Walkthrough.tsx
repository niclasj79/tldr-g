/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE WALKTHROUGH
 * =============================================================================
 *
 * Seven steps that teach the thesis BY OPERATING THE PRODUCT.
 *
 * THE RULE THIS FILE LIVES BY: every step drives a REAL action on the REAL store
 * — the same `runQuery`, `toggle` and `goToRung` a click drives. There is no
 * scripted playback, no fake cursor, no mocked panel. If the engine were broken,
 * the walkthrough would break with it, loudly. A tour that plays a recording of a
 * product working is exactly the kind of lie this codebase exists to argue
 * against, and it would be the easiest lie to tell here.
 *
 * IT IS NOT MODAL. The card docks bottom-centre above the HUD, the terrain stays
 * live behind it, and the user can pan, hover and click at any time without
 * dismissing anything. A walkthrough that holds the product hostage teaches
 * nothing about the product.
 *
 * IT DOES NOT NAG. Seen-state persists to localStorage, so it runs once. It is
 * re-runnable for ever after from the help overlay, because the person who most
 * wants a second pass is the one about to demo this to someone else.
 * =============================================================================
 */

import { useCallback, useEffect, useState } from 'react';

import { COPY } from '@/copy';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Num } from '@/ui/primitives';

const SEEN_KEY = 'tldrg.visual-demo.walkthrough.seen';

/**
 * Set once anything has explicitly closed the walkthrough this session.
 *
 * It exists because of a genuine race: the scene driver dismisses the coach as
 * part of its baseline, and only THEN does the corpus finish ingesting and the
 * app reach READY — at which point the auto-open effect would fire and put the
 * card back over the screenshot. Storage alone cannot settle this, because the
 * dismissal and the auto-open are racing within one mount.
 */
let suppressed = false;

/*
 * The suppression listener is registered AT MODULE SCOPE, not in the component.
 *
 * This is the whole bug it was written for: on load the app is in FIRST-RUN,
 * where the shell returns early and never mounts <Walkthrough/>. A close event
 * dispatched then — which is exactly when the scene driver's baseline sends one —
 * arrived with no listener attached, so the flag stayed false, and the coach
 * opened over the first screenshot the moment the corpus reached READY.
 *
 * A gate that only works while the thing it gates is on screen is not a gate.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('atlas:walkthrough-close', () => {
    suppressed = true;
  });
  window.addEventListener('atlas:walkthrough', () => {
    suppressed = false;
  });
}

/** Has this browser already been walked through? Storage can throw under privacy modes. */
function seen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* A browser that refuses storage gets the walkthrough again. That is the
       harmless failure direction; silently skipping it is not. */
  }
}

/**
 * What each step needs the product to actually be doing when it is on screen.
 *
 * Returning a promise is meaningful: the step's Next is disabled until the real
 * work lands, so the walkthrough can never narrate ahead of the engine.
 */
const ENTER: Record<string, (() => void | Promise<void>) | undefined> = {
  terrain: () => {
    const s = useAtlas.getState();
    s.clearFocus();
    if (s.ui.inspector) s.toggle('inspector');
  },
  staged: () => {
    const s = useAtlas.getState();
    if (!s.ui.inspector) s.toggle('inspector');
  },
  render: async () => {
    const s = useAtlas.getState();
    // The real query, through the real action. If it has already been run this
    // session, re-running is still honest — it is the same call the button makes.
    if (s.query.active === null) await s.runQuery(s.query.staged);
  },
  receipt: () => {
    const s = useAtlas.getState();
    if (!s.ui.receipt) s.toggle('receipt');
  },
  verify: () => {
    void useAtlas.getState().verifyActive();
  },
  rungs: () => {
    const s = useAtlas.getState();
    if (!s.ui.atlas) s.toggle('atlas');
  },
};

export interface WalkthroughProps {
  className?: string;
}

export function Walkthrough({ className }: WalkthroughProps): JSX.Element | null {
  const app = useAtlasStore((s) => s.app);
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);

  const steps = COPY.walkthrough.steps;

  // Offer it once, and only once the corpus is actually on screen. Opening over
  // FIRST-RUN or SETTLING would be coaching someone through a map that is not
  // there yet.
  useEffect(() => {
    if (app !== 'READY' || suppressed || seen()) return;
    markSeen();
    setOpen(true);
    setI(0);
  }, [app]);

  // Re-entry from the help overlay. A custom event rather than more store
  // surface: the walkthrough is chrome, not application state, and nothing else
  // needs to be able to read whether it is open.
  useEffect(() => {
    const onStart = (): void => {
      suppressed = false;
      setI(0);
      setOpen(true);
    };
    const onStop = (): void => {
      suppressed = true;
      setOpen(false);
    };
    window.addEventListener('atlas:walkthrough', onStart);
    window.addEventListener('atlas:walkthrough-close', onStop);
    return () => {
      window.removeEventListener('atlas:walkthrough', onStart);
      window.removeEventListener('atlas:walkthrough-close', onStop);
    };
  }, []);

  const go = useCallback(
    async (next: number) => {
      if (next < 0 || next >= steps.length) return;
      const enter = ENTER[steps[next].id];
      setI(next);
      if (enter === undefined) return;
      setBusy(true);
      try {
        await enter();
      } finally {
        setBusy(false);
      }
    },
    [steps],
  );

  // While the walkthrough is up it IS the explanation of the map, so the rung
  // legend stands down rather than competing with it in the same strip. A data
  // attribute rather than new store surface: this is chrome coordination, and
  // `ui` should not grow a key that only CSS reads.
  useEffect(() => {
    const root = document.documentElement;
    if (open) root.dataset.walkthrough = '1';
    else delete root.dataset.walkthrough;
    return () => {
      delete root.dataset.walkthrough;
    };
  }, [open]);

  // Esc closes, like every other dismissible surface here.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open || app === 'FIRST-RUN' || app === 'EMPTY') return null;

  const step = steps[i];
  const last = i === steps.length - 1;

  return (
    <div
      className={['walk', className].filter(Boolean).join(' ')}
      role="region"
      aria-label={COPY.walkthrough.open.title}
    >
      <div className="walk__hd">
        <span className="walk__count">
          <Num value={i + 1} format="int" /> {COPY.walkthrough.ofLabel}{' '}
          <Num value={steps.length} format="int" />
        </span>
        <Btn variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {COPY.walkthrough.skip}
        </Btn>
      </div>

      <h2 className="walk__title">{step.title}</h2>
      <p className="walk__body">{step.body}</p>

      <div className="walk__ft">
        {/* A rail of ticks rather than a progress bar: a bar implies work being
            done, and nothing is loading here. */}
        <div className="walk__ticks" aria-hidden="true">
          {steps.map((s, n) => (
            <span key={s.id} className={n <= i ? 'walk__tick walk__tick--on' : 'walk__tick'} />
          ))}
        </div>
        <div className="walk__acts">
          {i > 0 ? (
            <Btn variant="quiet" size="sm" onClick={() => void go(i - 1)} disabled={busy}>
              {COPY.walkthrough.back}
            </Btn>
          ) : null}
          {last ? (
            <Btn variant="primary" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              {COPY.walkthrough.done}
            </Btn>
          ) : (
            <Btn variant="primary" size="sm" onClick={() => void go(i + 1)} disabled={busy}>
              {COPY.walkthrough.next}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

/** Re-run the walkthrough. Called by the help overlay. */
export function startWalkthrough(): void {
  window.dispatchEvent(new Event('atlas:walkthrough'));
}

/**
 * Close it, and stop it offering itself again in this browser.
 *
 * The scene driver calls this before it photographs anything: a first-visit
 * coach is correct behaviour for a person and pure contamination for a
 * screenshot, and every named scene must be captured as the product looks when
 * you are actually working in it.
 */
export function dismissWalkthrough(): void {
  markSeen();
  window.dispatchEvent(new Event('atlas:walkthrough-close'));
}
