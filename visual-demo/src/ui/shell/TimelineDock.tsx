/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — TIMELINE MODE
 * =============================================================================
 *
 * `T` opens the corpus's own clock: every dated event the engine returned, laid
 * on a real axis between the corpus's earliest and latest DECLARED BOUNDARY.
 *
 * NOT A DECORATIVE SPARKLINE. Three things make it an instrument:
 *
 *   1. THE AXIS IS MEASURED. `TimelineResponse.from` / `.to` are the corpus's
 *      real span. The engine explicitly never returns a sentinel window, because
 *      an axis labelled `0000-01-01 → 9999-12-31` is a placeholder that escaped
 *      into an instrument and the reader cannot tell it from a measurement.
 *
 *   2. THE TWO EVENT KINDS ARE NOT THE SAME THING and are not drawn as if they
 *      were. A BOUNDARY is a document declaring itself one thing — old light,
 *      `--evidence`. A CLAIM is a relation asserting a date — the graph talking,
 *      drawn in ink. A quarantined claim is drawn at `latent` opacity: it is in
 *      the payload, it is on the clock, and it never carried an answer.
 *
 *   3. THE TERRAIN REFLECTS THE WINDOW. Scrubbing selects, in the terrain, the
 *      nodes whose events fall inside it — through the real `selectNode` action,
 *      so the render light on the map is a real selection and the Inspector and
 *      the HUD agree with the axis. Nothing here paints the terrain directly.
 *
 * -----------------------------------------------------------------------------
 * WHY THE WINDOW IS APPLIED CLIENT-SIDE
 * -----------------------------------------------------------------------------
 * The store fetches the WHOLE span once. Sub-windows are then taken over the
 * events already in hand: dragging a handle is not an excuse to hit the engine
 * sixty times a second, and re-fetching per frame would make the axis flicker
 * between two truthful answers. The consequence is stated on screen — if the
 * engine truncated the fetch, the `truncated` readout says how many events the
 * limit cut off, so a window over a sample is never mistaken for a window over
 * everything.
 * =============================================================================
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { COPY } from '@/copy';
import type { TimelineEvent } from '@/engine';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Chip, Num, Panel, Tip } from '@/ui/primitives';

/** A date, as the corpus states it. Sliced from the ISO instant, never reformatted. */
function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

interface Brush {
  /** 0..1 of the full span. */
  a: number;
  b: number;
}

const FULL: Brush = { a: 0, b: 1 };

export interface TimelineDockProps {
  className?: string;
}

