/**
 * GLYPH — the spine mark for a node, readable without a word.
 *
 *   ◆ continent   ⬢ island   ▮ asset   · passage
 *
 * Four marks, THREE rungs. The passage keeps its dot and lost its rung on
 * 2026-08-02 (the floor model), so this takes a `kind`, not a `rung` — a
 * citation and a drilldown both need the dot and neither is standing anywhere. The marks come from the engine
 * (`RUNG_GLYPH`) so a rung can never be drawn with a symbol the schema does not
 * recognise. Each is optically size-corrected in CSS: `·` at the same font-size
 * as `◆` is nearly invisible, and a breadcrumb where the glyphs do not line up
 * reads as sloppy rather than as a hierarchy.
 */

import { KIND_GLYPH, type NodeKind } from '@/engine';
import { cx, toneClass, type Tone } from './tone';

export interface GlyphProps {
  kind: NodeKind;
  tone?: Tone;
  className?: string;
}

export function Glyph({ kind, tone = 'dim', className }: GlyphProps): JSX.Element {
  return (
    <span
      className={cx('glyph', `glyph-${kind}`, toneClass(tone), className)}
      title={kind}
      aria-label={kind}
      role="img"
    >
      {KIND_GLYPH[kind]}
    </span>
  );
}
