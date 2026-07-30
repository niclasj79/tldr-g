/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — MOTION BARREL
 * =============================================================================
 *
 * `import { installMotion, firePingVolley } from '@/motion';`
 *
 * THE FIVE SIGNATURE ANIMATIONS, one clock, one collapse:
 *
 *   1. THE DESCENT        `beginRungMotion`     — a body becoming the ground
 *   2. THE RENDER REVEAL  `installRenderReveal` — one timeline, text and map
 *   3. THE TRACE PING     `firePingVolley`      — provenance watched happening
 *   4. THE RECEIPT        `useReceiptCelebration` — the one celebration, once
 *   5. INGEST SETTLING    `settleIngest`        — snowfall becoming terrain
 *
 * THE FIVE LAWS, and where each is enforced rather than merely observed:
 *
 *   1  RESOLUTION STEPS, NEVER POPS      every tier change goes through the
 *                                        renderer's ramp — `./lod`, `./ingest`
 *   2  THE CAMERA IS ONE OBJECT          a second run supersedes the first and
 *                                        resolves it — `./timeline`
 *   3  MOTION DEPICTS REAL STATE         every run names the engine fact it
 *                                        depicts and is checked against the live
 *                                        store — `./witness`, surfaced through
 *                                        `audit().animationsWithoutState`
 *   4  transform / opacity / filter ONLY one rAF for the whole layer, and one
 *                                        stylesheet that animates nothing else —
 *                                        `./timeline`, `./motion.css`
 *   5  REDUCED MOTION COLLAPSES ALL      one place decides it, and every run
 *                                        inherits it — `./budget`
 * =============================================================================
 */

/* ---- installation --------------------------------------------------------- */
export { installMotion } from './install';
export { installMotionHook, type MotionHook } from './hook';

/* ---- the shared clock ----------------------------------------------------- */
export {
  awaitMotion,
  cancelMotion,
  clearMotionLog,
  isRunning,
  motionActive,
  motionIdle,
  motionLog,
  runMotion,
  type MotionFrame,
  type MotionResult,
  type MotionRun,
  type MotionSpec,
} from './timeline';

/* ---- the budget and the curves -------------------------------------------- */
export {
  collapse,
  invalidateMotionBudget,
  readMotionBudget,
  steps,
  type MotionBudget,
} from './budget';
export { bezier, easeToken, invalidateCurves, spring, springOver, type Curve } from './ease';

/* ---- law 3 ---------------------------------------------------------------- */
export {
  checkWitness,
  clearMotionViolations,
  currentPlace,
  motionViolations,
  placeKey,
  recordViolation,
  type MotionName,
  type Witness,
} from './witness';

/* ---- the resolution map, while something is arriving ---------------------- */
export { motionOwnsLod, restoreStoreLod, tierOf } from './lod';
export { setMotionTerrain, terrainNow, terrainSoon, type MotionTerrain } from './terrain';

/* ---- the five ------------------------------------------------------------- */
export { beginRungMotion, type RungMotion, type RungMotionInput } from './descent';
export { installRenderReveal, isRevealing, startRenderReveal } from './reveal';
export {
  firePingVolley,
  installTraceCleanup,
  pingStaggerMs,
  type PingEdge,
  type PingRun,
} from './ping';
export {
  forgetReceiptCelebrations,
  receiptCelebrated,
  useReceiptCelebration,
  type ReceiptCelebration,
} from './receipt';
export { settleIngest } from './ingest';
