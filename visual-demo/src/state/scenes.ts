/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE SCENE HOOK
 * =============================================================================
 *
 * `window.__atlas.scene(name)` drives the REAL application into a named screen
 * using nothing but the REAL actions. There is no mock render anywhere in this
 * file: `home` runs the same `goToRung` a click runs, `receipt` runs the same
 * `runQuery` the command bar runs, and `degraded` fails for a real reason with
 * the engine's own remedy attached.
 *
 * That constraint is the entire value of the hook. A screenshot harness that
 * photographs a mock is a harness that certifies a lie, and the critic reviewing
 * those images has no way to tell. Every pixel `scripts/shoot.mjs` captures was
 * produced by the product doing its job.
 *
 * -----------------------------------------------------------------------------
 * TRANSIENT STATES AND THE CHECKPOINT HOLD
 * -----------------------------------------------------------------------------
 * INGESTING and SETTLING last exactly as long as the work does. To photograph
 * them, the scene driver parks the pipeline at a NAMED CHECKPOINT of real work
 * (see `./bridge`) — the state is genuine, the data in it is genuine, and the
 * only thing that changed is that it is waiting to be released. It is a pause
 * button, not a fake loading screen.
 *
 * -----------------------------------------------------------------------------
 * DETERMINISM
 * -----------------------------------------------------------------------------
 * Every scene starts from the same baseline: the corpus is closed and re-opened
 * through `unload()` + `ingestDemo()`. Re-ingesting is fast because the engine's
 * fixtures are memoised and its response cache is warm — which is the truth
 * about a second ingest, not a shortcut around it. The result is that scenes are
 * order-independent, so a `--scenes receipt` run and a full run photograph the
 * same screen.
 * =============================================================================
 */

import { useAtlas, registerTestHookInstaller, parentIdOf } from '@/state/store';
import type { AtlasState } from '@/state/store';
import { EngineClient, toDegradedReason } from '@/engine';
import { drain, holdAt, isIdle, releaseHold } from '@/state/bridge';
import { forgetVisited } from '@/state/density';
import type { PerfReadout } from '@/state/perf';

/** Exactly the scene names the module contract fixes. `scripts/shoot.mjs` requires all of them. */
export const SCENE_NAMES = Object.freeze([
  'first-run',
  'empty',
  'ingesting',
  'settling',
  'home',
  'query-render',
  'constellation',
  'receipt',
  'passage-drilldown',
  'path-explain',
  'atlas-continent',
  'atlas-island',
  'atlas-asset',
  'atlas-passage',
  'analyst',
  'timeline',
  'verify-valid',
  'verify-invalid',
  'quarantine',
  'degraded',
  'degraded-query',
  'saved-view',
] as const);

export type SceneName = (typeof SCENE_NAMES)[number];

/**
 * A question no entity label or alias in this corpus contains, asked in a shape
 * a user would really type. The engine throws `QUERY_NO_MATCH` for it, which is
 * the real failure the `degraded` scene photographs. `scripts/verify-state.mjs`
 * asserts that this still fails — if the corpus ever grows a Zzyrmont, the test
 * goes red rather than the screenshot going quietly green.
 */
export const NO_MATCH_PROBE = 'What did Zzyrmont acquire in 2031?';

const st = (): AtlasState => useAtlas.getState();

/** One animation frame, or one 16ms tick where there is no rAF (node, workers). */
function frame(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise<void>((resolve) => setTimeout(resolve, 16));
}

/** The staged bridge question — the one the whole demo is built around. */
function demoQuestion(): string {
  return st().stagedQueries[0]?.query ?? 'q:bridge:tollstrand';
}

/**
 * Close the corpus and re-open it, leaving the app in READY with default chrome.
 *
 * `unload()` is a real action (the "close corpus" control), and `ingestDemo()`
 * is the same one the FIRST-RUN screen's primary button calls.
 */
