/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE STAGED QUESTION
 * =============================================================================
 *
 * The ONE home of a question that has not been run.
 *
 * The question used to be on screen three times at once — the top-bar input, a
 * floating card over the terrain, and this panel — which is three instruments
 * reporting one fact and one of them sitting on the map. The card is gone and
 * its sentence lives here, directly under the button it is about: the engine has
 * not spent a token on this yet, and THIS is the control that makes it spend.
 *
 * Every field of it is real: `StagedQuery` is an engine payload with a declared
 * intent, a declared mode and the corpus's own one-line reason for the question
 * existing.
 *
 * IT DOES NOT PRINT THE GOLD ANSWER. The corpus holds a by-construction answer
 * for every staged question and the receipt shows it afterwards, which is what
 * makes the engine scoreable. Printing it BEFORE the render would answer the
 * question in the chrome and leave the engine with nothing to demonstrate. So
 * the panel discloses that a known answer exists — which is the honest part —
 * and keeps the value until there is a render to check it against.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS NOT HERE ANY MORE
 * -----------------------------------------------------------------------------
 * Two explanatory paragraphs. The rail was arguing with the reader in five grey
 * paragraphs across its length while truncating its own field labels; a
 * rationale is a thing you reach for, not a thing you are handed. Both are now
 * the tooltip of the control they explain, which is where a reader looks for
 * them and nowhere else.
 * =============================================================================
 */

import { COPY, intentCopy, modeCopy } from '@/copy';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Chip, KeyHint, Panel, Tip } from '@/ui/primitives';
import { keyHintFor } from '@/state';

export interface StagedPanelProps {
  className?: string;
}

export function StagedPanel({ className }: StagedPanelProps): JSX.Element | null {
  const { staged, stagedQueries, app, running } = useAtlasStore((s) => ({
    staged: s.query.staged,
    stagedQueries: s.stagedQueries,
    app: s.app,
    running: s.query.running,
  }));

  if (app !== 'READY' && app !== 'QUERYING' && app !== 'DEGRADED') return null;

  const text = staged.trim();
  const declared = stagedQueries.find((q) => q.query === text) ?? null;

  return (
    <Panel
      title={COPY.command.label}
      tone="curiosity"
      className={className}
      actions={
        <Tip content={COPY.search.title}>
          <KeyHint keys={keyHintFor('search')} />
        </Tip>
      }
    >
      {text.length === 0 ? (
        <p className="t-12-5 ink-dim" data-prose>
          {COPY.command.emptyInput}
        </p>
      ) : (
        <p className="staged__q t-14" data-prose>
          {text}
        </p>
      )}

      {declared === null ? (
        <p className="t-11 ink-faint" data-prose>
          {COPY.command.freeText.note}
        </p>
      ) : (
        <>
          <div className="staged__chips">
            <Tip content={intentCopy(declared.intent).long}>
              <Chip tone="curiosity" active>
                {intentCopy(declared.intent).label}
              </Chip>
            </Tip>
            <Tip content={modeCopy(declared.mode).long}>
              <Chip tone="dim">{modeCopy(declared.mode).label}</Chip>
            </Tip>
            {/* The staging disclosure, as a mark rather than as a paragraph. */}
            <Tip content={COPY.provenance.staged}>
              <Chip tone="dim">{COPY.answer.goldLabel}</Chip>
            </Tip>
          </div>
          <span className="caps ink-faint">{COPY.command.menu.why}</span>
          <p className="t-12-5 ink-dim" data-prose>
            {declared.why}
          </p>
        </>
      )}

      {/* THE ACT, AND THE LINE THAT MAKES IT ONE. This is the whole ten-second
          thesis: a question loaded, an engine that has not moved, and a button
          that makes it move. */}
      <Tip content={COPY.command.budget.tip} className="u-block">
        <Btn
          variant="primary"
          onClick={() => void useAtlas.getState().runQuery(text)}
          disabled={text.length === 0 || app !== 'READY'}
          title={COPY.command.run.title}
        >
          {running ? COPY.command.running.label : COPY.command.run.label}
        </Btn>
      </Tip>

      <p className="staged__thesis t-12-5" data-prose>
        {running ? COPY.command.running.note : COPY.command.staged.hint}
      </p>
    </Panel>
  );
}
