/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE RESULT TABS
 * =============================================================================
 *
 * Three surfaces, one at a time, over a pinned question and answer.
 *
 * WHAT THIS REPLACED, MEASURED. The rail was a single scroll column that
 * appended every panel any switch had ever turned on. In one tested state it was
 * 6,409px tall against a 632px viewport:
 *
 *     answer          875px
 *     render trace  3,022px
 *     signature       746px
 *     inspector     1,442px
 *
 * Turning Analyst Mode on lit its switch in the top bar and put every control it
 * added several screens below the fold — a control that reports itself as active
 * while showing you none of itself. That is not a long panel; it is a document
 * with a toolbar, and nobody can hold a document's fourth section in mind while
 * reading its first.
 *
 * -----------------------------------------------------------------------------
 * WHY TABS RATHER THAN COLLAPSED SECTIONS
 * -----------------------------------------------------------------------------
 * Accordions keep the vertical problem: eight collapsed headers still cost a
 * scroll, and any two open sections put the second one below the fold again.
 * Tabs make the exclusivity structural — the rail is exactly one surface tall,
 * always, and the question and answer above them never move.
 *
 * PROGRESSIVE DISCLOSURE STILL APPLIES INSIDE EACH TAB. Confidence decomposition,
 * signature internals, cache statistics, relation-family inventories and full
 * passage bodies are collapsed until asked for. Tabs solve "which surface"; the
 * disclosures inside them solve "how much of it".
 *
 * -----------------------------------------------------------------------------
 * THE ARIA IS THE DESIGN, NOT A COATING ON IT
 * -----------------------------------------------------------------------------
 * `tablist` / `tab` / `tabpanel` with roving `tabindex` and arrow-key movement is
 * what a tab strip IS. A screen-reader user hears "Evidence, tab 2 of 3,
 * selected" — the same fact the lit segment carries visually — and Home/End
 * reach the ends the same way the pointer does.
 * =============================================================================
 */

import { useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { COPY } from '@/copy';
import { keyHintFor, useAtlas, useAtlasStore, RESULT_TABS } from '@/state';
import type { KeyActionId, ResultTab } from '@/state';
import { KeyHint, Num, Tip } from '@/ui/primitives';

/** The binding each tab is also reachable by, so the hint and the handler agree. */
const TAB_KEY: Readonly<Record<ResultTab, KeyActionId>> = {
  answer: 'tab-answer',
  evidence: 'tab-evidence',
  inspect: 'tab-inspect',
};

/** The id a tab's panel carries, so `aria-controls` points at something real. */
export function panelIdFor(tab: ResultTab): string {
  return `rail-panel-${tab}`;
}

export interface ResultTabsProps {
  className?: string;
}

export function ResultTabs({ className }: ResultTabsProps): JSX.Element | null {
  const { tab, hasAnswer, evidenceCount, hasNode } = useAtlasStore((s) => ({
    tab: s.tab,
    hasAnswer: s.query.active !== null,
    /* THE COUNT IS THE PROMISE. `Evidence 7` says how many sources are behind
       the answer before the tab is opened, which is the number a sceptic wants
       first and the one the old chip only revealed after navigating away. */
    evidenceCount:
      s.query.active === null
        ? 0
        : new Set(s.query.active.constellation.path.flatMap((step) => step.evidence_passage_ids)).size,
    hasNode: s.focus !== null || s.selection.length > 0,
  }));

  const strip = useRef<HTMLDivElement>(null);

  if (!hasAnswer) return null;

  /* ROVING FOCUS. Exactly one tab is in the tab order; the arrows move between
     them. Three tab stops for one control is how a keyboard user ends up
     tabbing through a strip they meant to step past. */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const i = RESULT_TABS.indexOf(tab);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? RESULT_TABS.length - 1
          : (i + (e.key === 'ArrowRight' ? 1 : RESULT_TABS.length - 1)) % RESULT_TABS.length;
    useAtlas.getState().setTab(RESULT_TABS[next], { pin: true });
    // Focus follows selection in an automatic-activation tablist, which is the
    // right pattern here: every panel is already rendered from local state and
    // switching costs nothing, so requiring Enter would be ceremony.
    requestAnimationFrame(() => {
      strip.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    });
  };

  return (
    <div
      ref={strip}
      className={['rtabs', className].filter(Boolean).join(' ')}
      role="tablist"
      aria-label={COPY.tabs.label}
      onKeyDown={onKeyDown}
    >
      {RESULT_TABS.map((t) => {
        const copy = COPY.tabs[t];
        const selected = tab === t;
        return (
          <Tip
            key={t}
            content={
              <span className="rtabs__tip">
                {copy.long}
                <KeyHint keys={keyHintFor(TAB_KEY[t])} />
              </span>
            }
          >
            <button
              type="button"
              className="rtabs__tab"
              role="tab"
              id={`rail-tab-${t}`}
              aria-selected={selected}
              aria-controls={panelIdFor(t)}
              tabIndex={selected ? 0 : -1}
              data-active={selected}
              onClick={() => useAtlas.getState().setTab(t, { pin: true })}
            >
              <span className="rtabs__name">{copy.label}</span>
              {t === 'evidence' && evidenceCount > 0 ? (
                <Num value={evidenceCount} format="int" tone={selected ? 'evidence' : 'dim'} className="rtabs__n" />
              ) : null}
              {/* AN EMPTY INSPECT TAB SAYS SO BEFORE IT IS OPENED. A tab that
                  looks available and is empty is a click spent learning nothing. */}
              {t === 'inspect' && !hasNode ? <span className="rtabs__dot" aria-hidden="true" /> : null}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}
