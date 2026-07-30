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
import { awaitHold, runSettleGate, track } from '@/state/bridge';
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
 * A chain visits n+1 distinct nodes over n hops and has exactly two nodes that
 * appear once. A `summarize` answer is a bundle of hops around one subject and
 * has neither property — which is a fact about the answer, not a failure, and
 * `explainPath` reports it as `not-a-chain` rather than inventing two ends.
 */
function chainEndpoints(path: readonly PathStep[]): [string, string] | null {
  if (path.length === 0) return null;
  const degree = new Map<string, number>();
  for (const step of path) {
    degree.set(step.from_id, (degree.get(step.from_id) ?? 0) + 1);
    degree.set(step.to_id, (degree.get(step.to_id) ?? 0) + 1);
  }
  if (degree.size !== path.length + 1) return null;
  const ends = [...degree.entries()].filter(([, n]) => n === 1).map(([id]) => id);
  return ends.length === 2 ? [ends[0], ends[1]] : null;
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
            const stack = await ancestorStack(node.asset_id);
            const view = await loadRung('passage', node.asset_id);
            commit((s) => ({
              rung: 'passage',
              stack,
              view,
              selection: [passageId],
              focus: passageId,
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
          await enter('QUERYING', 'runQuery');
          set((s) => ({ query: { ...s.query, staged: text, running: true, error: null } }));
          try {
            const active = await engine.postQuery(text);
            const trace = await engine.getRenderTrace(active.trace_id);
            const view = await fetchView(get().rung, parentIdOf(get()), active);
            commit(() => ({
              query: { staged: text, active, running: false, error: null },
              trace,
              view,
              verify: null,
              tampered: false,
              explain: null,
            }));
            await awaitHold('QUERYING:done');
            await enter('READY', 'runQuery');
          } catch (err) {
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
            commit((s) => ({
              explain: { steps: [], verdict: 'not-a-chain', endpoints: null, checked_at },
              ui: { ...s.ui, inspector: true },
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
            commit((s) => ({
              explain: { steps, verdict, endpoints, checked_at },
              selection: [...onPath],
              focus: active.constellation.bridge_entity_id ?? endpoints[1],
              ui: { ...s.ui, inspector: true },
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

    loadTimeline: async () => {
      await track(
        (async () => {
          const s = get();
          try {
            const scopeId = parentIdOf(s);
            const timeline = await engine.getTimeline({
              limit: 200,
              includeQuarantined: s.filters.showQuarantined,
              ...(scopeId === null ? {} : { scopeId }),
            });
            set({ timeline });
          } catch (err) {
            fail(err);
          }
        })(),
      );
    },

    /* ===================================================================== *
     * POINTER, SELECTION, CHROME
     * ===================================================================== */

    /** One field. Deliberately NOT routed through `commit` — hover is not a resolution input. */
    hoverNode: (id) => {
      if (get().hover === id) return;
      set({ hover: id });
    },

    selectNode: (id, additive = false) => {
      commit((s) => {
        if (!additive) return { selection: [id], focus: id };
        const has = s.selection.includes(id);
        const selection = has ? s.selection.filter((x) => x !== id) : [...s.selection, id];
        return { selection, focus: has ? (selection[selection.length - 1] ?? null) : id };
      });
    },

    /** Esc. Drops the pointer state and the transient overlays; keeps the answer. */
    clearFocus: () => {
      commit((s) => ({
        focus: null,
        selection: [],
        hover: null,
        ui: { ...s.ui, search: false, help: false },
      }));
    },

    setCamera: (x, y, zoom) => {
      set((s) => ({ camera: { x, y, zoom, version: s.camera.version + 1 } }));
    },

    toggle: (key) => {
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
        case 'atlas':
          s.toggle('atlas');
          return true;
        case 'inspector':
          s.toggle('inspector');
          return true;
        case 'receipt':
          s.toggle('receipt');
          return true;
        case 'timeline':
          s.toggle('timeline');
          if (s.timeline === null) void s.loadTimeline();
          return true;
        case 'analyst':
          s.toggle('analyst');
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
          const depth = RUNG_DEPTH[rung];
          const scope = s.stack[depth - 1]?.id ?? null;
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
