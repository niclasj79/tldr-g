/**
 * =============================================================================
 * RUNG LEGEND — what this rung MEANS. Nothing else.
 * =============================================================================
 *
 * ONE INSTRUMENT, ONE JOB, and the job is not measurement.
 *
 * This used to be a ~1000px panel carrying the rung, its body count, the
 * corridors, the straits, the entity layer, the relations stroked, the
 * relations withheld, the rule that chose them and a five-tier histogram of the
 * resolution ramp — sitting forty pixels above a HUD that reported six of those
 * nine figures itself. Two instruments, one reading, and the numbers did not
 * even agree: the legend said ENTITY 1118, its own ramp summed to 1179 and the
 * HUD said NODES 1151, all inside one hundred vertical pixels of the frame that
 * goes in the deck. A product whose whole thesis is that the counting is honest
 * cannot print three totals for one population three lines apart.
 *
 * So the facts were divided and each has exactly one owner:
 *
 *   THE HUD OWNS MEASUREMENT     nodes, stroked, withheld, the resolution ramp,
 *                                labels, corridors, points, draw calls, frame.
 *   THE BREADCRUMB OWNS DEPTH    where you are on the spine, and how many bodies
 *                                this rung has. It is a navigation gauge and the
 *                                count is what makes it one.
 *   THIS OWNS MEANING            one glyph, one noun and one sentence saying
 *                                what the things in front of you ARE at this
 *                                depth. No numerals at all.
 *
 * The sentence comes from `COPY.atlas.captions`, which is keyed by `Rung` and
 * compile-checked to cover all four, so a fifth rung cannot be added without
 * somebody writing what it means. And while Atlas Mode is open the shell stands
 * this down entirely — that panel is the instrument whose subject this is, and
 * two panels reciting one line 800px apart is how you signal that nobody decided
 * which of them owns it.
 * =============================================================================
 */

import { COPY, rungCopy } from '@/copy';
import { useAtlasStore } from '@/state';
import { Glyph, cx } from '@/ui/primitives';

export interface RungLegendProps {
  className?: string;
  /**
   * Retained so the shell's existing call site keeps compiling. There is no
   * ramp here any more: the resolution histogram is a MEASUREMENT and the HUD
   * owns it, forty pixels below, where it was already being printed.
   */
  showRamp?: boolean;
}

export function RungLegend({ className }: RungLegendProps): JSX.Element {
  const { rung, assetId, assetTiling } = useAtlasStore((s) => ({
    rung: s.rung,
    assetId: s.assetId,
    assetTiling: s.assetTiling,
  }));
  const here = rungCopy(rung);

  /* ON A FLOOR THIS NAMES THE COVERING, NOT THE RUNG.
     -------------------------------------------------------------------------
     Standing inside one document while the legend reads "Asset — Documents with
     declared boundaries" describes the level the reader has just LEFT. They are
     past that sentence; what is on screen now is one of two tilings of a single
     document, and that is the thing that needs naming. The glyph follows for the
     same reason: a span-dot for the reading covering and nothing for the graph
     one, because the graph covering's subject is the cross-cutting layer, which
     has never had a spine mark and should not acquire one here. */
  const onFloor = assetId !== null;
  const label = onFloor ? COPY.navigation.tiling[assetTiling].label : here.label;
  const caption = onFloor ? COPY.navigation.tiling[assetTiling].long : COPY.atlas.captions[rung];

  return (
    <section className={cx('rl', className)} aria-label={COPY.topbar.rung.label}>
      <Glyph kind={onFloor ? (assetTiling === 'reading' ? 'passage' : 'entity') : rung} tone="render" />
      <span className="rl-name t-12-5 w-500">{label}</span>
      {/* The ontology at this depth. One line, and it is the whole reason the
          zoom is worth performing. */}
      <p className="rl-caption t-12-5 ink-dim">{caption}</p>
    </section>
  );
}
