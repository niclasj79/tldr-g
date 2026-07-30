/**
 * =============================================================================
 * RUNG LEDGER — the ontology change, in words as well as in pixels
 * =============================================================================
 *
 * The terrain changes what things LOOK like when you descend. This changes what
 * they are DESCRIBED BY, and that is the half a screenshot can be argued about.
 *
 * EVERY ROW IS A NAME AND A LINE ABOUT IT. Two lines, at all four rungs, and
 * the second line is where the ontology lives.
 *
 * It used to be a table: a name column that ellipsed and three numeric columns
 * headed by unlabelled glyphs. Both halves of that were wrong in the same way.
 * A viewer looking at `5 / 93 / 388` could not tell whether those were islands,
 * assets and passages or something else — an unlabelled numeric column is
 * unreadable at any density — and `Corporate Holding…` truncated the ONE place
 * in the product where that proper noun appears at all. The rule now is the
 * blunt one: names never truncate, and no figure is ever printed without the
 * word for what it counts.
 *
 * The fields are not a layout choice. They are what the schema actually
 * carries at each rung, and there is no field that appears at two rungs by
 * accident:
 *
 *   ◆ continent   islands · assets · passages          — a REGION LEDGER. What a
 *                 landmass contains, transitively. Geography.
 *   ⬢ island      assets · passages · straits          — a CLUSTER LEDGER. The
 *                 strait count is the one that matters: it is how many ways
 *                 there are out of this island, through a bridge entity.
 *   ▮ asset       boundary · declared · passages · tok — a MANIFEST. Every row
 *                 names the kind of boundary somebody declared and the date they
 *                 declared it. This is the molecule rung, so the ledger is about
 *                 provenance of authorship, not about size.
 *   · passage     mark · span · tokens · resolution · hash — a DOCUMENT. Rows
 *                 are sorted on the same character offsets the terrain lays its
 *                 reading spine along, and each row is titled with the SAME
 *                 label the map prints under its mark, so the third row of this
 *                 list and the third mark from the left are visibly one thing.
 *                 Each bar is scaled by its real token count and each row
 *                 carries the disclosure of how far its text has travelled from
 *                 the bytes on disk plus the hash over those bytes. At this rung
 *                 you are not looking at a map any more.
 *
 * Read the four together and the product's grain is legible without a single
 * paragraph of explanation: molecules have boundaries, spans have offsets,
 * regions have contents, and entities cross.
 *
 * Every string is from `@/copy`; every figure goes through `<Num>`; every hash
 * through `<Hash>`. Rows are capped and the cap is REPORTED, never silent.
 * =============================================================================
 */

import type { Asset, Continent, GraphNode, Island, Passage, Rung } from '@/engine';
import { COPY, resolutionCopy } from '@/copy';
import { useAtlasStore } from '@/state';
import { Hash, Num, SectionLabel, Tip, cx } from '@/ui/primitives';

/**
 * Rows shown before the ledger stops and says so.
 *
 * Not a styling number: a ledger that scrolls for three hundred rows has stopped
 * being a readout and become a database client. When it binds, the row count and
 * the total are both printed, so the cap is a stated fact rather than a silent
 * truncation.
 */
const ROW_CAP = 20;

export interface RungLedgerProps {
  className?: string;
  /** Override the cap. The readout still reports whatever cap is in force. */
  cap?: number;
}

function isKind<K extends GraphNode['kind']>(kind: K) {
  return (n: GraphNode): n is Extract<GraphNode, { kind: K }> => n.kind === kind;
}

/** `2031-04-17T00:00:00.000Z` -> `2031-04-17`. A date, not a timestamp readout. */
function dayOf(iso: string): string {
  const t = iso.indexOf('T');
  return t === -1 ? iso : iso.slice(0, t);
}

