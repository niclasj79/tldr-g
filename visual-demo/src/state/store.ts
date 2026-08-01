/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE STORE
 * =============================================================================
 *
 * One zustand store. Everything downstream reads through it, nothing downstream
 * reaches around it, and every field in it is either a payload the engine
 * returned or a decision the user made. There is no derived-for-looks state.
 *
 * -----------------------------------------------------------------------------
 * FOUR RULES THIS FILE IS BUILT AROUND
 * -----------------------------------------------------------------------------
 * 1. THE MACHINE IS DECLARED, NOT EMERGENT. Every `app` change goes through
 *    `enter()`, which consults the transition table in `./machine`. An
 *    undeclared move throws in dev. See that file for why.
 *
 * 2. THE CAMERA IS A TARGET, NOT A POSITION. `camera` carries a version counter
 *    and nothing else changes it per frame. The renderer owns the CURRENT camera
 *    and interpolates towards this; if React were in the loop a 60fps pan would
 *    be 60 reconciliations and the panels would repaint underneath it.
 *
 * 3. HOVER MUST NOT REPAINT A PANEL. `hoverNode` writes exactly one field, and
 *    `useAtlasStore` compares selector results shallowly, so a panel selecting
 *    `{ app, rung }` never re-renders because a pointer moved.
 *
 * 4. NO FAKE WORK. SETTLING is driven by the real bake; INGESTING by the real
 *    corpus materialisation; DEGRADED by a real `EngineError` carrying a real
 *    remedy. There is not one `setTimeout` in this file pretending to be
 *    progress. The only deliberate pauses are the visual-QA checkpoint holds in
 *    `./bridge`, which park real work at a real boundary and are named as such.
 * =============================================================================
 */

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import {
  RUNGS,
  RUNG_DEPTH,
  SIGMA_CLASSES,
  engine,
  getFixtureTimings,
  tamper,
  toDegradedReason,
} from '@/engine';
import type {
  AppState,
  DegradedReason,
  DensityMode,
  FixtureTimings,
  GraphNode,
  GraphViewOptions,
  GraphViewResponse,
  IntegrityResponse,
  IsoTimestamp,
  LayoutBake,
  LodState,
  PathStep,
  QueryRenderResponse,
  RenderTraceV1,
  Rung,
  SigmaClass,
  StagedQuery,
  TamperKind,
  TimelineResponse,
  VerifyResult,
} from '@/engine';

import { assertTransition, recoveryTarget, STRICT_TRANSITIONS } from '@/state/machine';
import { deriveLod, lodHoles } from '@/state/lod';
import {
  applyDensity,
  detectDensity,
  hasVisited,
  markVisited,
  prefersReducedMotion,
  readStoredDensity,
  subscribeReducedMotion,
} from '@/state/density';
import {
  decodeSavedView,
  encodeSavedView,
  readSavedViewFromHash,
  writeSavedViewToHash,
  SavedViewError,
} from '@/state/savedView';
import { matchBinding } from '@/state/keys';
import type { KeyEventLike } from '@/state/keys';
import { awaitHold, readViewpoint, runFrameGate, runSettleGate, track } from '@/state/bridge';
import type { Checkpoint } from '@/state/bridge';
import type { PerfReadout } from '@/state/perf';

/* =============================================================================
 * 1. THE SHAPE
 * ========================================================================== */

/** One step of the breadcrumb: the node we descended INTO, and the rung it lives on. */
export interface RungStackEntry {
  rung: Rung;
  id: string;
  label: string;
}

/**
 * THE WORKSPACE LENSES. Mutually exclusive, because they are PLACES.
 *
 * The product used to carry five independent switches in the top bar — Atlas,
 * Inspector, Provenance, Timeline, Analyst — at equal rank, any subset of which
 * could be lit at once. They are not equal-rank things. Two of them are
 * workspaces you enter, one is a lens over the same data, one is detail about a
 * result and one is detail about a selection; presenting them as five peers made
 * managing the instrument the user's job before answering their question was.
 *
 * A lens is where you are working. You are in exactly one at a time, the way you
 * are on exactly one rung at a time, and switching is a move rather than a
 * toggle. `Explore` is the resting lens and the one everything returns to.
 */
export type Lens = 'explore' | 'timeline' | 'analyze';

/** Every lens, in the order the switch renders them. */
export const LENSES: readonly Lens[] = Object.freeze(['explore', 'timeline', 'analyze'] as const);

/**
 * THE RESULT TABS. Contextual detail about the answer on screen, one at a time.
 *
 * The rail used to stack every one of these vertically: in one measured state it
 * was 6,409px of column against a 632px viewport, with the analyst controls
 * several screens below a switch that had just been lit to reveal them. A column
 * that long is a document, and a document is not an interface — you cannot see
 * two of its sections at once anyway, so stacking them buys nothing and costs the
 * ability to find any of them.
 *
 *   answer     what the engine claims, how confident it is, and how it got there
 *   evidence   the receipt, the sources, and the signature over both
 *   inspect    whatever node is selected
 */
export type ResultTab = 'answer' | 'evidence' | 'inspect';

/**
 * WHAT THE TIMELINE IS A TIMELINE OF.
 *
 * Ordered by how much of the world each one admits, because that is the order
 * the control offers them in and broadening should always be the deliberate
 * step. `answer` is the default whenever there is a result: an alternate lens
 * preserves the current answer's scope unless the user explicitly widens it.
 */
export type TimelineScope = 'answer' | 'selection' | 'corpus';

/** Every timeline scope, in widening order. */
export const TIMELINE_SCOPES: readonly TimelineScope[] = Object.freeze([
  'answer',
  'selection',
  'corpus',
] as const);

/** Every result tab, in rail order. */
export const RESULT_TABS: readonly ResultTab[] = Object.freeze(['answer', 'evidence', 'inspect'] as const);

/**
 * A SAVED EXPLORATION SCENE — everything a render or a drill-down displaces.
 *
 * The failure this exists to end: after opening evidence at the passage rung, a
 * new question rendered while the breadcrumb still read the old document and the
 * old passage scope, so the new answer arrived inside an unrelated previous
 * viewpoint. A render is a SCENE TRANSITION, not a payload swap — it deserves the
 * same treatment a rung descent gets: save where you were, go somewhere
 * deliberate, and offer the way back.
 */
export interface SceneSnapshot {
  /**
   * THE ENGINE'S OWN NAME FOR THE PLACE — a node label, or the question that was
   * on screen. Never authored prose: the store holds no copy, and a return
   * control that says `Back to Tollstrand 2` is naming something the engine
   * named. Empty when the place has no name (the unscoped world), in which case
   * the control falls back to the deck's own wording.
   */
  label: string;
  rung: Rung;
  stack: RungStackEntry[];
  selection: string[];
  focus: string | null;
  /** The LIVE camera at the moment of capture, read off the renderer. May be null. */
  viewpoint: { x: number; y: number; zoom: number } | null;
  lens: Lens;
  tab: ResultTab;
}

/**
 * How deep the back stack goes.
 *
 * Not unlimited, and the reason is the same one that keeps `saveView` off
 * `history.pushState`: a reverse action nobody can predict the destination of is
 * a reverse action nobody uses. Eight is more than any observed session needed
 * and short enough that "Back" always means somewhere you remember being.
 */
export const HISTORY_MAX = 8;

/** Every panel that can be open. Booleans, because a panel is either there or it is not. */
export interface AtlasUi {
  inspector: boolean;
  receipt: boolean;
  analyst: boolean;
  timeline: boolean;
  atlas: boolean;
  search: boolean;
  quarantine: boolean;
  help: boolean;
}

/** The key of any panel. `toggle(key)` accepts exactly these. */
export type UiPanel = keyof AtlasUi;

export interface AtlasQuery {
  /** What is in the command bar right now. `Q` renders this. */
  staged: string;
  /** The last successful render. `null` until one has been run. */
  active: QueryRenderResponse | null;
  /** True while a render is in flight. */
  running: boolean;
  /** The last failure's `what_failed`, kept after recovery so the bar can still show it. */
  error: string | null;
}

export interface AtlasFilters {
  /** Which sigma-classes may be stroked. All six by default. */
  sigma: SigmaClass[];
  /** Relation families to restrict to. Empty means "no family restriction". */
  families: string[];
  /** Draw the claims the truth gate rejected. They ship either way; this strokes them. */
  showQuarantined: boolean;
}

/** The camera TARGET. `version` increments on every set so the renderer can diff cheaply. */
export interface AtlasCamera {
  x: number;
  y: number;
  zoom: number;
  version: number;
}