export function TimelineDock({ className }: TimelineDockProps): JSX.Element | null {
  const { open, timeline, showQuarantined, hasCorpus } = useAtlasStore((s) => ({
    open: s.ui.timeline,
    timeline: s.timeline,
    showQuarantined: s.filters.showQuarantined,
    hasCorpus: s.view !== null,
  }));

  const [win, setWin] = useState<Brush>(FULL);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<'a' | 'b' | null>(null);

  /* AN OPEN PANEL WITH NO AXIS IN IT IS NOT AN INSTRUMENT.
     `Timeline not loaded.` was shipped in a 1890×95px slab across the bottom of
     five of the twenty-one captures, occluding the terrain to announce its own
     absence. Two rules now: if it is open and has no data it FETCHES, and until
     the fetch lands it draws nothing at all. */
  useEffect(() => {
    if (!open || !hasCorpus || timeline !== null) return;
    void useAtlas.getState().loadTimeline();
  }, [open, hasCorpus, timeline]);

  // A new fetch is a new axis. Keeping a window from the previous one would put
  // the handles at positions that mean something different.
  useEffect(() => setWin(FULL), [timeline?.from, timeline?.to, timeline?.scope_id]);

  const span = useMemo(() => {
    if (timeline === null) return null;
    const t0 = Date.parse(timeline.from);
    const t1 = Date.parse(timeline.to);
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null;
    return { t0, t1, ms: t1 - t0 };
  }, [timeline]);

  const placed = useMemo(() => {
    if (timeline === null || span === null) return [];
    return timeline.events.map((e) => ({
      event: e,
      /** 0..1 along the axis. The only derived number on this screen. */
      p: (Date.parse(e.at) - span.t0) / span.ms,
    }));
  }, [timeline, span]);

  const inWindow = useMemo(
    () => placed.filter((x) => x.p >= Math.min(win.a, win.b) && x.p <= Math.max(win.a, win.b)),
    [placed, win],
  );

  /* THE YEAR GRID.
     A picket fence of two hundred ticks between two end labels cannot be read:
     you cannot see WHEN activity clusters, which is the only reason to have a
     timeline at all. The year boundaries come from the axis's own instants —
     nothing is binned to make them and nothing is rounded — and they are what
     turns "the ticks stop a third of the way along" from a rendering fault into
     the sentence "there is nothing after 2024". */
  const years = useMemo(() => {
    if (span === null) return [];
    const out: { p: number; label: string }[] = [];
    const first = new Date(span.t0).getUTCFullYear();
    const last = new Date(span.t1).getUTCFullYear();
    for (let y = first + 1; y <= last; y++) {
      const p = (Date.UTC(y, 0, 1) - span.t0) / span.ms;
      if (p > 0.02 && p < 0.98) out.push({ p, label: String(y) });
    }
    return out;
  }, [span]);

  /* THE DENSITY ENVELOPE. One column per bin, height = share of the busiest
     bin. It is a histogram of the events already placed on the axis above it —
     the same population, counted — so the shape and the ticks cannot disagree. */
  const envelope = useMemo(() => {
    const bins = 72;
    const counts = new Array<number>(bins).fill(0);
    for (const x of placed) {
      const i = Math.min(bins - 1, Math.max(0, Math.floor(x.p * bins)));
      counts[i] += 1;
    }
    const peak = Math.max(1, ...counts);
    return counts.map((n) => n / peak);
  }, [placed]);

  /* ---- the drag ---------------------------------------------------------- */

  useEffect(() => {
    if (!open) return;
    const move = (e: PointerEvent): void => {
      const handle = dragging.current;
      const el = track.current;
      if (handle === null || el === null) return;
      const rect = el.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
      setWin((w) => ({ ...w, [handle]: p }) as Brush);
    };
    const up = (): void => {
      if (dragging.current === null) return;
      dragging.current = null;
      reflectInTerrain();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // `reflectInTerrain` is read at call time from the latest closure below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inWindow]);

  /** Select, in the terrain, the nodes whose events fall in the window. */
  const reflectInTerrain = (): void => {
    const ids: string[] = [];
    for (const x of inWindow) if (!ids.includes(x.event.node_id)) ids.push(x.event.node_id);
    const store = useAtlas.getState();
    if (ids.length === 0) {
      store.clearFocus();
      return;
    }
    ids.forEach((id, i) => store.selectNode(id, i > 0));
  };

  if (!open) return null;
  // Nothing to draw yet. The toggle stays lit because the panel is open and the
  // fetch is in flight; the moment it lands, the axis appears where the empty
  // slab used to be.
  if (timeline === null || span === null) return null;

  const from = timeline.from;
  const to = timeline.to;
  const lo = Math.min(win.a, win.b);
  const hi = Math.max(win.a, win.b);
  const windowFrom = new Date(span.t0 + lo * span.ms).toISOString();
  const windowTo = new Date(span.t0 + hi * span.ms).toISOString();
  const truncated = timeline.truncated;
  const lastP = placed.length === 0 ? 1 : Math.max(...placed.map((x) => x.p));

  return (
    <Panel
      title={
        <Tip content={`${COPY.timeline.subtitle} ${COPY.timeline.note}`}>
          <span>{COPY.timeline.title}</span>
        </Tip>
      }
      className={['tdock', className].filter(Boolean).join(' ')}
      /* EVERY CONTROL IN ONE ROW, BECAUSE THIS PANEL SITS ON THE MAP.
         The two window controls used to have a foot of their own under the
         axis, which made the dock 206px tall — 12.1% of the window, and the
         reason Timeline Mode measured 67.2% unobstructed terrain, under the
         brief's floor, in the honest audit. A control row is a control row
         wherever it is; the axis is the only thing that needs its own band. */
      actions={
        <>
          <Btn variant="quiet" size="sm" onClick={reflectInTerrain} title={COPY.hud.selectionLabel}>
            {COPY.hud.selectionLabel}
          </Btn>
          <Btn
            variant="ghost"
            size="sm"
            onClick={() => {
              setWin(FULL);
              useAtlas.getState().clearFocus();
            }}
            title={COPY.hud.clearSelection.title}
          >
            {COPY.hud.clearSelection.label}
          </Btn>
          <Tip content={COPY.timeline.includeQuarantined.title}>
            <Chip
              active={showQuarantined}
              tone={showQuarantined ? 'warn' : 'dim'}
              onClick={() => {
                useAtlas.getState().toggleQuarantined();
                void useAtlas.getState().loadTimeline();
              }}
            >
              {COPY.timeline.includeQuarantined.label}
            </Chip>
          </Tip>
          <Btn variant="ghost" size="sm" onClick={() => useAtlas.getState().toggle('timeline')} title={COPY.common.close.title}>
            {COPY.common.close.label}
          </Btn>
        </>
      }
    >
      {/* ONE HEADER ROW, AND THE THREE COUNTS RECONCILE IN IT.
          It used to shout `NOT SHOWN 2 168` at one end and `200 of 200` ninety
          pixels below at the other, with nothing joining them — one instrument
          contradicting itself twice in one panel. Selected, plotted and cut off
          are now adjacent, in that order, and they add up. */}
      <div className="tdock__head">
        <Tip content={COPY.timeline.window.tip}>
          <span className="tdock__span">
            <span className="caps ink-faint">{COPY.timeline.window.label}</span>
            <span className="mono ink-dim">{isoDay(from)}</span>
            <span className="ink-faint">→</span>
            <span className="mono ink-dim">{isoDay(to)}</span>
          </span>
        </Tip>
        <Tip content={COPY.timeline.scope.tip}>
          <span className="tdock__span">
            <span className="caps ink-faint">{COPY.timeline.scope.label}</span>
            <span className="mono ink-dim">{timeline.scope_id ?? COPY.timeline.scope.all}</span>
          </span>
        </Tip>
        <Tip content={COPY.timeline.events.claim.tip}>
          <span className="tdock__span">
            <span className="caps ink-faint">{COPY.timeline.events.claim.label}</span>
            {/* A COUNT OF EVENTS IN A WINDOW IS NOT THE ENGINE'S ATTENTION.
                The window handles are teal because dragging one is the live
                selection; the tally it produces is a measurement, in ink. */}
            <Num value={inWindow.length} format="int" tone="dim" />
            <span className="ink-faint">{COPY.common.ofLabel}</span>
            <Num value={placed.length} format="int" tone="faint" />
          </span>
        </Tip>
        {truncated === 0 ? null : (
          <Tip content={COPY.timeline.truncated.tip}>
            <span className="tdock__span">
              <span className="caps ink-faint">{COPY.timeline.truncated.label}</span>
              <Num value={truncated} format="int" tone="warn" />
            </span>
          </Tip>
        )}
        {/* THE SELECTED WINDOW, ONLY WHEN IT IS A SELECTION. At full extent it
            is the same two dates WINDOW already prints two cells to the left,
            and one instrument printing one reading twice is what made this
            panel contradict itself. */}
        {lo > 0.001 || hi < 0.999 ? (
          <span className="tdock__span">
            <span className="caps ink-faint">{COPY.hud.selectionLabel}</span>
            <span className="mono ink">
              {isoDay(windowFrom)} → {isoDay(windowTo)}
            </span>
          </span>
        ) : null}
        {placed.length === 0 ? (
          <span className="t-12-5 ink-dim" data-prose>
            {COPY.timeline.empty}
          </span>
        ) : null}
        <span className="tdock__keys">
          <Tip content={COPY.timeline.events.boundary.tip}>
            <span className="tdock__legend">
              <i className="tdock__key tdock__key--boundary" />
              <span className="caps ink-faint">{COPY.timeline.events.boundary.label}</span>
            </span>
          </Tip>
          <Tip content={COPY.timeline.events.claim.tip}>
            <span className="tdock__legend">
              <i className="tdock__key tdock__key--claim" />
              <span className="caps ink-faint">{COPY.timeline.events.claim.label}</span>
            </span>
          </Tip>
          {truncated === 0 ? null : (
            <Tip content={COPY.timeline.truncated.tip}>
              <span className="tdock__legend">
                <i className="tdock__key tdock__key--unsampled" />
                <span className="caps ink-faint">{COPY.timeline.truncated.label}</span>
              </span>
            </Tip>
          )}
        </span>
      </div>

      <div className="tdock__track" ref={track}>
        {/* The shape, under the ticks: one column per bin, scaled to the busiest
            bin. It is the same events counted, so it cannot disagree with them. */}
        <div className="tdock__envelope" aria-hidden="true">
          {envelope.map((h, i) => (
            <span key={i} className="tdock__bin" style={{ height: `${(h * 100).toFixed(1)}%` }} />
          ))}
        </div>

        {years.map((y) => (
          <span key={y.label} className="tdock__gridline" style={{ left: `${y.p * 100}%` }}>
            <span className="tdock__year mono ink-faint">{y.label}</span>
          </span>
        ))}

        <div className="tdock__axis" />
        {/* Everything outside the window is dimmed, never removed: the axis
            is the whole corpus and the window is a reading of it. */}
        <div className="tdock__mask" style={{ left: 0, width: `${lo * 100}%` }} />
        <div className="tdock__mask" style={{ left: `${hi * 100}%`, right: 0 }} />

        {/* THE UNSAMPLED REMAINDER.
            The engine caps the fetch and reports what it cut off, but the
            COUNT alone does not stop the picture from lying: with the limit
            taken in date order, the ticks bunch in the early years and the
            axis LOOKS like a corpus where nothing happened after that. So
            the span past the last event in hand is marked as unsampled,
            because a reader takes the shape before they take the number. */}
        {truncated > 0 && lastP < 0.999 ? (
          <span
            className="tdock__unsampled"
            style={{ left: `${lastP * 100}%`, right: 0 }}
            title={COPY.timeline.truncated.tip}
          />
        ) : null}

        {placed.map((x, i) => (
          <i
            key={`${x.event.node_id}:${x.event.edge_id ?? 'b'}:${i}`}
            className="tdock__tick"
            data-kind={x.event.family === null ? 'boundary' : 'claim'}
            data-quarantined={x.event.quarantined}
            style={{ left: `${x.p * 100}%` }}
            title={`${isoDay(x.event.at)} · ${x.event.label}`}
          />
        ))}

        <button
          type="button"
          className="tdock__handle"
          style={{ left: `${lo * 100}%` }}
          onPointerDown={() => {
            dragging.current = win.a <= win.b ? 'a' : 'b';
          }}
          aria-label={COPY.timeline.window.label}
        />
        <button
          type="button"
          className="tdock__handle"
          style={{ left: `${hi * 100}%` }}
          onPointerDown={() => {
            dragging.current = win.a <= win.b ? 'b' : 'a';
          }}
          aria-label={COPY.timeline.window.label}
        />
      </div>

    </Panel>
  );
}

/** Exported for the analyst rail: the same events, summarised without the axis. */
export function timelineSummary(events: readonly TimelineEvent[]): {
  boundaries: number;
  claims: number;
  quarantined: number;
} {
  let boundaries = 0;
  let claims = 0;
  let quarantined = 0;
  for (const e of events) {
    if (e.family === null) boundaries += 1;
    else claims += 1;
    if (e.quarantined) quarantined += 1;
  }
  return { boundaries, claims, quarantined };
}
