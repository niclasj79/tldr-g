/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE COMMAND BAR
 * =============================================================================
 *
 * THE MOST IMPORTANT CONTROL IN THE PRODUCT, because the first render is the
 * USER'S ACT. A question sits here staged and unrun; pressing Render is the
 * moment "render, don't retrieve" stops being a tagline and becomes something
 * the user watched happen. So this is not a search box and it must not read like
 * one: the verb is RENDER, and the line under it says the engine has not spent a
 * token yet.
 *
 * -----------------------------------------------------------------------------
 * THE UNDERLINE IS A FIVE-POSITION SELECTOR SWITCH
 * -----------------------------------------------------------------------------
 * The brief asks the bar's underline to tint by CLASSIFIED INTENT. The engine
 * returns one of five — bridge · lookup · compare · timeline · summarize — and
 * the honest way to show a five-way classification is a five-position switch
 * with exactly one position lit, not five invented colours.
 *
 * Five colours would need five new tokens, and this product has THREE LIGHTS
 * with one meaning each. So the POSITION carries which intent, and the LIGHT
 * carries where the classification came from:
 *
 *   --render     the engine classified it while rendering. `query.active.intent`
 *                is the engine's own attention, which is what cyan means.
 *   --curiosity  the corpus DECLARES this intent for this staged question, and
 *                it has not been run. It is still a question, and violet is the
 *                question light.
 *   unlit        free text nobody has classified. The track stays --line and the
 *                readout says `unclassified` rather than guessing.
 *
 * The intent is also named in words beside it, because a lit segment on a track
 * is a state, not a label, and an instrument should never make you count.
 * =============================================================================
 */

import { useEffect, useRef, useState } from 'react';

import { COPY, intentCopy } from '@/copy';
import type { QueryIntent } from '@/engine';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Tip } from '@/ui/primitives';

/** The five, in the engine's own declaration order. The track reads left to right. */
const INTENTS: readonly QueryIntent[] = ['bridge', 'lookup', 'compare', 'timeline', 'summarize'];

/** Where a classification came from. Never inferred — always one of three facts. */
type IntentSource = 'rendered' | 'declared' | 'unclassified';

export interface CommandBarProps {
  className?: string;
}

export function CommandBar({ className }: CommandBarProps): JSX.Element {
  const { staged, active, running, app, stagedQueries, error } = useAtlasStore((s) => ({
    staged: s.query.staged,
    active: s.query.active,
    running: s.query.running,
    app: s.app,
    stagedQueries: s.stagedQueries,
    error: s.query.error,
  }));

  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  // `/` focuses the palette, which is the interaction layer's job. What belongs
  // here is the other half: when the palette stages a question, the bar should
  // show it without stealing focus from whatever the user is doing.
  useEffect(() => {
    if (!focused && input.current !== null && input.current.value !== staged) {
      input.current.value = staged;
    }
  }, [staged, focused]);

  const text = staged.trim();
  const declared = stagedQueries.find((q) => q.query === text) ?? null;
  const renderedThis = active !== null && active.query === text;

  const source: IntentSource = renderedThis ? 'rendered' : declared !== null ? 'declared' : 'unclassified';
  const intent: QueryIntent | null = renderedThis
    ? active.intent
    : declared !== null
      ? declared.intent
      : null;

  const tone = source === 'rendered' ? 'render' : source === 'declared' ? 'curiosity' : 'faint';
  const canRun = text.length > 0 && !running && app !== 'INGESTING' && app !== 'SETTLING';

  const run = (): void => {
    if (!canRun) return;
    void useAtlas.getState().runQuery(text);
  };

  return (
    <form
      className={['cmd', className].filter(Boolean).join(' ')}
      data-source={source}
      onSubmit={(e) => {
        e.preventDefault();
        run();
      }}
      aria-label={COPY.a11y.commandBar}
    >
      <div className="cmd__well">
        <input
          ref={input}
          className="cmd__input"
          type="text"
          defaultValue={staged}
          spellCheck={false}
          autoComplete="off"
          placeholder={COPY.command.placeholder}
          aria-label={COPY.command.label}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => useAtlas.getState().stageQuery(e.target.value)}
        />

        {/* THE SELECTOR SWITCH. Five positions, one lit, and the light says why. */}
        <Tip
          content={
            intent === null
              ? COPY.command.freeText.note
              : `${intentCopy(intent).label} — ${intentCopy(intent).short}`
          }
        >
          <span className="cmd__track" role="presentation">
            {INTENTS.map((i) => (
              <span
                key={i}
                className="cmd__seg"
                data-lit={i === intent ? source : 'off'}
                title={intentCopy(i).label}
              />
            ))}
          </span>
        </Tip>
      </div>

      {/* ONE READOUT, AND IT IS NOT A MEASUREMENT.
          The intent is a CLASSIFICATION, which is the one thing about a question
          that belongs next to the question. The mode and the latency used to sit
          here too: the rail's answer header already names the mode and the HUD
          already prints the latency, and three instruments reporting one render
          in one screenshot is what made this row read as a toolbar. */}
      <span className="cmd__meta">
        {intent === null ? (
          <span className="caps ink-faint">{COPY.common.unknown}</span>
        ) : (
          <Tip content={intentCopy(intent).long}>
            <span className={`caps u-tone tone-${tone === 'faint' ? 'dim' : tone}`}>
              {intentCopy(intent).label}
            </span>
          </Tip>
        )}
      </span>

      <Btn
        variant="primary"
        size="sm"
        onClick={run}
        disabled={!canRun}
        title={renderedThis ? COPY.command.rerun.title : COPY.command.run.title}
      >
        {running
          ? COPY.command.running.label
          : renderedThis
            ? COPY.command.rerun.label
            : COPY.command.run.label}
      </Btn>

      {error !== null && !running ? <span className="u-sr">{error}</span> : null}
    </form>
  );
}

/* =============================================================================
 * THE FLOATING STAGED CARD IS GONE, ON PURPOSE
 * -----------------------------------------------------------------------------
 * It used to sit over the terrain under this bar, and it made the staged
 * question the THIRD copy of itself on one screen: the input above it, the card
 * itself, and the QUESTION panel in the rail — while occluding the top of the
 * map to do it.
 *
 * The line it carried is the best sentence in the product ("Staged, not
 * rendered. The engine has not spent a token on this yet") and it has not been
 * deleted: it moved into `StagedPanel`, directly under the Render button, which
 * is the control the sentence is actually about. One question, one home, and the
 * top of the terrain back.
 * ========================================================================== */
