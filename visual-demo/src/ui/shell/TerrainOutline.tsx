/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE TERRAIN OUTLINE
 * =============================================================================
 *
 * The graph's structured twin: a real, focusable, operable list that IS the
 * terrain rather than a description of it.
 *
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG, AND WHAT THE MEASUREMENT WAS
 * -----------------------------------------------------------------------------
 * The terrain shipped `role="application"` on ONE div with `tabIndex={0}` and a
 * STATIC accessible name — the same sentence at every cursor position. Arrow keys
 * genuinely traversed the graph: `nearestInDirection` over baked world positions,
 * then `selectNode` and `hoverNode`. But the cursor it moved existed only in
 * world coordinates. There was NO DOM ELEMENT PER NODE anywhere in the tree, so
 * DOM focus never left that single div, `aria-activedescendant` appeared nowhere
 * in the application, and a screen reader was told nothing at all — not the node,
 * not the level, not the hop. The keyboard worked and the announcement did not,
 * which is the specific failure mode the review named: keyboard access to a
 * canvas is not an equivalent, it is a canvas you can move a silent cursor
 * around in.
 *
 * -----------------------------------------------------------------------------
 * IT IS HIDDEN, AND THAT IS AN ARGUMENT, NOT A SHORTCUT
 * -----------------------------------------------------------------------------
 * This renders visually hidden (`.u-sr`) rather than as a second visible panel.
 * A visible list of the graph would be a SECOND INFORMATION ARCHITECTURE over the
 * same data: laid out, ranked, scrolled, and revised every time the map is. The
 * day the two disagree — and they would — the product has two surfaces
 * contradicting each other about the same graph, which is the failure the
 * independent re-derivation exists to catch, reintroduced by the accessibility
 * feature. Hidden, it is ONE derivation of ONE store and it cannot drift.
 *
 * What IS visible is the skip link and the CARET PLATE, because a focused control
 * a sighted keyboard user cannot see is a trap — see the third banner below.
 *
 * -----------------------------------------------------------------------------
 * SYNCHRONISED MEANS THERE IS ONE CURSOR, NOT TWO
 * -----------------------------------------------------------------------------
 * The active descendant is `store.focus`. Not a local index that tries to keep
 * step with it — the store field itself. So arrowing in this list calls the same
 * `selectNode` the canvas calls, clicking the canvas moves this list's cursor,
 * and there is no third state that can be wrong. Every action here is a store
 * action; this component owns no graph state at all.
 *
 * -----------------------------------------------------------------------------
 * THE ORDER DOES NOT KNOW WHERE THE READER IS STANDING
 * -----------------------------------------------------------------------------
 * THE OLD MODEL, AND THE TWO MEASUREMENTS THAT KILLED IT. Rows were grouped
 * `Centred on` / `One relation away` / `Also held` / `Everything else`, pivoted
 * on a node that was only supposed to move when the cursor arrived from outside
 * the list. Both halves were broken:
 *
 *   THE HOISTING. `Also held` is the store's `selection`, and `selectNode(id,
 *   false)` REPLACES the selection with the node the arrow key just landed on.
 *   So every press moved one row into the group above `Everything else` and
 *   pushed the row it came from into the slot directly under the cursor.
 *   Measured at the passage rung: ArrowDown ten times from `e:tollstrand-battery`
 *   gave tollstrand -> bruntorp -> rimsdal -> lysnas -> odsmal -> lysnas ->
 *   odsmal -> … forever.
 *
 *   THE PIVOT NEVER ENGAGED FOR A KEYBOARD-ONLY USER. It started `null`, and the
 *   only code that set it was an effect that every in-list move disarmed one
 *   press in advance. Measured on a freshly loaded page, arrowing straight into
 *   the list: null -> mergers-divestments -> nuclear-lto -> mergers-divestments
 *   -> … Two presses of Down returned to where you started, forever. And the
 *   disarming flag was cleared only by a `focus` CHANGE, so a no-op move
 *   (ArrowUp at row 0, End at the last row) left it armed and swallowed the next
 *   genuinely external focus change — after which the list reported the
 *   neighbourhood of a node that was not under the cursor at all.
 *
 * THE MODEL NOW: **row order is a pure function of the view and the answer path.**
 * `focus` is not an input to it. The answer's own nodes come first, in the order
 * the render walked them; everything else follows by the engine's centrality,
 * tie-broken by id so it is total. There is no pivot, no local cursor state and
 * no flag — a list you can walk in a straight line and count is the whole
 * difference between a list and a nearest-neighbour query, and it is cheaper to
 * guarantee structurally than to defend with a ref.
 *
 * The two facts the old groups carried are not lost, they are said where they are
 * true: what is HELD is `aria-selected` on the row, and what is ONE RELATION from
 * the cursor is a clause on the row it is true of. Both change as the cursor
 * moves. Neither moves a row.
 *
 * -----------------------------------------------------------------------------
 * THE ANSWER IS READ AS THE KIND OF ANSWER IT IS
 * -----------------------------------------------------------------------------
 * MEASURED: this section used to be a flat `<ol>` of hops — `Hop 1: A via family
 * (class) B` — for all five intents. A sighted reader gets five different
 * readings from `src/ui/shell/intents/*`: a three-verdict comparison table with
 * the Unknown count docked in its header, a chronology ordered by the structural
 * fiber with the gap in days and the entity sets differenced, a σ-class grouping
 * with the omission count, a linked route that refuses to link when the hops are
 * a fork. A screen reader got the hop list. The structured conclusion IS the
 * intent view; a twin that renders only its input is not a twin.
 *
 * So the conclusions are derived here and stated as text, in the visible views'
 * own words (`COPY.intentViews.*`) so the two cannot say different things about
 * the same answer.
 *
 * IT IS NOT A SECOND DERIVATION ANY MORE, AND THE ONE TIME IT WAS, IT WAS WRONG.
 * `findFork` and the compare facet table were module-private to `CompareView`
 * and re-derived here, and the copy was the OLD one: it wrote a single edge into
 * both `direct` cells and hardcoded the verdict `same`, which the visual view had
 * already been refactored to stop doing. So for one round the spoken surface
 * asserted a comparison the seen surface had retracted — on the surface no
 * sighted reviewer reads, which is exactly where a duplicate goes to stay wrong.
 *
 * `findFork`, `compareFacets`, `linkChain` and `citationCount` are all imported
 * now. `orderFiber` and `busiestNode` are the two that remain module-private to
 * their views; they are the next to be lifted, and until they are, a change to
 * `TimelineView` or `SummariseView` has to be made here too.
 *
 * -----------------------------------------------------------------------------
 * THE CROP IS STATED, BECAUSE A SILENT CROP IS THE FAILURE
 * -----------------------------------------------------------------------------
 * The passage level of this corpus carries 2,207 nodes. Two thousand options is
 * not a list — at a screen reader's default rate it is over an hour of reading —
 * so the list is capped at `LIST_MAX`. The cap is reported IN THE ACCESSIBLE NAME
 * of the listbox, between the two figures it sits on top of, and both figures
 * render through `<Num>` like every other measured quantity in the product. What
 * the user is HOLDING is never cropped: cropping the user's own selection to make
 * room for the engine's ranking is the one omission that cannot be defended. A
 * held node past the cap is listed at its OWN rank position, at the tail, so the
 * exemption adds rows and never reorders them.
 * ========================================================================== */