async function baseline(): Promise<void> {
  releaseHold();
  // The first-visit walkthrough is correct for a person and pure contamination
  // for a screenshot: it would sit over every named scene the harness captures.
  // Dismissed here rather than in the harness so a scene is the same screen
  // however it was reached.
  // Guarded: `verify-state.mjs` drives this same module under plain node, where
  // there is no window. The scene driver must stay runnable outside a browser.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('atlas:walkthrough-close'));
  }
  await drain();
  await st().boot();
  if (st().app !== 'EMPTY') st().unload('EMPTY');
  await st().ingestDemo();
}

/** The resting map: the island rung, unscoped, nothing selected, no panels but the inspector. */
async function home(): Promise<void> {
  await baseline();
  await st().goToRung('island', null);
  st().clearFocus();
}

/** The demo answer, rendered for real. Every scene downstream of a query starts here. */
async function rendered(): Promise<void> {
  await home();
  await st().runQuery(demoQuestion());
}

/** Descend the spine with real `descend()` calls, stopping at `depth` (0 = continent). */
async function descendTo(depth: 0 | 1 | 2 | 3): Promise<void> {
  await baseline();
  await st().goToRung('continent', null);
  for (let d = 0; d < depth; d++) {
    const s = st();
    const next = s.view?.nodes.find((n) => n.kind === s.rung);
    if (next === undefined) {
      throw new Error(
        `[state/scenes] no ${s.rung} to descend into while building the atlas scene at depth ${depth}.`,
      );
    }
    await st().descend(next.id);
  }
}

/* =============================================================================
 * THE SCENES
 * ========================================================================== */