/** The independent re-derivation of an answer path. See `explainPath()`. */
export interface AtlasExplain {
  /** The chain `GET /graph/path` found between the answer's own endpoints. */
  steps: PathStep[];
  /**
   * `identical`          the traversal reproduced the answer's edges exactly
   * `not-a-chain`        the answer is a set of hops, not a single route
   * `no-admitted-route`  no route exists through admitted relations
   * `differs`            the two disagree — a real contradiction, and it degrades
   */
  verdict: 'identical' | 'not-a-chain' | 'no-admitted-route' | 'differs';
  endpoints: [string, string] | null;
  checked_at: IsoTimestamp;
}

/**
 * THE DATA. Field names are fixed by the module contract — nothing here is
 * renamed, and the five fields marked ADDITIVE are additions, never
 * replacements.
 */
export interface AtlasData {
  app: AppState;
  degraded: DegradedReason | null;
  rung: Rung;
  /** Ancestors of the current view, continent-first. Empty when the rung is unscoped. */
  stack: RungStackEntry[];
  view: GraphViewResponse | null;
  bake: LayoutBake | null;
  hover: string | null;
  selection: string[];
  focus: string | null;
  query: AtlasQuery;
  trace: RenderTraceV1 | null;
  verify: VerifyResult | null;
  tampered: boolean;
  integrity: IntegrityResponse | null;
  timeline: TimelineResponse | null;
  ui: AtlasUi;
  density: DensityMode;
  filters: AtlasFilters;
  camera: AtlasCamera;
  /** node id -> admitted resolution tier. TOTAL over `view.nodes`; never has holes. */
  lod: Record<string, LodState>;
  reducedMotion: boolean;
  perf: PerfReadout;

  /* ---- ADDITIVE (beyond the fixed contract; nothing downstream must use them) */
  /** ADDITIVE. Measured phase costs of the corpus build. Null against a live engine. */
  timings: FixtureTimings | null;
  /** ADDITIVE. The staged questions with by-construction answers — the command bar's real menu. */
  stagedQueries: StagedQuery[];
  /** ADDITIVE. Node ids that arrived in the last ingest. Drives the settle animation. */
  ingestedIds: string[];
  /** ADDITIVE. The encoded scene from the last `saveView()`. */
  savedView: string | null;
  /** ADDITIVE. The result of the last `explainPath()`. */
  explain: AtlasExplain | null;

  /* ---- ADDITIVE (the workspace spine: lens -> result -> tab -> history) --- */
  /** ADDITIVE. Which workspace the user is in. Exactly one, always. */
  lens: Lens;
  /** ADDITIVE. Which detail surface the rail is showing. Exactly one, always. */
  tab: ResultTab;
  /**
   * ADDITIVE. True once the user has chosen a tab BY HAND for the current result.
   *
   * This is the whole of "respect an intentional close for reruns of the same
   * result, but reopen it for a new result": a new `query_id` clears the pin and
   * the rail lands on Evidence again, while a re-run of the question you are
   * already reading leaves you where you put yourself.
   */
  tabPinned: boolean;
  /** ADDITIVE. Scenes displaced by a render, a drill-down or a lens. Newest last. */
  history: SceneSnapshot[];
  /**
   * ADDITIVE. The scene the current result was framed in.
   *
   * `Return to result` aims here, so a drill-down four rungs deep always has one
   * move back to the answer that sent it there — which is what makes descending
   * into evidence safe enough to do.
   */
  resultScene: SceneSnapshot | null;

  /* ---- ADDITIVE (the timeline lens: one window, two views over it) -------- */
  /**
   * ADDITIVE. What the timeline is a timeline OF.
   *
   * It used to be the whole corpus, always, and it announced that as
   * `200 shown / 2,168 not shown` — a sample of an unbounded population, offered
   * as if it were the population. Scope defaults to the current answer, because
   * a lens over a result is a lens over THAT result unless the user broadens it.
   */
  timelineScope: TimelineScope;
  /**
   * ADDITIVE. The brushed window, as two fractions of the axis. `null` is "the
   * whole span". SHARED, because the axis over the terrain and the event list in
   * the rail are two views of one window and two copies would drift.
   */
  timelineWindow: { a: number; b: number } | null;
  /**
   * ADDITIVE. True once the user has APPLIED the window rather than previewed it.
   *
   * The old dock applied on `pointerup`: dragging one handle selected 162 nodes
   * out of a 200-event sample and reframed the map into a blob, as a side effect
   * of looking. Dragging is a preview now and applying is a press.
   */
  timelineApplied: boolean;

  /**
   * ADDITIVE. False when the selection was set by a LENS rather than by a person.
   *
   * The shell frames any selection that arrives as a set, which is right for a
   * constellation and wrong for a date window — it is what turned "show me this
   * period" into "throw the camera at 162 nodes". The wiring reads this.
   */
  selectionFramed: boolean;
}

/** THE ACTIONS. Names are fixed by the module contract. */
export interface AtlasActions {
  /**
   * @param opts.auto force the full FIRST-RUN -> READY path even on a genuine
   *        first visit. The shell passes this when it would rather open into
   *        the terrain than into the invitation. Default: honour the visit flag.
   */
  boot(opts?: { auto?: boolean }): Promise<void>;
  descend(id: string): Promise<void>;
  ascend(): Promise<void>;
  goToRung(rung: Rung, id?: string | null): Promise<void>;
  runQuery(q: string): Promise<void>;
  clearFocus(): void;
  selectNode(id: string, additive?: boolean): void;
  hoverNode(id: string | null): void;
  setCamera(x: number, y: number, zoom: number): void;
  toggle(key: UiPanel): void;
  setDensity(d: DensityMode): void;
  setSigmaFilter(list: SigmaClass[]): void;
  /** ADDITIVE. The family half of `filters`; `setSigmaFilter` only covers the class half. */
  setFamilyFilter(list: string[]): void;
  toggleQuarantined(): void;
  verifyActive(): VerifyResult | null;
  tamperActive(kind: TamperKind): void;
  restoreTrace(): Promise<void>;
  openPassage(passageId: string): Promise<void>;
  explainPath(): Promise<PathStep[]>;
  loadTimeline(): Promise<void>;
  degrade(reason: DegradedReason): void;
  recover(): Promise<void>;
  saveView(): string;
  loadView(encoded: string): Promise<void>;
  setPerf(p: Partial<PerfReadout>): void;
  ingestDemo(): Promise<void>;

  /* ---- ADDITIVE ------------------------------------------------------- */
  /** ADDITIVE. Write the command bar without running it. */
  stageQuery(text: string): void;
  /** ADDITIVE. Close the corpus. The only legal way back to EMPTY / FIRST-RUN. */
  unload(to: 'FIRST-RUN' | 'EMPTY'): void;
  /** ADDITIVE. Dispatch a keyboard event through `KEYMAP`. Returns true if it was consumed. */
  handleKey(event: KeyEventLike): boolean;

  /* ---- ADDITIVE (the workspace spine) --------------------------------- */
  /**
   * ADDITIVE. Enter a workspace lens.
   *
   * Saves the viewpoint on the way out of Explore and restores it on the way
   * back, because a lens that reframes the map and then hands it back somewhere
   * else has silently spent the user's orientation to show them a date axis.
   */
  setLens(lens: Lens): Promise<void>;
  /**
   * ADDITIVE. Show one result surface.
   *
   * @param opts.pin the user chose this by hand, so a re-run of the SAME result
   *        must not move them off it. A new result clears the pin.
   */
  setTab(tab: ResultTab, opts?: { pin?: boolean }): void;
  /** ADDITIVE. Capture the current scene onto the back stack, under a human label. */
  pushScene(label: string): void;
  /** ADDITIVE. Restore the most recently displaced scene. No-op on an empty stack. */
  back(): Promise<void>;
  /** ADDITIVE. The whole world, unscoped, at the island rung. The one guaranteed landmark. */
  home(): Promise<void>;
  /** ADDITIVE. Return to the scene the current result was framed in. */
  returnToResult(): Promise<void>;
  /** ADDITIVE. Frame a set of node ids through the renderer. Used by the result transition. */
  frameIds(ids: readonly string[], paddingPx?: number): Promise<void>;
  /**
   * ADDITIVE. Throw the current result away.
   *
   * The remedy an INTEGRITY failure needs and the one the product did not have.
   * When an independent re-traversal contradicts the receipt, the honest set of
   * moves is look / re-render / discard — and `Recover` was none of the three: it
   * cleared the alarm and left the contradicted answer on screen wearing a green
   * badge. This removes the ANSWER, not the warning about it.
   */
  discardResult(): void;
  /**
   * ADDITIVE. Hold a node WITHOUT changing what the rail is showing.
   *
   * `selectNode` is a person pointing at something, and it takes them to the
   * reading of what they pointed at — which is right for the map and wrong for a
   * list. "Locate on map" in the evidence trail must light the passage and leave
   * the reader in the list they are working through; without this it either
   * moved the camera to a node that was not lit, or lit it and threw the list
   * away. Neither is what the verb says.
   *
   * Also does not fly the camera, for the same reason a date window does not:
   * the caller frames deliberately, or does not.
   */
  highlightNode(id: string | null): void;