import { useEffect, useMemo, useState } from 'react';

import { COPY, intentCopy, resolutionCopy, sigmaCopy } from '@/copy';
import { SIGMA_CLASSES, byFamily, engine } from '@/engine';
import type {
  Asset,
  Citation,
  GraphNode,
  GraphViewResponse,
  PathStep,
  QueryRenderResponse,
  RenderTraceV1,
  SigmaClass,
} from '@/engine';
import { useAtlas, useAtlasStore } from '@/state';
import { Num } from '@/ui/primitives';

import { canDescend } from '@/interaction/useTerrain';

import { citationCount, linkChain } from './intents/BridgeView';
/* THE COMPARISON TABLE COMES FROM THE VIEW THAT DRAWS IT.
   This file used to carry its own `findFork` and its own facet table, and the
   copy was the OLD one: it wrote a single edge into both `direct` cells and
   hardcoded the verdict `same`, which the visual view had already been
   refactored to stop doing. A twin that derives its own conclusions is not a
   twin — it is a second implementation with no reviewer, on the surface a
   sighted reviewer never reads. One table, both surfaces. */
import { compareFacets, findFork } from './intents/CompareView';
import type { FacetRow, Value } from './intents/CompareView';

import './a11y.css';

/**
 * How many nodes the list offers at once.
 *
 * Not a performance number — 2,207 hidden spans cost the renderer nothing. It is
 * a LISTENING number. A screen reader reads an option in roughly a second, so a
 * complete passage level would be about forty minutes of list before the first
 * useful move, and a list nobody can reach the end of is a list with no end.
 * Everything the user is holding is exempt (see `buildRows`), so the cap can only
 * ever crop the engine's own ranking, never the user's decisions.
 */
const LIST_MAX = 200;

/** A stable empty path, so the node resolver's effect does not re-fire every render. */
const NO_PATH: readonly PathStep[] = Object.freeze([]);

/** The groups, in the order the list renders them. Both are facts about the GRAPH. */
type GroupId = 'answer' | 'level';

interface OutlineRow {
  node: GraphNode;
  group: GroupId;
  /** 1-based position on the answer path, or `null` off it. Stable. */
  hop: number | null;
}

/** What joins a node to the CURSOR. An annotation on a row, never an ordering key. */
interface Reach {
  /** The relation family joining this node to the cursor. */
  via: string;
  /** The σ-class of that relation, so the twin says what KIND of claim joins them. */
  sigma: SigmaClass;
  /**
   * True when every relation joining this node to the cursor was rejected by the
   * truth gate. It is still listed — rejected claims ship in the payload and
   * render latent, and hiding them here would make the terrain look better to a
   * screen reader than it looks to an eye.
   */
  rejectedOnly: boolean;
}

/* =============================================================================
 * IDS
 * -----------------------------------------------------------------------------
 * `aria-activedescendant` is matched by id string, and node ids in this corpus
 * carry `:` and `.` (`p:syn:0000042.3`, `e:tollstrand-battery`). Both are legal
 * in an HTML id and neither survives a naive `-` substitution injectively —
 * `a:b-c` and `a-b:c` would collide, and two options sharing an id is a cursor
 * that lands on whichever one the browser found first. So the encoding is
 * reversible: every character outside `[A-Za-z0-9-]` becomes `_<hex>_`, and `_`
 * is itself outside that set, so nothing can alias onto anything else.
 * ========================================================================== */

function encodeNodeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9-]/g, (c) => `_${(c.codePointAt(0) ?? 0).toString(16)}_`);
}

/**
 * The DOM id of a node's option row.
 *
 * Exported because the INPUT SURFACE points `aria-activedescendant` at it. The
 * two must agree exactly and there is one function, so they cannot fail to.
 */
export function terrainOptionId(nodeId: string): string {
  return `tro-o-${encodeNodeId(nodeId)}`;
}

/* =============================================================================
 * THE ORDER — a pure function of the view and the answer path
 * ========================================================================== */

/**
 * The answer's nodes, each once, in the order the render walked them.
 *
 * `linkChain` first, because a real route has a traversal order and printing it
 * in assembly order would hide the route. Where the hops are a fork, a collider
 * or a star it returns `null` and the render's own assembly order is the honest
 * one. BOTH are stable: neither reads the cursor, the selection or anything else
 * a reader can move.
 */
