/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE HELP DIALOG
 * =============================================================================
 *
 * `?` — five things to do, and then everything else, folded.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS REPLACED, MEASURED
 * -----------------------------------------------------------------------------
 * The overlay opened onto `.help__cols` — `repeat(auto-fit, minmax(280px, 1fr))`
 * inside a 1120px sheet, which is THREE columns at a laptop's width — carrying
 * "reading the terrain", "the lights", "why you can check it", "what this build
 * does not do", the evidence-trail note and the whole keyboard map, side by
 * side, at 12.5px and 11px. Under that sat 42 glossary entries at
 * `columns: 3 300px`. Every word of it was true and none of it answered "what do
 * I do here", because the answer to that question was not on the screen at all.
 *
 * It was also not a dialog. It wrapped `<ScrimOverlay>` — which set no `role`,
 * no `aria-modal`, no focus trap and no focus restore — around a plain
 * `<Panel>`, i.e. a `<section>`. The command palette, forty lines away in the
 * same codebase, got this right. Opening help with `?` left focus on the
 * terrain, so the first Tab walked out of a viewport-covering overlay into
 * controls the reader could neither see nor click.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT IS NOW
 * -----------------------------------------------------------------------------
 *   FIVE TASKS FIRST      ask · read · open · return · check. One column, 13px,
 *                         --ink-dim or brighter, in the order a person meets
 *                         them. Each one names controls that exist on screen.
 *   EVERYTHING ELSE FOLDS the terrain, the lights, trust, the limits, the
 *                         keyboard and the vocabulary are five disclosures. They
 *                         are not less important for being folded; they are what
 *                         you open second.
 *   THE GLOSSARY IS FOUND rather than scanned. A search field filters 42 entries,
 *                         and the `see` cross-references — which used to be
 *                         `entry.see.join(' · ')`, plain text naming entries you
 *                         then had to hunt for — are buttons that open the entry
 *                         they name and clear the filter to reach it.
 *   IT IS A REAL DIALOG   `role`, `aria-modal`, a focus trap and focus restore,
 *                         all inherited from ScrimOverlay, which is where they
 *                         belong: the palette needed every one of them too.
 *
 * ONE SOURCE OF TRUTH, STILL TWICE OVER. The key GLYPHS come from `KEYMAP` — the
 * same table the handler dispatches from — and the WORDS come from the copy
 * deck, keyed by the same action ids. A help overlay documenting a shortcut
 * nobody wired is not available here, because there is only one place to be
 * wrong.
 *
 * THE "WHAT THIS DOES NOT DO" FOLD IS NOT AN APOLOGY. A system that names where
 * it is weak is the only kind you can calibrate against, so the limits sit in
 * the same dialog as the capabilities, at the same size, in the same voice.
 * =============================================================================
 */

import { useCallback, useEffect, useState } from 'react';

import { COPY, GLOSSARY, glossaryFor } from '@/copy';
import type { GlossaryEntry } from '@/copy';
import { startWalkthrough } from '@/ui/shell/Walkthrough';
import { KEY_GROUPS, bindingsInGroup, keyHintFor, useAtlas, useAtlasStore } from '@/state';
import type { KeyActionId } from '@/state';
import { Btn, Disclosure, KeyHint, Num, Panel, ScrimOverlay, SectionLabel } from '@/ui/primitives';

import './help.css';

/**
 * The shortcuts that belong to each task, by action id rather than by glyph.
 *
 * STRUCTURE, NOT PROSE — which is why it lives here and not in the copy block.
 * The glyphs are resolved from `KEYMAP` at render time, so a rebinding moves the
 * cap on the task card with it and this table never has to be told.
 */
const TOPIC_KEYS: Record<string, readonly KeyActionId[]> = {
  ask: ['run-query', 'search'],
  read: ['tab-answer'],
  open: ['tab-evidence'],
  return: ['back', 'return-to-result', 'home'],
  check: [],
};

