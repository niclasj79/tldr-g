/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — HELP AND THE GLOSSARY
 * =============================================================================
 *
 * `?` — how to read the terrain, what the lights mean, why you can check it,
 * what this build does not do, the keyboard, and the vocabulary.
 *
 * ONE SOURCE OF TRUTH, TWICE OVER. The key GLYPHS come from `KEYMAP` — the same
 * table the handler dispatches from — and the WORDS come from the copy deck,
 * keyed by the same action ids. The classic failure of a help overlay is that it
 * documents a shortcut nobody wired; that is not available here, because there
 * is only one place to be wrong.
 *
 * THE "WHAT THIS DOES NOT DO" SECTION IS NOT AN APOLOGY. A system that names
 * where it is weak is the only kind you can calibrate against, so the limits sit
 * in the same overlay as the capabilities, at the same size, in the same voice.
 * =============================================================================
 */

import { COPY, GLOSSARY } from '@/copy';
import { startWalkthrough } from '@/ui/shell/Walkthrough';
import { KEY_GROUPS, bindingsInGroup, useAtlas, useAtlasStore } from '@/state';
import { Btn, Disclosure, KeyHint, Panel, ScrimOverlay, SectionLabel } from '@/ui/primitives';

export interface HelpOverlayProps {
  className?: string;
}

export function HelpOverlay({ className }: HelpOverlayProps): JSX.Element | null {
  const open = useAtlasStore((s) => s.ui.help);
  if (!open) return null;

  const close = (): void => useAtlas.getState().toggle('help');

  return (
    <ScrimOverlay onDismiss={close}>
      <Panel
        title={COPY.help.title}
        className={['help', className].filter(Boolean).join(' ')}
        scroll
        actions={
          <>
            {/* The walkthrough lives here because this is where someone goes when
                they cannot read the screen — and because the person most likely
                to want a second pass is the one about to demo it to someone. */}
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
        <p className="help__thesis t-16" data-prose>
          {COPY.help.subtitle}
        </p>
        <p className="t-12-5 ink-dim" data-prose>
          {COPY.product.mechanism}
        </p>

        <div className="help__cols">
          {/* ---- reading the terrain ---------------------------------------- */}
          <section className="help__col">
            <SectionLabel>{COPY.help.sections.reading.title}</SectionLabel>
            <p className="t-12-5 ink-dim" data-prose>
              {COPY.help.sections.reading.body}
            </p>

            <SectionLabel>{COPY.help.sections.lights.title}</SectionLabel>
            <ul className="help__lights">
              <li className="help__light" data-light="render" data-prose>
                {COPY.help.sections.lights.render}
              </li>
              <li className="help__light" data-light="evidence" data-prose>
                {COPY.help.sections.lights.evidence}
              </li>
              <li className="help__light" data-light="curiosity" data-prose>
                {COPY.help.sections.lights.curiosity}
              </li>
              <li className="help__light" data-light="alarm" data-prose>
                {COPY.help.sections.lights.alarm}
              </li>
            </ul>
          </section>

          {/* ---- trust and limits ------------------------------------------- */}
          <section className="help__col">
            <SectionLabel>{COPY.help.sections.trust.title}</SectionLabel>
            <p className="t-12-5 ink-dim" data-prose>
              {COPY.help.sections.trust.body}
            </p>

            <SectionLabel>{COPY.help.sections.limits.title}</SectionLabel>
            <p className="t-12-5 ink-dim" data-prose>
              {COPY.help.sections.limits.body}
            </p>

            <SectionLabel>{COPY.provenance.field}</SectionLabel>
            <p className="t-12-5 ink-dim" data-prose>
              {COPY.provenance.long}
            </p>
            <p className="t-11 ink-faint" data-prose>
              {COPY.provenance.why}
            </p>
          </section>

          {/* ---- the keyboard, generated from the map ----------------------- */}
          <section className="help__col">
            <SectionLabel>{COPY.keyboard.title}</SectionLabel>
            <p className="t-11 ink-faint" data-prose>
              {COPY.keyboard.note}
            </p>
            {KEY_GROUPS.map((group) => (
              <div key={group.id} className="help__group">
                <span className="caps ink-faint">{COPY.keyboard.groups[group.id]}</span>
                <ul className="help__keys">
                  {bindingsInGroup(group.id).map((binding) => (
                    <li key={binding.id} className="help__key">
                      <KeyHint keys={binding.keys} />
                      <span className="t-12-5 ink-dim">{COPY.keyboard.actions[binding.id]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </div>

        {/* ---- the vocabulary --------------------------------------------- */}
        <SectionLabel>{COPY.help.glossary.title}</SectionLabel>
        <p className="t-11 ink-faint" data-prose>
          {COPY.help.glossary.note}
        </p>
        <div className="help__glossary">
          {GLOSSARY.map((entry) => (
            <Disclosure
              key={entry.term}
              className="help__term"
              summary={
                <span className="help__termhd">
                  <span className="t-12-5 w-500">{entry.term}</span>
                  <span className="t-11 ink-faint" data-prose>
                    {entry.short}
                  </span>
                </span>
              }
            >
              <p className="t-12-5 ink-dim" data-prose>
                {entry.long}
              </p>
              {entry.see === undefined ? null : (
                <p className="t-11 ink-faint" data-prose>
                  {entry.see.join(' · ')}
                </p>
              )}
            </Disclosure>
          ))}
        </div>
      </Panel>
    </ScrimOverlay>
  );
}
