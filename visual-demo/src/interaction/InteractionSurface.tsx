/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE INPUT SURFACE
 * =============================================================================
 *
 * One full-bleed element over the terrain that owns every pointer and every key
 * the graph responds to. It is a sibling of the canvas rather than a listener on
 * it, for two reasons: the canvas belongs to the renderer and nothing outside
 * `src/graph/**` should be attaching handlers to it, and a single surface means
 * there is exactly one place where a screen coordinate becomes a world one.
 *
 * -----------------------------------------------------------------------------
 * THE CONTRACT WITH WHOEVER MOUNTS THIS
 * -----------------------------------------------------------------------------
 * The surface must cover the terrain canvas EXACTLY — `position: absolute;
 * inset: 0` over the same positioned ancestor. Its own bounding rect is what
 * anchors the zoom, so a surface offset from the canvas would zoom about the
 * wrong point. That is not left to trust: on mount it measures the canvas beside
 * it and says so on the console if the two rects disagree by half a pixel.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT DOES, AND WHAT IT REFUSES TO DO
 * -----------------------------------------------------------------------------
 *   wheel / pinch    zoom anchored at the cursor, via `camera.zoomAt`
 *   drag             pan, with momentum that decays as e^(-t/τ)
 *   shift-drag       rubber-band select, capped — and the cap is REPORTED
 *   click            select and focus; a click that moved is a drag, not a click
 *   alt-click        expand the node's real one-hop neighbourhood; again collapses
 *   double-click     descend, but only into a body of the current rung — an
 *                    entity is cross-cutting and is opened, never entered
 *   arrows           move focus to the nearest node in that direction
 *   Enter            descend / open the passage under focus
 *   + / -            zoom from the keyboard, so this works without a wheel at all
 *
 * It never writes the store's camera DURING a gesture. The store holds a TARGET
 * and the renderer owns the current camera; writing 60 targets a second would put
 * React in the pan loop and repaint every panel underneath it. The target is
 * written ONCE, when the hand stops, so a saved view carries where you actually
 * are rather than where you last clicked.
 *
 * -----------------------------------------------------------------------------
 * AND IT CARRIES THE SURFACE'S ASSISTIVE-TECHNOLOGY EQUIVALENT
 * -----------------------------------------------------------------------------
 * `<TerrainOutline/>` and `<Announcer/>` mount HERE rather than in the shell, and
 * the reason is `aria-activedescendant`: it is resolved against the DOM subtree
 * of the element that declares it, so the option rows the surface points at have
 * to be its own descendants. Mounting the outline in the shell would put it in a
 * sibling subtree and the attribute would resolve to nothing — a cursor that
 * names a node no screen reader can find.
 *
 * The three things that changed on this element, and what each one was before:
 *
 *   aria-label              was ONE STATIC SENTENCE at every cursor position. It
 *                           names the node under the cursor now, because the node
 *                           is what changes when you press an arrow key.
 *   aria-activedescendant   did not exist anywhere in the application. The arrow
 *                           keys moved a cursor that lived only in world
 *                           coordinates, with no DOM element behind it, so
 *                           traversing the graph was completely silent.
 *   the marquee's cap       the rubber band's cap was reported to the eye as
 *                           `40 of 137` and to a screen reader as two numbers.
 * ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { COPY } from '@/copy';
import { RUNG_DEPTH, engine } from '@/engine';
import type { GraphNode, Rung, Vec2 } from '@/engine';
import type { AssetTiling } from '@/engine';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Num } from '@/ui/primitives';
import { Announcer } from '@/ui/shell/Announcer';
import { TerrainOutline, terrainOptionId } from '@/ui/shell/TerrainOutline';

import { createCameraControl, type PointerSample } from '@/interaction/camera-control';
import { placeHoverCard } from '@/interaction/HoverCard';
import { HoverLayer } from '@/interaction/HoverLayer';
import {
  insideFrustum,
  nearestInDirection,
  nearestToPoint,
  type Direction,
  type NavNode,
} from '@/interaction/keyboard-nav';
import { invalidateTuning, readTuning } from '@/interaction/tuning';
import { canDescend, useTerrain } from '@/interaction/useTerrain';

import '@/interaction/interaction.css';

