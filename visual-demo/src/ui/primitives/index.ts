/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — UI PRIMITIVES
 * =============================================================================
 *
 * `import { Panel, Num, Hash } from '@/ui/primitives';`
 *
 * The complete chrome vocabulary. If a screen needs a shape that is not in this
 * list, the right move is almost always to compose two of these rather than to
 * invent a third — a product with seventeen bespoke card treatments does not
 * look like an instrument, it looks like seventeen people.
 *
 * THE ONE RULE THAT MATTERS MOST: every measured number goes through <Num>.
 * Token counts, latency, hashes' companions, degrees, confidences, percentages,
 * cache hits, ids, counts. `scripts/check-discipline.mjs` enforces it, and
 * `window.__atlas.audit().monoViolations` catches what the linter cannot see.
 *
 * Styling lives in `@/styles/primitives.css`, which the shell imports once.
 * Nothing here ships an inline colour, duration or radius.
 * =============================================================================
 */

export { Panel, type PanelProps } from './Panel';
export { Num, formatFigure, figureText, type NumFormat, type NumProps } from './Num';
export { Hash, type HashProps } from './Hash';
export { Chip, type ChipProps } from './Chip';
export { Btn, type BtnProps } from './Btn';
export { Meter, type MeterProps } from './Meter';
export { Glyph, type GlyphProps } from './Glyph';
export { StateDot, type DotState, type StateDotProps } from './StateDot';
export { KeyHint, type KeyHintProps } from './KeyHint';
export { Row, SectionLabel, Divider, type RowProps, type SectionLabelProps, type DividerProps } from './Row';
export { Disclosure, type DisclosureProps } from './Disclosure';
export { Tip, type TipProps } from './Tip';
export { Sparkline, type SparklineProps } from './Sparkline';
export { ScrimOverlay, type ScrimOverlayProps } from './ScrimOverlay';
export { LodChip, type LodChipProps } from './LodChip';
export { cx, toneClass, type Tone } from './tone';
