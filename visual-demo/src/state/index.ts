/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — STATE BARREL
 * =============================================================================
 *
 * `import { useAtlas, useAtlasStore } from '@/state';`
 *
 * One import path for the store, the selector hook, the lifecycle machine, the
 * resolution map, the shareable scene codec, the density/motion plumbing, the
 * keyboard map and the visual-QA scene hook.
 *
 * THE TWO THINGS EVERY OTHER MODULE NEEDS:
 *
 *   useAtlas          the zustand store itself. `getState()` / `subscribe()`
 *                     for anything outside React — the renderer subscribes to
 *                     `camera` here and interpolates without a re-render.
 *   useAtlasStore     the React hook. ALWAYS use this rather than `useAtlas`
 *                     with an object selector: it compares results shallowly, so
 *                     a hover across 4,406 nodes repaints no panel at all.
 *
 * Importing this module also registers the scene driver with the store, which is
 * why `boot()` can install `window.__atlas` without importing `./scenes` and
 * creating a cycle.
 * =============================================================================
 */

/* -----------------------------------------------------------------------------
 * 1. THE STORE. Everything downstream reads through this.
 * -------------------------------------------------------------------------- */
export {
  useAtlas,
  useAtlasStore,
  parentIdOf,
  registerTestHookInstaller,
  HISTORY_MAX,
  LENSES,
  RESULT_TABS,
  TIMELINE_SCOPES,
} from '@/state/store';
export type {
  AtlasActions,
  AtlasCamera,
  AtlasData,
  AtlasExplain,
  AtlasFilters,
  AtlasQuery,
  AtlasState,
  AtlasUi,
  Lens,
  ResultTab,
  RungStackEntry,
  SceneSnapshot,
  TimelineScope,
  UiPanel,
} from '@/state/store';

/* -----------------------------------------------------------------------------
 * 1b. THE FAILURE TAXONOMY. Four kinds, not seventeen codes — and which remedies
 *     are honest for each.
 * -------------------------------------------------------------------------- */
export {
  failureClassOf,
  invalidatesResult,
  knowsFailureClass,
  remediesFor,
} from '@/state/failure';
export type { FailureClass, RemedyId } from '@/state/failure';

/* -----------------------------------------------------------------------------
 * 2. THE LIFECYCLE MACHINE. Declared transitions; illegal ones throw in dev.
 * -------------------------------------------------------------------------- */
export {
  assertTransition,
  canTransition,
  illegalPairs,
  isTransient,
  recoveryTarget,
  transitionPairs,
  IllegalTransition,
  APP_STATES,
  STRICT_TRANSITIONS,
  TRANSITIONS,
} from '@/state/machine';

/* -----------------------------------------------------------------------------
 * 3. THE RESOLUTION MAP. The terrain never has holes.
 * -------------------------------------------------------------------------- */
export { coarser, deriveLod, isLodState, lodHistogram, lodHoles, sharper } from '@/state/lod';
export type { LodInput } from '@/state/lod';

/* -----------------------------------------------------------------------------
 * 4. SHAREABLE SCENE STATE.
 * -------------------------------------------------------------------------- */
export {
  clearSavedViewHash,
  decodeSavedView,
  encodeSavedView,
  readSavedViewFromHash,
  writeSavedViewToHash,
  SavedViewError,
  SAVED_VIEW_HASH_KEY,
  SAVED_VIEW_VERSION,
} from '@/state/savedView';
export type { SavedView } from '@/state/savedView';

/* -----------------------------------------------------------------------------
 * 5. DENSITY, INPUT MODE, MOTION.
 * -------------------------------------------------------------------------- */
export {
  applyDensity,
  detectDensity,
  forgetVisited,
  hasVisited,
  isDensityMode,
  isTouchMode,
  markVisited,
  prefersReducedMotion,
  readStoredDensity,
  storeDensity,
  subscribeInputMode,
  subscribeReducedMotion,
  DENSITY_STORAGE_KEY,
  VISITED_STORAGE_KEY,
} from '@/state/density';

/* -----------------------------------------------------------------------------
 * 6. THE KEYBOARD MAP, AS DATA. One source for the handler, the help overlay
 *    and every KeyHint chip.
 * -------------------------------------------------------------------------- */
export {
  bindingFor,
  bindingsInGroup,
  isEditableTarget,
  keyHintFor,
  matchBinding,
  KEYMAP,
  KEY_GROUPS,
} from '@/state/keys';
export type { KeyActionId, KeyBinding, KeyEventLike, KeyGroup } from '@/state/keys';

/* -----------------------------------------------------------------------------
 * 7. THE FRAME-BUDGET ACCUMULATOR. The terrain feeds it; it emits at 4Hz.
 * -------------------------------------------------------------------------- */
export { createPerfSampler, PERF_HZ } from '@/state/perf';
export type { FrameSample, PerfReadout, PerfSampler } from '@/state/perf';

/* -----------------------------------------------------------------------------
 * 8. THE HOST BRIDGE. How the shell lends the store the renderer's clock
 *    without the store ever importing the renderer.
 * -------------------------------------------------------------------------- */
export {
  drain,
  heldAt,
  holdAt,
  inflightCount,
  isHeld,
  isIdle,
  readViewpoint,
  registerCameraProbe,
  registerFrameGate,
  registerIdleProbe,
  registerSettleGate,
  releaseHold,
  resetBridge,
  runFrameGate,
  track,
  HOLD_TIMEOUT_MS,
} from '@/state/bridge';
export type { CameraProbe, Checkpoint, FrameGate, IdleProbe, SettleGate, Viewpoint } from '@/state/bridge';

/* -----------------------------------------------------------------------------
 * 9. THE SCENE HOOK. Real actions only; `scripts/shoot.mjs` is its only caller.
 * -------------------------------------------------------------------------- */
export {
  describe,
  installAtlasTestHook,
  perf,
  scene,
  settled,
  NO_MATCH_PROBE,
  SCENE_NAMES,
} from '@/state/scenes';
export type { AtlasTestHook, SceneName } from '@/state/scenes';
