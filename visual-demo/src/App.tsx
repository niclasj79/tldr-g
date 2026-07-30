/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE APPLICATION
 * =============================================================================
 *
 * One component, and it is deliberately this thin.
 *
 * There is no router, no provider tower and no context. State lives in one
 * zustand store that anything can read; the renderer is reached through a
 * module-level handle rather than through React; and the copy deck is a frozen
 * object. Wrapping any of that in a provider would add a re-render boundary
 * without adding a capability.
 *
 * What this file does own is the ERROR BOUNDARY, because a shell that throws must
 * not take the terrain down with a blank page. A React error is routed into the
 * same DEGRADED state every engine failure uses, with the same three fields —
 * a code, what failed, and an exact remedy — so a rendering bug is reported by
 * the same instrument as a transport failure, in the same words.
 * =============================================================================
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { COPY } from '@/copy';
import { useAtlas } from '@/state';
import { Shell } from '@/ui/shell';

import '@/styles/base.css';
import '@/styles/primitives.css';

interface BoundaryState {
  failed: boolean;
}

/**
 * FAIL LOUD, IN THE PRODUCT'S OWN VOICE.
 *
 * The boundary does not render an apology. It degrades the store — which is what
 * raises the full-width alarm bar with the code, the failure and the remedy —
 * and then re-renders the shell underneath it, so the terrain, the HUD and the
 * last answer all survive a broken panel.
 */
class ShellBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[App] the shell threw', error, info.componentStack);
    useAtlas.getState().degrade({
      code: 'SHELL_RENDER_FAILED',
      what_failed: `A panel in the interface threw while rendering: ${error.message}`,
      exact_remedy:
        'Press Recover to return to the last good state. If it recurs, open the browser console — the component stack was logged there — and report it with the trace id from the receipt.',
    });
  }

  override componentDidUpdate(): void {
    // One retry per failure. The store is now in DEGRADED and the bar is up, so
    // remounting the shell shows the working instrument beside the real alarm.
    if (this.state.failed) this.setState({ failed: false });
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="shell shell--bare">
          <p className="t-14 ink-dim" data-prose>
            {COPY.states.DEGRADED.body}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App(): JSX.Element {
  return (
    <ShellBoundary>
      <Shell />
    </ShellBoundary>
  );
}

export default App;
