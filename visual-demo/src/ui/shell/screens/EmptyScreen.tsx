/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — EMPTY
 * =============================================================================
 *
 * NEVER A BLANK PAGE. The terrain is drawn at `latent` — outline only, 12%, in
 * real positions — plus one panel explaining that latent is a real tier of the
 * resolution ramp rather than a placeholder, and one control that ingests.
 *
 * -----------------------------------------------------------------------------
 * THE SCREEN USED TO CONTRADICT ITSELF, IN THE ONE PLACE IT COULD LEAST AFFORD TO
 * -----------------------------------------------------------------------------
 * The plate said `No corpus loaded` and `outline only, no labels`. Behind it,
 * the names of the corpus that had just been closed were still on the terrain.
 * A UX review found it and it is the correct finding: this is the one screen in
 * the product whose entire text is a lecture about not pretending, and it was
 * pretending.
 *
 * IT WAS TWO STALE LAYERS, NOT ONE. `useShellWiring` skips `terrain.setScene`
 * while `view === null`, and `unload()` never clears the terrain, so on
 * close-then-EMPTY the WebGL canvas still holds the last frame it drew AND
 * `.tg-labels` still holds that frame's names at `--z-labels`. This screen's own
 * `LatentField` is a transparent canvas — it `clearRect`s and strokes outlines —
 * so it covered neither of them.
 *
 * Both are answered in `../instruments.css`, by switching each stale layer off
 * at its own source rather than painting over the pair. That file carries the
 * argument, and the short version is that covering them satisfies the eye and
 * nothing else: `audit()` tests a label's `display`, `visibility` and `opacity`
 * but never its occlusion, so an opaque plate leaves the instrument reporting
 * live labels on a screen that says there are none. The proper repair is
 * upstream — `unload()` clearing the terrain, or the wiring pushing an empty
 * scene when the view goes null — and it lives in files this screen does not
 * own.
 *
 * -----------------------------------------------------------------------------
 * "A GHOST OF WHAT WILL APPEAR", MEANT LITERALLY — AND SAID ONLY WHEN TRUE
 * -----------------------------------------------------------------------------
 * If the corpus has been materialised in this session and then closed, the
 * engine still holds the bake — so the field behind this panel is the REAL
 * layout of the world that is about to load, drawn at the tier that says nothing
 * has been spent on it. That is not a mock-up of what will appear; it is what
 * will appear, unresolved.
 *
 * If nothing has ever been built, there is no layout to show and the field falls
 * back to the engine's own deterministic hex lattice.
 *
 * THE SENTENCE FOLLOWS THE SOURCE. The deck's `states.EMPTY.body` opens "the
 * grid behind this panel", which is true of the lattice and false of the bake —
 * the same error, in the same direction, as the caption that used to claim real
 * positions under the lattice. `COPY.instruments.empty.field` is two sentences,
 * one per source, and `latentSource()` picks. A screen that silently swapped a
 * real layout for a lattice would be doing exactly the thing this product is
 * built against; a screen that CALLS a real layout a lattice is the same defect
 * with the swap done in words.
 *
 * -----------------------------------------------------------------------------
 * THE INSTRUMENTS ARE PRESENT, AND THEY ARE MEASURING NOTHING
 * -----------------------------------------------------------------------------
 * The top bar and the HUD ARE here, unlike FIRST-RUN. The HUD used to prove it
 * had measured nothing by printing a row of em dashes — except for one cell,
 * which printed `0 ms`, because `engine.lastLatency` initialises to zero. So the
 * claim this screen made about that row was false in exactly one place, which is
 * the worst possible number of places for a claim about honesty to be false in.
 *
 * The row states its own emptiness in one sentence now, and this plate says so
 * rather than describing punctuation it no longer prints.
 *
 * THE FIX WAS THE SUBJECT TEST, NOT A GATE ON THE LATENCY FIGURE, and it is
 * worth naming here because this plate is one of three surfaces that describe
 * that row. A second fix was written — suppress the figure until the client
 * cache records a lookup — and it could never fire: the cell it guarded only
 * exists once a render has landed, which cannot happen without a call. It is
 * gone. What removed `0 ms` from this screen is that on a corpus-less row there
 * is no `Last call` cell at all. See BottomHUD.tsx.
 * =============================================================================
 */

import { COPY } from '@/copy';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, LodChip, Panel } from '@/ui/primitives';

import { LatentField, latentSource } from '../LatentField';

export function EmptyScreen(): JSX.Element {
  const busy = useAtlasStore((s) => s.app !== 'EMPTY');
  const source = latentSource();

  return (
    <div className="empty">
      <LatentField shape="field" className="empty__field" />

      <Panel title={COPY.states.EMPTY.title} className="empty__plate">
        {/* WHAT IS ACTUALLY BEHIND THIS PANEL — see the header. Two sentences,
            one per source, and never both. */}
        <p className="t-14 ink-dim" data-prose>
          {source === 'bake' ? COPY.instruments.empty.field.bake : COPY.instruments.empty.field.grid}
        </p>

        {/* --ink-dim, NOT --ink-faint. This is the sentence that teaches what
            `latent` is, on the screen the whole product uses to teach it. Faint
            is the decoration step at 3:1 and is not allowed to carry the only
            statement of a thing the reader has to understand. */}
        <p className="t-12-5 ink-dim" data-prose>
          {COPY.states.EMPTY.note}
        </p>

        <div className="empty__ramp">
          {/* The tier name is a label on a resolution scale, not a light. */}
          <LodChip state="latent" tone="neutral" />
          <span className="t-11 ink-dim" data-prose>
            {COPY.ramp.states.latent.short}
          </span>
        </div>

        {/* THE ROW ALONG THE BOTTOM, DESCRIBED AS IT NOW BEHAVES. It used to be
            described as a row of em dashes, which was both the intent and, in
            the latency cell, untrue. */}
        <p className="t-11 ink-dim" data-prose>
          {COPY.instruments.empty.hudNote}
        </p>

        <Btn
          variant="primary"
          onClick={() => void useAtlas.getState().ingestDemo()}
          disabled={busy}
          title={COPY.states.EMPTY.action?.title}
        >
          {COPY.states.EMPTY.action?.label}
        </Btn>
      </Panel>
    </div>
  );
}