  /* ---- ADDITIVE (the timeline lens) ------------------------------------ */
  /** ADDITIVE. Widen or narrow what the timeline covers, and re-fetch it. */
  setTimelineScope(scope: TimelineScope): Promise<void>;
  /** ADDITIVE. Move the brush. A PREVIEW — nothing is selected and nothing moves. */
  setTimelineWindow(window: { a: number; b: number } | null): void;
  /** ADDITIVE. Commit the previewed window: hold the nodes in it, without re-framing. */
  applyTimelineWindow(): void;
  /** ADDITIVE. Whole span, nothing held. The reverse of `applyTimelineWindow`. */
  resetTimelineWindow(): void;
}

export type AtlasState = AtlasData & AtlasActions;

/* =============================================================================
 * 2. HELPERS
 * ========================================================================== */

/** The rung view's scope: the deepest breadcrumb entry, or the whole rung. */
export function parentIdOf(s: Pick<AtlasData, 'stack'>): string | null {
  return s.stack.length === 0 ? null : s.stack[s.stack.length - 1].id;
}

/**
 * The edge policy a view fetch should ask for.
 *
 * EDGES ARE EARNED. With an answer on screen the only honest set is the
 * constellation, and the entity layer has to come with it or the answer's own
 * nodes are missing from the rung it is drawn over.
 */
function viewOptionsFor(active: QueryRenderResponse | null): GraphViewOptions {
  if (active === null) return {};
  return {
    drawnReason: 'query-constellation',
    queryId: active.query_id,
    includeEntities: true,
  };
}

/**
 * Fetch one rung under the right edge policy.
 *
 * WHY THE FALLBACK. An answer between two entities has nothing to say at the
 * continent rung — continents have no relations of their own — so the
 * constellation policy legitimately returns zero edges there. Drawing zero edges
 * would read as a broken map rather than as "the answer is not visible from this
 * altitude", so the skeleton is fetched instead. The response's own
 * `stats.drawn_reason` then reports `trade-route-skeleton`, which is exactly what
 * was drawn. The HUD never has to be told twice.
 */
async function fetchView(
  rung: Rung,
  parentId: string | null,
  active: QueryRenderResponse | null,
): Promise<GraphViewResponse> {
  const options = viewOptionsFor(active);
  if (options.drawnReason === undefined) return engine.getGraphView(rung, parentId);
  const constellation = await engine.getGraphView(rung, parentId, options);
  if (constellation.stats.edge_count > 0) return constellation;
  return engine.getGraphView(rung, parentId);
}

/** The resolution map for a whole snapshot. One derivation, used by every commit. */
function computeLod(s: AtlasData): Record<string, LodState> {
  return deriveLod({
    view: s.view,
    bake: s.bake,
    trace: s.trace,
    path: s.query.active?.constellation.path ?? null,
    selection: s.selection,
    focus: s.focus,
  });
}

/**
 * The endpoints of an answer path, when the answer IS a chain.
 *
 * A `summarize` answer is a bundle of hops around one subject and is not a
 * chain — which is a fact about the answer, not a failure, and `explainPath`
 * reports it as `not-a-chain` rather than inventing two ends.
 *
 * -----------------------------------------------------------------------------
 * WHY THE DEGREE TEST WAS NOT ENOUGH, AND WHAT IT COST
 * -----------------------------------------------------------------------------
 * This used to accept any path with n+1 distinct nodes and exactly two nodes of
 * degree one. THAT TEST CANNOT TELL A CHAIN FROM A FORK. Take the two shapes at
 * n = 2:
 *
 *     chain   a --> b --> c        degrees  a:1  b:2  c:1
 *     fork    a --> r <-- b        degrees  a:1  r:2  b:1
 *
 * Identical signatures. The difference is DIRECTION: in a chain the middle node
 * is the target of one hop and the SOURCE of the next; in a fork it is the
 * target of both.
 *
 * The cost of missing that was the worst defect in the product. The corpus's own
 * curated `compare` question is a fork by construction — two subjects joined by
 * one shared regulator — and `buildStagedQueries()` says so in as many words
 * ("the constellation should be a fork, not a chain"). This function called it a
 * chain, handed `[a, b]` to `GET /graph/path`, and that traversal correctly
 * returned a DIFFERENT route between two nodes that were never the ends of
 * anything. The verdict came back `differs`, the app degraded with
 * `PATH_DISAGREEMENT`, and a demo question shipped as a trust failure — while
 * the engine had been right the whole way through.
 *
 * So the test is now directional continuity over the engine's own hop order. A
 * fork reports `not-a-chain`, which is true, which is what the copy already
 * said, and which is not an error.
 */
function chainEndpoints(path: readonly PathStep[]): [string, string] | null {
  if (path.length === 0) return null;

  /* ---- 1. IS IT A SIMPLE PATH AT ALL? (undirected) ----------------------
     The hops do NOT arrive in traversal order — `index` is the order the render
     assembled them, and the bridge answer's two hops arrive as
     `Tollstrand -> Bruntorp` then `Rimsdal -> Tollstrand`, which is one chain
     written middle-first. So the shape test is undirected: every node of degree
     at most two, exactly two of degree one, and n+1 nodes over n hops. */
  const degree = new Map<string, number>();
  for (const step of path) {
    degree.set(step.from_id, (degree.get(step.from_id) ?? 0) + 1);
    degree.set(step.to_id, (degree.get(step.to_id) ?? 0) + 1);
  }
  if (degree.size !== path.length + 1) return null;
  if ([...degree.values()].some((n) => n > 2)) return null;
  const ends = [...degree.entries()].filter(([, n]) => n === 1).map(([id]) => id);
  if (ends.length !== 2) return null;

  /* ---- 2. IS IT A CHAIN, OR A FORK WEARING A CHAIN'S DEGREE SEQUENCE? ----
     This is the half that was missing, and its absence is what shipped a curated
     question as a trust failure. At n = 2 these three shapes are INDISTINGUISHABLE
     by degree alone:

         chain       r --> t --> b      t: in 1, out 1
         fork        a <-- r --> b      r: in 0, out 2
         collider    a --> r <-- b      r: in 2, out 0

     The corpus's own `compare` question is a collider by construction — two
     subjects joined by one shared regulator, and `buildStagedQueries()` says so
     in as many words ("the constellation should be a fork, not a chain"). The
     old degree test called it a chain, handed its two outer nodes to
     `GET /graph/path`, and that traversal correctly returned a DIFFERENT route
     between two nodes that were never the ends of anything. Verdict: `differs`.
     The app raised `PATH_DISAGREEMENT` — the loudest thing it can say — over an
     answer the engine had got right at every step.

     An INTERNAL node of a chain is passed THROUGH: exactly one hop arrives and
     exactly one leaves. A fork's or a collider's centre is not. */
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const step of path) {
    outDeg.set(step.from_id, (outDeg.get(step.from_id) ?? 0) + 1);
    inDeg.set(step.to_id, (inDeg.get(step.to_id) ?? 0) + 1);
  }
  for (const [id, n] of degree) {
    if (n !== 2) continue; // an END is allowed to be one-directional
    if ((inDeg.get(id) ?? 0) !== 1 || (outDeg.get(id) ?? 0) !== 1) return null;
  }

  return [ends[0], ends[1]];
}

function sameEdgeSet(a: readonly PathStep[], b: readonly PathStep[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a.map((s) => s.edge_id));
  return b.every((s) => left.has(s.edge_id));
}

/** Node kinds that sit on the containment spine. Entities and sources do not. */
function isSpineNode(node: GraphNode): node is Extract<GraphNode, { kind: Rung }> {
  return node.kind !== 'entity' && node.kind !== 'source';
}

/**
 * What to CALL the place the user is standing in, using only names the engine
 * gave us.
 *
 * Order of preference: the thing they are holding, then the scope they are
 * inside, then nothing. The last case is not a failure — the whole world at the
 * island rung genuinely has no name, and inventing one ("Overview") would be the
 * store authoring prose, which is the one thing it does not do.
 */
function placeName(s: Pick<AtlasData, 'stack' | 'focus' | 'view'>): string {
  if (s.focus !== null) {
    const held = s.view?.nodes.find((n) => n.id === s.focus);
    if (held !== undefined) return held.label;
  }
  return s.stack.length === 0 ? '' : s.stack[s.stack.length - 1].label;
}

/* =============================================================================
 * 3. THE TEST-HOOK INSTALLER SEAM
 * -----------------------------------------------------------------------------
 * `./scenes` imports this module; this module must not import it back, or the
 * two would form a cycle that a bundler is entitled to evaluate in the wrong
 * order. So the scene driver registers itself here at module load and `boot()`
 * calls it — the same one-directional trick as `./bridge`, one layer up.
 * ========================================================================== */

