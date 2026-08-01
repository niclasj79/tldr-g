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
 * WHAT WAS WRONG: THE BEST TOOL IN THE PRODUCT HAD ONE DOOR AND IT WAS INVISIBLE
 * -----------------------------------------------------------------------------
 * Command search indexes 3,885 nodes — the count the palette's own footer prints,
 * read live off `index.items.length` — plus the whole keyboard map and the four
 * detail levels. Exactly ONE production affordance opened it: the `/` key, plus
 * one accident, pressing Enter on an empty bar.
 *
 * NOTHING ON SCREEN NAMED IT. An earlier reading of this defect said the one
 * visible reference was a `<KeyHint>` chip in `StagedPanel` — that component is
 * defined and re-exported and is mounted by nothing (`InspectorRail` mounts
 * `StagedQuestions` from `CorpusPanel` instead, and that panel has no search
 * reference at all). The true measurement is worse than the one that was
 * reported: in the default states a scan of every `button` and `[role=button]`
 * for text matching /search/ returned nothing. The key was documented inside the
 * help overlay, which is itself behind a second keystroke, and a degraded-state
 * remedy opened the palette after a failure. A user who did not already know the
 * convention had no route into the index at all, and free-typing into this field
 * matched lexically against entity labels while five curated, gold-answered
 * questions sat one keystroke away, unadvertised.
 *
 * The composer therefore grows two doors, and they are different kinds of thing.
 *
 * -----------------------------------------------------------------------------
 * WHY THE FOCUS BEHAVIOUR IS A COMBOBOX AND NOT THE MODAL PALETTE
 * -----------------------------------------------------------------------------
 * "Open its suggestions when the question field receives focus" describes a
 * combobox. The palette is a `role="dialog" aria-modal="true"` surface that
 * autofocuses its own input and traps focus — opening it on focus would take the
 * caret away from a user who clicked into this field to type, and the reverse
 * action for that is Escape, which a first-time user has no reason to try. An
 * affordance that fires on focus must never be the thing that removes focus.
 *
 * So focus opens an INLINE listbox owned by this input: `role="combobox"` with
 * `aria-expanded` / `aria-controls` / `aria-activedescendant`, options that are
 * reached with the arrow keys and taken with Enter, and Escape closing the list
 * rather than the product. It offers the STAGED QUESTIONS only — the five things
 * this corpus has a by-construction answer for — for two reasons:
 *
 *   1. The node index is 3,885 entries and is deliberately built on the FIRST
 *      palette open rather than on boot, because the passage rung alone is 2,207
 *      nodes carrying their full text and most sessions never search. Building
 *      that on FOCUS of the question field would fire it in every session that
 *      clicks the field once, which is the cost the lazy build exists to avoid.
 *   2. A listbox under a composer that can return nearly four thousand rows is a
 *      modal wearing a listbox's clothes. The short list is the suggestion; the
 *      whole index is a place you go.
 *
 * The last row of the list goes there, carrying whatever has been typed, and the
 * labelled Search control beside the field does the same with `/` printed next to
 * it as a hint rather than as the route.
 *
 * PICKING A SUGGESTION STAGES IT. It does not render it. The palette's own
 * question rows run on selection and that is right for the palette — it is an
 * explicit "go" surface you opened on purpose. This list appears because the
 * caret landed in a field, and an autocomplete that spends the token budget on a
 * click somebody made to READ A LIST has taken the user's act away from them.
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
 *
 * -----------------------------------------------------------------------------
 * THE READOUT NAMES THE VERIFIED CASE IN PLAIN WORDS
 * -----------------------------------------------------------------------------
 * When the staged text is one of the corpus's own questions, the only thing that
 * said so was a violet segment on a 1px track and a tooltip. The readout now
 * carries the mark in words — and it uses the PLAIN half of the pair,
 * `Verified sample answer`, because the composer is the first surface a stranger
 * meets and `By construction` is four words they have to decode before they have
 * asked anything. The technical term is not deleted: it is the second half of
 * `dual()` in the tip, it is what the receipt says, and it is what the answer's
 * gold row keeps. Plain name leads; expert surfaces are unchanged.
 *
 * -----------------------------------------------------------------------------
 * THREE ROWS, NOT ONE — AND THE MODIFIER HAS TO OUTWEIGH `.cmd`, NOT FOLLOW IT
 * -----------------------------------------------------------------------------
 * The composer is now the full width of a 320px rail, which is 295px inside its
 * padding. A single flex row holding the field, a Search control, the intent
 * readout and Render leaves the field itself around 100px — narrower than it was
 * in the top bar it was moved out of. So the composer lays out as a small grid:
 * the field at full width, the two controls under it, the readout under those.
 * The grid is a MODIFIER class owned by this surface's own stylesheet; the base
 * `.cmd` rules in shell.css are untouched.
 *
 * The modifier shipped once as a single-class selector and lost the tie to
 * `.cmd { display: flex }` on source order, so the grid never applied and the
 * field measured 18px wide. The fix and the measurement are in `search.css` §1;
 * what belongs here is the reason the class is still a modifier rather than an
 * edit to `.cmd`: any other mounting of this component keeps the row it was
 * designed for.
 * =============================================================================
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { COPY, dual, intentCopy, plain } from '@/copy';
import type { QueryIntent, StagedQuery } from '@/engine';
import { keyHintFor, useAtlas, useAtlasStore } from '@/state';
import { Btn, Chip, KeyHint, SectionLabel, Tip } from '@/ui/primitives';