function answerOrder(path: readonly PathStep[]): string[] {
  const chain = linkChain(path);
  if (chain !== null) return chain.ids;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const step of path) {
    for (const id of [step.from_id, step.to_id]) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * The rows, in the ONE order this list has.
 *
 *   1. the answer's own nodes   in the order the render walked them
 *   2. the rest of the level    by the engine's centrality, id-tiebroken
 *
 * `focus` is deliberately not a parameter. See the banner for the ten measured
 * ArrowDown presses that made it one no longer.
 *
 * `selection` appears only as the cap EXEMPTION: a held node past `LIST_MAX` is
 * listed at its own rank rather than dropped. It cannot reorder anything, because
 * the sort key it is filtered against does not mention it.
 *
 * A node appears EXACTLY ONCE. Listing it twice would give it two option ids, and
 * `aria-activedescendant` can only point at one of them.
 */
function buildRows(
  view: GraphViewResponse | null,
  path: readonly PathStep[],
  selection: readonly string[],
): OutlineRow[] {
  if (view === null) return [];

  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const rows: OutlineRow[] = [];
  const taken = new Set<string>();

  for (const id of answerOrder(path)) {
    const node = byId.get(id);
    if (node === undefined || taken.has(id)) continue;
    taken.add(id);
    rows.push({ node, group: 'answer', hop: rows.length + 1 });
  }

  /* THE TIE-BREAK IS NOT DECORATION. Centrality ties are common at the passage
     rung, and a sort that leaves ties to the engine's array order would reorder
     the list on any re-fetch that returned the same nodes in a different order —
     the same defect as ranking on the cursor, arriving from the network instead. */
  const rest = view.nodes
    .filter((n) => !taken.has(n.id))
    .sort((a, b) => b.centrality - a.centrality || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const held = new Set(selection);
  for (const node of rest) {
    if (rows.length >= LIST_MAX && !held.has(node.id)) continue;
    rows.push({ node, group: 'level', hop: null });
  }

  return rows;
}

/**
 * What the CURSOR can reach in one relation, from the view's own edges.
 *
 * Not from a fetch: this list must be able to report what is on screen at the
 * instant it is read, and an async neighbourhood would make the twin lag the
 * picture by a round trip. A twin that lags is a twin that is sometimes wrong.
 */
function reachFrom(view: GraphViewResponse | null, cursor: string | null): Map<string, Reach> {
  const out = new Map<string, Reach>();
  if (view === null || cursor === null) return out;
  for (const edge of view.edges) {
    const other: string | null =
      edge.from_id === cursor ? edge.to_id : edge.to_id === cursor ? edge.from_id : null;
    if (other === null || other === cursor) continue;
    const prev = out.get(other);
    // An admitted relation always wins the label over a rejected one: the pair is
    // only "reached through a rejected claim" if EVERY relation joining them was
    // rejected.
    if (prev === undefined || (prev.rejectedOnly && !edge.quarantined)) {
      out.set(other, {
        via: byFamily[edge.family].label,
        sigma: edge.sigma,
        rejectedOnly: edge.quarantined,
      });
    }
  }
  return out;
}


/** The structural families that carry a session order. Mirrors `TimelineView`. */
const FIBER: ReadonlySet<string> = new Set(['_session_follows', '_session_precedes']);

/** The chain of session ids, earliest first, or `null` when the fiber is not one order. */
function orderFiber(path: readonly PathStep[]): { ids: string[]; family: string } | null {
  const links = path.filter((s) => FIBER.has(s.family));
  if (links.length === 0) return null;

  const pairs = links.map((s) =>
    s.family === '_session_follows'
      ? ([s.from_id, s.to_id] as const)
      : ([s.to_id, s.from_id] as const),
  );

  const laterOf = new Map<string, string>();
  const isLater = new Set<string>();
  for (const [later, earlier] of pairs) {
    if (laterOf.has(earlier)) return null; // two successors: not one order
    laterOf.set(earlier, later);
    isLater.add(later);
  }

  const heads = [...new Set(pairs.map(([, earlier]) => earlier))].filter((id) => !isLater.has(id));
  if (heads.length !== 1) return null;

  const ids: string[] = [heads[0]];
  const seen = new Set(ids);
  for (;;) {
    const next = laterOf.get(ids[ids.length - 1]);
    if (next === undefined) break;
    if (seen.has(next)) return null; // a loop is not a chronology
    ids.push(next);
    seen.add(next);
  }
  return ids.length === pairs.length + 1 ? { ids, family: links[0].family } : null;
}

function assetOf(node: GraphNode | undefined): Asset | null {
  return node !== undefined && node.kind === 'asset' ? node : null;
}

/** Whole days between two declared boundaries. Arithmetic on two engine timestamps. */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The node this render's claims attach to most often. A COUNT, not a judgement. */
function busiestNode(path: readonly PathStep[]): { id: string; count: number } | null {
  const tally = new Map<string, number>();
  for (const step of path) {
    tally.set(step.from_id, (tally.get(step.from_id) ?? 0) + 1);
    tally.set(step.to_id, (tally.get(step.to_id) ?? 0) + 1);
  }
  let best: { id: string; count: number } | null = null;
  for (const [id, count] of tally) {
    if (best === null || count > best.count) best = { id, count };
  }
  return best !== null && best.count >= 2 ? best : null;
}

/** The first citation the render admitted for this hop. Matched by passage id, never by position. */
function firstCitation(trace: RenderTraceV1 | null, step: PathStep): Citation | null {
  if (trace === null) return null;
  const wanted = new Set(step.evidence_passage_ids);
  return trace.citations.find((c) => wanted.has(c.passage_id)) ?? null;
}

/* =============================================================================
 * THE ONE DOM REACH IN THE TWIN
 * -----------------------------------------------------------------------------
 * The skip link needs somewhere to land, and the command bar carries no id — so
 * there is nothing to point an `href` at and this has to find it. It is the only
 * place in this file that reads the document instead of the store, and it is
 * written to be replaced: the day the command input has an `id`, this becomes an
 * anchor and the whole function goes.
 *
 * Until then the candidates are ordered from most specific to most durable, and
 * they deliberately do not share a failure: the class comes from the shell's
 * stylesheet, the accessible name comes from the copy deck. A rename in one does
 * not take the other with it.
 *
 * IT FAILS LOUD. A skip link that quietly does nothing is worse than no skip
 * link, because it is the one keyboard route out of a full-bleed
 * `role="application"` region and a user who presses it and stays put has no way
 * to know whether they moved.
 * ========================================================================== */

/**
 * The id of the rail's pinned header — the skip link's destination.
 *
 * Declared HERE, beside the only thing that jumps to it, and consumed by
 * `InspectorRail`. A destination named in one file and rendered in another with
 * no shared constant is the defect this fixes: it was a class selector on the
 * composer, and the composer unmounts.
 */
export const TASK_ANCHOR_ID = 'rail-task';

function focusCommandBar(): void {
  /* THE COMPOSER IS NOT ALWAYS MOUNTED, AND THAT IS BY DESIGN.
     Every candidate below is part of the composer, and the composer is replaced
     by the asked question the moment a result lands — so from the state a reader
     is in for most of a session, the one keyboard route out of a full-bleed
     `role="application"` region pointed at nothing and logged an error. The
     destination is the RAIL'S PINNED HEADER, which exists in every state that
     has a corpus and holds the composer, the question, the reverse actions and
     the tab strip. `TASK_ANCHOR_ID` is declared here and consumed by
     `InspectorRail`, so the two cannot be renamed apart. */
  const candidates = [
    `#${TASK_ANCHOR_ID}`,
    '.cmd__input',
    `form[aria-label="${COPY.a11y.commandBar}"] input`,
    '.cmd input',
  ];
  for (const selector of candidates) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el !== null) {
      el.focus();
      return;
    }
  }
  // eslint-disable-next-line no-console
  console.error(
    '[ui/shell/TerrainOutline] the skip link found no command bar. It tried ' +
      candidates.map((c) => `\`${c}\``).join(', ') +
      '. Either the command bar is not mounted in this state — in which case this control should ' +
      'not have been reachable — or it was renamed and the destination has to be renamed with it. ' +
      'Giving the command input a stable `id` would end this whole class of failure.',
  );
}

