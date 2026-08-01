/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE EVENT AXIS
 * =============================================================================
 *
 * The half of the Timeline lens that sits over the terrain: every dated event
 * the current scope returned, on the corpus's real span, with a two-handled
 * brush over it.
 *
 * It is the WHEN. The rail beside it (TimelinePanel.tsx) is the WHAT — the
 * scope, the three verbs, and the events as rows you can open. Both are mounted
 * by the same lens and neither exists without the other.
 *
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG, PRECISELY
 * -----------------------------------------------------------------------------
 * 1. THE BRUSH WAS PRIVATE. The window lived in this component's own `useState`,
 *    so the axis and the rail's event list were two copies of one reading and
 *    the second one did not exist yet. It is `store.timelineWindow` now: one
 *    field, two renders, and they cannot disagree by construction.
 *
 * 2. DRAGGING SELECTED. `pointerup` called `reflectInTerrain()`, which called
 *    `selectNode` once per node in the window: one handle drag selected 162
 *    nodes out of a 200-event sample, the shell framed the set, and the map
 *    became a dense blob. Looking cost you the camera. Dragging is now a
 *    preview — it writes one field, touches neither the selection nor the
 *    viewpoint — and committing is a press, in the rail, called `Apply window`.
 *
 * 3. THE HANDLES CROSSED. The drag picked which end to move with
 *    `win.a <= win.b ? 'a' : 'b'`, so dragging Start past End silently swapped
 *    which handle was which. A control labelled `Start date` that becomes the
 *    end date is worse than an unlabelled one. Each end is now clamped by the
 *    other and keeps its identity for the whole gesture.
 *
 * 4. THE WORD `WINDOW` MEANT THE WHOLE SPAN. See the copy block; the span is
 *    `Axis` here and `Window` is the brush and nothing else.
 *
 * -----------------------------------------------------------------------------
 * WHY THE THREE VERBS ARE NOT IN THIS PANEL
 * -----------------------------------------------------------------------------
 * A DECISION, not an omission. `Apply window`, `Reset window` and `Restore
 * previous view` live only in the rail.
 *
 *   - They are co-visible with this axis by construction. `lens === 'timeline'`
 *     mounts this dock over the stage AND `TimelinePanel` into the rail body;
 *     there is no state in which you can reach the brush and not the verbs.
 *   - Apply's reverse action is Reset. Splitting them across two surfaces would
 *     break the one rule this whole revision is built on — every navigation
 *     action has a VISIBLE reverse action — to save a few hundred pixels of
 *     pointer travel.
 *   - This panel stands on the map. At 206px it took 12.1% of the window and
 *     Timeline Mode measured 67.2% unobstructed terrain, under the brief's
 *     floor. Every control that does not have to be here is terrain given back.
 *
 * The dock's own `Close` went with them, and that is the same argument: it was
 * `toggle('timeline')`, which is `setLens('explore')`, which is what the rail
 * calls `Restore previous view` — one action wearing two names in one lens, and
 * only one of the two names told you the camera was coming back.
 *
 * -----------------------------------------------------------------------------
 * WHY THE TICKS ARE DECORATION AND THE RAIL LIST IS THE OPERABLE SURFACE
 * -----------------------------------------------------------------------------
 * Also a decision. A tick used to be `<i title="…">`: a hover title is not an
 * affordance, and the review said so. The obvious repair — make all two hundred
 * of them focusable buttons — is the wrong one. It puts two hundred tab stops
 * between a keyboard user and the next control, each stop a 1px object whose
 * accessible name would be a date and a label read out of any order that helps.
 *
 * So the marks stay marks (`aria-hidden`, `pointer-events: none`), the axis
 * carries a structured textual twin of what it draws — count, span, how many
 * the window admits, how many are on held nodes — and the enumeration lives in
 * the rail as rows that can be read, opened and worked through in order. The
 * link runs BOTH ways: a tick whose node is currently held is drawn in
 * `--render`, so pressing a row in the list, or a node on the map, shows you
 * where in time it happened.
 *
 * -----------------------------------------------------------------------------
 * WHY THE WINDOW IS APPLIED CLIENT-SIDE
 * -----------------------------------------------------------------------------
 * The store fetches the whole span for the scope once. Sub-windows are taken
 * over the events already in hand: dragging a handle is not an excuse to hit
 * the engine sixty times a second, and re-fetching per frame would make the
 * axis flicker between two truthful answers. Where the fetch was capped, the
 * span past the last event in hand is hatched — the count alone does not stop
 * the picture from lying, because with a limit taken in date order the ticks
 * bunch early and the axis LOOKS like a corpus where nothing happened after
 * that. The count itself is stated once, as a sentence, in the rail.
 * =============================================================================
 */

import { useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { COPY } from '@/copy';
import type { TimelineEvent } from '@/engine';
import { useAtlas, useAtlasStore } from '@/state';
import { Chip, Num, Panel, Tip } from '@/ui/primitives';

import './timeline.css';

/** A date, as the corpus states it. Sliced from the ISO instant, never reformatted. */
function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

/** Which end of the brush. Named, because the two are not interchangeable. */
type Handle = 'start' | 'end';

interface Brush {
  /** 0..1 of the full span. */
  a: number;
  b: number;
}

const FULL: Brush = { a: 0, b: 1 };

const DAY_MS = 86_400_000;

/**
 * The coarse keyboard step: a twentieth of the axis.
 *
 * The fine step is one DAY, which is the axis's own unit — but a corpus
 * spanning six years is 2,190 arrow presses wide, so a keyboard user needs a
 * stride as well as a nudge. A twentieth is the same granularity the density
 * envelope bins at, so Page Up moves roughly one visible column.
 */
const COARSE = 0.05;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * The id the axis's own description hangs off.
 *
 * A constant rather than a `useId`, and legitimately so: `lens === 'timeline'`
 * mounts exactly one of these, the way it mounts exactly one rail panel. A
 * generated id here would be a unique name for a thing that cannot collide.
 */
const SUMMARY_ID = 'tdock-axis-summary';

/**
 * Write ONE end of the brush, clamped by the other.
 *
 * Reads the store rather than a closure on purpose: the pointer listeners below
 * are registered once for the life of the panel, and a closure over `window`
 * would have them writing a stale brush by the second gesture.
 *
 * THE CLAMP IS THE FIX FOR THE SWAPPING HANDLES. Start can reach End and stops;
 * it never becomes End. A slider labelled `Start date` that silently turns into
 * the end date is a control that lies about itself once per drag.
 */
function moveEnd(handle: Handle, p: number): void {
  const st = useAtlas.getState();
  const cur = st.timelineWindow ?? FULL;
  const at = clamp01(p);
  st.setTimelineWindow(
    handle === 'start' ? { a: Math.min(at, cur.b), b: cur.b } : { a: cur.a, b: Math.max(at, cur.a) },
  );
}

export interface TimelineDockProps {
  className?: string;
}

export function TimelineDock({ className }: TimelineDockProps): JSX.Element | null {
  /* NO `ui.timeline` READ. This panel is mounted by `lens === 'timeline'` and by
     nothing else (see Shell.tsx), so "is it open" is a question the component
     cannot be asked. It used to be a panel that could be left lit over any
     workspace, which is how five captures in a row carried a timeline slab over
     a scene about something else. */
  const { timeline, brush, applied, showQuarantined, hasCorpus, selection, focus } = useAtlasStore(
    (s) => ({
      timeline: s.timeline,
      brush: s.timelineWindow,
      applied: s.timelineApplied,
      showQuarantined: s.filters.showQuarantined,
      hasCorpus: s.view !== null,
      selection: s.selection,
      focus: s.focus,
    }),
  );

  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<Handle | null>(null);
  /** The pointer that armed the drag. A second finger is not this gesture. */
  const dragPointer = useRef<number | null>(null);

  /* AN OPEN PANEL WITH NO AXIS IN IT IS NOT AN INSTRUMENT.
     `Timeline not loaded.` shipped in a 1890×95px slab across the bottom of five
     of the twenty-one captures, occluding the terrain to announce its own
     absence. Two rules: if it is mounted and has no data it FETCHES, and until
     the fetch lands it draws nothing at all. */
  useEffect(() => {
    if (!hasCorpus || timeline !== null) return;
    void useAtlas.getState().loadTimeline();
  }, [hasCorpus, timeline]);

  /* NO LOCAL RESET ON A NEW AXIS. `loadTimeline()` and `setTimelineScope()` both
     clear `timelineWindow` where the payload changes, which is the only place
     that can know the handles are about to mean something different. The local
     `useEffect(() => setWin(FULL), [timeline?.from, …])` this replaces was the
     second half of the two-copies bug: it reset one copy of the window. */

  const span = useMemo(() => {
    if (timeline === null) return null;
    const t0 = Date.parse(timeline.from);
    const t1 = Date.parse(timeline.to);
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null;
    return { t0, t1, ms: t1 - t0 };
  }, [timeline]);

  /** Every node the user is holding right now. The axis's half of the two-way link. */
  const heldIds = useMemo(() => {
    const set = new Set(selection);
    if (focus !== null) set.add(focus);
    return set;
  }, [selection, focus]);

  const placed = useMemo(() => {
    if (timeline === null || span === null) return [];
    return timeline.events.map((e) => ({
      event: e,
      /** 0..1 along the axis. The only derived number on this screen. */
      p: (Date.parse(e.at) - span.t0) / span.ms,
    }));
  }, [timeline, span]);

  /**
   * The span the DRAWN events actually occupy, which is not the axis.
   *
   * It is the fact the year grid exists to carry — "the ticks stop a third of
   * the way along" becoming "there is nothing after 2024" — and it was available
   * only by looking. The gridlines are `aria-hidden` and stay that way (five
   * bare year numbers interleaved into the group would be noise, the same
   * argument that keeps two hundred ticks out of the tab order), so the landmark
   * goes where the rest of the picture's readings already go: the textual twin.
   */
  const drawn = useMemo(() => {
    if (placed.length === 0) return null;
    let first = placed[0];
    let last = placed[0];
    for (const x of placed) {
      if (x.p < first.p) first = x;
      if (x.p > last.p) last = x;
    }
    return { from: isoDay(first.event.at), to: isoDay(last.event.at), lastP: last.p };
  }, [placed]);

  const win = brush ?? FULL;
  const lo = Math.min(win.a, win.b);
  const hi = Math.max(win.a, win.b);

  const inWindow = useMemo(
    () => placed.filter((x) => x.p >= lo && x.p <= hi),
    [placed, lo, hi],
  );

  const heldInWindow = useMemo(
    () => inWindow.reduce((n, x) => n + (heldIds.has(x.event.node_id) ? 1 : 0), 0),
    [inWindow, heldIds],
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

  /* ---- the drag ----------------------------------------------------------
     Registered ONCE. The old effect re-subscribed on every change to
     `inWindow` — an array rebuilt on every pointermove — so a single drag tore
     down and rebuilt two window listeners per frame, and the `pointerup`
     handler it removed was the one holding the commit.

     THREE WAYS OUT, BECAUSE ONE WAS NOT ENOUGH. `dragging.current` was cleared
     only by a `pointerup` this window happened to observe. Measured in the
     shipped build: arm a drag on the track, deliver no `pointerup` (release the
     button outside the browser frame), then move the bare mouse across the page
     — the brush followed it, b: 0.60 → 0.95 → 0.20, with nothing held down. So
     the gesture now also ends on `pointercancel` (the OS or the browser taking
     the pointer: a touch interruption, a gesture takeover, a drag onto a native
     menu) and on the first move that arrives with no button pressed, which is
     the only signal available when the release itself was never delivered. */

  useEffect(() => {
    /* AND NOTHING HAPPENS ON RELEASE. This is where `reflectInTerrain()` used to
       be: letting go of a handle selected every node in the window and threw the
       camera at the result. Releasing a brush now ends a gesture and means
       nothing else. */
    const end = (): void => {
      dragging.current = null;
      dragPointer.current = null;
    };
    const move = (e: PointerEvent): void => {
      const handle = dragging.current;
      const el = track.current;
      if (handle === null || el === null) return;
      if (dragPointer.current !== null && e.pointerId !== dragPointer.current) return;
      if (e.buttons === 0) {
        end();
        return;
      }
      const rect = el.getBoundingClientRect();
      moveEnd(handle, (e.clientX - rect.left) / Math.max(1, rect.width));
    };
    globalThis.addEventListener('pointermove', move);
    globalThis.addEventListener('pointerup', end);
    globalThis.addEventListener('pointercancel', end);
    return () => {
      globalThis.removeEventListener('pointermove', move);
      globalThis.removeEventListener('pointerup', end);
      globalThis.removeEventListener('pointercancel', end);
    };
  }, []);

  if (timeline === null || span === null) return null;

  /* ---- the readings, all of them derived from ONE window ------------------ */

  /** The axis in DAYS. The slider's domain is the corpus's own unit, not a percentage. */
  const days = Math.max(1, Math.round(span.ms / DAY_MS));
  /** One day, as a fraction of the axis. The arrow-key step. */
  const fine = Math.min(0.5, DAY_MS / span.ms);

  const axisFrom = isoDay(timeline.from);
  const axisTo = isoDay(timeline.to);
  const windowFrom = isoDay(new Date(span.t0 + lo * span.ms).toISOString());
  const windowTo = isoDay(new Date(span.t0 + hi * span.ms).toISOString());
  const brushing = brush !== null;
  const state = applied ? COPY.timelineLens.axis.applied : COPY.timelineLens.axis.previewing;
  const lastP = drawn?.lastP ?? 1;

  /**
   * Arm a drag. The ONLY place `dragging.current` is written non-null, so the
   * two guards below cannot be forgotten at one of the two entry points.
   *
   * THE PRIMARY BUTTON, AND ONLY IT. There was no button check anywhere on this
   * surface. Measured in the shipped build: a `button: 2` pointerdown at 90% of
   * the 1,542px track rewrote the window from b: 0.60 to b: 0.90 before the
   * context menu opened — and armed a drag whose `pointerup` the menu could then
   * swallow. Harmless before "the whole track is the brush", because a press
   * used to arm a handle and move nothing; a press now moves an end.
   *
   * AND CAPTURE, SO THE RELEASE COMES BACK. With the pointer captured, the
   * `pointerup` is delivered to this element even when it happens outside the
   * element, outside the panel, or outside the browser frame — which is the
   * release the `buttons === 0` guard above exists to survive not getting.
   */
  const beginDrag = (handle: Handle, e: ReactPointerEvent<HTMLElement>): boolean => {
    if (e.button !== 0 || !e.isPrimary) return false;
    dragging.current = handle;
    dragPointer.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* A pointer the browser no longer considers active. The gesture still
         runs on the window listeners; it just loses the delivery guarantee. */
    }
    return true;
  };

  /** Grab the nearer end from anywhere on the track. */
  const grabNearest = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const el = track.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const p = clamp01((e.clientX - rect.left) / Math.max(1, rect.width));
    const handle: Handle = Math.abs(p - lo) <= Math.abs(p - hi) ? 'start' : 'end';
    if (!beginDrag(handle, e)) return;
    moveEnd(handle, p);
  };

  const onHandleKey = (handle: Handle, e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const cur = useAtlas.getState().timelineWindow ?? FULL;
    const at = handle === 'start' ? cur.a : cur.b;
    let next: number;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = at - fine;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        next = at + fine;
        break;
      case 'PageDown':
        next = at - COARSE;
        break;
      case 'PageUp':
        next = at + COARSE;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = 1;
        break;
      default:
        return;
    }
    /* Both, and for two different reasons: `preventDefault` stops Home and the
       arrows scrolling the page out from under the axis, `stopPropagation` keeps
       the gesture out of the global keymap in `@/state/keys`. */
    e.preventDefault();
    e.stopPropagation();
    moveEnd(handle, next);
  };

  const brushHandle = (kind: Handle, at: number, date: string): JSX.Element => {
    const name = kind === 'start' ? COPY.timelineLens.handles.start : COPY.timelineLens.handles.end;
    /* THE ANNOUNCED RANGE IS THE RANGE THE CONTROL WILL ACCEPT.
       Both thumbs shipped `aria-valuemin={0} aria-valuemax={days}` — the whole
       axis, on both ends — while `moveEnd` clamps each end by the other. A
       reader on `Start date` was told the domain was 0–1,267 days, pressed End,
       and heard the value stop at wherever the other thumb happened to be: the
       control stating a range it refuses to enter. That is the same lie as the
       swapping handles this rewrite removed, moved out of the visual layer and
       into the accessibility layer. The clamp is one fact; it is now stated in
       both places. (WAI-ARIA APG, dual-thumb slider.) */
    const min = kind === 'start' ? 0 : Math.round(lo * days);
    const max = kind === 'start' ? Math.round(hi * days) : days;
    return (
      <div
        /* A REAL SLIDER, WITH A REAL DOMAIN. It was an 8px <button>, and the
           accessible name it carried was `Window` — on BOTH ends, and the header
           cell forty pixels above spent the same word on the corpus's whole
           span. Named, then, and the name told you neither which end you had
           hold of nor what it was an end OF. What it genuinely had none of was
           keyboard operability and touch scaling: 8px WIDE in every density,
           because it was sized in raw pixels and --density-hit-scale never
           reached it. `aria-valuetext` carries the DATE, because "day 1,284 of
           2,190" is arithmetic and `2022-07-08` is the reading. */
        className="tdock__handle u-hitslop"
        role="slider"
        tabIndex={0}
        data-end={kind}
        style={{ left: `${at * 100}%` }}
        aria-label={name}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(at * days)}
        aria-valuetext={date}
        title={`${name} — ${date}. ${COPY.timelineLens.handles.tip}`}
        onPointerDown={(e) => {
          /* Stopped BEFORE the button check, so a non-primary press on a handle
             is not handed on to the track's own grab either. */
          e.stopPropagation();
          if (!beginDrag(kind, e)) return;
          e.currentTarget.focus();
        }}
        onKeyDown={(e) => onHandleKey(kind, e)}
      />
    );
  };

  return (
    <Panel
      title={
        <Tip content={COPY.timelineLens.axis.tip}>
          <span>{COPY.timelineLens.axis.title}</span>
        </Tip>
      }
      className={['tdock', className].filter(Boolean).join(' ')}
      /* ONE CONTROL LEFT IN THE HEADER, AND IT CHANGES WHAT THE AXIS DRAWS.
         `Selected` and `Clear` were an action wearing the name of a state and a
         verb with no object; both are now named verbs in the rail, beside the
         list they govern. What stays here is the filter over the payload this
         panel plots, which belongs to the plot. */
      actions={
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
      }
    >
      {/* ONE HEADER ROW, AND IT NO LONGER LEADS WITH ITS OWN INCOMPLETENESS.
          It used to shout `NOT SHOWN 2 168` at one end and `200 of 200` ninety
          pixels below at the other. The sampling limit is a real limit and it is
          still stated — once, as a sentence, in the rail, and once as a hatched
          band on the axis where the sample actually stops. It is not the
          headline of an instrument whose subject is the corpus's chronology.

          The scope cell went too: the rail names the scope in words, in a
          control the user can change. Printing the raw `scope_id` here was the
          same reading, rawer, in a place you cannot act on it. */}
      <div className="tdock__head">
        <Tip content={COPY.timelineLens.axis.span.tip}>
          <span className="tdock__span">
            <span className="caps ink-dim">{COPY.timelineLens.axis.span.label}</span>
            <span className="mono ink-dim">{axisFrom}</span>
            {/* A GLYPH THAT IS THE ONLY THING SAYING WHAT THE TWO DATES ARE TO
                EACH OTHER. Marked `aria-hidden` it left the cell announcing as
                two adjacent bare dates; announced raw it is read out as "right
                arrow" or dropped, depending on the reader. So the mark stays a
                mark and carries the WORD as its name. */}
            <span className="ink-dim" role="img" aria-label={COPY.timelineLens.axis.through}>
              →
            </span>
            <span className="mono ink-dim">{axisTo}</span>
          </span>
        </Tip>

        {/* THE BRUSHED WINDOW, ONLY WHEN THERE IS ONE. At full extent it is the
            same two dates the AXIS cell prints one cell to the left, and one
            instrument printing one reading twice is what made this panel
            contradict itself. */}
        {brushing ? (
          <Tip content={`${COPY.timelineLens.axis.window.tip} ${state.tip}`}>
            <span className="tdock__span">
              <span className="caps ink-dim">{COPY.timelineLens.axis.window.label}</span>
              <span className="mono ink">{windowFrom}</span>
              <span className="ink-dim" role="img" aria-label={COPY.timelineLens.axis.through}>
                →
              </span>
              <span className="mono ink">{windowTo}</span>
              {/* THE STATE, IN A WORD. The old panel expected you to infer
                  whether a drag had committed by watching whether the map
                  changed — which it did, catastrophically, every time. */}
              <span className="tdock__state caps" data-applied={applied}>
                {state.label}
              </span>
            </span>
          </Tip>
        ) : null}

        <Tip content={COPY.timelineLens.axis.events.tip}>
          <span className="tdock__span">
            <span className="caps ink-dim">{COPY.timelineLens.axis.events.label}</span>
            {/* A COUNT OF EVENTS IN A WINDOW IS NOT THE ENGINE'S ATTENTION. The
                handles are teal because a brush is a live reading; the tally it
                produces is a measurement, in ink. And BOTH figures are ink-dim:
                the total used to render faint, which put the one number stating
                how much of the corpus is on this axis under every contrast
                floor in the product. */}
            {brushing ? (
              <>
                <Num value={inWindow.length} format="int" tone="dim" />
                {/* THE WORD IS THE RATIO. `aria-hidden` on it announced the cell
                    as "Events 162 200" — two adjacent bare numbers with no
                    stated relation — and --ink-faint left the only visual thing
                    distinguishing "162 of 200" from "162 200" on the 3.19:1 step
                    this file's own §1 comment declares decoration-only. It is
                    functional text, so it reads and it sits on --ink-dim beside
                    the figures it joins. */}
                <span className="ink-dim">{COPY.common.ofLabel}</span>
              </>
            ) : null}
            <Num value={placed.length} format="int" tone="dim" />
          </span>
        </Tip>

        {placed.length === 0 ? (
          <span className="t-12-5 ink-dim" data-prose>
            {COPY.timelineLens.axis.empty}
          </span>
        ) : null}

        <span className="tdock__keys">
          <Tip content={COPY.timeline.events.boundary.tip}>
            <span className="tdock__legend">
              <i className="tdock__key tdock__key--boundary" aria-hidden="true" />
              <span className="caps ink-dim">{COPY.timeline.events.boundary.label}</span>
            </span>
          </Tip>
          <Tip content={COPY.timeline.events.claim.tip}>
            <span className="tdock__legend">
              <i className="tdock__key tdock__key--claim" aria-hidden="true" />
              <span className="caps ink-dim">{COPY.timeline.events.claim.label}</span>
            </span>
          </Tip>
          {timeline.truncated === 0 ? null : (
            <Tip content={COPY.timelineLens.axis.unsampled.tip}>
              <span className="tdock__legend">
                <i className="tdock__key tdock__key--unsampled" aria-hidden="true" />
                <span className="caps ink-dim">{COPY.timelineLens.axis.unsampled.label}</span>
              </span>
            </Tip>
          )}
        </span>
      </div>

      {/* THE TRACK IS THE BRUSH, NOT JUST ITS BACKGROUND.
          Pressing anywhere on it grabs the NEARER end and drags it there, which
          is the only way an 8px handle is placeable without a mouse and a steady
          hand. `cursor: ew-resize` has advertised this since the first build;
          until now it was advertising something that did not happen. */}
      <div
        className="tdock__track"
        ref={track}
        role="group"
        aria-label={COPY.timelineLens.axis.title}
        aria-describedby={SUMMARY_ID}
        onPointerDown={grabNearest}
      >
        {/* The structured textual twin. Not a caption on a picture — the same
            facts, in the form a reader who cannot see the picture can use. It is
            in the DOM as well as referenced, so it is reachable both by walking
            the group and by whatever announces its description.

            IT NOW CARRIES THE TWO FACTS THE PICTURE HAD TO ITSELF. The span the
            events actually occupy (the year grid's job) and the count the
            sampling limit cut (the hatched band's job) were drawn and never
            said: with `truncated` at 2,168 a sighted reader got a hatched
            remainder and a legend key, and this sentence ended "…carrying 200
            dated events" as if that were the corpus. Both marks are
            `aria-hidden`; this is where their reading lives. */}
        <span className="u-sr" id={SUMMARY_ID}>
          {COPY.timelineLens.axis.summary({
            total: placed.length,
            from: axisFrom,
            to: axisTo,
            drawnFrom: drawn?.from ?? null,
            drawnTo: drawn?.to ?? null,
            inside: inWindow.length,
            held: heldInWindow,
            truncated: timeline.truncated,
          })}
        </span>

        {/* The shape, under the ticks: one column per bin, scaled to the busiest
            bin. It is the same events counted, so it cannot disagree with them. */}
        <div className="tdock__envelope" aria-hidden="true">
          {envelope.map((h, i) => (
            <span key={i} className="tdock__bin" style={{ height: `${(h * 100).toFixed(1)}%` }} />
          ))}
        </div>

        {years.map((y) => (
          <span
            key={y.label}
            className="tdock__gridline"
            style={{ left: `${y.p * 100}%` }}
            aria-hidden="true"
          >
            {/* MOVED OFF THE DECORATION STEP. These labels were --ink-faint,
                measured 3.19:1 on --surface, while the banner above argues they
                are the axis's load-bearing temporal landmark. A landmark at the
                decoration floor is a landmark for readers with good eyes and a
                good monitor. 11px is correct — the scale calls --fs-11
                "micro-labels, axis ticks" and that is exactly what a year label
                on an axis is — but the contrast was not. */}
            <span className="tdock__year mono ink-dim">{y.label}</span>
          </span>
        ))}

        <div className="tdock__axis" aria-hidden="true" />
        {/* Everything outside the window is dimmed, never removed: the axis is
            the whole corpus and the window is a reading of it. THIS is the
            "temporal filtering and highlighting" the brush does — it never
            removes an event and it never selects one. */}
        <div className="tdock__mask" style={{ left: 0, width: `${lo * 100}%` }} aria-hidden="true" />
        <div className="tdock__mask" style={{ left: `${hi * 100}%`, right: 0 }} aria-hidden="true" />

        {/* THE UNSAMPLED REMAINDER. The engine caps the fetch and reports what it
            cut off, but the COUNT alone does not stop the picture from lying:
            with the limit taken in date order the ticks bunch in the early years
            and the axis LOOKS like a corpus where nothing happened after that.
            So the span past the last event in hand is marked as unsampled,
            because a reader takes the shape before they take the number. */}
        {timeline.truncated > 0 && lastP < 0.999 ? (
          <span
            className="tdock__unsampled"
            style={{ left: `${lastP * 100}%`, right: 0 }}
            aria-hidden="true"
          />
        ) : null}

        {/* MARKS, NOT CONTROLS — see the banner. `data-held` is the return leg of
            the two-way link: press a row in the rail's list, or a node on the
            map, and the tick for it lights in --render here. */}
        <div className="tdock__ticks" aria-hidden="true">
          {placed.map((x, i) => (
            <i
              key={`${x.event.node_id}:${x.event.edge_id ?? 'b'}:${i}`}
              className="tdock__tick"
              data-kind={x.event.family === null ? 'boundary' : 'claim'}
              data-quarantined={x.event.quarantined}
              data-held={heldIds.has(x.event.node_id)}
              style={{ left: `${x.p * 100}%` }}
            />
          ))}
        </div>

        {brushHandle('start', lo, windowFrom)}
        {brushHandle('end', hi, windowTo)}
      </div>
    </Panel>
  );
}

