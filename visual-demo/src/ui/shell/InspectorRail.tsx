/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE INSPECTOR RAIL
 * =============================================================================
 *
 * Right, collapsible with `I`. THE ONLY PLACE DENSE DETAIL LIVES.
 *
 * A left rail would take the horizontal away from the terrain, which is the one
 * thing the terrain is not allowed to lose — `npm run check` fails the build on
 * one, and `window.__atlas.audit()` looks for the SHAPE of one at runtime in
 * case somebody builds it under a different name.
 *
 * -----------------------------------------------------------------------------
 * ORDER IS ARGUMENT
 * -----------------------------------------------------------------------------
 * The rail is stacked in the order a sceptic reads it, not in the order the
 * panels were built:
 *
 *   ANSWER      what the engine claims, and its own confidence in it
 *   TRACE       what that claim cost — the receipt, and the count-down
 *   SIGNATURE   whether that trace is the one the engine produced
 *   INSPECTOR   whatever node is under the pointer or held        (`I`)
 *   QUARANTINE  what the truth gate threw away
 *   ANALYST     the controls that change what is drawn            (`G`)
 *
 * AND, WHEN NONE OF THAT EXISTS YET, the two panels the resting frame needs:
 * the corpus's own staged questions, and the census of the bake the map is drawn
 * against. They are LAST in the file and last in the column, because they are
 * what the rail holds while it waits rather than what it is for. Before them
 * this column was one QUESTION panel over ~700px of void on the frame everybody
 * sees first. See CorpusPanel.tsx.
 *
 * THE RECEIPT MOVED ABOVE THE SIGNATURE, and it is the one deliberate departure
 * from "verdict above evidence". The reason is a measurement: with the signature
 * block between them, the budget rows — rendered against stuffed context, and
 * the saving — sat below the fold of a 1440px frame in the one screenshot the
 * whole thesis rests on. The product's celebratory moment was invisible in the
 * scene named after it. The signature verdict is four rows and it now sits
 * directly under the arithmetic it is vouching for, which is close enough to be
 * read in the same glance.
 *
 * Every panel below the answer can be closed. The answer cannot, while there is
 * one, because a product that lets you hide the claim and keep the receipt has
 * the relationship backwards.
 *
 * -----------------------------------------------------------------------------
 * ATLAS MODE IS A PANEL IN THIS COLUMN, NOT A SECOND COLUMN
 * -----------------------------------------------------------------------------
 * It used to float its own 300px rail on top of the terrain, beside this one.
 * That is two columns of chrome on a product whose single layout law is that the
 * terrain owns the horizontal, and it cost exactly what you would expect: with
 * Atlas Mode open the unobstructed terrain was 69.7% of the window — under the
 * brief's 70% floor — while `audit()` was still reporting 80.4% because it
 * measured the canvas rect and never asked what was sitting on it.
 *
 * Hosted here it costs the terrain NOTHING: the rail is already 368px wide and
 * already beside the map rather than over it. Atlas Mode takes the top of the
 * column while it is open, because a mode you just entered is the thing you are
 * reading — the same rule Analyst Mode follows below.
 *
 * IT ALSO MEANS THE RAIL CAN BE OPEN WITHOUT THE INSPECTOR BEING ON. `I` toggles
 * the inspector's own panels; the column itself is up whenever anything wants to
 * live in it, or a lit Atlas switch in the top bar would open nothing.
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
import {
  InspectorBody,
  QuarantinePanel,
  ReceiptPanel,
  VerificationPanel,
} from '@/ui/provenance';
import { Btn, Panel, Tip } from '@/ui/primitives';

import { AnalystRail } from './AnalystMode';
import { AnswerPanel } from './AnswerPanel';
import { CorpusPanel, StagedQuestions } from './CorpusPanel';
import { StagedPanel } from './StagedPanel';

export interface InspectorRailProps {
  className?: string;
}

