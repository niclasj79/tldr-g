/**
 * SCRIMOVERLAY — for the rare full-bleed state, and it is a REAL DIALOG now.
 *
 * FIRST-RUN, the help sheet, a DEGRADED stop. Not for confirmations and never
 * for anything the terrain could have said in place.
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
 *
 * -----------------------------------------------------------------------------
 * WHAT IT DID NOT DO, AND WHAT THAT COST
 * -----------------------------------------------------------------------------
 * This component had Escape and click-outside and NOTHING ELSE: no `role`, no
 * `aria-modal`, no focus trap, and no focus restore. Both surfaces built on it
 * inherited all four gaps. Opening help with `?` left focus on whatever the
 * terrain had, so a keyboard reader pressed Tab and walked straight out of an
 * overlay that was covering the entire viewport — into controls they could not
 * see and could not reach with a pointer either. Closing it dropped focus at the
 * top of the document rather than back on the control that opened it, which
 * turns "glance at the help" into "find your place again".
 *
 * All three are fixed HERE rather than in the two callers, because a focus trap
 * implemented twice is a focus trap that is correct once.
 *
 * -----------------------------------------------------------------------------
 * WHY THE DIALOG ROLE IS CONDITIONAL
 * -----------------------------------------------------------------------------
 * The scrim element is the BACKDROP: it spans the viewport and a click on it
 * dismisses. Declaring `role="dialog"` on it unconditionally would have given
 * the command palette — which already, correctly, declares its own dialog on its
 * inner box — two nested dialogs, the outer of which is named after the
 * backdrop. So the semantics attach exactly when this component is given a name
 * (`label` / `labelledBy`) and the caller has therefore made it the dialog.
 *
 * The BEHAVIOUR is unconditional. A trap and a restore are not semantics; the
 * palette needs both whether or not it hands its name over.
 *
 * -----------------------------------------------------------------------------
 * WHY THERE IS A STACK, AND WHAT IT COST NOT TO HAVE ONE
 * -----------------------------------------------------------------------------
 * The `focusin` guard below was written as if one overlay could ever be up. Two
 * can: `ui.help` and `ui.search` are independent booleans and the help dialog's
 * own Keyboard fold advertises the key that opens the second one — with focus
 * resting on the help dialog's Walkthrough button, `/` is not an editable-target
 * press, so it dispatches and `document.querySelectorAll('.scrim').length` is 2.
 *
 * With both mounted, each overlay's handler saw focus land outside ITSELF and
 * called `.focus()`, which fired `focusin` on the other, which pulled it back.
 * Measured with both open and a breaker installed: a strict alternating trace
 * `INPUT.ix-palette__input -> BUTTON.btn.btn-quiet.btn-sm.tone-render -> …` that
 * ran 41 hops before the breaker stopped it. In a browser that actually holds
 * system focus this is synchronous unbounded recursion — RangeError: Maximum
 * call stack size exceeded, and the renderer is wedged. It did not show up in a
 * live check because the pane under test was hidden, `document.hasFocus()` was
 * false, and `focusin` therefore never fired natively.
 *
 * A trap is only correct if it knows whether it is the TOP-MOST modal, so the
 * mounted overlays are kept in a module-level stack and exactly one of them —
 * the last pushed — enforces containment. Everything under it stands down until
 * it unmounts and pops. One handler acting means the focus it takes lands inside
 * itself, which is the early-return case, so the chain terminates in one hop.
 */

/* `ReactKeyDown` is aliased deliberately: importing React's `KeyboardEvent`
   under its own name shadows the DOM one, and the window-level Escape listener
   below is typed against the DOM event. Two different KeyboardEvents in one file
   is a trap worth naming rather than rediscovering. */
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyDown,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from './tone';

/**
 * Everything a Tab press can legally land on.
 *
 * `summary` is in the list because the whole help glossary is 42 `<details>`
 * elements and their summaries are the only way into them. `[tabindex="-1"]` is
 * out of it because that is precisely what "focusable by script, not by Tab"
 * means — including the overlay's own root, which is the fallback target rather
 * than a stop.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Is this element hidden inside a collapsed `<details>` somewhere under `root`?
 *
 * MEASURED, NOT ASSUMED. A rect test alone does NOT catch this: with the help
 * dialog's five folds shut, `getBoundingClientRect()` on a cross-reference
 * button eleven levels inside them still reported `143 × 19` at a real page
 * position, while `focus()` on the same element was a no-op — because Chrome
 * hides closed details content by skipping its rendering rather than by removing
 * its box. Trusting the rect gave a trap whose "last stop" was an unreachable
 * button, so Shift+Tab from the first control moved nowhere at all.
 *
 * A `<summary>` is exempt from its OWN details, which is the whole point of it:
 * it is the control that opens the thing it is inside.
 */
function inCollapsedDetails(el: HTMLElement, root: HTMLElement): boolean {
  let child: HTMLElement = el;
  let parent: HTMLElement | null = el.parentElement;
  while (parent !== null && parent !== root) {
    if (
      parent instanceof HTMLDetailsElement &&
      !parent.open &&
      child.tagName !== 'SUMMARY'
    ) {
      return true;
    }
    child = parent;
    parent = parent.parentElement;
  }
  return false;
}

