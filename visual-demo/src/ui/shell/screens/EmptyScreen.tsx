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
 * "A GHOST OF WHAT WILL APPEAR", MEANT LITERALLY
 * -----------------------------------------------------------------------------
 * If the corpus has been materialised in this session and then closed, the
 * engine still holds the bake — so the field behind this panel is the REAL
 * layout of the world that is about to load, drawn at the tier that says nothing
 * has been spent on it. That is not a mock-up of what will appear; it is what
 * will appear, unresolved.
 *
 * If nothing has ever been built, there is no layout to show and the field falls
 * back to the engine's own deterministic hex lattice. The two are visually
 * different and the caption says which one is on screen, because a screen that
 * silently swapped a real layout for a lattice would be doing exactly the thing
 * this product is built against.
 *
 * The top bar and the HUD ARE present here, unlike FIRST-RUN, and every figure
 * in the HUD reads as an em dash. That is the point: it is the one screen where
 * the instrument can be seen honestly reporting that it has measured nothing.
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
        <p className="t-14 ink-dim" data-prose>
          {COPY.states.EMPTY.body}
        </p>
        <p className="t-12-5 ink-faint" data-prose>
          {COPY.states.EMPTY.note}
        </p>

        <div className="empty__ramp">
          {/* The tier name is a label on a resolution scale, not a light. */}
          <LodChip state="latent" tone="neutral" />
          <span className="t-11 ink-faint" data-prose>
            {COPY.ramp.states.latent.short}
          </span>
        </div>

        {/* THE CAPTION ONLY MAKES THE REAL-POSITIONS CLAIM WHEN IT IS TRUE.
            `latentNote` says "latent nodes are drawn in their real positions",
            and it was printed under the fallback LATTICE — a perfectly regular
            grid of identical circles, in the one panel whose whole text is a
            lecture about not pretending. When there is no bake there are no
            positions, and the body copy above already says the honest thing:
            this is a grid, drawn at latent resolution. */}
        {source === 'bake' ? (
          <p className="t-11 ink-faint" data-prose>
            {COPY.hud.latentNote}
          </p>
        ) : null}

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
