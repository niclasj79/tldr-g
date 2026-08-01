/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE INTENT VIEWS
 * =============================================================================
 *
 * `import { CompareView, type IntentViewProps } from './intents';`
 *
 * Five readings of one answer, one per `QueryIntent`. The Answer tab picks
 * between them; nothing else in the product imports one directly.
 *
 * -----------------------------------------------------------------------------
 * WHY FIVE FILES AND NOT ONE SWITCH
 * -----------------------------------------------------------------------------
 * The review's finding was that "different query intents receive essentially the
 * same answer layout", and the reason they did is that there was one layout with
 * an intent CHIP on it. A chip is not a layout decision; it is a label attached
 * to the absence of one. Five files make the divergence structural: adding a
 * sixth intent to the engine now fails to compile a view rather than silently
 * rendering the bridge one.
 *
 * -----------------------------------------------------------------------------
 * THE STYLESHEET IS IMPORTED HERE, ONCE
 * -----------------------------------------------------------------------------
 * `../intents.css` sits beside `shell.css` and `result.css` rather than inside
 * this directory, matching where every other shell stylesheet lives. It is
 * imported from the barrel so that importing any one view brings its styling with
 * it and no consumer has to remember a second import — the same arrangement the
 * primitives use.
 *
 * -----------------------------------------------------------------------------
 * THE SHARED ATOMS LIVE IN `BridgeView`, NOT HERE
 * -----------------------------------------------------------------------------
 * This file is a `.ts` barrel and components are `.tsx`. The clickable node name,
 * the relation label, the evidence control, the disclosure line and the dispute
 * line are declared in `BridgeView.tsx` — the hop chain is the primitive shape
 * and the other four views are re-arrangements of it — and re-exported from here
 * so the import path is the same for everyone. See that file's header for the
 * argument.
 *
 * -----------------------------------------------------------------------------
 * THE DERIVATIONS ARE EXPORTED, NOT JUST THE COMPONENTS
 * -----------------------------------------------------------------------------
 * `hopEvidence` and `linkChain` are pure and they are exported because the
 * screen-reader twin (`../TerrainOutline.tsx`) has to reach the SAME conclusions
 * about the same answer, and two derivations of one fact eventually disagree.
 * `citationCount` is the one-figure form of `hopEvidence` for that surface.
 * `findFork`, `orderFiber` and `busiestNode` are still module-private to their
 * views and still re-derived over there; they belong here too.
 * =============================================================================
 */

import '../intents.css';

export {
  BridgeView,
  DerivedNote,
  DisputedNote,
  EvidenceChip,
  IntentHead,
  NoEvidence,
  NodeName,
  Relation,
  StraitMark,
  citationCount,
  hopEvidence,
  linkChain,
  type HopEvidence,
  type IntentViewProps,
} from './BridgeView';
/* THE COMPARISON TABLE IS EXPORTED, NOT JUST THE VIEW THAT DRAWS IT.
   The screen-reader twin carried its own copy of `findFork` and of the facet
   table, and the copy still wrote one edge into both `direct` cells and
   hardcoded the verdict `same` — the exact defect this view was refactored to
   remove, surviving on the surface that is read aloud, where no sighted reviewer
   would ever see it. Two derivations of one fact eventually disagree, and the
   one nobody looks at is the one that stays wrong. */
export {
  CompareView,
  compareFacets,
  findFork,
  type FacetRow,
  type Fork,
  type Value,
  type Verdict,
} from './CompareView';
export { LookupView } from './LookupView';
export { SummariseView } from './SummariseView';
export { TimelineView } from './TimelineView';