let testHookInstaller: (() => void) | null = null;

/** Called once by `./scenes` at module load. Not for application code. */
export function registerTestHookInstaller(install: () => void): void {
  testHookInstaller = install;
}

/* =============================================================================
 * 4. THE STORE
 * ========================================================================== */

export const useAtlas = create<AtlasState>()((set, get) => {
  /* ---- closure state: real, but not something React ever renders -------- */

  /** The state we were in when we degraded. `recover()` aims at this. */
  let priorApp: AppState = 'FIRST-RUN';
  /** Every node id the session has ever seen, so an ingest can report what is NEW. */
  const known = new Set<string>();
  /**
   * `boot()` is idempotent AND shareable: a second caller gets the FIRST call's
   * promise rather than an instant resolve. Returning early instead would let a
   * scene driver tear the corpus down underneath an ingest that is still in the
   * air, and the ingest would then attempt SETTLING from EMPTY.
   */
  let bootPromise: Promise<void> | null = null;
  let unsubscribeMotion: (() => void) | null = null;

  /**
   * Apply a patch AND recompute the resolution map from the result.
   *
   * Everything that can change a node's resolution — the view, the bake, the
   * trace, the selection, the focus — goes through here, so the map can never
   * fall out of step with what is on screen. In dev the result is checked for
   * holes, because a node without a tier is a node the renderer silently skips.
   */
  const commit = (mutate: (s: AtlasState) => Partial<AtlasData>): void => {
    set((s) => {
      const patch = mutate(s);
      const next = { ...s, ...patch } as AtlasState;
      const lod = computeLod(next);
      if (STRICT_TRANSITIONS) {
        const holes = lodHoles(next.view, lod);
        if (holes.length > 0) {
          // eslint-disable-next-line no-console
          console.error(
            `[state/store] the resolution map has ${holes.length} hole(s) — e.g. ${holes.slice(0, 5).join(', ')}. ` +
              `The terrain is not allowed to have holes: every node in the view must carry a tier, ` +
              `down to \`latent\`.`,
          );
        }
      }
      return { ...patch, lod };
    });
  };

  /** The one place `app` changes. Consults the table, then parks if QA asked it to. */
  const enter = async (next: AppState, via: string): Promise<void> => {
    const from = get().app;
    if (from !== next) {
      assertTransition(from, next, via);
      if (next === 'DEGRADED' && from !== 'DEGRADED') priorApp = from;
      set({ app: next });
    }
    await awaitHold(`${next}:enter` as Checkpoint);
  };

  /** Route any thrown value to the DEGRADED screen with its three real fields. */
  const fail = (err: unknown): void => {
    get().degrade(toDegradedReason(err));
  };

  /**
   * The breadcrumb for a node, continent-first, INCLUDING the node itself.
   *
   * Walks `parent_id` with real `GET /node/{id}` calls rather than reading
   * labels out of whatever view happens to be loaded — the label shown in the
   * breadcrumb and the label the engine holds must be the same string.
   */
  const ancestorStack = async (nodeId: string): Promise<RungStackEntry[]> => {
    const out: RungStackEntry[] = [];
    const guard = new Set<string>();
    let cursor: string | null = nodeId;
    while (cursor !== null && !guard.has(cursor)) {
      guard.add(cursor);
      const node: GraphNode = await engine.getNode(cursor);
      if (!isSpineNode(node)) break;
      out.unshift({ rung: node.kind, id: node.id, label: node.label });
      cursor = node.parent_id;
    }
    return out;
  };

  /** Fetch one rung under whatever edge policy the session is currently under. */
  const loadRung = async (rung: Rung, parentId: string | null): Promise<GraphViewResponse> => {
    return fetchView(rung, parentId, get().query.active);
  };

  /* ---- the navigation stack --------------------------------------------- *
   * Three tiny functions, and between them they are the whole of "every
   * navigation action has a visible reverse action".                        */

  /** Everything the current place consists of, including where the camera is standing. */
  const snapshot = (label: string): SceneSnapshot => {
    const s = get();
    return {
      label,
      rung: s.rung,
      stack: [...s.stack],
      selection: [...s.selection],
      focus: s.focus,
      viewpoint: readViewpoint(),
      lens: s.lens,
      tab: s.tab,
    };
  };

  /**
   * Put a scene back on screen.
   *
   * The order matters and is not arbitrary: the VIEW is fetched before anything
   * is committed, so a failed fetch leaves the user where they are rather than
   * half-way between two places. The camera is moved LAST, after the payload it
   * is being pointed at exists.
   */
  const restore = async (scene: SceneSnapshot): Promise<void> => {
    try {
      const parentId = scene.stack.length === 0 ? null : scene.stack[scene.stack.length - 1].id;
      const view = await loadRung(scene.rung, parentId);
      commit((s) => ({
        rung: scene.rung,
        stack: [...scene.stack],
        view,
        selection: [...scene.selection],
        focus: scene.focus,
        hover: null,
        selectionFramed: true,
        lens: scene.lens,
        tab: scene.tab,
        /* THE DERIVED FLAGS TRAVEL WITH THE LENS. A scene captured while the
           timeline was open restores `lens: 'timeline'`, and leaving `ui` behind
           would put the primary and its derivation out of step — which is
           exactly the class of drift the lens was introduced to end. Restoring
           both from one source is the only version of this that cannot rot. */
        ui: { ...s.ui, timeline: scene.lens === 'timeline', analyst: scene.lens === 'analyze' },
      }));
      if (scene.viewpoint !== null) {
        get().setCamera(scene.viewpoint.x, scene.viewpoint.y, scene.viewpoint.zoom);
      }
    } catch (err) {
      fail(err);
    }
  };

  /** Push a scene, keeping the stack short enough that `Back` is still predictable. */
  const push = (label: string): void => {
    const scene = snapshot(label);
    set((s) => ({ history: [...s.history, scene].slice(-HISTORY_MAX) }));
  };

  return {
    /* ===================================================================== *
     * INITIAL DATA
     * ===================================================================== */

    app: 'FIRST-RUN',
    degraded: null,
    // The island rung, unscoped, is home: 33 islands and every strait between
    // them. It is the view the product's whole thesis is legible at.
    rung: 'island',
    stack: [],
    view: null,
    bake: null,
    hover: null,
    selection: [],
    focus: null,
    query: { staged: '', active: null, running: false, error: null },
    trace: null,
    verify: null,
    tampered: false,
    integrity: null,
    timeline: null,
    ui: {
      inspector: true,
      receipt: false,
      analyst: false,
      timeline: false,
      atlas: false,
      search: false,
      quarantine: false,
      help: false,
    },
    density: 'comfortable',
    filters: { sigma: [...SIGMA_CLASSES], families: [], showQuarantined: false },
    camera: { x: 0, y: 0, zoom: 1, version: 0 },
    lod: {},
    reducedMotion: false,
    perf: { fps: 0, frameMs: 0, points: 0, drawCalls: 0 },
    timings: null,
    stagedQueries: [],
    ingestedIds: [],
    savedView: null,
    explain: null,
    lens: 'explore',
    tab: 'answer',
    tabPinned: false,
    history: [],
    resultScene: null,
    timelineScope: 'answer',
    timelineWindow: null,
    timelineApplied: false,
    selectionFramed: true,

    /* ===================================================================== *
     * LIFECYCLE
     * ===================================================================== */

    /**
     * Bring the app up.
     *
     * FIRST-RUN is a real screen and it is worth exactly one visit: the terrain
     * explains itself and the user accepts the invitation by ingesting. Every
     * later load goes straight through EMPTY -> INGESTING -> SETTLING -> READY.
     * A shared `#view=` link always auto-ingests, because the link promised a
     * scene and stopping to explain the product would be a bait and switch.
     */
    boot: async (opts = {}) => {
      if (bootPromise !== null) return bootPromise;
      bootPromise = track(
        (async () => {
          const density = readStoredDensity() ?? detectDensity();
          applyDensity(density, { persist: false });
          set({ density, reducedMotion: prefersReducedMotion() });
          unsubscribeMotion?.();
          unsubscribeMotion = subscribeReducedMotion((reduced) => set({ reducedMotion: reduced }));

          // Visual QA drives the real actions through this. Installing it here
          // means a missing wire in the shell cannot cost the critic every shot.
          testHookInstaller?.();

          const token = readSavedViewFromHash();
          if (opts.auto !== true && token === null && !hasVisited()) {
            return; // stay on FIRST-RUN, awaiting the invitation. `ingestDemo()` accepts it.
          }

          await enter('EMPTY', 'boot');
          await get().ingestDemo();
          if (token !== null && get().app === 'READY') await get().loadView(token);
        })(),
      );
      return bootPromise;
    },

    /**
     * Materialise the corpus and stand the terrain up.
     *
     * INGESTING is `engine.warm()` — real generation, real validation, real
     * bake, measured by the engine and reported by `timings`. SETTLING is the
     * layout arriving and the terrain physically settling the new nodes, which
     * the shell gates through `registerSettleGate`. Neither is a timer.
     */
    ingestDemo: async () => {
      await track(
        (async () => {
          try {
            await enter('INGESTING', 'ingestDemo');
            set({ ingestedIds: [] });

            await engine.warm();
            const timings = getFixtureTimings();
            const bake = await engine.getLayoutBake();
            const view = await loadRung(get().rung, parentIdOf(get()));

            const fresh: string[] = [];
            for (const node of view.nodes) {
              if (!known.has(node.id)) {
                known.add(node.id);
                fresh.push(node.id);
              }
            }
            commit(() => ({ bake, view, timings, ingestedIds: fresh }));
            await awaitHold('INGESTING:done');

            if (view.nodes.length === 0) {
              // An ingest that produced nothing is not an error. It is EMPTY.
              await enter('EMPTY', 'ingestDemo');
              return;
            }

            await enter('SETTLING', 'ingestDemo');
            const [stagedQueries, integrity] = await Promise.all([
              engine.getStagedQueries(),
              engine.getIntegrity(),
            ]);
            commit((s) => ({
              stagedQueries,
              integrity,
              query: {
                ...s.query,
                staged: s.query.staged.length > 0 ? s.query.staged : (stagedQueries[0]?.query ?? ''),
              },
            }));

            await runSettleGate(fresh);
            await awaitHold('SETTLING:done');
            markVisited();
            await enter('READY', 'ingestDemo');
          } catch (err) {
            fail(err);
          }
        })(),
      );
    },

    /**
     * Close the corpus. The only legal route back to EMPTY or FIRST-RUN.
     *
     * The engine's fixtures are NOT reset: re-ingesting is fast because the
     * corpus is already materialised, and that is the truth about what happens.
     * Tearing the memo down would mint a new object graph under a live screen.
     */
    unload: (to) => {
      const from = get().app;
      assertTransition(from, to, 'unload');
      known.clear();
      commit(() => ({
        app: to,
        degraded: null,
        view: null,
        bake: null,
        stack: [],
        rung: 'island',
        hover: null,
        selection: [],
        focus: null,
        query: { staged: '', active: null, running: false, error: null },
        trace: null,
        verify: null,
        tampered: false,
        integrity: null,
        timeline: null,
        timings: null,
        stagedQueries: [],
        ingestedIds: [],
        explain: null,
        savedView: null,
        /* THE HISTORY GOES WITH THE CORPUS. Every scene on the stack names a
           rung, a scope and a selection inside a world that no longer exists;
           offering `Back` to one of them would be offering a door onto nothing. */
        lens: 'explore',
        tab: 'answer',
        tabPinned: false,
        history: [],
        resultScene: null,
        timelineScope: 'answer',
        timelineWindow: null,
        timelineApplied: false,
        selectionFramed: true,
      }));
    },

    degrade: (reason) => {
      const from = get().app;
      assertTransition(from, 'DEGRADED', 'degrade');
      if (from !== 'DEGRADED') priorApp = from;
      set({ app: 'DEGRADED', degraded: reason });
    },

    recover: async () => {
      if (get().app !== 'DEGRADED') return;
      const target = recoveryTarget(priorApp, get().view !== null);
      set({ degraded: null });
      await enter(target, 'recover');
    },

    /* ===================================================================== *
     * NAVIGATION — the spine
     * ===================================================================== */

    descend: async (id) => {
      await track(
        (async () => {
          const s = get();
          const next = RUNGS[RUNG_DEPTH[s.rung] + 1];
          if (next === undefined) {
            // eslint-disable-next-line no-console
            console.error(
              '[state/store] descend() at the passage rung: there is nothing below a passage. ' +
                'Its verbatim source segment is not a fifth rung — open it with openPassage().',
            );
            return;
          }
          try {
            const node =
              s.view?.nodes.find((n) => n.id === id) ?? (await engine.getNode(id));
            if (node.kind !== s.rung) {
              // eslint-disable-next-line no-console
              console.error(
                `[state/store] descend("${id}") — that node is a ${node.kind} and the current rung is ` +
                  `${s.rung}. Only the rung's own bodies are descendable; entities are cross-cutting ` +
                  `and are opened, not entered.`,
              );
              return;
            }
            const view = await loadRung(next, id);
            commit((st) => ({
              rung: next,
              stack: [...st.stack, { rung: s.rung, id, label: node.label }],
              view,
              hover: null,
            }));
          } catch (err) {
            fail(err);
          }
        })(),
      );
    },

    ascend: async () => {
      await track(
        (async () => {
          const s = get();
          try {
            if (s.stack.length === 0) {
              const depth = RUNG_DEPTH[s.rung];
              if (depth === 0) return; // the world is a set of continents; there is nothing above
              const up = RUNGS[depth - 1];
              const view = await loadRung(up, null);
              commit(() => ({ rung: up, view, hover: null }));
              return;
            }
            const entry = s.stack[s.stack.length - 1];
            const stack = s.stack.slice(0, -1);
            const parentId = stack.length === 0 ? null : stack[stack.length - 1].id;
            const view = await loadRung(entry.rung, parentId);
            commit(() => ({ rung: entry.rung, stack, view, hover: null }));
          } catch (err) {
            fail(err);
          }
        })(),
      );
    },

    /**
     * Jump to a rung, optionally scoped to a containing node.
     *
     * `id` must be a node ONE RUNG ABOVE `rung` — that is what the engine's
     * `parent_id` means. Passing `null` shows the whole rung, which is a real
     * and useful view: every island in the world is where the straits read.
     */
    goToRung: async (rung, id = null) => {
      await track(
        (async () => {
          try {
            const stack = id === null ? [] : await ancestorStack(id);
            const view = await loadRung(rung, id);
            commit(() => ({ rung, stack, view, hover: null }));
          } catch (err) {
            fail(err);
          }
        })(),
      );
    },

    /**
     * Descend to a passage and read it.
     *
     * The passage rung is reached through its containing asset — the molecule is
     * the extraction context, and a passage without its asset on the breadcrumb
     * is a quote without a document.
     */
    openPassage: async (passageId) => {
      await track(
        (async () => {
          try {
            const node = await engine.getNode(passageId);
            if (node.kind !== 'passage') {
              // eslint-disable-next-line no-console
              console.error(`[state/store] openPassage("${passageId}") — that node is a ${node.kind}.`);
              return;
            }
            /* READING A SOURCE IS A JOURNEY, SO IT LEAVES A WAY BACK.
               This action changes the rung, the scope, the selection and the
               camera in one step — the single most displacing move in the
               product — and until now it left nothing behind. */
            push(placeName(get()));
            const stack = await ancestorStack(node.asset_id);
            const view = await loadRung('passage', node.asset_id);
            commit((s) => ({
              rung: 'passage',
              stack,
              view,
              selection: [passageId],
              focus: passageId,
              /* WHAT YOU CAME TO READ IS WHAT THE RAIL SHOWS. Landing on the
                 passage rung with the rail still on the receipt is the map
                 changing under a panel that did not. */
              tab: 'inspect',
              tabPinned: true,
              lens: 'explore',
              ui: { ...s.ui, inspector: true },
            }));
          } catch (err) {
            fail(err);
          }
        })(),
      );
    },

    /* ===================================================================== *
     * QUERY
     * ===================================================================== */

    stageQuery: (text) => {
      set((s) => ({ query: { ...s.query, staged: text } }));
    },

    /**
     * Render an answer.
     *
     * `POST /query/render`, then `GET /trace/{id}` for the receipt, then a
     * re-fetch of the current rung under the `query-constellation` edge policy
     * so what is stroked on screen is exactly what the answer used. The
     * resolution map is then rebuilt from the trace's own AdmissionRecords: the
     * picture's LOD and the receipt's LOD are the same numbers.
     *
     * A question nothing matches throws `QUERY_NO_MATCH` and lands on DEGRADED
     * with the engine's own remedy. It does not get an invented answer.
     */
    runQuery: async (q) => {
      const text = q.trim();
      if (text.length === 0) return;
      await track(
        (async () => {
          const before = get();
          /* A RENDER IS A SCENE TRANSITION, NOT A PAYLOAD SWAP.
             The bug this ends: after drilling into evidence at the passage rung,
             a new question rendered while the breadcrumb still named the old
             document and the old passage scope, so the answer arrived inside a
             viewpoint that had nothing to do with it. Four moves, in order —
             save where they were, clear what belonged to the old place, land on
             a rung the answer is legible at, frame the whole path — and the
             saved scene becomes `Return to previous view`. */
          const sameQuestion = before.query.active?.query === text;
          if (!sameQuestion) push(placeName(before));

          await enter('QUERYING', 'runQuery');
          set((s) => ({
            query: { ...s.query, staged: text, running: true, error: null },
            /* STALE FOCUS DOES NOT SURVIVE A NEW QUESTION. */
            selection: sameQuestion ? s.selection : [],
            focus: sameQuestion ? s.focus : null,
            hover: null,
          }));
          try {
            const active = await engine.postQuery(text);
            const trace = await engine.getRenderTrace(active.trace_id);

            /* THE RUNG THE ANSWER IS LEGIBLE AT.
               An answer between two entities has nothing to say from the
               continent rung, and everything to say from the island rung, which
               is where straits are. A drill-down leaves us at `passage` scoped
               to one document; rendering there would draw the constellation
               inside a scope that excludes most of it. So a NEW question returns
               to the unscoped island rung — the product's own home altitude —
               while a re-run of the question already on screen holds still. */
            const goHome = !sameQuestion && (get().stack.length > 0 || get().rung !== 'island');
            const rung: Rung = goHome ? 'island' : get().rung;
            const stack = goHome ? [] : get().stack;
            const parentId = stack.length === 0 ? null : stack[stack.length - 1].id;
            const view = await fetchView(rung, parentId, active);

            commit((s) => ({
              query: { staged: text, active, running: false, error: null },
              trace,
              rung,
              stack,
              view,
              verify: null,
              tampered: false,
              explain: null,
              /* THE RESULT STATE. A render that lands is a defined place, and
                 this is what defines it: the evidence surface is selected, the
                 pin is cleared so a NEW result opens it even if the last one was
                 deliberately closed, and the lens returns to Explore because a
                 date axis or a filter bank is not where a fresh answer is read. */
              tab: sameQuestion && s.tabPinned ? s.tab : 'evidence',
              tabPinned: sameQuestion ? s.tabPinned : false,
              lens: 'explore',
            }));

            /* THE RENDER IS DONE WHEN THE PAYLOAD IS DONE, NOT WHEN THE CAMERA
               ARRIVES. This awaited the camera flight BEFORE leaving QUERYING,
               which had two costs and one of them was a real regression:

                 THE TERRAIN STAYED DIMMED through a 700ms flight, over an answer
                 that had already landed. Dimming means "this has not been spent
                 on yet"; it was still on screen after the spending had finished.

                 A SECOND QUESTION HAD TO WAIT OUT THE FIRST'S FLIGHT before it
                 could even start, because `runQuery` did not return until the
                 camera had arrived.

               NOTE WHAT THIS DOES NOT FIX. `verify-motion`'s MOTION LAW 2 — two
               renders 120ms apart, the second superseding the first — fails
               before this change and after it, and it fails identically on the
               pre-pass build (498ms / 654ms, neither superseded), so it is not
               this ordering and it is not this pass. The reveal simply does not
               begin until its payload commits, and at a 120ms gap the first
               payload has usually not landed yet, so the two runs never overlap
               to interrupt. That is a real limit of the interruption model and it
               is filed rather than papered over here.

               So the machine reaches READY on the payload, and the choreography
               runs after it, in READY.
               The framing is still AWAITED, because the scene snapshot below has
               to be taken from where the camera actually came to rest — or
               `Back to result` returns to the viewpoint the question was asked
               from rather than the one the answer was framed in. */
            await awaitHold('QUERYING:done');
            await enter('READY', 'runQuery');

            /* FRAME THE COMPLETE ANSWER PATH — every node of it, not the
               terminal. An answer whose first hop is off-camera is an answer the
               picture cannot be checked against. */
            const onPath = new Set<string>();
            for (const step of active.constellation.path) {
              onPath.add(step.from_id);
              onPath.add(step.to_id);
            }
            if (active.constellation.bridge_entity_id !== null) {
              onPath.add(active.constellation.bridge_entity_id);
            }
            await runFrameGate([...onPath], 112);

            /* The place the answer was framed in, so a drill-down always has one
               move home.

               GUARDED, because this no longer runs inside QUERYING: a second
               question may have started AND landed while this flight was in the
               air, and writing this render's scene over the newer one would
               leave `Back to result` pointing at an answer nobody is looking at.
               The query id is what says which render this is. */
            if (get().query.active?.query_id === active.query_id) {
              set({ resultScene: snapshot(text) });
            }

            /* THE RE-DERIVATION IS A PROPERTY OF THE RESULT, NOT OF A PANEL.
               It used to be fired by an effect inside the answer panel, which was
               fine while that panel was always mounted — and became a silent hole
               the moment a landing render selected the EVIDENCE surface instead.
               The verdict simply did not run unless the reader happened to open
               the Answer tab, so the strongest trust claim in the product became
               conditional on a navigation nobody was asked to make, and the
               pinned trust line above every tab had nothing to say.

               It runs here, where the render is, unconditionally. It is a local
               graph walk that costs nothing, it either agrees or it does not, and
               the panel's own effect now finds the verdict already in hand. */
            await get().explainPath();
          } catch (err) {
            /* A RENDER THAT NEVER LANDED DISPLACED NOTHING, SO IT LEAVES NO WAY
               BACK. The scene was pushed on the way IN, before the request, and
               a failure means the user is still standing exactly where it was
               taken — so `Back` would offer a door onto the room they are in.
               A reverse action that does nothing visible is worse than an absent
               one: it is the control teaching people not to trust it. */
            if (!sameQuestion) set((s) => ({ history: s.history.slice(0, -1) }));
            const reason = toDegradedReason(err);
            set((s) => ({ query: { ...s.query, running: false, error: reason.what_failed } }));
            get().degrade(reason);
          }
        })(),
      );
    },

    /**
     * Re-derive the answer path INDEPENDENTLY and compare.
     *
     * The receipt says the answer went a certain way. `GET /graph/path` walks
     * the graph again, from the answer's own endpoints, with no knowledge of the
     * render. If the two disagree the product has two panels contradicting each
     * other about the same two nodes, which is precisely the failure this
     * instrument cannot afford — so it degrades and says so.
     */
    explainPath: async () => {
      let steps: PathStep[] = [];
      await track(
        (async () => {
          const active = get().query.active;
          if (active === null) return;
          const answer = active.constellation.path;
          const checked_at = new Date().toISOString();
          const endpoints = chainEndpoints(answer);

          if (endpoints === null) {
            commit(() => ({
              explain: { steps: [], verdict: 'not-a-chain', endpoints: null, checked_at },
            }));
            return;
          }

          try {
            steps = await engine.findPath(endpoints[0], endpoints[1]);
            if (steps.length === 0) steps = await engine.findPath(endpoints[1], endpoints[0]);

            const verdict: AtlasExplain['verdict'] =
              steps.length === 0
                ? 'no-admitted-route'
                : sameEdgeSet(steps, answer)
                  ? 'identical'
                  : 'differs';

            const onPath = new Set<string>();
            for (const step of answer) {
              onPath.add(step.from_id);
              onPath.add(step.to_id);
            }
            /* THE VERDICT DOES NOT STEAL THE RAIL. It used to force the inspector
               open, which on a disagreement pushed the reader onto a node panel
               at the exact moment the ANSWER was the thing that had stopped being
               trustworthy. The verdict is stated in the pinned header above every
               tab, so it is already unmissable wherever the reader is. */
            commit(() => ({
              explain: { steps, verdict, endpoints, checked_at },
              selection: [...onPath],
              focus: active.constellation.bridge_entity_id ?? endpoints[1],
              selectionFramed: true,
            }));

            if (verdict === 'differs') {
              get().degrade({
                code: 'PATH_DISAGREEMENT',
                what_failed:
                  `The receipt for ${active.query_id} routes the answer through ` +
                  `${answer.map((s) => s.family).join(' + ')}, but re-traversing the graph between the ` +
                  `same two nodes returns ${steps.map((s) => s.family).join(' + ')}. Two surfaces of the ` +
                  `engine disagree about the same claim.`,
                exact_remedy:
                  'Open the Integrity panel and check whether an edge on either route was quarantined after the render, then re-run the question.',
              });
            }
          } catch (err) {
            fail(err);
          }
        })(),
      );
      return steps;
    },

    /* ===================================================================== *
     * TRUST
     * ===================================================================== */

    /**
     * Verify the active receipt. LOCAL and SYNCHRONOUS: you do not ask the party
     * that issued the receipt whether the receipt is good, and a trust badge
     * must not blink through an `await`.
     */
    verifyActive: () => {
      const trace = get().trace;
      if (trace === null) return null;
      const verify = engine.verifyTraceSync(trace);
      set({ verify });
      return verify;
    },

    /**
     * Mutate the receipt's actual bytes and re-verify.
     *
     * The badge goes red because the signature genuinely stopped matching, not
     * because a flag was flipped. That is the entire pedagogical point of the
     * control, and it is why the verification here is the same code path the
     * valid case uses.
     */
    tamperActive: (kind) => {
      const trace = get().trace;
      if (trace === null) return;
      try {
        const mutated = tamper(trace, kind);
        const verify = engine.verifyTraceSync(mutated);
        commit(() => ({ trace: mutated, tampered: true, verify }));
      } catch (err) {
        fail(err);
      }
    },

    /** Re-fetch the pristine receipt from the engine. The tampered copy was never stored. */
    restoreTrace: async () => {
      await track(
        (async () => {
          const s = get();
          const traceId = s.trace?.trace_id ?? s.query.active?.trace_id ?? null;
          if (traceId === null) return;
          try {
            const trace = await engine.getRenderTrace(traceId);
            commit(() => ({ trace, tampered: false, verify: engine.verifyTraceSync(trace) }));
          } catch (err) {
            fail(err);
          }
        })(),
      );
    },

    /**
     * Fetch the dated claims this lens is a lens OF.
     *
     * THE SCOPE IS A DECISION, NOT A SIDE EFFECT OF WHERE YOU HAPPEN TO BE.
     * This used to key off `parentIdOf()` — the deepest breadcrumb entry — so
     * the axis silently meant something different depending on how you had been
     * navigating, and at the top of the world it meant "the whole corpus" and
     * said so as `200 shown / 2,168 not shown`. A sample of an unbounded
     * population presented as the population is the one thing a timeline must
     * not do, so the scope is now explicit and defaults to the current answer.
     */
    loadTimeline: async () => {
      await track(
        (async () => {
          const s = get();
          try {
            /* The ids the current scope admits. `null` means the whole corpus,
               which is the only scope this engine expresses as "unscoped". */
            const scopeId =
              s.timelineScope === 'corpus'
                ? null
                : s.timelineScope === 'selection'
                  ? (s.focus ?? s.selection[0] ?? parentIdOf(s))
                  : /* answer */ (s.query.active?.constellation.bridge_entity_id ??
                     s.query.active?.constellation.path[0]?.from_id ??
                     parentIdOf(s));
            const timeline = await engine.getTimeline({
              limit: 200,
              includeQuarantined: s.filters.showQuarantined,
              ...(scopeId === null ? {} : { scopeId }),
            });
            set({ timeline, timelineWindow: null, timelineApplied: false });
          } catch (err) {
            fail(err);
          }
        })(),
      );
    },

    setTimelineScope: async (scope) => {
      if (get().timelineScope === scope) return;
      set({ timelineScope: scope, timeline: null, timelineWindow: null, timelineApplied: false });
      await get().loadTimeline();
    },

    /** A PREVIEW. Deliberately writes one field and touches neither the selection
        nor the camera — see `timelineApplied`. */
    setTimelineWindow: (window) => {
      /* MOVING THE BRUSH UN-APPLIES IT. `timelineApplied` was set true by
         `applyTimelineWindow` and cleared only by a scope change or a reset, so
         dragging after applying left the axis reading `Applied` over a window
         that had not been — a state word describing the previous window. The
         held selection is deliberately NOT cleared here: it is still a real
         selection the user made, and dropping it on the first pixel of a drag
         would be the lens taking something back without being asked. */
      set((s) => ({ timelineWindow: window, timelineApplied: s.timelineApplied && window === null }));
    },

    applyTimelineWindow: () => {
      const s = get();
      const t = s.timeline;
      const w = s.timelineWindow;
      if (t === null) return;
      if (w === null) {
        get().resetTimelineWindow();
        return;
      }
      const t0 = Date.parse(t.from);
      const t1 = Date.parse(t.to);
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return;
      const lo = t0 + Math.min(w.a, w.b) * (t1 - t0);
      const hi = t0 + Math.max(w.a, w.b) * (t1 - t0);
      const ids: string[] = [];
      for (const e of t.events) {
        const at = Date.parse(e.at);
        if (at >= lo && at <= hi && !ids.includes(e.node_id)) ids.push(e.node_id);
      }
      /* HELD, NOT FLOWN TO. `selectionFramed: false` is what stops the shell
         throwing the camera at everything a date range happens to contain. */
      commit(() => ({ selection: ids, focus: null, timelineApplied: true, selectionFramed: false }));
    },

    resetTimelineWindow: () => {
      commit(() => ({
        timelineWindow: null,
        timelineApplied: false,
        selection: [],
        focus: null,
        selectionFramed: true,
      }));
    },

    /* ===================================================================== *
     * POINTER, SELECTION, CHROME
     * ===================================================================== */

    /** One field. Deliberately NOT routed through `commit` — hover is not a resolution input. */
    hoverNode: (id) => {
      if (get().hover === id) return;
      set({ hover: id });
    },

    /**
     * Hold a node — and SHOW what was held.
     *
     * Selecting used to change the map and nothing else: the node lit up on the
     * terrain while its reading began somewhere below the fold of a rail that
     * was already several screens tall, so the observable result of a click was
     * a colour change. The detail exists; the click now takes you to it.
     *
     * The tab is PINNED by this, because arriving at the inspector by pointing at
     * something is as deliberate a choice as pressing the tab itself.
     */
    selectNode: (id, additive = false) => {
      commit((s) => {
        /* A HAND-MADE SELECTION IS NOT THE DATE WINDOW'S SELECTION.
           `timelineApplied` says "the nodes on screen are the ones this window
           admitted". Pointing at one node makes that false, and leaving the flag
           set left the axis reading `Applied` over a selection the window had
           nothing to do with — the same lie the pill was raised for, reached
           through the other door. */
        const toInspect = {
          tab: 'inspect' as ResultTab,
          tabPinned: true,
          selectionFramed: true,
          timelineApplied: false,
        };
        if (!additive) return { selection: [id], focus: id, ...toInspect };
        const has = s.selection.includes(id);
        const selection = has ? s.selection.filter((x) => x !== id) : [...s.selection, id];
        const focus = has ? (selection[selection.length - 1] ?? null) : id;
        return { selection, focus, ...(focus === null ? {} : toInspect) };
      });
    },

    /** Esc. Drops the pointer state and the transient overlays; keeps the answer. */
    clearFocus: () => {
      commit((s) => ({
        focus: null,
        selection: [],
        hover: null,
        selectionFramed: true,
        timelineApplied: false,
        ui: { ...s.ui, search: false, help: false },
        /* THE INSPECT TAB HAS NOTHING LEFT TO INSPECT. Leaving the rail on an
           empty inspector after Esc is the panel reporting on the user rather
           than on the engine — so it falls back to the surface the result state
           defines, and the pin that put it there is released with it. */
        ...(s.tab === 'inspect'
          ? { tab: (s.query.active === null ? 'answer' : 'evidence') as ResultTab, tabPinned: false }
          : {}),
      }));
    },

    setCamera: (x, y, zoom) => {
      set((s) => ({ camera: { x, y, zoom, version: s.camera.version + 1 } }));
    },

    /**
     * Flip a panel.
     *
     * TWO OF THESE ARE NO LONGER PANELS. `timeline` and `analyst` are lenses now
     * — places, mutually exclusive with Explore and with each other — so the flag
     * they used to own is derived from `lens` and this routes to `setLens()`
     * rather than writing it directly. Everything that already calls
     * `toggle('timeline')` (the scene driver, the dock's own Close, the keyboard)
     * therefore keeps working and cannot leave the two out of step.
     */
    toggle: (key) => {
      if (key === 'timeline' || key === 'analyst') {
        const want: Lens = key === 'timeline' ? 'timeline' : 'analyze';
        void get().setLens(get().lens === want ? 'explore' : want);
        return;
      }
      set((s) => ({ ui: { ...s.ui, [key]: !s.ui[key] } }));
    },

    setDensity: (d) => {
      applyDensity(d);
      set({ density: d });
    },

    setSigmaFilter: (list) => {
      set((s) => ({ filters: { ...s.filters, sigma: [...list] } }));
    },

    setFamilyFilter: (list) => {
      set((s) => ({ filters: { ...s.filters, families: [...list] } }));
    },

    toggleQuarantined: () => {
      set((s) => ({ filters: { ...s.filters, showQuarantined: !s.filters.showQuarantined } }));
    },

    setPerf: (p) => {
      set((s) => ({ perf: { ...s.perf, ...p } }));
    },

    /* ===================================================================== *
     * THE WORKSPACE SPINE — lens, tab, and the way back out of both
     * ===================================================================== */

    /**
     * Enter a lens.
     *
     * A LENS BORROWS THE VIEWPOINT AND GIVES IT BACK. Dragging a date window used
     * to select 162 nodes out of a 200-event sample, reframe the map onto them,
     * and then hand the map back exactly there when the panel closed — the user
     * paid for a glance at the clock with their whole orientation. So leaving
     * Explore saves the viewpoint and returning restores it, which is the same
     * contract `Back` offers, applied to a move that never looked like one.
     */
    setLens: async (lens) => {
      const s = get();
      if (s.lens === lens) return;

      if (s.lens === 'explore') {
        // On the way out: remember where Explore was standing.
        push(placeName(s));
      }

      set({ lens, ui: { ...s.ui, timeline: lens === 'timeline', analyst: lens === 'analyze' } });

      if (lens === 'timeline' && get().timeline === null) await get().loadTimeline();

      if (lens === 'explore') {
        // On the way back: the top of the stack is the Explore scene we left.
        const stack = get().history;
        const last = stack[stack.length - 1];
        if (last !== undefined && last.lens === 'explore') {
          set({ history: stack.slice(0, -1) });
          await restore(last);
        }
      }
    },

    setTab: (tab, opts = {}) => {
      set((s) => (s.tab === tab && s.tabPinned === (opts.pin ?? s.tabPinned) ? s : { tab, tabPinned: opts.pin ?? s.tabPinned }));
    },

    pushScene: (label) => {
      push(label);
    },

    back: async () => {
      const stack = get().history;
      const last = stack[stack.length - 1];
      if (last === undefined) return;
      set({ history: stack.slice(0, -1) });
      await track(restore(last));
    },

    /**
     * The one guaranteed landmark.
     *
     * The whole world at the island rung, unscoped, with nothing held — the view
     * the product's thesis is legible at and the only place a lost user can be
     * promised in advance. It does NOT throw the answer away: `Home` is a place,
     * not a reset, and the receipt for the question you asked is still yours.
     */
    home: async () => {
      const s = get();
      if (s.rung !== 'island' || s.stack.length > 0 || s.selection.length > 0) {
        push(placeName(s));
      }
      await track(
        (async () => {
          try {
            const view = await loadRung('island', null);
            commit((st) => ({
              rung: 'island',
              stack: [],
              view,
              selection: [],
              focus: null,
              hover: null,
              lens: 'explore',
              ui: { ...st.ui, timeline: false, analyst: false },
              tab: (st.query.active === null ? 'answer' : 'evidence') as ResultTab,
              tabPinned: false,
            }));
          } catch (err) {
            fail(err);
          }
        })(),
      );
    },

    returnToResult: async () => {
      const scene = get().resultScene;
      if (scene === null) return;
      await track(restore(scene));
    },

    frameIds: async (ids, paddingPx) => {
      await runFrameGate(ids, paddingPx);
    },

    highlightNode: (id) => {
      commit(() => ({
        selection: id === null ? [] : [id],
        focus: id,
        selectionFramed: false,
        timelineApplied: false,
      }));
    },

    discardResult: () => {
      const s = get();
      if (s.query.active === null) return;
      commit((st) => ({
        query: { staged: st.query.staged, active: null, running: false, error: null },
        trace: null,
        verify: null,
        tampered: false,
        explain: null,
        resultScene: null,
        selection: [],
        focus: null,
        hover: null,
        tab: 'answer' as ResultTab,
        tabPinned: false,
        degraded: null,
      }));
      /* THE PICTURE GOES WITH IT. The terrain is still stroking a constellation
         that belongs to a discarded render; re-fetching under the plain policy is
         what makes "discarded" true on the map as well as in the rail. */
      void track(
        (async () => {
          try {
            const view = await loadRung(get().rung, parentIdOf(get()));
            commit(() => ({ view }));
          } catch (err) {
            fail(err);
          }
        })(),
      );
      if (get().app === 'DEGRADED') void get().recover();
    },

    /* ===================================================================== *
     * SHAREABLE SCENE STATE
     * ===================================================================== */

    saveView: () => {
      const s = get();
      const token = encodeSavedView({
        version: 1,
        rung: s.rung,
        parentId: parentIdOf(s),
        camera: { x: s.camera.x, y: s.camera.y, zoom: s.camera.zoom },
        selection: [...s.selection],
        focus: s.focus,
        queryId: s.query.active?.query_id ?? null,
        query: s.query.active?.query ?? null,
        filters: {
          sigma: [...s.filters.sigma],
          families: [...s.filters.families],
          showQuarantined: s.filters.showQuarantined,
        },
        density: s.density,
      });
      writeSavedViewToHash(token);
      set({ savedView: token });
      return token;
    },

    loadView: async (encoded) => {
      await track(
        (async () => {
          let saved;
          try {
            saved = decodeSavedView(encoded);
          } catch (err) {
            get().degrade(
              err instanceof SavedViewError
                ? { code: err.code, what_failed: err.what_failed, exact_remedy: err.exact_remedy }
                : toDegradedReason(err),
            );
            return;
          }
          try {
            if (saved.density !== get().density) get().setDensity(saved.density);
            // The question is re-rendered rather than restored from the link:
            // a receipt that came out of a URL is not a receipt.
            if (saved.query !== null && saved.query.length > 0) await get().runQuery(saved.query);
            if (get().app === 'DEGRADED') return;

            const stack = saved.parentId === null ? [] : await ancestorStack(saved.parentId);
            const view = await loadRung(saved.rung, saved.parentId);
            commit(() => ({
              rung: saved.rung,
              stack,
              view,
              selection: [...saved.selection],
              focus: saved.focus,
              filters: {
                sigma: [...saved.filters.sigma],
                families: [...saved.filters.families],
                showQuarantined: saved.filters.showQuarantined,
              },
              savedView: encoded,
            }));
            get().setCamera(saved.camera.x, saved.camera.y, saved.camera.zoom);
          } catch (err) {
            fail(err);
          }
        })(),
      );
    },

    /* ===================================================================== *
     * KEYBOARD
     * ===================================================================== */

    /**
     * Dispatch one keyboard event through `KEYMAP`.
     *
     * The shell owns the listener; this owns the meaning. Same table the help
     * overlay and every `<KeyHint>` chip read from, so the glyph on screen and
     * the branch taken here can never drift.
     */
    handleKey: (event) => {
      const binding = matchBinding(event);
      if (binding === null) return false;
      const s = get();
      switch (binding.id) {
        case 'search':
          s.toggle('search');
          return true;

        /* ---- lenses: a press is a MOVE, and pressing the one you are in
           returns you to Explore, which is the only lens that is a home. ---- */
        case 'lens-explore':
          void s.setLens('explore');
          return true;
        case 'lens-timeline':
          void s.setLens(s.lens === 'timeline' ? 'explore' : 'timeline');
          return true;
        case 'lens-analyze':
          void s.setLens(s.lens === 'analyze' ? 'explore' : 'analyze');
          return true;

        /* ---- result tabs: pinned, because a keystroke is a deliberate act - */
        case 'tab-answer':
          s.setTab('answer', { pin: true });
          return true;
        case 'tab-evidence':
          s.setTab('evidence', { pin: true });
          return true;
        case 'tab-inspect':
          s.setTab('inspect', { pin: true });
          return true;

        case 'help':
          s.toggle('help');
          return true;
        case 'clear-focus':
          s.clearFocus();
          return true;
        case 'ascend':
          void s.ascend();
          return true;
        case 'back':
          void s.back();
          return true;
        case 'home':
          void s.home();
          return true;
        case 'return-to-result':
          void s.returnToResult();
          return true;
        case 'run-query':
          if (s.query.staged.trim().length > 0) void s.runQuery(s.query.staged);
          else s.toggle('search');
          return true;
        case 'rung-continent':
        case 'rung-island':
        case 'rung-asset':
        case 'rung-passage': {
          const rung = binding.rung;
          if (rung === null) return false;
          // Keep the scope when the breadcrumb already contains a legal parent
          // for the target rung; otherwise show the whole rung.
          /* ONE RULE FOR THE MOVE, WHEREVER IT IS ASKED FOR.
             This trusted the breadcrumb stack alone, while the pointer path had
             moved to "descend into the selected parent or the current answer
             scope". Two rules for one move means the keyboard and the mouse land
             somewhere different from the same state, which is the kind of
             difference nobody reports as a bug and everybody stops trusting. */
          const depth = RUNG_DEPTH[rung];
          const scope =
            s.stack[depth - 1]?.id ??
            (depth === 0 ? null : (s.focus ?? s.selection[0] ?? null));
          void s.goToRung(rung, scope);
          return true;
        }
        default:
          return false;
      }
    },
  };
});

/* =============================================================================
 * 5. THE SELECTOR HOOK
 * ========================================================================== */

/**
 * Read the store with a selector, compared SHALLOWLY.
 *
 * This is the whole re-render discipline in one line. `useAtlas(s => ({...}))`
 * with zustand v5's default `Object.is` would re-render on every store write,
 * because the selector returns a fresh object each time. Wrapping in
 * `useShallow` means a panel selecting `{ app, rung, tokens }` re-renders when
 * one of those three changes and at no other time — a pointer moving across
 * 4,406 nodes repaints nothing but the terrain.
 */
export function useAtlasStore<T>(selector: (s: AtlasState) => T): T {
  return useAtlas(useShallow(selector));
}