/** Consecutive rows of one group, so the list can carry real `role="group"` sections. */
function sections(rows: readonly OutlineRow[]): { id: GroupId; rows: OutlineRow[] }[] {
  const out: { id: GroupId; rows: OutlineRow[] }[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last !== undefined && last.id === row.group) last.rows.push(row);
    else out.push({ id: row.group, rows: [row] });
  }
  return out;
}

/* =============================================================================
 * THE NODES THE ANSWER IS MADE OF
 * -----------------------------------------------------------------------------
 * The same resolution `AnswerPanel.useAnswerNodes` performs, against the same
 * cached client: the view's own nodes where it has them, one `GET /node/{id}`
 * for the rest. It is not a duplicate REQUEST — `EngineClient.send` is
 * content-cached per bake, so a node the panel already resolved is served from
 * memory here.
 *
 * IT IS NOT OPTIONAL. A comparison table reads `entity_type`, `island_ids`,
 * `degree` and `mentions` off the payload and a chronology reads
 * `boundary_declared_at` and `entity_ids`. Deriving those from the current view
 * alone would make every subject the level does not carry read `Unknown` here and
 * a real value on the panel — two surfaces disagreeing about one answer, which is
 * the failure the whole twin is arranged to avoid.
 * ========================================================================== */

function useAnswerNodes(
  active: QueryRenderResponse | null,
  viewNodes: readonly GraphNode[] | null,
): ReadonlyMap<string, GraphNode> {
  const [nodes, setNodes] = useState<ReadonlyMap<string, GraphNode>>(() => new Map());
  const path = active?.constellation.path ?? NO_PATH;
  const bridgeId = active?.constellation.bridge_entity_id ?? null;

  useEffect(() => {
    const ids = new Set<string>();
    for (const step of path) {
      ids.add(step.from_id);
      ids.add(step.to_id);
    }
    if (bridgeId !== null) ids.add(bridgeId);

    const known = new Map<string, GraphNode>();
    for (const node of viewNodes ?? []) if (ids.has(node.id)) known.set(node.id, node);

    const missing = [...ids].filter((id) => !known.has(id));
    if (missing.length === 0) {
      setNodes(known);
      return;
    }

    let live = true;
    void Promise.all(missing.map((id) => engine.getNode(id).catch(() => null))).then((fetched) => {
      if (!live) return;
      const next = new Map(known);
      for (const node of fetched) if (node !== null) next.set(node.id, node);
      setNodes(next);
    });
    return () => {
      live = false;
    };
  }, [path, bridgeId, viewNodes]);

  return nodes;
}

/* =============================================================================
 * THE ANSWER, WRITTEN OUT
 * -----------------------------------------------------------------------------
 * `data-engine-label` marks every element whose text is an ENGINE STRING — a node
 * name, a boundary kind, a field value — rather than a measurement. Without it
 * `Q1 2024 settlement month` arrives at the audit's mono rule as an unmonospaced
 * figure, and `scripts/verify-shell.mjs` fails on a name.
 * ========================================================================== */

/** A node's name, from the answer's own resolved payloads, falling back to the engine's id. */
function Name({
  id,
  nodes,
}: {
  id: string;
  nodes: ReadonlyMap<string, GraphNode>;
}): JSX.Element {
  return <span data-engine-label>{nodes.get(id)?.label ?? id}</span>;
}

