/**
 * PANEL — thin glass over the void.
 *
 * Not a card. A panel is a pane of instrument glass laid over a terrain that is
 * still moving underneath it: --panel-bg is translucent and blurred on purpose,
 * so the world does not disappear behind the instrumentation reading it.
 *
 * ELEVATION IS TWO THINGS AND ONLY TWO THINGS: a 1px --line border, and
 * --edge-light, an inset highlight along the TOP EDGE only, as if the panel's
 * upper lip is catching the glow of the terrain below. There is no light source
 * above this UI, so there is nothing that could cast a drop shadow.
 *
 * The title is a section marker, not a headline: 11px, uppercase, --ink-faint,
 * wide tracking. If a panel needs to shout its own name, the panel is wrong.
 */

import type { ReactNode } from 'react';
import type { NodeKind } from '@/engine';
import { Glyph } from './Glyph';
import { cx, toneClass, type Tone } from './tone';

export interface PanelProps {
  /** Section marker. Rendered 11px uppercase --ink-faint, never as a headline. */
  title?: ReactNode;
  /** Spine glyph shown before the title, tinted by `tone`. ◆ ⬢ ▮ ·
      A KIND, not a rung: the passage keeps its dot and lost its rung. */
  glyph?: NodeKind;
  /** Controls docked to the right of the title row. Keep them quiet. */
  actions?: ReactNode;
  /** Colours the glyph and any tone-consuming child that does not set its own. */
  tone?: Tone;
  /** Scroll the BODY internally. The page itself never scrolls. */
  scroll?: boolean;
  children?: ReactNode;
  className?: string;
  id?: string;
}

export function Panel({
  title,
  glyph,
  actions,
  tone = 'neutral',
  scroll = false,
  children,
  className,
  id,
}: PanelProps): JSX.Element {
  const head = title !== undefined || glyph !== undefined || actions !== undefined;
  return (
    <section id={id} className={cx('panel', toneClass(tone), className)}>
      {head ? (
        <header className="panel-hd">
          {glyph ? <Glyph kind={glyph} tone={tone} className="panel-glyph" /> : null}
          {title !== undefined ? <h2 className="panel-title">{title}</h2> : null}
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('panel-body', scroll && 'is-scroll u-scroll')}>{children}</div>
    </section>
  );
}
