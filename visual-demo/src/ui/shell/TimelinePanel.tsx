/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE TIMELINE LENS, RAIL SIDE
 * =============================================================================
 *
 * The axis over the terrain says WHEN. This says WHAT, and it is the half the
 * lens never had.
 *
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG, PRECISELY
 * -----------------------------------------------------------------------------
 * The dock's real model was "brush a date window, then select every graph node
 * whose events fall inside it" — and nothing on screen said so. The control
 * labelled `Selected` was an ACTION wearing the name of a state. Dragging one
 * handle selected 162 nodes out of a 200-event sample, reframed the map into a
 * dense blob, and neither `Clear` nor closing the lens gave the camera back. The
 * two hundred ticks were hover titles: you could see that something happened in
 * 2023 and you could not open it, name it, or find it on the map.
 *
 * Four changes, and they are all in this file or in the store beside it:
 *
 *   SCOPE IS EXPLICIT AND STARTS NARROW. `Current answer` by default, then
 *   `Current selection`, then `Whole corpus` as a deliberate widening. An
 *   alternate lens preserves the current answer's scope unless the user asks for
 *   more — which is also why the truncation notice stops being the headline.
 *
 *   DRAGGING IS A PREVIEW. The window writes one store field and touches neither
 *   the selection nor the camera. `Apply window` is a press.
 *
 *   EVENTS ARE OBJECTS. Every event is a row: its date, what it says, and the
 *   node it happened to — clickable, and bidirectional with the map, so the list
 *   and the terrain are two views of one set rather than two populations.
 *
 *   THE VERBS SAY WHAT THEY DO. `Apply window`, `Reset window`, `Restore
 *   previous view` — the last of which is the camera the lens borrowed, handed
 *   back, which is the promise `Clear` never made and never kept.
 * =============================================================================
 */

import { useMemo } from 'react';

import { COPY } from '@/copy';
import type { TimelineEvent } from '@/engine';
import { useAtlas, useAtlasStore, TIMELINE_SCOPES } from '@/state';
import type { TimelineScope } from '@/state';
import { Btn, Num, Panel, SectionLabel, Tip } from '@/ui/primitives';

/** The events the current window admits, and the window's own instants. */
function useWindowed(): {
  events: { event: TimelineEvent; p: number; inside: boolean }[];
  from: string | null;
  to: string | null;
  total: number;
  truncated: number;
} {
  const { timeline, window } = useAtlasStore((s) => ({ timeline: s.timeline, window: s.timelineWindow }));

  return useMemo(() => {
    if (timeline === null) return { events: [], from: null, to: null, total: 0, truncated: 0 };
    const t0 = Date.parse(timeline.from);
    const t1 = Date.parse(timeline.to);
    const ms = t1 - t0;
    const lo = window === null ? 0 : Math.min(window.a, window.b);
    const hi = window === null ? 1 : Math.max(window.a, window.b);
    const events = timeline.events.map((event) => {
      const p = Number.isFinite(ms) && ms > 0 ? (Date.parse(event.at) - t0) / ms : 0;
      return { event, p, inside: p >= lo && p <= hi };
    });
    return {
      events,
      from: Number.isFinite(ms) && ms > 0 ? new Date(t0 + lo * ms).toISOString().slice(0, 10) : null,
      to: Number.isFinite(ms) && ms > 0 ? new Date(t0 + hi * ms).toISOString().slice(0, 10) : null,
      total: timeline.events.length,
      truncated: timeline.truncated,
    };
  }, [timeline, window]);
}

export interface TimelinePanelProps {
  className?: string;
}

