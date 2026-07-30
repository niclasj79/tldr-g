/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — PROVENANCE & TRUST
 * =============================================================================
 *
 *   import { ReceiptPanel, VerificationPanel, QuarantinePanel } from '@/ui/provenance';
 *
 * The section of the product that has to be MORE TRUSTWORTHY THAN A CITATION
 * LIST, and that gets there by doing the checks in front of you rather than
 * reporting that somebody already did them:
 *
 *   - the payload hash is RECOMPUTED in the panel and compared to the claimed one
 *   - a passage's content hash is RECOMPUTED from the source bytes it points at
 *   - the tamper control mutates real bytes, and the panel DIFFS them
 *   - a resolved quote is shown against the verbatim span it came from, marked
 *     word by word
 *   - the truth gate's rejections are counted against the honest denominator
 *
 * -----------------------------------------------------------------------------
 * PANELS AND BODIES
 * -----------------------------------------------------------------------------
 * Three of these bring their own glass and three do not, and the distinction is
 * about composition rather than taste:
 *
 *   PANELS   ReceiptPanel · VerificationPanel · QuarantinePanel
 *            Render a <Panel>. Drop one into a rail and it is finished.
 *
 *   BODIES   CitationList · PassageDrilldown · InspectorBody
 *            Render no chrome. They compose INTO a panel — CitationList sits
 *            inside the receipt, PassageDrilldown inside a citation card or the
 *            Inspector, InspectorBody inside whatever rail owns the Inspector.
 *            A body that brought its own border would nest glass inside glass.
 *
 * -----------------------------------------------------------------------------
 * PROPS OR THE STORE, YOUR CHOICE
 * -----------------------------------------------------------------------------
 * Every component reads `@/state` when a prop is absent and the prop when it is
 * present. `<ReceiptPanel />` in the product is fully wired; `<ReceiptPanel
 * trace={t} stats={s} />` in a harness or a test is fully controlled. Passing
 * `null` explicitly means "there is none", which is different from omitting the
 * prop, which means "ask the store".
 *
 * The stylesheet is imported here, once, so a consumer never has to remember to.
 * =============================================================================
 */

import './provenance.css';

/* ---- panels --------------------------------------------------------------- */
export { ReceiptPanel, type ReceiptPanelProps } from './ReceiptPanel';
export { VerificationPanel, VerifyBadge, type VerificationPanelProps, type VerifyBadgeProps } from './VerificationPanel';
export { QuarantinePanel, type QuarantinePanelProps } from './QuarantinePanel';

/* ---- the map annotation ---------------------------------------------------
 * A repudiated receipt de-trusts its evidence on the TERRAIN as well as in the
 * rail. Both panels render it and one of them wins, so the mark does not depend
 * on which tab is open. A host that wants it without a trust panel can mount it
 * directly; it draws nothing when there is nothing to repudiate.
 * ------------------------------------------------------------------------- */
export { RepudiationLayer, type RepudiationLayerProps } from './RepudiationLayer';

/* ---- bodies --------------------------------------------------------------- */
export { CitationList, type CitationListProps } from './CitationList';
/* `usePassage` and `DiffStream` are exported because the substitution has two
   owners now — the drilldown and the citation card — and both must read the same
   bytes through the same client. A second loader would be a second answer. */
export {
  DiffStream,
  PassageDrilldown,
  usePassage,
  type LoadState,
  type Loaded,
  type PassageDrilldownProps,
} from './PassageDrilldown';
export { InspectorBody, type InspectorBodyProps } from './InspectorBody';

/* ---- shared parts, for a host that needs one on its own ------------------- */
export {
  Code,
  Digest,
  Empty,
  Fact,
  NodeId,
  Note,
  ProvenanceChip,
  ResolutionBadge,
  Why,
  resolutionBadgeTone,
  resolutionTone,
  type CodeProps,
  type DigestProps,
  type EmptyProps,
  type FactProps,
  type NodeIdProps,
  type ResolutionBadgeProps,
} from './bits';

/* ---- the trace-ping seam --------------------------------------------------
 * The renderer is reached through `resolveTracePing()`, which prefers an
 * installed override and falls back to `getTerrain()` from '@/graph' via a
 * DYNAMIC import — so importing a receipt panel never pulls in three.js, and a
 * page with no canvas gets an honest `attached: false` instead of a control that
 * silently does nothing.
 * ------------------------------------------------------------------------- */
export {
  hasMapProbeOverride,
  resolveMapProbe,
  setMapProbe,
  subscribeMapProbe,
  type MapProbe,
  type Projection,
  type ScreenFrame,
  type ScreenPoint,
  type WorldPoint,
} from './mapProbe';

export {
  citationEdges,
  firePings,
  hasTracePingOverride,
  pingStaggerMs,
  resolveTracePing,
  setTracePing,
  type PingEdge,
  type PingResult,
  type TracePingFn,
} from './tracePing';

/* ---- the resolution diff, for anyone who needs the same marks ------------- */
export {
  coalesce,
  diffWords,
  firstDifference,
  focusChanges,
  sliceAround,
  substitutionShare,
  tokenize,
  MAX_TOKENS,
  type DiffOp,
  type DiffRun,
  type MutationSlice,
} from './diff';