/** One hop, stated as one claim. The fallback shape every view drops to when it refuses. */
function Claim({
  step,
  nodes,
  trace,
}: {
  step: PathStep;
  nodes: ReadonlyMap<string, GraphNode>;
  trace: RenderTraceV1 | null;
}): JSX.Element {
  return (
    <>
      <Name id={step.from_id} nodes={nodes} /> {COPY.answer.path.via}{' '}
      <span data-engine-label>{byFamily[step.family].label}</span> ({sigmaCopy(step.sigma).label}){' '}
      <Name id={step.to_id} nodes={nodes} />
      {step.crosses_strait ? <> — {COPY.intentViews.bridge.strait}</> : null}
      {step.evidence_passage_ids.length === 0 ? (
        <> — {COPY.intentViews.noEvidence}</>
      ) : (
        <>
          {' '}
          — {COPY.intentViews.evidence.label}:{' '}
          <Num value={citationCount(trace, step)} format="int" />
        </>
      )}
    </>
  );
}

function Claims({
  path,
  nodes,
  trace,
}: {
  path: readonly PathStep[];
  nodes: ReadonlyMap<string, GraphNode>;
  trace: RenderTraceV1 | null;
}): JSX.Element {
  return (
    <ol>
      {path.map((step) => (
        <li key={step.edge_id}>
          <Claim step={step} nodes={nodes} trace={trace} />
        </li>
      ))}
    </ol>
  );
}

/** A comparison cell. A figure goes through `<Num>`; a string is an engine label. */
function CellText({ value }: { value: Value }): JSX.Element {
  if (value === null) return <>{COPY.intentViews.compare.absent}</>;
  if (typeof value === 'number') return <Num value={value} format="int" />;
  return <span data-engine-label>{value}</span>;
}

interface ReadingProps {
  active: QueryRenderResponse;
  nodes: ReadonlyMap<string, GraphNode>;
  trace: RenderTraceV1 | null;
}

/**
 * The answer, read as the kind of answer it is.
 *
 * AN EXHAUSTIVE SWITCH, like `AnswerPanel.IntentView`, and for the same reason: a
 * sixth intent added to the engine's union must fail to compile here rather than
 * quietly giving a screen reader the bridge reading of a question that is not one.
 */
function IntentReading(props: ReadingProps): JSX.Element {
  switch (props.active.intent) {
    case 'lookup':
      return <LookupReading {...props} />;
    case 'bridge':
      return <BridgeReading {...props} />;
    case 'compare':
      return <CompareReading {...props} />;
    case 'timeline':
      return <TimelineReading {...props} />;
    case 'summarize':
      return <SummariseReading {...props} />;
  }
}