/**
 * The live camera control of the mounted surface.
 *
 * `stopMomentum()` is the public half and it exists because momentum outlives the
 * hand: a fling still travelling cancels any camera flight started while it runs
 * (`panByPixels` cancels flights by design, so a drag can interrupt one). Anything
 * that flies the camera deliberately — a search result, a breadcrumb, Atlas Mode's
 * descent choreography — should call this first.
 *
 * `debugCameraControl()` is the rig's half: it exposes `lastRelease()` so a
 * gesture that did nothing can say why without a debugger.
 */
let activeControl: ReturnType<typeof createCameraControl> | null = null;

/** Stop any momentum still travelling. Safe to call when there is none. */
export function stopMomentum(): void {
  activeControl?.stop();
}

export function debugCameraControl(): ReturnType<typeof createCameraControl> | null {
  return activeControl;
}

export interface InteractionSurfaceProps {
  className?: string;
  /**
   * Zooming past a threshold changes the ontology, not the pixel scale. The
   * choreography of the descent belongs to Atlas Mode; this is the input that
   * triggers it. Pass `false` when something else is driving the rung.
   */
  semanticZoom?: boolean;
  /** Fetch and reveal the pointer target's one-hop neighbourhood. Default true. */
  hoverNeighborhood?: boolean;
  /** The small selected-count readout. Default true. */
  showSelectionReadout?: boolean;
}

/**
 * The coalesced sample stream behind one `pointermove`, in surface coordinates.
 *
 * Returns an empty array where the API is absent (older Safari), which the camera
 * control reads as "use the single sample" rather than as "the pointer did not
 * move". Timestamps are the events' own, so the input queue does not leak into
 * the velocity.
 */
function coalesced(e: React.PointerEvent<HTMLDivElement>, r: DOMRect): PointerSample[] {
  const native = e.nativeEvent;
  const list = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
  const out: PointerSample[] = [];
  for (const ce of list) out.push({ x: ce.clientX - r.left, y: ce.clientY - r.top, t: ce.timeStamp });
  return out;
}

const ARROWS: Readonly<Record<string, Direction>> = Object.freeze({
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
});

/** What a rubber band caught, so the cap can be reported rather than applied silently. */
interface MarqueeResult {
  taken: number;
  total: number;
}