/**
 * The focusable elements that are actually reachable, in DOM order.
 *
 * THE VISIBILITY TESTS ARE LOAD-BEARING, not defensive tidiness. The help dialog
 * holds 42 glossary entries behind disclosures; measured with the folds shut it
 * has SEVEN reachable controls, and the rect test alone counted 139. A trap that
 * cycles through 132 things the reader cannot see is not a trap, it is a maze.
 */
function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0 && !inCollapsedDetails(el, root),
  );
}

/* -----------------------------------------------------------------------------
   THE LIVE OVERLAY STACK
   -----------------------------------------------------------------------------
   Mounted overlays, deepest last. It holds the REF OBJECTS rather than the DOM
   nodes because a ref is stable for the whole life of one mount while its
   `.current` is null before the first commit and after the last — so identity
   here survives exactly as long as the component does, which is what "is this
   one still up" has to mean.

   Push happens BEFORE the overlay takes focus, or the overlay it is opening over
   would still be top for one turn and would yank the focus straight back.
   -------------------------------------------------------------------------- */
type OverlayRef = { current: HTMLDivElement | null };

const LIVE: OverlayRef[] = [];

function isTopmost(overlay: OverlayRef): boolean {
  return LIVE.length > 0 && LIVE[LIVE.length - 1] === overlay;
}

export interface ScrimOverlayProps {
  children?: ReactNode;
  /** Called on Escape and on a click landing on the scrim itself. */
  onDismiss?: () => void;
  className?: string;
  /**
   * The dialog's accessible name. Supplying this (or `labelledBy`) is what makes
   * this element the dialog — see the header. Say what the surface is FOR; it is
   * announced before any of the content.
   */
  label?: string;
  /** Id of the element that names the dialog. Wins over `label` when both are set. */
  labelledBy?: string;
}

export function ScrimOverlay({
  children,
  onDismiss,
  className,
  label,
  labelledBy,
}: ScrimOverlayProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!onDismiss) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  /**
   * Take focus on open, hold it, and give it back on close.
   *
   * The opener is read at MOUNT, which is the only moment it is still true — by
   * the time this unmounts, `document.activeElement` is whatever the closing
   * control was, or `<body>` if the close came from Escape.
   *
   * The `focusin` guard is the half a keydown trap cannot cover: focus can also
   * arrive from a click on the page underneath, from the browser returning it
   * after the address bar, or from a programmatic `.focus()` in a component that
   * does not know an overlay is up. Whatever the route, it comes back.
   *
   * IT ONLY COMES BACK TO THE TOP-MOST ONE. See the header: two overlays each
   * reclaiming focus from the other is not a trap, it is a loop, and it was one
   * — 41 alternating hops before a breaker stopped it. Everything under the top
   * of the stack keeps its listener registered and does nothing with it, so the
   * moment the top pops the one beneath resumes trapping with no re-subscribe.
   */
  useEffect(() => {
    const opener = document.activeElement;
    LIVE.push(ref);
    const root = ref.current;
    if (root !== null) (focusableIn(root)[0] ?? root).focus();

    const onFocusIn = (e: FocusEvent): void => {
      const live = ref.current;
      if (live === null) return;
      if (!isTopmost(ref)) return;
      if (e.target instanceof Node && live.contains(e.target)) return;
      (focusableIn(live)[0] ?? live).focus();
    };
    document.addEventListener('focusin', onFocusIn);

    return () => {
      document.removeEventListener('focusin', onFocusIn);
      /* Popped by identity, not by `pop()`: overlays do not always close in the
         order they opened, and a blind pop would leave the survivor believing it
         is not top and trapping nothing. */
      const at = LIVE.lastIndexOf(ref);
      if (at !== -1) LIVE.splice(at, 1);
      /* Only a real, still-connected control gets it back. Focusing `<body>`
         would be a no-op dressed as a restore, and focusing an element that the
         close itself unmounted throws. */
      if (
        opener instanceof HTMLElement &&
        opener !== document.body &&
        opener.isConnected
      ) {
        opener.focus();
      }
    };
  }, []);

  /** Tab and Shift+Tab wrap inside the overlay. The last stop leads to the first. */
  const onKeyDown = useCallback((e: ReactKeyDown<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return;
    const root = ref.current;
    if (root === null) return;
    const items = focusableIn(root);
    if (items.length === 0) {
      // Nothing to move to. Swallowing the press is the trap: the alternative is
      // Tab leaving a viewport-covering overlay for controls behind it.
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  if (typeof document === 'undefined') return null;

  const named = label !== undefined || labelledBy !== undefined;

  return createPortal(
    <div
      ref={ref}
      className={cx('scrim', className)}
      /* -1: reachable by the trap's fallback, never a Tab stop of its own. */
      tabIndex={-1}
      role={named ? 'dialog' : undefined}
      aria-modal={named ? true : undefined}
      aria-label={labelledBy === undefined ? label : undefined}
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (onDismiss && e.target === e.currentTarget) onDismiss();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