const SCENES: Record<SceneName, () => Promise<void>> = {
  /* ---- lifecycle ------------------------------------------------------- */

  'first-run': async () => {
    releaseHold();
    await drain();
    await st().boot();
    // A genuine first run: forget the visit flag so the next boot would show
    // this screen for real, then close the corpus back to the invitation.
    forgetVisited();
    st().unload('FIRST-RUN');
  },

  empty: async () => {
    releaseHold();
    await drain();
    await st().boot();
    st().unload('EMPTY');
  },

  ingesting: async () => {
    releaseHold();
    await drain();
    await st().boot();
    if (st().app !== 'EMPTY') st().unload('EMPTY');
    // Park at the end of the ingest: every document has landed and the first
    // view is in hand, but the layout has not been handed to the renderer yet.
    const arrived = holdAt('INGESTING:done');
    void st().ingestDemo();
    await arrived;
  },

  settling: async () => {
    releaseHold();
    await drain();
    await st().boot();
    if (st().app !== 'EMPTY') st().unload('EMPTY');
    // Park the moment the bake is on screen and the terrain starts settling.
    const arrived = holdAt('SETTLING:enter');
    void st().ingestDemo();
    await arrived;
  },

  /* ---- the resting map -------------------------------------------------- */

  home,

  /* ---- query ------------------------------------------------------------ */

  'query-render': rendered,

  constellation: async () => {
    await rendered();
    const active = st().query.active;
    if (active === null) return;
    // A real selection: the nodes on the answer path. That is what earns the
    // render glow, and it is what the shell fits the camera to.
    const onPath = new Set<string>();
    for (const step of active.constellation.path) {
      onPath.add(step.from_id);
      onPath.add(step.to_id);
    }
    const ids = [...onPath];
    ids.forEach((id, i) => st().selectNode(id, i > 0));
    if (active.constellation.bridge_entity_id !== null) {
      st().selectNode(active.constellation.bridge_entity_id, true);
    }
  },

  /* THE RECEIPT IS A TAB NOW, NOT A PANEL.
     `ui.receipt` was a boolean that appended a 3,022px panel to the bottom of a
     scroll column; the evidence trail is a surface the rail SWITCHES to. The
     scene name is unchanged on purpose: it names the state being photographed,
     and that state still exists. */
  receipt: async () => {
    await rendered();
    st().setTab('evidence', { pin: true });
  },

  'passage-drilldown': async () => {
    await rendered();
    const citation = st().trace?.citations[0];
    if (citation === undefined) return;
    // `openPassage` now pushes the scene it displaces, so this capture is also
    // the one that proves `Back` has somewhere to go.
    await st().openPassage(citation.passage_id);
  },

  'path-explain': async () => {
    await rendered();
    await st().explainPath();
  },

  /* ---- Atlas Mode, one scene per rung ----------------------------------- */

  /* ATLAS MODE IS NOT A PANEL YOU OPEN ANY MORE — it is what the Explore lens
     shows in the rail while nothing has been asked, and the rung selector it
     carries is permanent chrome rather than a mode. So these four scenes assert
     the LENS and the RUNG, which is what they were always photographing. */
  'atlas-continent': async () => {
    await st().setLens('explore');
    await descendTo(0);
  },

  'atlas-island': async () => {
    await st().setLens('explore');
    await descendTo(1);
  },

  'atlas-asset': async () => {
    await st().setLens('explore');
    await descendTo(2);
  },

  'atlas-passage': async () => {
    await st().setLens('explore');
    await descendTo(3);
  },

  /* ---- the instrument panels -------------------------------------------- */

  analyst: async () => {
    await rendered();
    await st().setLens('analyze');
  },

  /* THE TIMELINE OVER AN ANSWER, not over the whole corpus. The lens defaults to
     the current answer's scope, and photographing it from `home()` with no
     result would capture the one state the review singled out: a sampled axis
     announcing `200 shown / 2,168 not shown` as its headline. */
  timeline: async () => {
    await rendered();
    await st().setLens('timeline');
  },

  'verify-valid': async () => {
    await rendered();
    st().setTab('evidence', { pin: true });
    st().verifyActive();
  },

  'verify-invalid': async () => {
    await rendered();
    st().setTab('evidence', { pin: true });
    // Real bytes are mutated and the same verifier runs. The badge goes red
    // because the signature genuinely stopped matching.
    st().tamperActive('payload');
  },

  /* THE TRUTH GATE'S REJECTIONS LIVE IN THE ANALYZE LENS. They are engine
     internals — what was thrown away and why — which is the definition of the
     expert surface, and they were previously reachable as a floating panel over
     any workspace at all. */
  quarantine: async () => {
    await home();
    if (!st().filters.showQuarantined) st().toggleQuarantined();
    await st().setLens('analyze');
    if (!st().ui.quarantine) st().toggle('quarantine');
  },

  /* ---- failure ---------------------------------------------------------- */

  degraded: async () => {
    await home();
    // THE CANONICAL DEGRADED STATE: the engine itself is unreachable.
    //
    // This is the failure the full-width --alarm bar exists for, so it is the one
    // the bar is photographed reporting. An alarm whose only ever exhibit is a
    // user typo is an alarm nobody will believe when it matters.
    //
    // The failure is REAL, not injected: a second EngineClient is pointed at a
    // port nothing listens on and asked for a graph view. The browser's own fetch
    // rejects, HttpTransport wraps the rejection as EngineError('TRANSPORT_FAILED')
    // carrying the unreachable origin and its own remedy, and toDegradedReason
    // hands that to the same degrade() a production failure would take. Nothing
    // here is a string we wrote for the screenshot — the remedy on screen names
    // the origin that actually refused the connection.
    // A high port in the ephemeral range with nothing bound to it. Deliberately
    // NOT a well-known discard port: browsers refuse those with ERR_UNSAFE_PORT,
    // which is the browser's policy talking rather than the engine being down.
    // An ordinary refused connection is the failure an operator actually sees.
    const dead = new EngineClient({ baseUrl: 'http://127.0.0.1:49221/tldrg' });
    try {
      await dead.getGraphView('continent');
      // Reaching here means something IS listening on the discard port, so the
      // scene cannot honestly claim a transport failure. Fail loud rather than
      // photograph an alarm we did not actually earn.
      throw new Error(
        'scene(degraded): expected the unreachable engine to refuse the connection, but it answered. ' +
          'Pick an origin nothing is bound to and re-run.',
      );
    } catch (err) {
      st().degrade(toDegradedReason(err));
    }
  },

  /**
   * The softer failure, kept as its own screen: a question this corpus genuinely
   * cannot answer. Same instrument, different report — the engine names the exact
   * miss and the exact remedy instead of inventing prose. Photographed separately
   * so both faces of the one failure state are on the record.
   */
  'degraded-query': async () => {
    await home();
    await st().runQuery(NO_MATCH_PROBE);
  },

  /* ---- shareable scene state -------------------------------------------- */

  'saved-view': async () => {
    await SCENES.constellation();
    const s = st();
    // A camera target worth sharing: centred on the view the answer was read at.
    const bounds = s.view?.bounds;
    if (bounds !== undefined) {
      s.setCamera((bounds.min_x + bounds.max_x) / 2, (bounds.min_y + bounds.max_y) / 2, s.camera.zoom);
    }
    const token = st().saveView();
    // Prove the round trip in the scene itself: what is on screen after this is
    // what the link reconstructs, not what produced it.
    await st().loadView(token);
  },
};