function LookupReading({ active, nodes, trace }: ReadingProps): JSX.Element {
  const path = active.constellation.path;
  return (
    <>
      {path.length > 1 ? <p>{COPY.intentViews.lookup.several}</p> : null}
      <ol>
        {path.map((step) => {
          const citation = firstCitation(trace, step);
          return (
            <li key={step.edge_id}>
              <Claim step={step} nodes={nodes} trace={trace} />
              {citation === null ? null : (
                <>
                  <p>{COPY.intentViews.lookup.quote.label}</p>
                  <blockquote>{citation.quote}</blockquote>
                  {citation.resolution === 'verbatim' ? null : (
                    <p>{resolutionCopy(citation.resolution).label}</p>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

function BridgeReading({ active, nodes, trace }: ReadingProps): JSX.Element {
  const path = active.constellation.path;
  const bridgeId = active.constellation.bridge_entity_id;
  const chain = linkChain(path);
  return (
    <>
      {chain === null ? (
        <>
          <p>{COPY.intentViews.bridge.unordered}</p>
          <Claims path={path} nodes={nodes} trace={trace} />
        </>
      ) : (
        <ol>
          {chain.ids.map((id, i) => {
            const step = i < chain.steps.length ? chain.steps[i] : null;
            return (
              <li key={id}>
                <Name id={id} nodes={nodes} />
                {id === bridgeId ? <> — {COPY.intentViews.bridge.mark}</> : null}
                {step === null ? null : (
                  <>
                    {' '}
                    — {COPY.answer.path.via}{' '}
                    <span data-engine-label>{byFamily[step.family].label}</span> (
                    {sigmaCopy(step.sigma).label})
                    {step.crosses_strait ? <> — {COPY.intentViews.bridge.strait}</> : null}
                    {step.evidence_passage_ids.length === 0 ? (
                      <> — {COPY.intentViews.noEvidence}</>
                    ) : (
                      <>
                        {' '}
                        — {COPY.intentViews.evidence.label}:{' '}
                        <Num value={citationCount(trace, step)} format="int" />
                      </>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {bridgeId === null ? null : (
        <p>
          {COPY.answer.bridge.label}: <Name id={bridgeId} nodes={nodes} />
        </p>
      )}
    </>
  );
}

function CompareReading({ active, nodes, trace }: ReadingProps): JSX.Element {
  const path = active.constellation.path;
  const fork = findFork(path);
  if (fork === null) {
    return (
      <>
        <p>{COPY.intentViews.compare.noFork}</p>
        <Claims path={path} nodes={nodes} trace={trace} />
      </>
    );
  }

  const a = nodes.get(fork.left.id);
  const b = nodes.get(fork.right.id);
  const rows: FacetRow[] = compareFacets(fork, path, trace, a, b);
  const unknowns = rows.filter((r) => r.verdict === 'unknown').length;
  const verdicts = COPY.intentViews.compare.verdicts;

  return (
    <>
      <p>
        {COPY.intentViews.compare.subjects.label}: <Name id={fork.left.id} nodes={nodes} />,{' '}
        <Name id={fork.right.id} nodes={nodes} />
      </p>
      <p>
        {COPY.intentViews.compare.facets.shared.label}: <Name id={fork.sharedId} nodes={nodes} />
      </p>
      {/* THE UNKNOWN COUNT, WHERE THE PANEL DOCKS IT: at the head of the table,
          not buried in the rows. How much of this table the render could not fill
          is the first thing a sceptic wants and the last thing a comparison
          usually admits. */}
      <p>
        <Num value={unknowns} format="int" /> {verdicts.unknown.label}
      </p>
      <ul>
        {rows.map((row) => (
          <li key={row.key}>
            {row.copy.label} — {verdicts[row.verdict].label}
            <ul>
              <li>
                <Name id={fork.left.id} nodes={nodes} />: <CellText value={row.a} />
              </li>
              <li>
                <Name id={fork.right.id} nodes={nodes} />: <CellText value={row.b} />
              </li>
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
}

function TimelineReading({ active, nodes, trace }: ReadingProps): JSX.Element {
  const path = active.constellation.path;
  const order = orderFiber(path);
  if (order === null) {
    return (
      <>
        <p>{COPY.intentViews.timeline.noFiber}</p>
        <Claims path={path} nodes={nodes} trace={trace} />
      </>
    );
  }

  const copy = COPY.intentViews.timeline;
  /* `seenBefore` is every entity any EARLIER session named, which is what makes
     "first named here" mean first rather than "not in the one immediately
     before". Accumulated as the fiber is walked, exactly as the card list does. */
  const seenBefore = new Set<string>();

  return (
    <>
      <p>
        {copy.order.label}: <span className="mono">{order.family}</span>
      </p>
      <ol>
        {order.ids.map((id, i) => {
          const asset = assetOf(nodes.get(id));
          const previous = i === 0 ? null : assetOf(nodes.get(order.ids[i - 1]));
          const fresh =
            asset === null ? null : asset.entity_ids.filter((e) => !seenBefore.has(e)).length;
          const dropped =
            asset === null || previous === null
              ? null
              : previous.entity_ids.filter((e) => !asset.entity_ids.includes(e)).length;
          const gap =
            asset === null || previous === null
              ? null
              : daysBetween(previous.boundary_declared_at, asset.boundary_declared_at);
          if (asset !== null) for (const e of asset.entity_ids) seenBefore.add(e);

          return (
            <li key={id}>
              <Name id={id} nodes={nodes} />
              {asset === null ? (
                <> — {copy.undated}</>
              ) : (
                <>
                  {' '}
                  — {copy.when.label}: <span className="mono">{asset.boundary_declared_at.slice(0, 10)}</span> —{' '}
                  <span data-engine-label>{asset.boundary_kind}</span>
                </>
              )}
              {asset === null ? null : <p data-prose>{asset.summary}</p>}
              <p>
                {copy.changed.label}:
                {i === 0 ? (
                  <> {copy.first}</>
                ) : (
                  <>
                    {gap === null ? null : (
                      <>
                        {' '}
                        {copy.gap.label} <Num value={gap} format="int" unit={copy.gap.unit} />.
                      </>
                    )}
                    {fresh === null ? null : fresh === 0 ? (
                      <> {copy.nothingNew}</>
                    ) : (
                      <>
                        {' '}
                        {copy.fresh.label} <Num value={fresh} format="int" />.
                      </>
                    )}
                    {dropped === null || dropped === 0 ? null : (
                      <>
                        {' '}
                        {copy.dropped.label} <Num value={dropped} format="int" />.
                      </>
                    )}
                  </>
                )}
              </p>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function SummariseReading({ active, nodes, trace }: ReadingProps): JSX.Element {
  const path = active.constellation.path;
  const busiest = busiestNode(path);
  const omitted = trace === null ? null : trace.omitted_but_connected.length;
  const copy = COPY.intentViews.summarize;

  /* GROUPED IN THE VOCABULARY'S OWN ORDER, not by group size — the same ladder
     the visible view reads down, so a render whose shape changes between two
     questions still reads in the same sequence on both surfaces. */
  const groups = SIGMA_CLASSES.map((sigma: SigmaClass) => ({
    sigma,
    steps: path.filter((s) => s.sigma === sigma),
  })).filter((g) => g.steps.length > 0);

  return (
    <>
      {busiest === null ? null : (
        <p>
          {copy.subject.label}: <Name id={busiest.id} nodes={nodes} />{' '}
          <Num value={busiest.count} format="int" />
        </p>
      )}
      {omitted === null ? null : (
        <p>
          {copy.omitted.label}: <Num value={omitted} format="int" />
        </p>
      )}
      {groups.length === 0 ? (
        <p>{copy.empty}</p>
      ) : (
        <>
          <p>
            {copy.themes.label}: {COPY.sigma.title}
          </p>
          <ul>
            {groups.map((group) => (
              <li key={group.sigma}>
                {sigmaCopy(group.sigma).label} — <Num value={group.steps.length} format="int" />{' '}
                {/* A GROUP OF ONE IS NOT `1 claims`. This is read ALOUD, where a
                    plural over a singular is not a typo you skim past — it is a
                    word the reader hears. */}
                {group.steps.length === 1 ? copy.claim : copy.claims}
                <p data-prose>{sigmaCopy(group.sigma).short}</p>
                <Claims path={group.steps} nodes={nodes} trace={trace} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/* =============================================================================
 * THE COMPONENT
 * ========================================================================== */

export interface TerrainOutlineProps {
  className?: string;
}

export function TerrainOutline({ className }: TerrainOutlineProps): JSX.Element | null {
  const { rung, stack, view, selection, focus, active, trace } = useAtlasStore((s) => ({
    rung: s.rung,
    stack: s.stack,
    view: s.view,
    selection: s.selection,
    focus: s.focus,
    active: s.query.active,
    trace: s.trace,
  }));

  const path = active?.constellation.path ?? NO_PATH;
  const answerNodes = useAnswerNodes(active, view?.nodes ?? null);

  /* THE ORDER. `focus` is not a dependency, and that is the fix rather than an
     optimisation: a memo that cannot see the cursor cannot re-rank under it. */
  const rows = useMemo(() => buildRows(view, path, selection), [view, path, selection]);
  const groups = useMemo(() => sections(rows), [rows]);
  /* THE ANNOTATION. This one DOES depend on the cursor — it is a statement about
     the cursor — and it changes only the text of rows, never their order. */
  const reach = useMemo(() => reachFrom(view, focus), [view, focus]);

  /* FAIL LOUD ON A SECOND OUTLINE. Every id in this subtree is a literal, because
     the input surface has to be able to name an option from outside it. Two
     outlines in one document means two elements answer to `tro-o-<id>` and
     `aria-activedescendant` resolves to whichever the browser reached first. */
  useEffect(() => {
    if (document.querySelectorAll('.tro').length <= 1) return;
    // eslint-disable-next-line no-console
    console.error(
      '[ui/shell/TerrainOutline] more than one terrain outline is mounted. Its element ids are ' +
        'literals, and the input surface points aria-activedescendant at them by name — two ' +
        'outlines means the cursor can land on the wrong document. Mount exactly one.',
    );
  }, []);

  /* THE CARET PLATE'S ONE PIECE OF STATE. See the caret note in the copy block:
     the listbox is a 1x623px box inside a `clip-path` ancestor, so its focus ring
     is clipped away and a sighted keyboard user who tabs into it sees nothing at
     all. `:focus-within` in CSS would do this without state — and would not be
     able to name the node under the cursor, which is the only thing that makes
     the plate a caret rather than a rectangle. */
  const [listFocused, setListFocused] = useState(false);

  if (view === null) return null;

  const total = view.nodes.length;
  const shown = rows.length;
  const capped = shown < total;
  const cursorRow = rows.find((r) => r.node.id === focus) ?? null;
  const activeId = cursorRow === null ? undefined : terrainOptionId(cursorRow.node.id);

  /* ---- the operations, all of them store actions ------------------------- */

  const moveTo = (index: number): void => {
    const row = rows[index];
    if (row === undefined) return;
    useAtlas.getState().selectNode(row.node.id, false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    /* THE INPUT SURFACE UNDERNEATH LISTENS FOR THE SAME KEYS. This element is a
       DOM child of `.ix-surface`, whose own `onKeyDown` moves the world cursor on
       arrows and descends on Enter. React bubbles synthetic events, so an
       unstopped press would be handled twice — once here and once there — and
       land two nodes from where this list said it would. Every branch below
       stops propagation for exactly that reason.

       THE ZOOM KEYS ARE NOT AMONG THEM. `+`, `=` and `-` are handled by the
       surface for every target inside it, precisely because this list has no
       implementation of them and swallowing them here would take zoom away from
       the one keyboard user who cannot reach it any other way. */
    const store = useAtlas.getState();
    const index = rows.findIndex((r) => r.node.id === store.focus);

    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        e.stopPropagation();
        if (rows.length === 0) return;
        // No focus yet: the first press lands on the first row rather than
        // teleporting to the end of a two-hundred-row list.
        const next =
          index < 0
            ? 0
            : Math.min(rows.length - 1, Math.max(0, index + (e.key === 'ArrowDown' ? 1 : -1)));
        moveTo(next);
        return;
      }
      case 'Home':
      case 'End': {
        e.preventDefault();
        e.stopPropagation();
        moveTo(e.key === 'Home' ? 0 : rows.length - 1);
        return;
      }
      case ' ':
      case 'Spacebar': {
        e.preventDefault();
        e.stopPropagation();
        const row = rows[index];
        if (row === undefined) return;
        /* ADD TO THE SELECTION, DO NOT TOGGLE IT AWAY UNDER THE CURSOR.
           `selectNode(id, true)` is a TOGGLE, and every arrow move calls
           `selectNode(id, false)` — which replaces the selection with exactly
           this row. So Space on the row you just arrived at always found it
           already selected, removed it, and took the focus with it: the one key
           whose entire job is "hold this" un-held it, and the cursor fell to
           whatever the store nominated next.

           Toggling is still right for a row that is NOT the one under the
           cursor — that is a reader curating a set — so the branch is on which
           of the two situations this is, rather than on the key. */
        const s = useAtlas.getState();
        const alreadyHeld = s.selection.includes(row.node.id);
        const isCursor = s.focus === row.node.id;
        if (alreadyHeld && isCursor && s.selection.length === 1) {
          /* The only member, and it is the cursor. Removing it would empty the
             selection and orphan the cursor in one keystroke; there is a control
             for that and it is Escape. */
          return;
        }
        store.selectNode(row.node.id, true);
        return;
      }
      case 'Enter': {
        const row = rows[index];
        if (row === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        /* THE SAME THREE OUTCOMES THE CANVAS OFFERS, in the same order and for
           the same reasons: a passage is read, a body of this level is entered,
           and anything else — an entity, a source — is framed rather than
           pretended to be a place you can walk into. */
        if (row.node.kind === 'passage') void store.openPassage(row.node.id);
        else if (canDescend(row.node, store.rung)) void store.descend(row.node.id);
        else void store.frameIds([row.node.id], 96);
        return;
      }
      case 'Escape': {
        e.stopPropagation();
        store.clearFocus();
        return;
      }
      default:
        return;
    }
  };

  const actionFor = (node: GraphNode): string => {
    if (node.kind === 'passage') return COPY.a11yTwin.outline.actions.open;
    if (canDescend(node, rung)) return COPY.a11yTwin.outline.actions.descend;
    return COPY.a11yTwin.outline.actions.frame;
  };

  return (
    <section className={['tro', className].filter(Boolean).join(' ')} aria-label={COPY.a11yTwin.outline.title}>
      {/* THE SKIP LINK, RENDERED AT LAST.
          A button rather than an anchor, because an `href="#…"` needs an id and
          the command bar does not have one. That is the right fix and it is not
          this file's to make; until it exists, the destination is resolved by
          `focusCommandBar()` — which fails loudly rather than doing nothing. */}
      <button type="button" className="tro__skip" onClick={focusCommandBar}>
        {COPY.a11y.skipToCommand}
      </button>

      {/* THE CARET, MADE VISIBLE.
          `aria-hidden` because every word of it is already in the twin below and
          on the listbox's own accessible name — this element exists for the eye
          that cannot find the caret, not for the reader that already has it. */}
      {listFocused ? (
        <div className="tro__caret" aria-hidden="true">
          <span className="tro__caret-name">{COPY.a11yTwin.outline.caret.label}</span>
          <span className="tro__caret-node" data-engine-label>
            {cursorRow === null ? COPY.a11yTwin.outline.caret.none : cursorRow.node.label}
          </span>
          <span className="tro__caret-hint">{COPY.a11yTwin.outline.caret.hint}</span>
        </div>
      ) : null}

      <div className="tro__twin u-sr">
        <p>{COPY.a11yTwin.outline.intro}</p>

        {/* ---- 1. WHERE YOU ARE ------------------------------------------ */}
        <h2>{COPY.a11yTwin.outline.scope.title}</h2>
        <p>
          {COPY.a11yTwin.outline.scope.levelLabel}: {COPY.rungs.levels[rung].label}
        </p>
        {stack.length === 0 ? (
          <p>{COPY.a11yTwin.outline.scope.wholeWorld}</p>
        ) : (
          <>
            <p>{COPY.a11yTwin.outline.scope.insideLabel}</p>
            <ol>
              {stack.map((entry) => (
                <li key={entry.id}>
                  <span data-engine-label>{entry.label}</span> — {COPY.rungs.levels[entry.rung].label}
                </li>
              ))}
            </ol>
          </>
        )}
        <p>
          {selection.length === 0 ? (
            COPY.a11yTwin.heldWords.none
          ) : (
            <>
              {COPY.hud.selectionLabel}: <Num value={selection.length} format="int" />{' '}
              {selection.length === 1 ? COPY.a11yTwin.heldWords.one : COPY.a11yTwin.heldWords.many}
            </>
          )}
        </p>

        {/* ---- 2. THE ANSWER, READ AS THE KIND OF ANSWER IT IS ----------- */}
        <h2>{COPY.answer.title}</h2>
        {active === null ? (
          <p>{COPY.answer.empty}</p>
        ) : (
          <>
            <p>
              {COPY.a11yTwin.outline.answer.readAs}: {intentCopy(active.intent).label} —{' '}
              {COPY.intentViews.titles[active.intent]}
            </p>
            <IntentReading active={active} nodes={answerNodes} trace={trace} />
            {/* THE DISCLOSURE LINE, ON THIS SURFACE TOO. These readings are
                composed here from what the engine returned, and a surface that
                composes has to say so — on every surface it composes on, not
                only on the one that is drawn. */}
            <p data-prose>{COPY.intentViews.derived[active.intent]}</p>
          </>
        )}

        {/* ---- 3. THE OPERABLE LIST -------------------------------------- */}
        <h2 id="tro-list-h">
          {COPY.a11yTwin.outline.list.title}: <Num value={shown} format="int" />{' '}
          {COPY.common.ofLabel} <Num value={total} format="int" />
          {capped ? <> — {COPY.a11yTwin.outline.list.capped}</> : null}
        </h2>
        <p id="tro-keys">
          {COPY.a11yTwin.outline.list.order} {COPY.a11yTwin.outline.keys}
        </p>

        {rows.length === 0 ? (
          <p>{COPY.a11yTwin.outline.list.empty}</p>
        ) : (
          <div
            className="tro__list"
            role="listbox"
            tabIndex={0}
            aria-multiselectable="true"
            aria-labelledby="tro-list-h"
            aria-describedby="tro-keys"
            aria-activedescendant={activeId}
            onKeyDown={onKeyDown}
            onFocus={() => setListFocused(true)}
            onBlur={() => setListFocused(false)}
          >
            {groups.map((group) => (
              <div
                key={group.id}
                role="group"
                aria-label={COPY.a11yTwin.outline.list.groups[group.id]}
              >
                {group.rows.map((row) => {
                  const near = reach.get(row.node.id);
                  return (
                    <div
                      key={row.node.id}
                      id={terrainOptionId(row.node.id)}
                      role="option"
                      className="tro__opt"
                      aria-selected={selection.includes(row.node.id)}
                      onClick={() => useAtlas.getState().selectNode(row.node.id, false)}
                    >
                      <span data-engine-label>{row.node.label}</span> —{' '}
                      {COPY.rungs.kinds[row.node.kind]} — {COPY.inspector.rows.degree.label}:{' '}
                      <Num value={row.node.degree} format="int" />
                      {row.hop === null ? null : (
                        <>
                          {' '}
                          — {COPY.a11yTwin.outline.list.hopLabel}:{' '}
                          <Num value={row.hop} format="int" />
                        </>
                      )}
                      {near === undefined ? null : (
                        <>
                          {' '}
                          — {COPY.a11yTwin.outline.list.reach}{' '}
                          <span data-engine-label>{near.via}</span> ({sigmaCopy(near.sigma).label})
                          {near.rejectedOnly ? <> — {COPY.quarantine.never}</> : null}
                        </>
                      )}
                      {/* The verbs, on the ONE option they apply to. */}
                      {row.node.id === focus ? <> {actionFor(row.node)}</> : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
