/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — SHELL BARREL
 * =============================================================================
 *
 * `import { Shell } from '@/ui/shell';`
 *
 * The shell is the integrator: it mounts the terrain, the interaction layer, the
 * rung atlas, the provenance panels and the primitives into ONE product, and it
 * owns the two things nobody else can own — the frame, and `window.__atlas`.
 *
 * `<Shell/>` is the entire public surface. Everything else is exported because a
 * harness or a test may want one piece on its own, never because the app assembles
 * itself from the parts.
 * =============================================================================
 */

export { Shell } from './Shell';

/* ---- the fixed frame ------------------------------------------------------ */
export { TopBar, type TopBarProps } from './TopBar';
export { BottomHUD, type BottomHUDProps } from './BottomHUD';
export { InspectorRail, type InspectorRailProps } from './InspectorRail';
export { DegradedBar, type DegradedBarProps } from './DegradedBar';
export { CommandBar, type CommandBarProps } from './CommandBar';
export { ShareControl, type ShareControlProps } from './ShareControl';

/* ---- the panels the shell owns ------------------------------------------- */
export { AnswerPanel, type AnswerPanelProps } from './AnswerPanel';
export { StagedPanel, type StagedPanelProps } from './StagedPanel';
export {
  CorpusPanel,
  StagedQuestions,
  type CorpusPanelProps,
  type StagedQuestionsProps,
} from './CorpusPanel';
export { AnalystRail } from './AnalystMode';
/* `timelineSummary` was re-exported here and consumed by nothing — the axis
   builds its own reading and the rail panel builds its own list. A dead
   affordance is deleted, not documented (INV-3); the two edits had to land in
   one commit or the build is red either way round. */
export { TimelineDock, type TimelineDockProps } from './TimelineDock';
export { HelpOverlay, type HelpOverlayProps } from './HelpOverlay';
export { Walkthrough, startWalkthrough, dismissWalkthrough, type WalkthroughProps } from './Walkthrough';

/* ---- the lifecycle screens ------------------------------------------------ */
export { FirstRun } from './screens/FirstRun';
export { EmptyScreen } from './screens/EmptyScreen';
export { IngestScreen } from './screens/IngestScreen';
export { LatentField, latentSource, type LatentFieldProps, type LatentSource } from './LatentField';

/* ---- the wiring and the QA surface ---------------------------------------- */
export {
  frameStatsOf,
  useEngineTelemetry,
  useKeyboard,
  useSavedViewHash,
  useShellWiring,
  useTerrainInstance,
  type EngineTelemetry,
} from './wiring';
export { installShellHook, type ShellHook } from './hook';
export { auditNow, type AtlasAudit } from './audit';