import { fuzzyBest, markRuns } from '@/interaction/fuzzy';
import { openCommandSearch } from '@/interaction/CommandPalette';

import '@/interaction/search.css';

/** The five, in the engine's own declaration order. The track reads left to right. */
const INTENTS: readonly QueryIntent[] = ['bridge', 'lookup', 'compare', 'timeline', 'summarize'];

/** Where a classification came from. Never inferred — always one of three facts. */
type IntentSource = 'rendered' | 'declared' | 'unclassified';

/**
 * How many staged questions the inline list will show.
 *
 * The corpus ships five, so this is a ceiling rather than a limit today — it
 * exists so a corpus with thirty cannot turn a suggestion list into a scrolling
 * panel hanging over the rail. Anything past it is reached through the last row,
 * which is the whole index anyway.
 */
const SUGGEST_MAX = 6;

/** Stable ids. `aria-activedescendant` needs one per row and one for the list. */
const LIST_ID = 'cmd-suggest';
const optionId = (i: number): string => `${LIST_ID}-opt-${i}`;

/** One staged question, matched, with the runs to mark up in its title. */
interface Suggestion {
  query: StagedQuery;
  runs: { text: string; hit: boolean }[];
  score: number;
}

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

  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [focused, setFocused] = useState(false);

  /* THE LISTBOX'S TWO PIECES OF STATE.
     `open` is whether the suggestions are showing; `cursor` is which row the
     arrow keys are on, and -1 means NONE — which is the resting state, so that
     Enter on a freshly focused field still renders the staged question rather
     than silently picking whatever happened to be first. A combobox that
     pre-selects a row changes what Enter does without being asked. */
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);

  // `/` focuses the palette, which is the interaction layer's job. What belongs
  // here is the other half: when the palette stages a question, the bar should
  // show it without stealing focus from whatever the user is doing.
  useEffect(() => {
    if (!focused && input.current !== null && input.current.value !== staged) {
      input.current.value = staged;
    }
  }, [staged, focused]);

  /* THE FIELD IS AS TALL AS THE QUESTION.
     `field-sizing: content` does this natively and is not everywhere yet, so the
     height is set from the content's own `scrollHeight` — bounded by the same
     `max-height` the stylesheet declares, so the two paths agree rather than
     fighting. It runs on every change and on every external stage, because a
     question arriving from the palette is as long as one that was typed. */
  useEffect(() => {
    const el = input.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [staged]);

  const text = staged.trim();
  const declared = stagedQueries.find((q) => q.query === text) ?? null;
  const renderedThis = active !== null && active.query === text;

  const source: IntentSource = renderedThis ? 'rendered' : declared !== null ? 'declared' : 'unclassified';
  const intent: QueryIntent | null = renderedThis
    ? active.intent
    : declared !== null
      ? declared.intent
      : null;

  /* THE READOUT'S TONE, AND IT HAS TWO VALUES BECAUSE IT CAN ONLY EVER HAVE TWO.
     It used to be a three-way with a `faint` arm and a ternary downstream mapping
     that arm to `dim`. Neither could fire: `faint` was reachable only from
     `unclassified`, which is exactly `declared === null && !renderedThis`, which
     is exactly `intent === null` — and the readout only prints a tone when
     `intent !== null`. A guard against a leak that cannot occur reads as a real
     guard and stops the next reader simplifying this. */
  const intentTone: 'render' | 'curiosity' = source === 'rendered' ? 'render' : 'curiosity';
  const canRun = text.length > 0 && !running && app !== 'INGESTING' && app !== 'SETTLING';

  /* THE SUGGESTIONS, RANKED BY THE QUERY AND BY NOTHING ELSE.
     Same matcher the palette uses, including its compactness gate — `Bruntorp`
     used to return all five staged questions because t-e-s-s-i-n can be
     scavenged out of any long sentence. An empty field shows the whole set,
     which is the point of opening on focus: the list IS the answer to "what can
     I ask this thing". */
  const suggestions = useMemo<Suggestion[]>(() => {
    const out: Suggestion[] = [];
    for (const q of stagedQueries) {
      const m = text.length === 0 ? { score: 0, indices: [] as number[] } : fuzzyBest(text, [q.query, q.why]);
      if (m === null) continue;
      out.push({ query: q, runs: markRuns(q.query, m.indices), score: m.score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, SUGGEST_MAX);
  }, [text, stagedQueries]);

  /* The last row is always present, so there is always at least one row and the
     arrow-key wrap can never divide by zero. */
  const rowCount = suggestions.length + 1;
  const everythingRow = suggestions.length;

  // Keep the cursor on a row that still exists after the list has re-filtered.
  useEffect(() => {
    setCursor((i) => (i >= rowCount ? -1 : i));
  }, [rowCount]);

  // Keep the cursor row in view without animating anything.
  useEffect(() => {
    if (!open || cursor < 0) return;
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, cursor]);

  const closeList = (): void => {
    setOpen(false);
    setCursor(-1);
  };

  const run = (): void => {
    if (!canRun) return;
    closeList();
    void useAtlas.getState().runQuery(text);
  };

  /** Take a suggestion: stage it, close the list, keep the caret where it is. */
  const stageSuggestion = (q: StagedQuery): void => {
    if (input.current !== null) input.current.value = q.query;
    useAtlas.getState().stageQuery(q.query);
    closeList();
    input.current?.focus();
  };

  /** The last row: hand the typed text to the modal palette and go there. */
  const goToEverything = (): void => {
    closeList();
    openCommandSearch(text);
  };

  const takeRow = (i: number): void => {
    if (i === everythingRow) {
      goToEverything();
      return;
    }
    const s = suggestions[i];
    if (s !== undefined) stageSuggestion(s.query);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    /* ENTER RENDERS; SHIFT+ENTER BREAKS THE LINE.
       A textarea's default is the opposite, and the default is wrong here: the
       field holds a question, and a question ends. A reader who wants a second
       line asks for one. */
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (open && cursor >= 0) {
        takeRow(cursor);
        return;
      }
      closeList();
      run();
      return;
    }
    if (e.key === 'Escape') {
      /* ESCAPE CLOSES THE LIST AND NOTHING ELSE.
         The global keymap routes Escape inside an editable target to
         `clear-focus`, which throws away the terrain selection. That is the
         right binding when there is nothing else to dismiss and the wrong one
         when a listbox is open in front of the user, so the event is stopped
         here — and only here, only while it is open. */
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      closeList();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setCursor(0);
        return;
      }
      setCursor((i) => (i + 1) % rowCount);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setCursor(rowCount - 1);
        return;
      }
      setCursor((i) => (i <= 0 ? rowCount - 1 : i - 1));
      return;
    }
    if (e.key === 'Tab') {
      closeList();
      return;
    }
    if (e.key === 'Enter' && open && cursor >= 0) {
      // Only a row under the cursor takes Enter. With no cursor the form
      // submits, which renders — the behaviour this field has always had.
      e.preventDefault();
      takeRow(cursor);
    }
  };

  return (
    <form
      className={['cmd', 'cmd--composer', className].filter(Boolean).join(' ')}
      onSubmit={(e) => {
        e.preventDefault();
        run();
      }}
      aria-label={COPY.a11y.commandBar}
    >
      <div className="cmd__well">
        {/* A QUESTION IS A SENTENCE, AND A SENTENCE DOES NOT FIT ON ONE LINE.
            This was an `<input type="text">`, so the composer showed
            `Which group acquired the operator that runs` and the rest scrolled
            out of sight under the caret — the exact defect the pinned ASKED
            header was built to end, still live one band above it in the control
            you type into. The rule is the same on both: the question wraps, and
            it never truncates.

            It grows to its content and stops at a ceiling, so a long question is
            fully readable and a runaway paste does not eat the rail; past the
            ceiling the field scrolls, which is the one place scrolling is
            correct because the text is still all there. */}
        <textarea
          ref={input}
          className="cmd__input"
          rows={1}
          defaultValue={staged}
          spellCheck={false}
          autoComplete="off"
          placeholder={COPY.command.placeholder}
          aria-label={COPY.command.label}
          /* THE COMBOBOX CONTRACT. Every one of these is load-bearing: without
             `aria-expanded` a screen reader never learns the list appeared, and
             without `aria-activedescendant` the arrow keys move a highlight the
             user cannot hear. */
          role="combobox"
          aria-expanded={open}
          /* Only while it exists. `aria-controls` pointing at an id that is not
             in the document is an invalid attribute value, not a harmless
             no-op — the list is unmounted when closed, so the reference goes
             with it and `aria-expanded` carries the state on its own. */
          aria-controls={open ? LIST_ID : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && cursor >= 0 ? optionId(cursor) : undefined}
          onFocus={() => {
            setFocused(true);
            setOpen(true);
            setCursor(-1);
          }}
          onBlur={() => {
            setFocused(false);
            /* Safe to close unconditionally: the options take the pointer on
               mousedown with `preventDefault`, so a click on a row never blurs
               the field in the first place. */
            closeList();
          }}
          onChange={(e) => {
            useAtlas.getState().stageQuery(e.target.value);
            setOpen(true);
            setCursor(-1);
          }}
          onKeyDown={onKeyDown}
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

      {/* THE VISIBLE DOOR. A real button, with the key beside it as a HINT.
          The help overlay's keyboard map documents `/` behind a second keystroke
          and cannot press it; this presses it, and prints the same glyph so the
          shortcut teaches itself. */}
      <div className="cmd__aux">
        <Btn
          variant="quiet"
          size="sm"
          className="cmd__search"
          onClick={() => openCommandSearch(text)}
          title={COPY.searchSurface.open.title}
        >
          {COPY.searchSurface.open.label}
          <KeyHint keys={keyHintFor('search')} />
        </Btn>
      </div>

      {/* THE ACT, AT THE SIZE OF AN ACT.
          It was `size="sm"` sharing a row with the Search door, at the same
          weight and the same height, so the single most important control in the
          product read as one of two equal options — and a test drive reported it
          in three words: "the Render CTA is unclear". It is its own full-width
          row now, at the default size, directly under the question it renders.
          The verb is unchanged: `render` is the thesis, not jargon to be
          translated away. */}
      <Btn
        variant="primary"
        className="cmd__act"
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

      {/* ONE READOUT, AND IT IS NOT A MEASUREMENT.
          The intent is a CLASSIFICATION, which is the one thing about a question
          that belongs next to the question. The mode and the latency used to sit
          here too: the rail's answer header already names the mode and the HUD
          already prints the latency, and three instruments reporting one render
          in one screenshot is what made this row read as a toolbar.

          The second mark is the verified case, in plain words — see the header
          for why the composer gets `Verified sample answer` and the receipt
          keeps `By construction`. */}
      <span className="cmd__meta">
        {intent === null ? (
          <span className="caps ink-dim">{COPY.common.unknown}</span>
        ) : (
          <Tip content={intentCopy(intent).long}>
            <span className={`caps u-tone tone-${intentTone}`}>{intentCopy(intent).label}</span>
          </Tip>
        )}
        {declared === null ? null : (
          /* AMBER, THROUGH THE SAME CHANNEL AS THE MARK BESIDE IT.
             This span carried `cmd__verified caps ink-dim` — a component colour
             rule and a colour utility on one element — and the utility won on
             source order, so the computed colour came back as --ink-dim and the
             evidence light the mark exists to carry never rendered. `.tone-*`
             plus `.u-tone` is the one channel this product paints tone with, and
             it is what the intent mark next to it already uses. */
          <Tip content={`${dual('byConstruction')} — ${COPY.provenance.staged}`}>
            <span className="caps u-tone tone-evidence">{plain('byConstruction')}</span>
          </Tip>
        )}
      </span>

      {open ? (
        <div className="cmd__pop">
          <SectionLabel className="cmd__popmark">{COPY.searchSurface.suggest.label}</SectionLabel>

          {suggestions.length === 0 ? (
            <p className="cmd__popempty t-12-5 ink-dim" data-prose>
              {COPY.searchSurface.suggest.empty}
            </p>
          ) : null}

          <ul
            ref={list}
            id={LIST_ID}
            className="cmd__opts u-scroll"
            role="listbox"
            aria-label={COPY.searchSurface.suggest.label}
          >
            {suggestions.map((s, i) => (
              <li
                key={s.query.id}
                id={optionId(i)}
                className="cmd__opt"
                role="option"
                aria-selected={i === cursor}
                data-active={i === cursor ? 'true' : undefined}
                onMouseEnter={() => setCursor(i)}
                /* MOUSEDOWN, PREVENTED. A click that blurs the field first would
                   close the list out from under the pointer and land on nothing. */
                onMouseDown={(e) => {
                  e.preventDefault();
                  takeRow(i);
                }}
              >
                <span className="cmd__opt-glyph" aria-hidden="true">
                  ?
                </span>
                <span className="cmd__opt-main">
                  <span className="cmd__opt-title">
                    {s.runs.map((r, k) =>
                      r.hit ? (
                        <mark key={k} className="cmd__opt-hit">
                          {r.text}
                        </mark>
                      ) : (
                        <span key={k}>{r.text}</span>
                      ),
                    )}
                  </span>
                  <span className="cmd__opt-sub">{s.query.why}</span>
                </span>
                <Chip tone="dim" title={`${dual('byConstruction')} — ${COPY.provenance.staged}`}>
                  {plain('byConstruction')}
                </Chip>
              </li>
            ))}

            {/* THE WAY OUT OF THE SHORT LIST. It is an option rather than a
                button so the arrow keys reach it like everything else — a route
                that only a pointer can take is the defect this whole surface
                exists to fix. */}
            <li
              id={optionId(everythingRow)}
              className="cmd__opt cmd__opt--all"
              role="option"
              aria-selected={cursor === everythingRow}
              data-active={cursor === everythingRow ? 'true' : undefined}
              title={COPY.searchSurface.suggest.everything.title}
              onMouseEnter={() => setCursor(everythingRow)}
              onMouseDown={(e) => {
                e.preventDefault();
                takeRow(everythingRow);
              }}
            >
              <span className="cmd__opt-glyph" aria-hidden="true">
                ›
              </span>
              <span className="cmd__opt-main">
                <span className="cmd__opt-title">{COPY.searchSurface.suggest.everything.label}</span>
                <span className="cmd__opt-sub">{COPY.searchSurface.suggest.everythingSub}</span>
              </span>
              <KeyHint keys={keyHintFor('search')} />
            </li>
          </ul>

          <p className="cmd__popft t-12-5 ink-dim" data-prose>
            {COPY.searchSurface.suggest.stages}
          </p>
        </div>
      ) : null}

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
 * rendered. The engine has not spent a token on this yet"). It was moved into
 * `StagedPanel`, directly under the Render button, which is the control the
 * sentence is actually about. One question, one home, and the top of the terrain
 * back.
 *
 * IT IS NOT ON SCREEN, AND THAT IS NOT THIS FILE'S TO FIX. `COPY.command.staged
 * .hint` renders in exactly one place — `StagedPanel` — and `StagedPanel` is
 * mounted by nothing: `InspectorRail` mounts `StagedQuestions` from
 * `CorpusPanel` instead, and that panel does not carry the line. So the sentence
 * moved out of the floating card and into a component that never renders. The
 * mount decision belongs to `InspectorRail`; what belongs here is not repeating
 * the claim that it landed somewhere a reader can see it.
 * ========================================================================== */
