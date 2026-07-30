/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — ENGINE BARREL
 * =============================================================================
 *
 * `import { engine, type GraphViewResponse } from '@/engine';`
 *
 * One import path for everything downstream needs: the contract types, the
 * client, the token bridge, the fixture accessor, and the trust primitives that
 * a receipt panel has to be able to run itself.
 *
 * WHAT IS DELIBERATELY NOT RE-EXPORTED, AND WHY:
 *
 *   - `@/engine/corpus/text` — the prose generator. Nothing outside the corpus
 *     builder should be able to synthesise a sentence that looks like evidence.
 *   - `bakeLayout` / `rebakeAnchored` — position is BAKED, once, in
 *     `@/engine/fixtures`. A component that can reach a layout function is a
 *     component that will eventually call one on a render path, and the map will
 *     start moving when the data did not. `scripts/check-discipline.mjs` enforces
 *     this for `src/ui`, `src/graph`, `src/interaction` and `src/motion`; leaving
 *     them out of the barrel is the same rule, applied earlier and more politely.
 *     Import them directly from `@/engine/layout/bake` if you are writing the
 *     bake layer itself.
 *
 * TWO NAMES ARE ALIASED because two modules legitimately own the same word:
 *   - `World`      -> the corpus's rich world. The layout engine's minimal
 *                     `{ nodes, edges }` structural version is `LayoutWorld`.
 *   - `HASH_PREFIX`-> the corpus's `sha256:` display prefix. The signer's
 *                     (identical) constant is not re-exported; use `payloadHash`.
 * =============================================================================
 */

/* -----------------------------------------------------------------------------
 * 1. THE CONTRACT. Everything else in this file exists to serve these shapes.
 * -------------------------------------------------------------------------- */
export * from '@/engine/types';

/* -----------------------------------------------------------------------------
 * 2. THE CLIENT. The seam that makes the demo liftable.
 * -------------------------------------------------------------------------- */
export {
  engine,
  EngineClient,
  EngineError,
  FixtureTransport,
  HttpTransport,
  toDegradedReason,
  BASE_URL_ENV_KEY,
  DRAWN_REASONS,
  WIRE,
} from '@/engine/api';
export type {
  CacheStats,
  EngineClientOptions,
  EngineRequest,
  GraphViewOptions,
  ParamValue,
  QueryOptions,
  TimelineEvent,
  TimelineOptions,
  TimelineResponse,
  Transport,
  TransportResult,
} from '@/engine/api';

/* -----------------------------------------------------------------------------
 * 3. THE FIXTURES. Build once, read everywhere.
 * -------------------------------------------------------------------------- */
export {
  boundsOfNodes,
  edgesById,
  fixturesReady,
  getFixtureTimings,
  getFixtures,
  nodesById,
  prepareFixtures,
  resetFixtures,
} from '@/engine/fixtures';
export type { Fixtures, FixtureTimings, RegionBundles } from '@/engine/fixtures';

/* -----------------------------------------------------------------------------
 * 4. THE TOKEN BRIDGE. The one place a computed style becomes a number.
 * -------------------------------------------------------------------------- */
export {
  fnv1a32,
  hueForCommunity,
  hueIndexForCommunity,
  invalidateTokens,
  readTokens,
  srgbToLinear,
  HUE_COUNT,
  TOKEN_COLOR_NAMES,
} from '@/styles/tokens';
export type { Rgb01, TokenColorName, Tokens } from '@/styles/tokens';

/* -----------------------------------------------------------------------------
 * 5. TRUST. A receipt panel must be able to verify without asking the engine.
 * -------------------------------------------------------------------------- */
export {
  canonicalize,
  getDemoKeypair,
  payloadHash,
  resolveDidKey,
  signTrace,
  tamper,
  tracePayload,
  verifyTrace,
  DEMO_DID,
  DEMO_KEY_ID,
  VERDICT,
} from '@/engine/trust/sign';
export type { DemoKeypair, TamperKind } from '@/engine/trust/sign';

export { computeIntegrity, truthGatedRate } from '@/engine/trust/integrity';
export type { EdgeSource, IntegrityOptions } from '@/engine/trust/integrity';

export {
  assertDemoReceipt,
  buildDemoRenderStats,
  buildDemoRenderTrace,
  buildRenderTrace,
  citationCost,
  demoConstellationNodeIds,
  deriveRenderStats,
  pointerCost,
  summaryCost,
  CONFIDENCE_WEIGHTS,
  DEMO_ANSWER,
  DEMO_BRIDGE_ENTITY_ID,
  DEMO_CONSTELLATION_EDGE_SET,
  DEMO_COUNTERFACTUAL_INVENTORY,
  DEMO_PATH,
  DEMO_QUERY_ID,
  DEMO_RECEIPT,
  DEMO_TRACE_ID,
} from '@/engine/trust/trace';
export type {
  ConfidenceWeights,
  ConstellationEdge,
  CounterfactualAsset,
  RenderStatsInput,
  RenderTraceInput,
} from '@/engine/trust/trace';

/* -----------------------------------------------------------------------------
 * 6. GEOMETRY READ HELPERS. Query the bake; never recompute it.
 * -------------------------------------------------------------------------- */
export {
  boundsOf,
  buildSpatialIndex,
  gridSnapForLatent,
  meanDriftPercent,
  pickAt,
  positionsById,
  queryRadius,
  queryRect,
  snapToLatentGrid,
} from '@/engine/layout/bake';
export type { LatentGridOpts, RungLayout, SpatialIndex } from '@/engine/layout/bake';
export type { World as LayoutWorld } from '@/engine/layout/bake';

/* -----------------------------------------------------------------------------
 * 7. THE CORPUS. Exposed so a test can rebuild it and a HUD can read its stats.
 * -------------------------------------------------------------------------- */
export {
  buildSynthetic,
  buildWorld,
  contentHash,
  dateLabelFromMs,
  isoFromMs,
  validateWorld,
  verbatimSpan,
  verifyPassageHash,
  BAKE_MS,
  DEFAULT_SEED,
  EPOCH_MS,
  HASH_PREFIX,
} from '@/engine/corpus/world';
export type { StagedQuery, World, WorldStats } from '@/engine/corpus/world';

export {
  gateWouldAdmit,
  inverseOf,
  isSelfInverse,
  labelOf,
  sigmaOf,
  CONFIDENCE_FLOOR,
  FAMILIES_BY_SIGMA,
  QUARANTINE_REASONS,
  SEMANTIC_FAMILIES,
  SEMANTIC_SIGMA_CLASSES,
  STRUCTURAL_FAMILIES,
} from '@/engine/corpus/relations';
export type { QuarantineReason } from '@/engine/corpus/relations';

/** Token counting, imported from the corpus so the budget and the corpus share one unit. */
export { tokenCount } from '@/engine/corpus/text';