export function InspectorRail({ className }: InspectorRailProps): JSX.Element | null {
  const { ui, hasAnswer, hasTrace, hasNode, hasCorpus, forming, queryId } = useAtlasStore((s) => ({
    ui: s.ui,
    hasAnswer: s.query.active !== null,
    hasTrace: s.trace !== null,
    hasNode: s.focus !== null || s.selection.length > 0 || s.hover !== null,
    hasCorpus: s.view !== null,
    forming: s.app === 'INGESTING' || s.app === 'SETTLING',
    queryId: s.query.active?.query_id ?? null,
  }));

  /* NOTHING HAS BEEN ASKED AND NO MODE IS OPEN. This is the ONLY condition under
     which the column has spare height to give away — the moment an answer, Atlas
     Mode, Analyst Mode or the quarantine report arrives, every pixel below the
     question belongs to it. Deliberately NOT keyed on hover: the node inspector
     comes and goes with the pointer, and a column that rebuilds itself twice a
     second while you read the map is worse than a column with a gap in it. */
  const atRest = !hasAnswer && !ui.atlas && !ui.analyst && !ui.quarantine;

  /* THE RAIL IS A SCROLL COLUMN AND A NEW ANSWER IS A NEW DOCUMENT.
     Landing a render with the column still scrolled to wherever the last one was
     read shows the middle of a receipt for a question that has been replaced. */
  const rail = useRef<HTMLElement>(null);
  useEffect(() => {
    rail.current?.scrollTo({ top: 0 });
  }, [queryId, ui.receipt]);

  // NOTHING WANTS THE COLUMN, SO THE TERRAIN TAKES IT BACK. Atlas Mode lives in
  // here now, so `I` alone no longer decides whether the rail exists.
  if (!ui.inspector && !ui.atlas) return null;
  // BEFORE THE CORPUS THERE IS NOTHING TO INSPECT. A 320px glass column holding
  // one panel that says "nothing selected" is not a restrained empty state, it is
  // a sixth of the frame spent telling the user what they already know. The
  // terrain takes the width back until there is something in it.
  if (!hasCorpus) return null;
  // AND NOT WHILE THE WORLD IS FORMING. During INGESTING and SETTLING the rail
  // had nothing in it but a hover hint for a map you cannot point at yet and a
  // control that throws away the corpus currently landing — 368px of empty glass
  // beside the one screen where the terrain is the entire story. The chrome
  // arrives when it has something to say, which is the same rule FIRST-RUN uses.
  if (forming) return null;

  return (
    <aside
      ref={rail}
      className={['shell__rail', 'u-scroll', className].filter(Boolean).join(' ')}
      aria-label={COPY.inspector.title}
    >
      {/* THE MODE YOU ARE IN OWNS THE TOP OF THE COLUMN. */}
      {ui.atlas ? <AtlasMode className="shell__atlas" /> : null}

      {!ui.inspector ? null : (
        <>
          {hasAnswer ? <AnswerPanel /> : <StagedPanel />}

          {/* THE ARITHMETIC, THEN THE SIGNATURE OVER IT. See the header. */}
          {ui.receipt ? (
            <>
              <ReceiptPanel />
              {hasTrace ? <VerificationPanel /> : null}
            </>
          ) : null}

          {/* THE MODE YOU JUST ENTERED OWNS THE TOP OF WHAT IS LEFT. With the
              analyst controls under the node inspector, turning Analyst Mode on
              put every control it adds below the fold — the switch was lit and
              the frame it produced showed none of it. */}
          <AnalystRail />

          {/* NO EMPTY-INSPECTOR PANEL. A bordered box whose entire content is
              "nothing is selected" is chrome reporting on the user rather than
              on the engine, and it was taking a full panel's worth of the rail
              on the resting screen. The affordance it carried is one line. */}
          {hasNode ? (
            <Panel title={COPY.inspector.title}>
              <InspectorBody />
            </Panel>
          ) : null}

          {ui.quarantine ? <QuarantinePanel /> : null}

          {/* THE REST OF THE COLUMN, WHEN NOTHING HAS BEEN ASKED YET.
              On the resting frame this rail held one QUESTION panel and then
              ~700px of nothing, on the screen everybody sees first. These two
              take that space with the corpus's own question set and the census
              of the bake the map is drawn against — see CorpusPanel.tsx for what
              was deliberately left out of them.

              THEY YIELD THE MOMENT ANYTHING REAL ARRIVES. An answer, a mode, or
              the quarantine report is what this column is for; a census of the
              world is what it holds while it is waiting. They sit BELOW the node
              inspector so that pointing at something never pushes its reading
              under the fold. */}
          {atRest ? (
            <>
              <StagedQuestions />
              <CorpusPanel />
            </>
          ) : null}

          {hasNode ? null : (
            <p className="shell__railhint t-11 ink-faint" data-prose>
              {COPY.hud.hoverHint}
            </p>
          )}

          {/* THE ONE DESTRUCTIVE CONTROL IN THE PRODUCT, AT THE FOOT OF THE
              COLUMN. It used to sit in the top bar, at the end of the
              highest-value pixel row on the screen, next to the wordmark — a
              control that throws the corpus away, one slip from the button that
              renders. Down here it is reachable, it is named, and it is nowhere
              near anything you press often. */}
          <div className="shell__railfoot">
            <Tip content={COPY.topbar.close.title}>
              <Btn variant="ghost" size="sm" onClick={() => useAtlas.getState().unload('EMPTY')}>
                {COPY.topbar.close.label}
              </Btn>
            </Tip>
          </div>
        </>
      )}
    </aside>
  );
}
