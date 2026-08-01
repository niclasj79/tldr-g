/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE TOP BAR
 * =============================================================================
 *
 * 48px, and FOUR THINGS. Who this is, where you are, which workspace you are in,
 * and the manual.
 *
 * It is deliberately the least interesting band on the screen. Everything in it
 * is either a name, a place or a switch; not one number lives here, because a
 * number belongs in the HUD where it can be read as instrumentation rather than
 * as chrome.
 *
 * -----------------------------------------------------------------------------
 * THE FIVE SWITCHES WERE NOT FIVE OF THE SAME THING
 * -----------------------------------------------------------------------------
 * This row used to carry Atlas · Inspector · Provenance · Timeline · Analyst as
 * five independent toggles at equal rank, any subset of which could be lit at
 * once. They were never peers:
 *
 *   Atlas, Analyst   WORKSPACES you enter
 *   Timeline         a LENS over the same data
 *   Provenance       detail about a RESULT
 *   Inspector        detail about a SELECTION
 *
 * Presenting four different kinds of thing as one row of switches made operating
 * the instrument a task the user had to complete before asking their question,
 * and it let the rail grow to six thousand pixels because every switch appended
 * rather than replaced. So the row now carries the one kind that genuinely
 * belongs in a global chrome band — WHICH WORKSPACE YOU ARE IN — as a segmented
 * control with exactly one segment lit, and the two detail surfaces moved into
 * the rail as tabs over the result they describe.
 *
 * -----------------------------------------------------------------------------
 * THE COMPOSER LEFT THIS ROW, AND THAT IS WHAT MADE THE ROOM
 * -----------------------------------------------------------------------------
 * The question used to be an input flexing between 520px and a 220px floor in the
 * middle of this bar. At 1280px it truncated heavily; near 1024px it was
 * effectively gone — the single most important thing on the screen, squeezed out
 * by the chrome around it, at exactly the widths where a user most needs to see
 * what they asked. It lives at the top of the rail now, sticky, at full width,
 * and it never has to compete with a wordmark again.
 *
 * WHAT THAT BOUGHT: the breadcrumb no longer disappears below 1500px. It used to
 * be the first thing cut, which meant orientation was withdrawn at exactly the
 * viewport where orientation was hardest. It is now permanent, in two forms — the
 * full ancestry when there is room, a compact scope-and-level readout when there
 * is not — and it is never absent.
 *
 * THE STATUS DOT IS NOT DECORATION. It maps onto `AppState` and nothing else:
 * off before there is a corpus, pending while real work is in flight, on when
 * the instrument is at rest, alarm when something has actually failed. There is
 * no fifth state and there is no "busy" that is not a real await.
 * =============================================================================
 */

import { COPY } from '@/copy';
import type { AppState } from '@/engine';
import { Breadcrumb } from '@/ui/atlas';
import { keyHintFor, useAtlas, useAtlasStore, LENSES } from '@/state';
import type { KeyActionId, Lens } from '@/state';
import { KeyHint, StateDot, Tip } from '@/ui/primitives';
import type { DotState } from '@/ui/primitives';

import { ShareControl } from './ShareControl';

/* The dot is a function of the machine, so it is written as one. */
const DOT: Readonly<Record<AppState, DotState>> = {
  'FIRST-RUN': 'off',
  EMPTY: 'off',
  INGESTING: 'pending',
  SETTLING: 'pending',
  READY: 'on',
  QUERYING: 'pending',
  DEGRADED: 'fail',
};

/** The three workspaces, with the binding each one is reached by. */
const LENS_KEY: Readonly<Record<Lens, KeyActionId>> = {
  explore: 'lens-explore',
  timeline: 'lens-timeline',
  analyze: 'lens-analyze',
};

export interface TopBarProps {
  className?: string;
}

export function TopBar({ className }: TopBarProps): JSX.Element {
  const { help, app, lens } = useAtlasStore((s) => ({
    help: s.ui.help,
    app: s.app,
    lens: s.lens,
  }));

  return (
    <header className={['topbar', className].filter(Boolean).join(' ')}>
      <div className="topbar__id">
        <StateDot state={DOT[app]} />
        <Tip content={COPY.product.taglineGloss}>
          <span className="topbar__name t-13 w-650">{COPY.product.name}</span>
        </Tip>
      </div>

      {/* WHERE YOU ARE. Permanent at every width — see the header. */}
      <Breadcrumb className="topbar__crumbs" />

      <div className="topbar__right">
        {/* ONE SEGMENTED CONTROL, ONE LIT SEGMENT.
            `radiogroup` rather than a group of toggle buttons, because that is
            what mutual exclusion IS — and it means a screen reader announces
            "2 of 3" rather than three independent pressed states, which is the
            same correction the visual design is making. */}
        <div
          className="topbar__lenses"
          role="radiogroup"
          aria-label={COPY.topbar.lenses.label}
        >
          {LENSES.map((l) => (
            <Tip
              key={l}
              content={
                <span className="topbar__tip">
                  {COPY.lenses[l].long}
                  <KeyHint keys={keyHintFor(LENS_KEY[l])} />
                </span>
              }
            >
              <button
                type="button"
                className="topbar__lens"
                role="radio"
                aria-checked={lens === l}
                data-active={lens === l}
                onClick={() => void useAtlas.getState().setLens(l)}
              >
                {COPY.lenses[l].label}
              </button>
            </Tip>
          ))}
        </div>

        <Tip
          content={
            <span className="topbar__tip">
              {COPY.help.title}
              <KeyHint keys={keyHintFor('help')} />
            </span>
          }
        >
          <button
            type="button"
            className="topbar__aux"
            aria-expanded={help}
            data-active={help}
            onClick={() => useAtlas.getState().toggle('help')}
          >
            {COPY.help.label}
          </button>
        </Tip>

        <ShareControl />

        {/* The corpus marker is a claim about the whole product, so it is visible
            from every screen. It is NOT evidence — gold in this product means an
            evidence anchor, and a badge that wears the evidence light on all
            twenty-one screens is what made gold stop meaning anything. It reads
            as a stamp, in ink. */}
        <Tip content={COPY.provenance.long}>
          <span className="topbar__corpus caps" data-prose>
            {COPY.provenance.badge}
          </span>
        </Tip>
      </div>
    </header>
  );
}