export function RungLedger({ className, cap = ROW_CAP }: RungLedgerProps): JSX.Element {
  // Select the payload, not a derived array: `useShallow` compares the selector
  // result shallowly, and a fresh `[]` every call is a fresh value every call.
  const { rung, view, selection, focus } = useAtlasStore((s) => ({
    rung: s.rung,
    view: s.view,
    selection: s.selection,
    focus: s.focus,
  }));

  const nodes: readonly GraphNode[] = view?.nodes ?? [];
  const bodies = inRungOrder(rung, nodes);
  const shown = bodies.slice(0, cap);
  const marked = new Set(selection);
  if (focus !== null) marked.add(focus);

  if (bodies.length === 0) {
    return (
      <div className={cx('rg', className)}>
        <p className="t-12-5 ink-faint">{COPY.hud.emptyRung}</p>
      </div>
    );
  }

  return (
    <div className={cx('rg', `rg-${rung}`, className)}>
      <header className="rg-hd">
        <SectionLabel>{headingFor(rung)}</SectionLabel>
        <span className="rg-of">
          <Num value={shown.length} format="int" tone="dim" />
          <span className="ink-faint">{COPY.common.ofLabel}</span>
          <Num value={bodies.length} format="int" tone="faint" />
        </span>
      </header>

      <ol className="rg-rows">
        {shown.map((node) => (
          <li key={node.id} className={cx('rg-row', marked.has(node.id) && 'is-marked')}>
            {rung === 'continent' ? <ContinentRow node={node as Continent} /> : null}
            {rung === 'island' ? <IslandRow node={node as Island} /> : null}
            {rung === 'asset' ? <AssetRow node={node as Asset} /> : null}
            {rung === 'passage' ? (
              <PassageRow node={node as Passage} widest={widestPassage(nodes)} />
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The rung's own bodies, IN THE ORDER THE RUNG HAS.
 *
 * Three of the four rungs have no order of their own — a continent is not
 * before another continent — so they keep the payload's, which is the bake's,
 * which is stable across renders. The passage rung DOES have one: a document is
 * read from its first byte to its last, the terrain now lays the spans on that
 * axis, and this file has claimed "rows are in reading order" in its own header
 * since it was written. Sorting on the field the axis is built from is what
 * makes that claim true rather than incidental, and it is what keeps row three
 * of the ledger next to the third mark from the left on the map.
 */
function inRungOrder(rung: Rung, nodes: readonly GraphNode[]): GraphNode[] {
  const bodies = nodes.filter((n) => n.kind === rung);
  if (rung !== 'passage') return bodies;
  return bodies
    .slice()
    .sort(
      (a, b) =>
        (a as Passage).char_start - (b as Passage).char_start ||
        (a as Passage).seq - (b as Passage).seq,
    );
}

/** The section marker: what a row of this ledger IS. */
function headingFor(rung: Rung): string {
  switch (rung) {
    case 'continent':
      return COPY.rungs.levels.continent.plural;
    case 'island':
      return COPY.rungs.levels.island.plural;
    case 'asset':
      return COPY.rungs.levels.asset.plural;
    default:
      return COPY.rungs.levels.passage.plural;
  }
}

/* =============================================================================
 * ◆ CONTINENT — the region ledger
 * ========================================================================== */

function ContinentRow({ node }: { node: Continent }): JSX.Element {
  return (
    <span className="rg-body">
      <span className="rg-name" title={node.summary}>
        {node.label}
      </span>
      {/* WHAT THIS LANDMASS CONTAINS, transitively, each figure next to the word
          for what it counts. Three unlabelled numerals under three glyphs was
          the compliance-table read, and a viewer could not tell 5/93/388 apart
          from any other triple. */}
      <span className="rg-figs">
        <Fig label={COPY.rungs.levels.continent.contains} value={node.island_ids.length} />
        <Fig label={COPY.rungs.levels.island.contains} value={node.asset_count} />
        <Fig label={COPY.rungs.levels.asset.contains} value={node.passage_count} tone="faint" />
      </span>
    </span>
  );
}

/* =============================================================================
 * ⬢ ISLAND — the cluster ledger. The strait count is the interesting figure.
 * ========================================================================== */

function IslandRow({ node }: { node: Island }): JSX.Element {
  const bridges = node.bridge_entity_ids.length;
  return (
    <span className="rg-body">
      <span className="rg-name" title={node.summary}>
        {node.label}
      </span>
      <span className="rg-figs">
        <Fig label={COPY.rungs.levels.island.contains} value={node.asset_ids.length} />
        <Fig label={COPY.rungs.levels.asset.contains} value={node.passage_count} tone="faint" />
        {/* The only figure at this rung that is about LEAVING. It is drawn in
            the question light because a strait is the thing you do not yet know
            the far side of. */}
        <Fig
          // The COUNTED form. Every other figure in this ledger is beside a
          // plural noun — `24 assets`, `103 passages` — and this one read
          // `6 strait`.
          label={COPY.rungs.strait.plural}
          title={COPY.rungs.strait.tip}
          value={bridges}
          tone={bridges > 0 ? 'curiosity' : 'faint'}
        />
      </span>
    </span>
  );
}

/* =============================================================================
 * ▮ ASSET — the manifest. Somebody declared this to be one thing, and when.
 * ========================================================================== */

function AssetRow({ node }: { node: Asset }): JSX.Element {
  return (
    <span className="rg-body">
      <span className="rg-name" title={node.summary}>
        {node.label}
      </span>
      {/* THE MANIFEST LINE. What kind of boundary somebody declared, when they
          declared it, and what it cost.

          ONE THING ON THIS LINE IS EVIDENCE AND IT IS THE DATE. The boundary
          KIND used to be a filled gold chip as well, which put two gold objects
          on every one of twenty rows and turned the whole asset rail amber —
          and gold that appears twenty times as a taxonomy tag has stopped
          meaning "this came out of a source" and started meaning "this is a
          chip". `contract` / `thread` / `session` is a classification, i.e.
          chrome, so it is set in ink. The DECLARED DATE is old light: somebody
          executed, merged or convened on that day, before this session existed,
          and that is exactly what the evidence light is for.

          IT WRAPS. It used to be `nowrap` with `overflow: hidden`, which clipped
          the token count mid-unit against the rail edge — `537 tol`, `775 to`,
          `466` — so the ledger was eliding its own units to protect a layout.
          A figure without its unit is not a measurement. */}
      <span className="rg-manifest">
        <span className="rg-boundary caps" title={COPY.rungs.boundary.tip}>
          {COPY.rungs.boundary.kinds[node.boundary_kind]}
        </span>
        <span
          className="rg-declared mono t-11"
          title={COPY.rungs.boundary.declaredAt.tip}
        >
          {dayOf(node.boundary_declared_at)}
        </span>
        <Fig
          label={COPY.rungs.levels.asset.contains}
          title={COPY.inspector.rows.mentions.tip}
          value={node.passage_ids.length}
          tone="faint"
        />
        <Num
          value={node.token_count}
          format="tokens"
          tone="dim"
          unit={COPY.common.units.tokens}
        />
      </span>
    </span>
  );
}

/* =============================================================================
 * · PASSAGE — a document, not a map. Reading order, real offsets, real hashes.
 * ========================================================================== */

function widestPassage(nodes: readonly GraphNode[]): number {
  let max = 0;
  for (const n of nodes) {
    if (isKind('passage')(n) && n.token_count > max) max = n.token_count;
  }
  return max;
}

function PassageRow({ node, widest }: { node: Passage; widest: number }): JSX.Element {
  const disclosure = resolutionCopy(node.resolution);
  const share = widest > 0 ? node.token_count / widest : 0;
  return (
    <span className="rg-pbody">
      {/* THE MARK, NAMED EXACTLY AS THE MAP NAMES IT.
          This row used to lead with a bare `seq` — an unlabelled 0, 1, 2, 3, 4
          in a two-character gutter — while the terrain drew the same five
          things as `BOA-0327 · span 1` … `span 5`, because `seq` is 0-based and
          the engine's own label is 1-based. So the rail counted from zero and
          the map counted from one, side by side, about the same five objects,
          in the one frame whose whole argument is that the two halves of the
          screen agree.
          The fix is not to add one to a number. It is to stop printing a second
          identity at all: the row carries the node's OWN label, which is the
          string the map prints under the mark, so there is one name for one
          span and no arithmetic between the two readings. Every other rung's
          row already led with `node.label`; this one is no longer the
          exception, and the ledger's stated rule — every row is a name and a
          line about it — is now true at all four. */}
      <span className="rg-name" title={COPY.inspector.rows.seq.tip}>
        {node.label}
      </span>
      <span className="rg-span mono t-11" title={COPY.inspector.rows.span.tip}>
        <Num value={node.char_start} format="int" tone="faint" unit="" />
        <span className="rg-dash ink-faint" aria-hidden="true">
          –
        </span>
        <Num value={node.char_end} format="int" tone="faint" unit="" />
      </span>
      {/* The bar IS the token count. Its width is `token_count / widest`, so a
          long span looks long. Nothing here is scaled for looks. */}
      <span
        className="rg-bar"
        style={{ ['--rg-share' as string]: String(share) }}
        title={COPY.inspector.rows.tokens.tip}
        aria-hidden="true"
      />
      <span className="rg-passage-foot">
        <Tip content={disclosure.long}>
          <span
            className={cx(
              'rg-disclosure caps',
              node.resolution === 'verbatim' ? 'is-verbatim' : 'is-resolved',
            )}
          >
            {disclosure.label}
          </span>
        </Tip>
        <Num value={node.token_count} format="tokens" tone="dim" unit={COPY.common.units.tokens} />
        <Hash value={node.content_hash} chars={10} />
      </span>
    </span>
  );
}

/* =============================================================================
 * One figure and the word for what it counts. The only place this file draws a
 * numeral, and the only shape in which it is allowed to draw one: there is no
 * bare number anywhere in this ledger, because a bare number in a column headed
 * by a glyph is a number nobody can read.
 * ========================================================================== */

function Fig({
  label,
  title,
  value,
  format = 'int',
  tone = 'dim',
}: {
  label: string;
  /** The explanation, when there is one worth hovering for. */
  title?: string;
  value: number;
  format?: 'int' | 'tokens';
  tone?: 'dim' | 'faint' | 'render' | 'curiosity';
}): JSX.Element {
  return (
    <span className="rg-fig" title={title ?? label}>
      <Num value={value} format={format} tone={tone} />
      <span className="rg-of-what caps ink-faint">{label}</span>
    </span>
  );
}

/** Re-exported so a caller can size a container without re-deriving the cap. */
export { ROW_CAP as LEDGER_ROW_CAP };