/** A DOM id for one glossary entry, so a cross-reference has something to aim at. */
function termDomId(term: string): string {
  return `guide-term-${term.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
}

/** Case- and accent-blind enough for a filter over 42 short entries. */
function matches(entry: GlossaryEntry, needle: string): boolean {
  if (needle.length === 0) return true;
  const q = needle.toLowerCase();
  return (
    entry.term.toLowerCase().includes(q) ||
    entry.short.toLowerCase().includes(q) ||
    entry.long.toLowerCase().includes(q)
  );
}

export interface HelpOverlayProps {
  className?: string;
}

/**
 * The mount gate, and nothing else.
 *
 * The dialog's own state — the glossary filter, the entry a cross-reference is
 * jumping to — lives in the child, so closing the overlay disposes of it. A
 * filter that survived a close would mean the next `?` opened onto a glossary
 * showing four of 42 terms with no visible reason.
 */
export function HelpOverlay({ className }: HelpOverlayProps): JSX.Element | null {
  const open = useAtlasStore((s) => s.ui.help);
  return open ? <HelpDialog className={className} /> : null;
}

function HelpDialog({ className }: HelpOverlayProps): JSX.Element {
  const [filter, setFilter] = useState('');
  /**
   * The entry a cross-reference asked for, held for exactly one render.
   *
   * It cannot be opened inside the click handler: the target may be filtered
   * out of the list at that moment, and clearing the filter is what puts it back
   * in the DOM. So the click clears the filter AND records the target, and the
   * effect below — which runs after the re-render that made the entry exist —
   * opens it. A dangling cross-reference is the failure this replaced; a
   * cross-reference that silently does nothing because of a filter would be the
   * same failure with more code.
   */
  const [landing, setLanding] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);

  /**
   * CLOSE IS IDEMPOTENT, AND IT HAS TO BE.
   *
   * It used to be a bare `toggle('help')`, and that made Escape a no-op that
   * looked like a bug in the dialog. Escape has TWO handlers: the shell's global
   * keyboard map routes it to `clear-focus`, whose `clearFocus()` already sets
   * `ui.help: false` — and ScrimOverlay's own dismiss then fired second (its
   * listener is registered later, because it mounts later) and TOGGLED the
   * already-closed dialog straight back open. Measured: `ui.help` was `true`
   * before an Escape and `true` after it.
   *
   * A dismiss that reads "close this" rather than "flip this" cannot lose that
   * race whichever handler wins.
   *
   * IT IS ALSO STABLE, AND THAT IS NOT COSMETIC. It is `onDismiss`, and
   * ScrimOverlay's Escape effect depends on it — so a fresh identity every
   * render tore down and re-added the window `keydown` listener once per
   * keystroke in the glossary filter and once per `landing`/`landed`
   * transition, re-queueing the Escape handler to the END of the window
   * listener list every time. The ordering the note above reasons about was
   * being re-established constantly rather than held. `[]` deps: it reads the
   * store through `getState()` and closes over nothing.
   */
  const close = useCallback((): void => {
    const s = useAtlas.getState();
    if (s.ui.help) s.toggle('help');
  }, []);

  useEffect(() => {
    if (landing === null) return;
    setLanding(null);
    const host = document.getElementById(termDomId(landing));
    if (host === null) return;
    const details = host.querySelector('details');
    if (details !== null) details.open = true;
    host.scrollIntoView({ block: 'nearest' });
    // Focus the summary, not the container: the reader's next Tab should
    // continue from the entry they were sent to, not from the top of the list.
    host.querySelector('summary')?.focus();
    setLanded(landing);
  }, [landing, filter]);

  const jumpTo = (term: string): void => {
    setFilter('');
    setLanding(term);
  };

  const shown = GLOSSARY.filter((entry) => matches(entry, filter));

  return (
    <ScrimOverlay onDismiss={close} label={COPY.guidance.dialog.label}>
      <Panel
        title={COPY.guidance.dialog.title}
        className={['guide', className].filter(Boolean).join(' ')}
        scroll
        actions={
          <>
            {/* The tour lives here because this is where someone goes when they
                cannot read the screen — and because the person most likely to
                want a second pass is the one about to demo it to someone. */}
            <Btn
              variant="quiet"
              size="sm"
              onClick={() => {
                close();
                startWalkthrough();
              }}
              title={COPY.walkthrough.resume.title}
            >
              {COPY.walkthrough.resume.label}
            </Btn>
            <Btn variant="ghost" size="sm" onClick={close} title={COPY.help.close.title}>
              {COPY.help.close.label}
            </Btn>
          </>
        }
      >
        <p className="guide__lede t-13" data-prose>
          {COPY.guidance.dialog.lede}
        </p>

        {/* ---- the five tasks -------------------------------------------- */}
        <ol className="guide__topics">
          {COPY.guidance.topics.map((topic, i) => (
            <li key={topic.id} className="guide__topic">
              <Num className="guide__ord" value={i + 1} format="int" tone="render" />
              <h3 className="guide__ttl t-13">{topic.title}</h3>
              <p className="guide__body t-13" data-prose>
                {topic.body}
              </p>
              {TOPIC_KEYS[topic.id]?.length === 0 ? null : (
                <span className="guide__keys">
                  {(TOPIC_KEYS[topic.id] ?? []).map((id) => (
                    <KeyHint key={id} keys={keyHintFor(id)} />
                  ))}
                </span>
              )}
            </li>
          ))}
        </ol>

        {/* ---- reading the terrain, and the three lights ------------------ */}
        <Disclosure className="guide__fold" summary={COPY.help.sections.reading.title}>
          <p className="guide__prose t-13" data-prose>
            {COPY.help.sections.reading.body}
          </p>
          <SectionLabel>{COPY.help.sections.lights.title}</SectionLabel>
          <ul className="guide__lights">
            <li className="guide__light" data-light="render" data-prose>
              {COPY.help.sections.lights.render}
            </li>
            <li className="guide__light" data-light="evidence" data-prose>
              {COPY.help.sections.lights.evidence}
            </li>
            <li className="guide__light" data-light="curiosity" data-prose>
              {COPY.help.sections.lights.curiosity}
            </li>
            <li className="guide__light" data-light="alarm" data-prose>
              {COPY.help.sections.lights.alarm}
            </li>
          </ul>
        </Disclosure>

        {/* ---- why you can check it -------------------------------------- */}
        <Disclosure className="guide__fold" summary={COPY.help.sections.trust.title}>
          <p className="guide__prose t-13" data-prose>
            {COPY.help.sections.trust.body}
          </p>
          <SectionLabel>{COPY.provenance.field}</SectionLabel>
          <p className="guide__prose t-13" data-prose>
            {COPY.provenance.long}
          </p>
          <p className="guide__prose t-13" data-prose>
            {COPY.provenance.why}
          </p>
        </Disclosure>

        {/* ---- the limits. Same size, same voice, same dialog. ------------ */}
        <Disclosure className="guide__fold" summary={COPY.help.sections.limits.title}>
          <p className="guide__prose t-13" data-prose>
            {COPY.help.sections.limits.body}
          </p>
        </Disclosure>

        {/* ---- the keyboard, generated from the map ----------------------- */}
        <Disclosure className="guide__fold" summary={COPY.keyboard.title}>
          <p className="guide__prose t-13" data-prose>
            {COPY.keyboard.note}
          </p>
          {KEY_GROUPS.map((group) => (
            <div key={group.id} className="guide__group">
              <SectionLabel>{COPY.keyboard.groups[group.id]}</SectionLabel>
              <ul className="guide__keymap">
                {bindingsInGroup(group.id).map((binding) => (
                  <li key={binding.id} className="guide__keyrow">
                    <KeyHint keys={binding.keys} />
                    <span className="t-13 ink-dim">{COPY.keyboard.actions[binding.id]}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Disclosure>

        {/* ---- the vocabulary, behind search ------------------------------ */}
        <Disclosure className="guide__fold" summary={COPY.help.glossary.title}>
          <p className="guide__prose t-13" data-prose>
            {COPY.help.glossary.note}
          </p>

          <div className="guide__find">
            <input
              className="guide__search"
              type="search"
              value={filter}
              spellCheck={false}
              autoComplete="off"
              aria-label={COPY.guidance.glossary.search.label}
              placeholder={COPY.guidance.glossary.search.placeholder}
              onChange={(e) => {
                setFilter(e.target.value);
                setLanded(null);
              }}
            />
            <span className="guide__count t-13">
              <Num value={shown.length} format="int" tone="dim" />
              {` ${COPY.guidance.glossary.of} `}
              <Num value={GLOSSARY.length} format="int" tone="dim" />
              {` ${COPY.guidance.glossary.terms}`}
            </span>
          </div>

          {shown.length === 0 ? (
            <p className="guide__prose t-13" data-prose>
              {COPY.guidance.glossary.empty}
            </p>
          ) : (
            <div className="guide__gloss">
              {shown.map((entry) => (
                <div
                  key={entry.term}
                  id={termDomId(entry.term)}
                  className="guide__term"
                  data-landed={landed === entry.term ? 'true' : undefined}
                >
                  <Disclosure
                    summary={
                      <span className="guide__termhd">
                        <span className="t-13 w-500">{entry.term}</span>
                        <span className="t-13 ink-dim" data-prose>
                          {entry.short}
                        </span>
                      </span>
                    }
                  >
                    <p className="guide__def t-13" data-prose>
                      {entry.long}
                    </p>
                    <SeeAlso see={entry.see} onJump={jumpTo} />
                  </Disclosure>
                </div>
              ))}
            </div>
          )}
        </Disclosure>
      </Panel>
    </ScrimOverlay>
  );
}

/* -----------------------------------------------------------------------------
 * THE CROSS-REFERENCES
 * -----------------------------------------------------------------------------
 * Each `see` string is resolved through `glossaryFor()` — the canonical,
 * case-folding accessor — and the CANONICAL entry's own term is what both the
 * label and the jump target are built from. Building a DOM id straight off the
 * reference string would work for 41 of 42 entries and break silently on the
 * first reference whose case differs from its target's, which is the class of
 * defect that only ever shows up in front of someone.
 *
 * A term that does not resolve is DROPPED rather than rendered as dead text.
 * `see` is checked at module load in dev, so an unresolved name here means the
 * glossary is mid-edit — and the honest rendering of a reference to something
 * that does not exist is no reference at all, not a control that fails when it
 * is pressed.
 * -------------------------------------------------------------------------- */

function SeeAlso({
  see,
  onJump,
}: {
  see?: readonly string[];
  onJump: (term: string) => void;
}): JSX.Element | null {
  const known = (see ?? [])
    .map((ref) => glossaryFor(ref))
    .filter((entry): entry is GlossaryEntry => entry !== undefined);
  if (known.length === 0) return null;
  return (
    <div className="guide__sees">
      <SectionLabel>{COPY.guidance.glossary.see.label}</SectionLabel>
      {known.map((entry) => (
        <button
          key={entry.term}
          type="button"
          className="guide__see u-hitslop"
          title={COPY.guidance.glossary.see.title}
          onClick={() => onJump(entry.term)}
        >
          {entry.term}
        </button>
      ))}
    </div>
  );
}