export function TimelinePanel({ className }: TimelinePanelProps): JSX.Element {
  const { scope, hasWindow, applied, focus, selection, loaded } = useAtlasStore((s) => ({
    scope: s.timelineScope,
    hasWindow: s.timelineWindow !== null,
    applied: s.timelineApplied,
    focus: s.focus,
    selection: s.selection,
    loaded: s.timeline !== null,
  }));

  const { events, from, to, total, truncated } = useWindowed();
  const inside = events.filter((e) => e.inside);

  return (
    <div className={['tl', className].filter(Boolean).join(' ')}>
      <Panel title={COPY.lenses.timeline.label} tone="neutral">
        {/* ---- SCOPE. Narrow by default; widening is a deliberate press. ---- */}
        <SectionLabel>{COPY.timelineLens.scope.label}</SectionLabel>
        <div className="tl__scopes" role="radiogroup" aria-label={COPY.timelineLens.scope.label}>
          {TIMELINE_SCOPES.map((s) => (
            <Tip key={s} content={COPY.timelineLens.scope.options[s].long}>
              <button
                type="button"
                className="tl__scope"
                role="radio"
                aria-checked={scope === s}
                data-active={scope === s}
                onClick={() => void useAtlas.getState().setTimelineScope(s as TimelineScope)}
              >
                {COPY.timelineLens.scope.options[s].label}
              </button>
            </Tip>
          ))}
        </div>

        {/* ---- THE INTERACTION, STATED. It was never stated before. -------- */}
        <p className="tl__hint t-12-5 ink-dim" data-prose>
          {COPY.timelineLens.hint}
        </p>

        {/* ---- THE WINDOW, AND THE THREE VERBS ---------------------------- */}
        <div className="tl__win">
          <span className="tl__winr mono t-12-5 ink-dim">
            {from ?? '—'} → {to ?? '—'}
          </span>
          <span className="tl__wine t-12-5 ink-dim">
            <Num value={inside.length} format="int" tone="dim" /> {COPY.common.ofLabel}{' '}
            <Num value={total} format="int" tone="dim" /> {COPY.timelineLens.events.label}
          </span>
        </div>

        <div className="tl__acts">
          <Btn
            variant="quiet"
            size="sm"
            disabled={!hasWindow}
            onClick={() => useAtlas.getState().applyTimelineWindow()}
            title={COPY.timelineLens.apply.title}
          >
            {COPY.timelineLens.apply.label}
          </Btn>
          <Btn
            variant="ghost"
            size="sm"
            disabled={!hasWindow && !applied}
            onClick={() => useAtlas.getState().resetTimelineWindow()}
            title={COPY.timelineLens.reset.title}
          >
            {COPY.timelineLens.reset.label}
          </Btn>
          <Btn
            variant="ghost"
            size="sm"
            onClick={() => void useAtlas.getState().setLens('explore')}
            title={COPY.timelineLens.restore.title}
          >
            {COPY.timelineLens.restore.label}
          </Btn>
        </div>

        {/* ---- THE AGGREGATE, NOT THE TRUNCATION NOTICE -------------------
            `200 shown / 2,168 not shown` made the sample's incompleteness the
            headline of a lens whose subject is the corpus's own chronology. The
            count of what the CURRENT SCOPE holds leads; the sampling limit is
            stated after it, once, and only when it actually binds. */}
        {truncated === 0 ? null : (
          <p className="tl__trunc t-11 ink-dim" data-prose>
            {COPY.timelineLens.truncated}
          </p>
        )}
      </Panel>

      {/* ---- THE EVENTS, AS OBJECTS ------------------------------------- */}
      <Panel title={COPY.timelineLens.events.title} tone="neutral">
        {!loaded ? (
          <p className="t-13 ink-dim" data-prose>
            {COPY.common.notLoaded}
          </p>
        ) : inside.length === 0 ? (
          <p className="t-13 ink-dim" data-prose>
            {COPY.timelineLens.events.empty}
          </p>
        ) : (
          <ol className="tl__events">
            {inside.map(({ event }) => {
              const held = focus === event.node_id || selection.includes(event.node_id);
              return (
                <li key={`${event.node_id}:${event.at}`} className="tl__event" data-held={held}>
                  <button
                    type="button"
                    className="tl__eventbtn"
                    aria-pressed={held}
                    onClick={() => {
                      /* BIDIRECTIONAL, AND IT HOLDS THE PLACE. Selecting from the
                         list frames the one node it names — which is a move the
                         user asked for, unlike the bulk fly-to the drag used to
                         cause — and leaves the lens open so the list is still
                         there to work through. */
                      const st = useAtlas.getState();
                      st.selectNode(event.node_id, false);
                      st.setTab('inspect', { pin: true });
                      void st.frameIds([event.node_id], 140);
                    }}
                  >
                    <span className="tl__at mono t-11">{event.at.slice(0, 10)}</span>
                    <span className="tl__what t-12-5" data-prose>
                      {event.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
    </div>
  );
}