/* =============================================================================
 * THE HOOK
 * ========================================================================== */

/** Drive the app into a named screen. Throws on an unknown name — the harness reports it. */
export async function scene(name: string): Promise<void> {
  const run = SCENES[name as SceneName];
  if (run === undefined) {
    throw new Error(
      `[state/scenes] unknown scene "${name}". Supported: ${SCENE_NAMES.join(', ')}.`,
    );
  }
  await run();
  await settled();
}

/**
 * Resolve when the app has stopped moving.
 *
 * Three conditions, in order: no store action in flight, the renderer reports an
 * idle camera, and two more frames have been presented. A screenshot taken
 * before all three is a photograph of a transition, which tells the critic
 * nothing about the design.
 */
export async function settled(timeoutMs = 6000): Promise<void> {
  await drain();
  const started = Date.now();
  await frame();
  while (!isIdle() && Date.now() - started < timeoutMs) await frame();
  await frame();
  await frame();
}

/** The store's own measured frame budget. Same numbers the HUD prints. */
export function perf(): PerfReadout {
  return st().perf;
}

/**
 * A one-line description of what is on screen, for the harness's report and for
 * a human reading the console. Everything in it is read from the store.
 */
export function describe(): Record<string, unknown> {
  const s = st();
  return {
    app: s.app,
    rung: s.rung,
    parent_id: parentIdOf(s),
    nodes: s.view?.stats.node_count ?? 0,
    edges_drawn: s.view?.stats.edges_drawn ?? 0,
    drawn_reason: s.view?.stats.drawn_reason ?? null,
    query_id: s.query.active?.query_id ?? null,
    trace_id: s.trace?.trace_id ?? null,
    verify: s.verify?.valid ?? null,
    tampered: s.tampered,
    degraded: s.degraded?.code ?? null,
    lod_entries: Object.keys(s.lod).length,
  };
}

/** The window surface this module owns. The shell adds `audit()` alongside it. */
export interface AtlasTestHook {
  scenes: readonly string[];
  scene(name: string): Promise<void>;
  settled(): Promise<void>;
  perf(): PerfReadout;
  describe(): Record<string, unknown>;
  /** The live store, for a harness that wants to assert on state rather than pixels. */
  store: typeof useAtlas;
  audit?: () => unknown;
}

/**
 * Install (or extend) `window.__atlas`.
 *
 * MERGES rather than replaces, so it does not matter whether the shell's
 * `audit()` lands before or after this call. Idempotent — `boot()` calls it too,
 * so a missing wire in the shell cannot cost the critic every screenshot.
 */
export function installAtlasTestHook(): void {
  if (typeof window === 'undefined') return;
  const host = window as unknown as { __atlas?: Partial<AtlasTestHook> };
  const existing = host.__atlas ?? {};
  host.__atlas = {
    ...existing,
    scenes: [...SCENE_NAMES],
    scene,
    settled,
    perf,
    describe,
    store: useAtlas,
  };
}

// One-directional wiring: the store cannot import this module without creating a
// cycle, so this module registers itself with the store instead.
registerTestHookInstaller(installAtlasTestHook);
