/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — FIRST RUN
 * =============================================================================
 *
 * The void, one latent constellation, and one control.
 *
 * THIS IS THE MOST RESTRAINED SCREEN IN THE PRODUCT AND IT IS SUPPOSED TO BE.
 * There is no top bar, no HUD, no rail, no second button and no third line of
 * copy. Every instrument in this application reports a measurement, and on this
 * screen there is nothing measured yet — a rack of em dashes would be chrome
 * pretending to be an instrument, which is the exact failure the HUD exists to
 * prevent everywhere else. So the chrome is not here. It arrives with the
 * corpus, which is when it starts having something to say.
 *
 * The constellation behind the words is the product's whole claim as a shape:
 * two clusters that share nothing but a single node, and the one hairline that
 * crosses between them. It is drawn at `latent` — outline only, 12% — because
 * nothing has been resolved. It carries no label and no figure, so there is
 * nothing on this screen that could be mistaken for data.
 *
 * The one control ingests the bundled corpus. `boot()` deliberately stops here
 * on a genuine first visit, and this button is how the invitation is accepted.
 *
 * -----------------------------------------------------------------------------
 * ONE SUBJECT, AND THE WORDS ARE NOT IT
 * -----------------------------------------------------------------------------
 * The plate used to be a fixed ~510px block marooned in the lower-left corner of
 * an unbounded canvas: at 4K it covered about 1.5% of the frame and had no
 * compositional relationship to the 2160px of nothing above it. Restraint is
 * deliberate emptiness around ONE COMMANDING SUBJECT, not content pushed into a
 * corner.
 *
 * So the subject is the constellation, drawn large and centred, and the plate is
 * bound to a visible optical axis at the lower left of it — the title block of a
 * technical drawing, which is exactly what this is. Its width and its type both
 * scale with the frame, so the same composition arrives at 1080p, 1440p and 4K
 * instead of the same 510px card arriving in three different amounts of void.
 * =============================================================================
 */

import { COPY } from '@/copy';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn } from '@/ui/primitives';

import { LatentField } from '../LatentField';

export function FirstRun(): JSX.Element {
  const busy = useAtlasStore((s) => s.app !== 'FIRST-RUN');

  return (
    <div className="firstrun">
      <LatentField shape="constellation" className="firstrun__field" />

      <div className="firstrun__plate">
        <h1 className="firstrun__name t-28 w-650">{COPY.states['FIRST-RUN'].title}</h1>
        <p className="firstrun__tagline t-16 tone-render u-tone">{COPY.product.tagline}</p>
        <p className="firstrun__body t-14 ink-dim" data-prose>
          {COPY.states['FIRST-RUN'].body}
        </p>
        <p className="firstrun__note t-12-5 ink-faint" data-prose>
          {COPY.states['FIRST-RUN'].note}
        </p>

        <Btn
          variant="primary"
          onClick={() => void useAtlas.getState().ingestDemo()}
          disabled={busy}
          title={COPY.states['FIRST-RUN'].action?.title}
        >
          {COPY.states['FIRST-RUN'].action?.label}
        </Btn>

        <p className="firstrun__corpus caps ink-faint" data-prose>
          {COPY.provenance.badge}
        </p>
      </div>
    </div>
  );
}
