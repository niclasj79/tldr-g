/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE RAIL
 * =============================================================================
 *
 * Right, 320px, and it is no longer a document.
 *
 * A left rail would take the horizontal away from the terrain, which is the one
 * thing the terrain is not allowed to lose — `npm run check` fails the build on
 * one, and `window.__atlas.audit()` looks for the SHAPE of one at runtime in
 * case somebody builds it under a different name. That law is unchanged. What
 * changed is what this column DOES with its height.
 *
 * -----------------------------------------------------------------------------
 * IT USED TO STACK; NOW IT PINS AND SWITCHES
 * -----------------------------------------------------------------------------
 * The old rail appended every panel any switch had ever turned on, in a reading
 * order that was argued for at length and was still 6,409px tall against a 632px
 * viewport in one measured state. The order was right and the mechanism was
 * wrong: you cannot read the fourth section while looking at the first, so
 * putting them in one scroll bought nothing and cost the ability to find any of
 * them.
 *
 * The column is now three bands:
 *
 *   PINNED   the question, the answer, and the answer's trust state — plus the
 *            reverse actions and the tab strip. Never scrolls away, because
 *            every one of those is context for whatever is below it.
 *   BODY     exactly ONE surface. A result tab, or the workspace lens that has
 *            replaced them.
 *   FOOT     the one destructive control in the product, under a rule.
 *
 * -----------------------------------------------------------------------------
 * A LENS REPLACES THE RESULT DETAIL; IT DOES NOT APPEND TO IT
 * -----------------------------------------------------------------------------
 * This is the rule that keeps the fix from unravelling. Analyst Mode used to add
 * its controls BELOW everything already in the column, which is how a lit switch
 * ended up showing none of itself. Entering a lens now takes the body — the
 * question, the answer and the trust state stay pinned above it, because a lens
 * is a way of looking at THIS result, not a different session.
 *
 * -----------------------------------------------------------------------------
 * TOUCH TURNS IT INTO A BOTTOM SHEET
 * -----------------------------------------------------------------------------
 * Not a preference — a reach. Nobody holding a tablet in two hands can work a
 * 320px column pinned to the right edge, and every one of them can reach the
 * bottom. The switch is `[data-density='touch']` in the stylesheet; not one line
 * of this component knows about it, which is how it stays one rail.
 * =============================================================================
 */

import { useEffect, useRef } from 'react';

import { COPY } from '@/copy';
import { AtlasMode } from '@/ui/atlas';
import { useAtlas, useAtlasStore } from '@/state';
import { InspectorBody, QuarantinePanel } from '@/ui/provenance';
import { Btn, Tip } from '@/ui/primitives';

import { AnalystRail } from './AnalystMode';
import { AnswerPanel } from './AnswerPanel';
import { CorpusPanel, StagedQuestions } from './CorpusPanel';
import { EvidenceTab } from './EvidenceTab';
import { NavStack } from './NavStack';
import { Orientation } from './Orientation';
import { ResultTabs, panelIdFor } from './ResultTabs';
import { TaskHeader } from './TaskHeader';
/* The skip link's destination. Declared beside the control that jumps to it. */
import { TASK_ANCHOR_ID } from './TerrainOutline';
import { TimelinePanel } from './TimelinePanel';

import './result.css';

export interface InspectorRailProps {
  className?: string;
}

