/**
 * GLYPH — the rung, readable without a word.
 *
 *   ◆ continent   ⬢ island   ▮ asset   · passage
 *
 * Four marks, exactly four rungs. The marks come from the engine
 * (`RUNG_GLYPH`) so a rung can never be drawn with a symbol the schema does not
 * recognise. Each is optically size-corrected in CSS: `·` at the same font-size
 * as `◆` is nearly invisible, and a breadcrumb where the glyphs do not line up
 * reads as sloppy rather than as a hierarchy.
 */

import { RUNG_GLYPH, type Rung } from '@/engine';
import { cx, toneClass, type Tone } from './tone';

export interface GlyphProps {
  rung: Rung;
  tone?: Tone;
  className?: string;
}

export function Glyph({ rung, tone = 'dim', className }: GlyphProps): JSX.Element {
  return (
    <span
      className={cx('glyph', `glyph-${rung}`, toneClass(tone), className)}
      title={rung}
      aria-label={rung}
      role="img"
    >
      {RUNG_GLYPH[rung]}
    </span>
  );
}