export function InteractionSurface({
  className,
  semanticZoom = true,
  hoverNeighborhood = true,
  showSelectionReadout = true,
}: InteractionSurfaceProps): JSX.Element {
  const terrain = useTerrain();

  const {
    app,
    rung,
    assetId,
    stackDepth,
    parentId,
    view,
    bake,
    selectionCount,
    focus,
    density,
    reducedMotion,
  } = useAtlasStore((s) => ({
    app: s.app,
    rung: s.rung,
    assetId: s.assetId,
    stackDepth: s.stack.length,
    parentId: s.stack.length === 0 ? null : s.stack[s.stack.length - 1].id,
    view: s.view,
    bake: s.bake,
    selectionCount: s.selection.length,
    /* THE CURSOR, READ FOR ITS NAME. It is already the thing the keyboard moves
       and the thing the terrain lights; it is now also the thing this element's
       accessible name and active descendant are derived from, so there is one
       cursor in the product rather than a visual one and an assistive one. */
    focus: s.focus,
    density: s.density,
    reducedMotion: s.reducedMotion,
  }));

  /**
   * The tuning is memoised — twenty `getComputedStyle` reads inside a pointermove
   * handler would be ruinous — so it has to be dropped when the values behind it
   * change. Density moves `--hit-slop-node`; reduced motion moves the whole
   * motion budget and switches the fling off. Without this the instrument keeps
   * using the reach and the motion of the mode you were in two settings ago.
   */
  useEffect(() => {
    invalidateTuning();
  }, [density, reducedMotion]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const marqueeRef = useRef<HTMLDivElement | null>(null);
  const cardElRef = useRef<HTMLDivElement | null>(null);
  const pointRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const rectRef = useRef<DOMRect | null>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  const [marquee, setMarqueeResult] = useState<MarqueeResult | null>(null);
  const expandedRef = useRef<string | null>(null);

  /* --- semantic zoom bookkeeping ------------------------------------------ */
  const refZoom = useRef<number | null>(null);
  const awaitingRef = useRef(true);
  const lastRungChange = useRef(0);
  /** Held in a ref so the camera control, memoised once, always calls the live one. */
  const evalRef = useRef<() => void>(() => {});

  const terrainRef = useRef(terrain);
  terrainRef.current = terrain;

  const readRect = useCallback((): DOMRect => {
    const el = hostRef.current;
    if (el === null) return new DOMRect(0, 0, 1, 1);
    const r = el.getBoundingClientRect();
    rectRef.current = r;
    return r;
  }, []);

  const rect = useCallback((): DOMRect => rectRef.current ?? readRect(), [readRect]);

  /* =========================================================================
   * THE CAMERA CONTROL
   * ====================================================================== */

  const control = useMemo(
    () =>
      createCameraControl({
        onSettled: () => {
          const t = terrainRef.current;
          if (t === null) return;
          const cam = t.camera.get();
          // ONE write, when the hand stops. The shell's `moveTo` sees a target
          // it is already at and resolves without a flight.
          useAtlas.getState().setCamera(cam.x, cam.y, cam.zoom);
        },
        onChange: () => evalRef.current(),
      }),
    [],
  );

  useEffect(() => {
    control.attach(terrain?.camera ?? null);
    activeControl = control;
    return () => {
      control.attach(null);
      if (activeControl === control) activeControl = null;
    };
  }, [control, terrain]);

  useEffect(() => {
    control.setBounds(bake?.bounds ?? null);
  }, [control, bake]);

  /**
   * A DELIBERATE NAVIGATION BEATS LEFTOVER MOMENTUM.
   *
   * `panByPixels` cancels whatever flight is in progress, which is correct while
   * a hand is on the terrain and wrong the moment one is not: a fling still
   * travelling when the user descends a rung, picks a search result or presses a
   * breadcrumb will cancel that flight frame by frame and the camera never
   * arrives. So every scene change stops the momentum first.
   */
  useEffect(() => {
    control.stop();
  }, [control, view, rung, parentId]);

  useEffect(() => () => control.dispose(), [control]);

  /* =========================================================================
   * NAVIGABLE NODES — the view's own nodes, at their baked positions
   * ====================================================================== */

  const navNodes = useMemo<NavNode[]>(() => {
    if (view === null || bake === null) return [];
    const pos = new Map(bake.positions.map((p) => [p.id, p]));
    const out: NavNode[] = [];
    for (const node of view.nodes) {
      const p = pos.get(node.id);
      if (p !== undefined) out.push({ id: node.id, x: p.x, y: p.y });
    }
    return out;
  }, [view, bake]);
  const navRef = useRef(navNodes);
  navRef.current = navNodes;

  const nodeById = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const n of view?.nodes ?? []) map.set(n.id, n);
    return map;
  }, [view]);
  const nodeByIdRef = useRef(nodeById);
  nodeByIdRef.current = nodeById;

  /* =========================================================================
   * SEMANTIC ZOOM — the input that changes the ontology
   * ====================================================================== */

  const semanticRef = useRef(semanticZoom);
  semanticRef.current = semanticZoom;
  const placeRef = useRef({ rung, parentId, app, stackDepth, assetId });
  placeRef.current = { rung, parentId, app, stackDepth, assetId };

  // A new place: the reference altitude is whatever the camera settles at.
  useEffect(() => {
    awaitingRef.current = true;
    refZoom.current = null;
    lastRungChange.current = performance.now();
  }, [rung, parentId, bake]);

  /**
   * Two things that both have to happen when the camera comes to rest, and both
   * of which need the renderer's own frame callback to notice it.
   *
   * 1. THE SEMANTIC-ZOOM REFERENCE. The altitude a rung is measured against is
   *    whatever the camera settles at, which is the END of the auto-frame flight
   *    and not the start of it.
   *
   * 2. THE STORE'S CAMERA TARGET. Nobody else writes it — `descend`, `ascend`,
   *    `fitTo` and the terrain's own auto-frame all move the RENDERER's camera
   *    and leave the store's target where it was. Left alone, `saveView()` would
   *    encode the place you were two navigations ago. So the target is
   *    reconciled here, once, whenever the camera is genuinely at rest.
   *
   *    `camera.idle()` alone is not enough: it reports flights, and a DRAG is
   *    not a flight. Without `control.busy()` this would write the store on every
   *    frame of a pan, which is the exact failure the target/current split
   *    exists to prevent.
   */
  useEffect(() => {
    if (terrain === null) return;
    return terrain.onFrame(() => {
      if (!terrain.camera.idle()) return;
      const cam = terrain.camera.get();

      if (awaitingRef.current) {
        refZoom.current = cam.zoom;
        awaitingRef.current = false;
      }

      if (control.busy()) return;
      const store = useAtlas.getState();
      const target = store.camera;
      if (
        Math.abs(target.x - cam.x) < 1e-3 &&
        Math.abs(target.y - cam.y) < 1e-3 &&
        Math.abs(target.zoom - cam.zoom) < 1e-9
      ) {
        return;
      }
      store.setCamera(cam.x, cam.y, cam.zoom);
    });
  }, [terrain, control]);

  const evaluateSemanticZoom = useCallback(() => {
    if (!semanticRef.current) return;
    const t = terrainRef.current;
    const place = placeRef.current;
    if (t === null || place.app !== 'READY') return;
    if (awaitingRef.current || refZoom.current === null) return;

    const tune = readTuning();
    const now = performance.now();
    if (now - lastRungChange.current < tune.rungCooldownMs) return;

    const ratio = t.camera.get().zoom / refZoom.current;
    const store = useAtlas.getState();

    /* ZOOMING IN STOPS AT THE FLOOR. Not because we ran out of rungs but
       because the Asset is the last declared stratum: past it, more zoom is
       a different covering, and a covering is a choice, never a gesture. */
    if (ratio >= tune.rungIn && place.assetId === null) {
      const target = centreTarget(t, rect(), store.view?.nodes ?? [], place.rung, navRef.current);
      if (target === null) return;
      lastRungChange.current = now;
      awaitingRef.current = true;
      control.stop();
      void store.descend(target);
      return;
    }

    if (ratio <= tune.rungOut && (place.stackDepth > 0 || RUNG_DEPTH[place.rung] > 0)) {
      lastRungChange.current = now;
      awaitingRef.current = true;
      control.stop();
      void store.ascend();
    }
  }, [control, rect]);
  evalRef.current = evaluateSemanticZoom;

  /* =========================================================================
   * POINTER
   * ====================================================================== */

  const paintMarquee = useCallback(
    (box: { x: number; y: number; w: number; h: number } | null) => {
      const el = marqueeRef.current;
      if (el === null) return;
      if (box === null) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.style.transform = `translate3d(${box.x}px, ${box.y}px, 0)`;
      el.style.width = `${box.w}px`;
      el.style.height = `${box.h}px`;
    },
    [],
  );

  const setDragging = useCallback((on: boolean) => {
    const el = hostRef.current;
    if (el === null) return;
    if (on) el.dataset.dragging = '';
    else delete el.dataset.dragging;
  }, []);

  const clearHover = useCallback(() => {
    const store = useAtlas.getState();
    if (store.hover === null) return;
    store.hoverNode(null);
    terrainRef.current?.setHover(null);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const r = readRect();
      hostRef.current?.focus({ preventScroll: true });
      e.currentTarget.setPointerCapture(e.pointerId);

      if (e.shiftKey && e.pointerType !== 'touch') {
        marqueeStart.current = { x: e.clientX - r.left, y: e.clientY - r.top };
        paintMarquee({ x: marqueeStart.current.x, y: marqueeStart.current.y, w: 0, h: 0 });
        return;
      }
      setDragging(true);
      control.pointerDown(e.pointerId, e.clientX - r.left, e.clientY - r.top, e.timeStamp);
    },
    [control, paintMarquee, readRect, setDragging],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const r = rect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      pointRef.current = { x: e.clientX, y: e.clientY };

      const start = marqueeStart.current;
      if (start !== null) {
        paintMarquee({
          x: Math.min(start.x, sx),
          y: Math.min(start.y, sy),
          w: Math.abs(sx - start.x),
          h: Math.abs(sy - start.y),
        });
        return;
      }

      if (control.pointers() > 0) {
        /* The browser delivers ONE pointermove per animation frame and keeps the
           samples it merged behind `getCoalescedEvents()`. On a slow display that
           is a single sample for a whole flick, and the momentum estimate has
           nothing to fit. Hand the control the real stream. */
        control.pointerMove(e.pointerId, sx, sy, coalesced(e, r));
        if (control.moved()) clearHover();
        return;
      }

      // Resting pointer: pick, and let the card follow at pointer rate. The card
      // is moved by a direct style write — React is not in this loop.
      const t = terrainRef.current;
      if (t === null) return;
      placeHoverCard(cardElRef.current, e.clientX, e.clientY);
      const id = t.pick(e.clientX, e.clientY);
      const store = useAtlas.getState();
      if (store.hover !== id) {
        store.hoverNode(id);
        t.setHover(id);
      }
    },
    [clearHover, control, paintMarquee, rect],
  );

  const commitMarquee = useCallback(
    (sx: number, sy: number) => {
      const start = marqueeStart.current;
      const t = terrainRef.current;
      marqueeStart.current = null;
      paintMarquee(null);
      if (start === null || t === null) return;
      if (Math.hypot(sx - start.x, sy - start.y) < readTuning().dragThresholdPx) return;

      const a: Vec2 = t.camera.screenToWorld(start.x, start.y);
      const b: Vec2 = t.camera.screenToWorld(sx, sy);
      const hits = t.pickRect(a, b);
      const cap = Math.max(1, Math.floor(readTuning().marqueeMax));
      const chosen = hits.slice(0, cap);
      setMarqueeResult(chosen.length === 0 ? null : { taken: chosen.length, total: hits.length });
      if (chosen.length === 0) return;

      // React batches these inside the event handler, so the panels reconcile
      // once. The cap exists because each one re-derives the resolution map.
      const store = useAtlas.getState();
      store.selectNode(chosen[0], false);
      for (let i = 1; i < chosen.length; i++) store.selectNode(chosen[i], true);
    },
    [paintMarquee],
  );

  /**
   * Expand a node's real one-hop neighbourhood into the selection, or collapse it
   * back to the node. The ids come from `GET /graph/neighborhood/{id}` and are
   * intersected with what this rung actually admits — selecting a passage while
   * standing on the island rung would put a highlight on something the user
   * cannot see or aim at.
   */
  const toggleExpand = useCallback(async (id: string) => {
    const store = useAtlas.getState();
    if (expandedRef.current === id) {
      expandedRef.current = null;
      store.selectNode(id, false);
      return;
    }
    try {
      const hood = await engine.getNeighborhood(id, 1);
      const admitted = new Set((useAtlas.getState().view?.nodes ?? []).map((n) => n.id));
      const ids = hood.nodes.map((n) => n.id).filter((n) => n !== id && admitted.has(n));
      const cap = Math.max(1, Math.floor(readTuning().marqueeMax));
      const chosen = ids.slice(0, cap);
      expandedRef.current = id;
      setMarqueeResult(chosen.length === 0 ? null : { taken: chosen.length + 1, total: ids.length + 1 });
      store.selectNode(id, false);
      for (const other of chosen) store.selectNode(other, true);
    } catch {
      // An expansion that could not be fetched selects the node it was asked
      // about and nothing else. It does not invent neighbours.
      expandedRef.current = null;
      store.selectNode(id, false);
    }
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const r = rect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;

      if (marqueeStart.current !== null) {
        commitMarquee(sx, sy);
        return;
      }

      const wasDrag = control.moved();
      const pinching = control.pointers() > 1;
      control.pointerUp(e.pointerId, e.timeStamp);
      if (control.pointers() === 0) setDragging(false);
      if (wasDrag || pinching) return;

      // A press that did not move is a click.
      const t = terrainRef.current;
      if (t === null) return;
      const id = t.pick(e.clientX, e.clientY);
      const store = useAtlas.getState();
      if (id === null) {
        expandedRef.current = null;
        setMarqueeResult(null);
        if (!e.shiftKey) store.clearFocus();
        return;
      }
      if (e.altKey) {
        void toggleExpand(id);
        return;
      }
      expandedRef.current = null;
      setMarqueeResult(null);
      store.selectNode(id, e.shiftKey || e.metaKey || e.ctrlKey);
    },
    [commitMarquee, control, rect, setDragging, toggleExpand],
  );

  const onPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      marqueeStart.current = null;
      paintMarquee(null);
      control.pointerCancel(e.pointerId);
      setDragging(false);
    },
    [control, paintMarquee, setDragging],
  );

  const onDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const t = terrainRef.current;
    if (t === null) return;
    const id = t.pick(e.clientX, e.clientY);
    if (id === null) return;
    const store = useAtlas.getState();
    const node = nodeByIdRef.current.get(id);
    if (node === undefined) return;

    if (node.kind === 'passage') {
      void store.openPassage(id);
      return;
    }
    if (canDescend(node, store.rung)) {
      awaitingRef.current = true;
      lastRungChange.current = performance.now();
      void store.descend(id);
      return;
    }
    // Not a body of this rung — an entity, a source. Frame it rather than
    // pretending it is a place you can walk into.
    store.selectNode(id, false);
    void t.camera.fitTo([id], 96);
  }, []);

  /* Wheel must be a NON-PASSIVE native listener: `preventDefault` is what stops
     the page scrolling underneath the terrain, and React registers its synthetic
     wheel handler as passive. */
  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = rect();
      control.wheel(e.deltaY, e.deltaMode, e.ctrlKey, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [control, rect]);

  /* =========================================================================
   * KEYBOARD — the graph is fully traversable without a pointer
   * ====================================================================== */

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const t = terrainRef.current;
      if (t === null) return;

      /* ZOOM IS THE SURFACE'S OWN, FROM ANYWHERE INSIDE IT, AND IT IS HANDLED
         BEFORE THE SUBTREE GUARD BELOW.
         The guard exists because children implement their own meanings for the
         arrow keys and Enter. NOTHING implements `+`/`=`/`-`: the outline's
         `onKeyDown` falls through its `default:` branch, `src/state/keys.ts`
         binds no zoom key globally, and this element's rect is what anchors the
         zoom in the first place. The outline's listbox is now the FIRST focusable
         child of this surface, which is exactly where a keyboard user lands — so
         with these three keys behind the guard, arriving by keyboard silently
         cost you the zoom that a keyboard user standing on the surface itself
         still had. There is no text-entry descendant to steal a `-` from: the
         command palette is a sibling and portals to `<body>`. */
      if (e.key === '+' || e.key === '=' || e.key === '-') {
        e.preventDefault();
        const r = rect();
        control.stop();
        t.camera.zoomAt(r.width / 2, r.height / 2, e.key === '-' ? 1 / 1.35 : 1.35);
        evaluateSemanticZoom();
        return;
      }

      /* THIS HANDLER BELONGS TO THE SURFACE ITSELF, NOT TO ITS SUBTREE.
         The surface now contains real focusable children — the skip link and the
         outline's listbox — and React bubbles their key events through here. The
         failure that guard prevents is concrete: Enter on the focused skip link
         reached this handler, which called `preventDefault()` and descended into
         whatever node the cursor was on, and the `preventDefault` then suppressed
         the button's own click, so the one keyboard route out of the terrain
         performed a navigation nobody asked for and did not skip anywhere. A
         handler on a container that reacts to keys pressed on its children is a
         handler that will keep finding new ways to be wrong as children are
         added; this is the general fix rather than a special case for Enter. */
      if (e.target !== e.currentTarget) return;
      const store = useAtlas.getState();
      const tune = readTuning();

      const dir = ARROWS[e.key];
      if (dir !== undefined) {
        e.preventDefault();
        const nodes = navRef.current;
        if (nodes.length === 0) return;
        const f = t.camera.frustum();
        const anchorId = store.focus ?? store.selection[store.selection.length - 1] ?? null;
        const anchor = anchorId === null ? null : (nodes.find((n) => n.id === anchorId) ?? null);
        // Nothing focused yet: the first press lands on what is already in front
        // of you rather than teleporting to the far side of the world.
        const next =
          anchor === null ? nearestToPoint(f.x, f.y, nodes) : nearestInDirection(anchor, nodes, dir);
        if (next === null) return;
        store.selectNode(next.id, false);
        store.hoverNode(next.id);
        t.setHover(next.id);
        if (!insideFrustum(next.x, next.y, t.camera.frustum())) {
          void t.camera.moveTo(next.x, next.y, t.camera.get().zoom, tune.ms.ui, 'ui');
        }
        return;
      }

      if (e.key === 'Enter') {
        const id = store.focus;
        if (id === null) return;
        e.preventDefault();
        const node = nodeByIdRef.current.get(id);
        if (node === undefined) return;
        if (node.kind === 'passage') {
          void store.openPassage(id);
        } else if (canDescend(node, store.rung)) {
          awaitingRef.current = true;
          lastRungChange.current = performance.now();
          void store.descend(id);
        } else {
          void t.camera.fitTo([id], 96);
        }
      }
    },
    [control, evaluateSemanticZoom, rect],
  );

  /* =========================================================================
   * THE HOVER-NEIGHBOURHOOD EDGE POLICY
   * -------------------------------------------------------------------------
   * Engaged ONLY where the terrain would draw individual relations. At the
   * region rungs it draws BUNDLED CORRIDORS instead, and swapping those for the
   * handful of exemplar relations shipped alongside them would tell the eye that
   * the corridors had gone away. They have not — they are what is drawn there,
   * and the payload's own `drawn_reason` still says `trade-route-skeleton`.
   * ====================================================================== */

  const drawsIndividualEdges = (view?.bundles.length ?? 0) === 0;

  /* =========================================================================
   * RECT CACHE + THE MOUNT CONTRACT CHECK
   * ====================================================================== */

  useEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    readRect();
    const ro = new ResizeObserver(() => readRect());
    ro.observe(el);
    const refresh = (): void => void readRect();
    window.addEventListener('scroll', refresh, true);
    window.addEventListener('resize', refresh);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', refresh, true);
      window.removeEventListener('resize', refresh);
    };
  }, [readRect]);

  useEffect(() => {
    if (terrain === null) return;
    const el = hostRef.current;
    const canvas = el?.parentElement?.querySelector('canvas') ?? null;
    if (el === null || canvas === null) return;
    const a = el.getBoundingClientRect();
    const b = canvas.getBoundingClientRect();
    const off = Math.max(
      Math.abs(a.left - b.left),
      Math.abs(a.top - b.top),
      Math.abs(a.width - b.width),
      Math.abs(a.height - b.height),
    );
    if (off > 0.5) {
      // FAIL LOUD. Every anchored zoom in the product is computed against this
      // rect; if it is not the canvas's rect the world slides out from under the
      // cursor, and no amount of tuning fixes a wrong origin.
      // eslint-disable-next-line no-console
      console.error(
        `[interaction/InteractionSurface] the input surface is offset from the terrain canvas by ` +
          `${off.toFixed(2)}px. Mount it as an inset:0 sibling of <TerrainCanvas/> inside the same ` +
          `positioned stage, or cursor-anchored zoom will be wrong.`,
      );
    }
  }, [terrain]);

  const clearSelection = useCallback(() => {
    expandedRef.current = null;
    setMarqueeResult(null);
    useAtlas.getState().clearFocus();
  }, []);

  const capped = marquee !== null && marquee.total > marquee.taken && marquee.taken === selectionCount;

  /**
   * THE ACCESSIBLE NAME NOW NAMES THE NODE.
   *
   * It was `COPY.a11y.terrain` at every cursor position — one sentence teaching
   * the controls, which is the right thing to say when you arrive and the wrong
   * thing to repeat on every arrow press. The resting name still teaches them;
   * the moment there is something under the cursor the name becomes that thing,
   * so a screen reader returning to this element is told where it is standing.
   */
  const focusNode = focus === null ? undefined : nodeById.get(focus);
  const surfaceLabel =
    app === 'QUERYING'
      ? COPY.a11y.terrainBusy
      : focusNode === undefined
        ? COPY.a11y.terrain
        : `${COPY.a11yTwin.surface.focusedOn} ${focusNode.label}`;

  return (
    <div
      ref={hostRef}
      className={className ? `ix-surface ${className}` : 'ix-surface'}
      tabIndex={0}
      role="application"
      aria-label={surfaceLabel}
      /* THE VIRTUAL CURSOR, MADE REAL. The id resolves to an option row inside
         `<TerrainOutline/>` below — a descendant of this element, which is what
         makes the attribute resolvable at all. It is only set when the node is in
         the current view, because `terrainOptionId` of a node the outline did not
         render is a pointer at nothing, and an unresolvable activedescendant is
         worse than none: it tells the screen reader a cursor exists and then
         refuses to say where. */
      aria-activedescendant={focusNode === undefined ? undefined : terrainOptionId(focusNode.id)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={clearHover}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* THE STRUCTURED TWIN, FIRST IN THE SUBTREE.
          First because it carries the skip link, and a skip link that is not the
          first thing reachable inside the region it skips out of is a skip link
          you have to tab through the region to find. */}
      <TerrainOutline />

      <div ref={marqueeRef} className="ix-marquee" hidden aria-hidden="true" />

      <HoverLayer
        cardRef={cardElRef}
        pointRef={pointRef}
        enabled={hoverNeighborhood}
        engagePolicy={hoverNeighborhood && drawsIndividualEdges}
      />

      {showSelectionReadout && selectionCount > 0 ? (
        <div className="ix-selection" title={COPY.hud.selectionLabel}>
          {/* THE SOLE OWNER OF THIS FACT, SO IT IS NOT DECORATION.
              The HUD carried a second SELECTED cell for one round and dropping it
              was right — one owner per fact — but it left the survivor's label on
              the decoration-only ink step, measured at 3.22:1 over the composited
              panel ground. A count nobody can read the name of is a count. */}
          <span className="caps ink-dim">{COPY.hud.selectionLabel}</span>
          <Num value={selectionCount} format="int" tone="render" />
          {capped ? (
            <>
              <span className="ink-faint">{COPY.common.ofLabel}</span>
              {/* --ink-dim, NOT --ink-faint. This figure is the only statement
                  anywhere on screen of how many nodes the rubber band actually
                  caught, and the faint step is decoration only — 3.01:1 against
                  the panel ground. A number that reports an omission cannot be
                  the least legible thing in the row that reports it. */}
              <Num value={marquee.total} format="int" tone="dim" />
            </>
          ) : null}
          <Btn
            variant="quiet"
            size="sm"
            onClick={clearSelection}
            title={COPY.hud.clearSelection.title}
          >
            {COPY.hud.clearSelection.label}
          </Btn>
        </div>
      ) : null}

      {/* THE RUBBER BAND'S CAP, SAID RATHER THAN IMPLIED.
          The readout above prints `40` and `of 137` and a sighted reader takes
          the omission from the word `of`. Read aloud, that is two numbers with a
          preposition between them. This states what happened.

          THE REGION IS MOUNTED FROM THE FIRST FRAME, EMPTY, and only its contents
          are conditional. It used to be created at the same moment it was
          populated, which is the classic way to ship an announcement that never
          fires — a screen reader does not watch a region it has never observed,
          so a rubber band that silently dropped nodes at the cap stayed silent,
          which is the omission this element exists to state. Announcer.tsx states
          the same rule over the two live regions it owns.

          It is NOT gated on `showSelectionReadout`, because the cap is a fact
          about what the gesture did rather than a property of the panel that
          reports it — a caller who turns the readout off has turned off a panel,
          not the truth.

          AND IT CARRIES ONE FIGURE, THE ONE NOTHING ELSE CARRIES. It used to
          print `marquee.taken` too, which line 777 above defines as
          `=== selectionCount` — the exact number the announcer already speaks as
          `N nodes held`. A fact with two owners is a fact that gets said twice,
          and the second saying is the one that makes a listener wonder which
          number to believe. */}
      <div className="u-sr" role="status" aria-live="polite" aria-atomic="true">
        {capped && marquee !== null ? (
          <>
            {COPY.a11yTwin.surface.marquee.lead} <Num value={marquee.total} format="int" />{' '}
            {COPY.a11yTwin.surface.marquee.trail}
          </>
        ) : null}
      </div>

      {/* THE LIVE REGIONS. Last in the subtree and mounted unconditionally: a
          region a screen reader has not been watching since the first frame is a
          region it will not read when it fills. See Announcer.tsx. */}
      <Announcer />
    </div>
  );
}

/**
 * The node a descent should enter when a GESTURE, not a click, asked for it.
 *
 * The pointer is not involved — a zoom gesture is aimed at the middle of the
 * screen — so this takes what sits under the centre of the viewport and, if that
 * is not a body of the current rung, the nearest one that is.
 */
function centreTarget(
  terrain: {
    pick(x: number, y: number): string | null;
    camera: { frustum(): { x: number; y: number; w: number; h: number } };
  },
  r: DOMRect,
  nodes: readonly GraphNode[],
  rung: Rung,
  nav: readonly NavNode[],
): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const picked = terrain.pick(r.left + r.width / 2, r.top + r.height / 2);
  if (picked !== null && byId.get(picked)?.kind === rung) return picked;

  const ofRung = nav.filter((n) => byId.get(n.id)?.kind === rung);
  if (ofRung.length === 0) return null;
  const f = terrain.camera.frustum();
  return nearestToPoint(f.x, f.y, ofRung)?.id ?? null;
}