export function InspectorRail({ className }: InspectorRailProps): JSX.Element | null {
  const { lens, tab, hasAnswer, hasNode, hasCorpus, forming, queryId, quarantine } = useAtlasStore((s) => ({
    lens: s.lens,
    tab: s.tab,
    hasAnswer: s.query.active !== null,
    hasNode: s.focus !== null || s.selection.length > 0 || s.hover !== null,
    hasCorpus: s.view !== null,
    forming: s.app === 'INGESTING' || s.app === 'SETTLING',
    queryId: s.query.active?.query_id ?? null,
    quarantine: s.ui.quarantine,
  }));

  /* A NEW SURFACE IS A NEW DOCUMENT. Landing a render, or switching tabs, with
     the body still scrolled to wherever the last one was read shows the middle
     of something that has been replaced. Only the BODY scrolls now, so this
     scrolls the body — the question above it was never going anywhere. */
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [queryId, tab, lens]);

  // BEFORE THE CORPUS THERE IS NOTHING TO INSPECT. A 320px glass column holding
  // one panel that says "nothing selected" is not a restrained empty state, it is
  // a sixth of the frame spent telling the user what they already know. The
  // terrain takes the width back until there is something in it.
  if (!hasCorpus) return null;
  // AND NOT WHILE THE WORLD IS FORMING. During INGESTING and SETTLING the rail
  // had nothing in it but a hover hint for a map you cannot point at yet and a
  // control that throws away the corpus currently landing — 320px of empty glass
  // beside the one screen where the terrain is the entire story. The chrome
  // arrives when it has something to say, which is the same rule FIRST-RUN uses.
  if (forming) return null;

  return (
    <aside className={['shell__rail', className].filter(Boolean).join(' ')} aria-label={COPY.inspector.title}>
      {/* ---- PINNED. Context for everything below, so it never scrolls away. */}
      <div className="rail__pinned" id={TASK_ANCHOR_ID} tabIndex={-1}>
        <TaskHeader />
        <NavStack />
        {lens === 'explore' ? <ResultTabs /> : null}
      </div>

      {/* ---- BODY. Exactly one surface. --------------------------------- */}
      <div ref={body} className="rail__body u-scroll">
        {lens === 'timeline' ? (
          <TimelinePanel />
        ) : lens === 'analyze' ? (
          <>
            <AnalystRail />
            {quarantine ? <QuarantinePanel /> : null}
          </>
        ) : !hasAnswer ? (
          /* NOTHING HAS BEEN ASKED, AND THE ORDER IS THE ARGUMENT.
             It used to lead with Atlas Mode — the altimeter, the ledger, the
             guided descent — which is the EXPERT navigation surface, offered
             first to the one reader guaranteed not to be an expert yet. A
             newcomer needs, in this order: what to do, what they may ask, what
             they are looking at, and only then the instrument for going
             somewhere specific. */
          <>
            <Orientation />
            <StagedQuestions />
            <CorpusPanel />
            <AtlasMode className="shell__atlas" />
          </>
        ) : tab === 'answer' ? (
          <div id={panelIdFor('answer')} role="tabpanel" aria-labelledby="rail-tab-answer" tabIndex={-1}>
            <AnswerPanel />
          </div>
        ) : tab === 'evidence' ? (
          <div id={panelIdFor('evidence')} role="tabpanel" aria-labelledby="rail-tab-evidence" tabIndex={-1}>
            <EvidenceTab />
          </div>
        ) : (
          <div id={panelIdFor('inspect')} role="tabpanel" aria-labelledby="rail-tab-inspect" tabIndex={-1}>
            {hasNode ? (
              <InspectorBody />
            ) : (
              /* NOT AN ERROR, AN INVITATION — AND NOT A DEAD END EITHER.
                 The old rail printed a bordered box whose entire content was
                 "nothing is selected": chrome reporting on the user rather than
                 on the engine. One sentence was an improvement on that and was
                 still a surface with nothing to do on it.

                 An empty inspector is precisely the moment a reader wants to
                 know WHAT IS HERE, so it holds the level's own ledger — the
                 bodies at this detail level, ranked, searchable, and selectable.
                 That also gives the ledger a permanent home: it lives in the
                 Explore rail while nothing has been asked, and here once a
                 result has taken that column, which are the only two states
                 there are. A surface reachable in one state and not the other is
                 how the altimeter and this ledger became unreachable in the
                 first place. */
              <>
                <p className="rail__empty t-13 ink-dim" data-prose>
                  {COPY.tabs.inspectEmpty}
                </p>
                <AtlasMode className="shell__atlas" />
              </>
            )}
          </div>
        )}
      </div>

      {/* ---- FOOT. The one destructive control in the product, under a rule.
          It used to sit in the top bar, at the end of the highest-value pixel
          row on the screen, next to the wordmark — a control that throws the
          corpus away, one slip from the button that renders. Down here it is
          reachable, it is named, and it is nowhere near anything you press
          often. */}
      <div className="rail__foot">
        <Tip content={COPY.topbar.close.title}>
          <Btn variant="ghost" size="sm" onClick={() => useAtlas.getState().unload('EMPTY')}>
            {COPY.topbar.close.label}
          </Btn>
        </Tip>
      </div>
    </aside>
  );
}
