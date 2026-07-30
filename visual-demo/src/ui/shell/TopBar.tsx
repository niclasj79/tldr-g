/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE TOP BAR
 * =============================================================================
 *
 * 48px, and FOUR THINGS. Who this is, where you are, what you are asking, and
 * which instruments are open.
 *
 * It is deliberately the least interesting band on the screen. Everything in it
 * is either a name, a place or a switch; not one number lives here, because a
 * number belongs in the HUD where it can be read as instrumentation rather than
 * as chrome.
 *
 * -----------------------------------------------------------------------------
 * WHAT WAS TAKEN OUT, AND WHY
 * -----------------------------------------------------------------------------
 * This row carried fourteen controls at equal rank and read as a toolbar. Four
 * things left it and the difference is the whole point of the band:
 *
 *   the tagline      a claim about mechanism, and it belongs where there is room
 *                    to make it: FIRST-RUN and the help overlay. Beside a
 *                    wordmark at 11px it was a byline nobody read twice. It
 *                    survives as the wordmark's own tooltip.
 *   the key hints    `/` and `Q` printed next to the control they operate is a
 *                    tutorial pinned to the instrument. The help overlay is
 *                    generated from the same KEYMAP and is one keystroke away.
 *   the latency      a measurement. The HUD prints it, once.
 *   Close corpus     a destructive-sounding control in the highest-value pixel
 *                    row of the product. It moved to the foot of the rail,
 *                    under a rule, where a destructive control belongs.
 *
 * The five panel switches are now ONE GROUP in a bordered well rather than five
 * peers of the wordmark, so the eye reads "panels" once instead of counting to
 * five. `?` sits outside it because it is not a panel over the terrain, it is
 * the manual.
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
import { keyHintFor, useAtlas, useAtlasStore } from '@/state';
import type { UiPanel } from '@/state';
import { Chip, KeyHint, StateDot, Tip } from '@/ui/primitives';
import type { DotState } from '@/ui/primitives';

import { CommandBar } from './CommandBar';
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

/** The panels the top bar switches, in the order the keyboard map lists them. */
const SWITCHES: readonly { panel: UiPanel; label: string; key: Parameters<typeof keyHintFor>[0] }[] = [
  { panel: 'atlas', label: COPY.atlas.title, key: 'atlas' },
  { panel: 'inspector', label: COPY.inspector.title, key: 'inspector' },
  { panel: 'receipt', label: COPY.receipt.keyHintLabel, key: 'receipt' },
  { panel: 'timeline', label: COPY.timeline.title, key: 'timeline' },
  { panel: 'analyst', label: COPY.analyst.title, key: 'analyst' },
];

export interface TopBarProps {
  className?: string;
}

export function TopBar({ className }: TopBarProps): JSX.Element {
  const ui = useAtlasStore((s) => s.ui);
  const app = useAtlasStore((s) => s.app);

  return (
    <header className={['topbar', className].filter(Boolean).join(' ')}>
      <div className="topbar__id">
        <StateDot state={DOT[app]} />
        <Tip content={COPY.product.taglineGloss}>
          <span className="topbar__name t-12-5 w-650">{COPY.product.name}</span>
        </Tip>
      </div>

      <Breadcrumb className="topbar__crumbs" />

      <CommandBar className="topbar__cmd" />

      <div className="topbar__right">
        {/* ONE GROUP, NOT FIVE PEERS. The well is the grouping; the lit box
            inside it is the state. */}
        <div className="topbar__panels" role="group" aria-label={COPY.topbar.panels.label}>
          {SWITCHES.map((s) => (
            <Tip
              key={s.panel}
              content={
                <span className="topbar__tip">
                  {s.label}
                  <KeyHint keys={keyHintFor(s.key)} />
                </span>
              }
            >
              {/* A PANEL SWITCH IS NOT THE RENDER CONTROL.
                  These five wore --render when lit, which put up to five teal
                  boxes in the top bar of a capture. Teal has one job here —
                  the engine's attention: the rendered path, the active
                  selection, the button that spends tokens — and a row of teal
                  chips for "is the timeline open" is how that stops being
                  legible. Active is still unmistakable: `.chip.is-active`
                  fills and outlines in whatever tone it is given, and in ink
                  the box is doing the work rather than the colour. */}
              <Chip
                active={ui[s.panel]}
                tone={ui[s.panel] ? 'neutral' : 'dim'}
                onClick={() => {
                  useAtlas.getState().toggle(s.panel);
                  if (s.panel === 'timeline' && useAtlas.getState().timeline === null) {
                    void useAtlas.getState().loadTimeline();
                  }
                }}
              >
                {s.label}
              </Chip>
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
          <Chip
            active={ui.help}
            tone={ui.help ? 'neutral' : 'dim'}
            onClick={() => useAtlas.getState().toggle('help')}
          >
            {keyHintFor('help')[0]}
          </Chip>
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
