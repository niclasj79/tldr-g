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
 * -----------------------------------------------------------------------------
 * IT WAS A CENSUS, NOT A NAVIGATOR — AND THAT IS WHAT CHANGED
 * -----------------------------------------------------------------------------
 * The header reported `20 of 521` at the asset rung and `20 of 2,207` at the
 * passage rung. Both figures were true and neither was actionable: the rows were
 * plain `<li>`s with no `onClick`, no key handler and no filter above them, so
 * the 501st asset was not merely uncaptioned — it had NO ROUTE TO THE SCREEN AT
 * ALL. A rail that names 2,207 things, offers twenty of them and lets you press
 * none of them is a sample of a database, not a way around a map.
 *
 * Three changes, and they are the whole of the fix:
 *
 *   1. THE NAME IS A CONTROL. Pressing it holds that body — the same act as
 *      clicking it on the terrain, through the same `selectNode`, so the map and
 *      the rail cannot disagree about what is held.
 *   2. THE ROW CARRIES `ENTER`, wherever there is a level below. Holding and
 *      entering are different questions — "which one is this" and "what is
 *      inside it" — and one undifferentiated click answering both is the same
 *      conflation the evidence trail's old `Evidence 3` control was split to
 *      end. Two verbs, two controls, each naming its own consequence.
 *   3. THE FILTER RUNS OVER THE WHOLE LEVEL, not over the twenty on show. That
 *      is what makes the cap honest rather than merely stated: a body past the
 *      cap is one substring away instead of unreachable. The cap is still
 *      printed, and now the sentence under it says what to do about it.
 *
 * THE WHOLE ROW IS NOT ONE BUTTON, deliberately: `<Hash>` is itself a button
 * (its entire job is to be copied and checked), and a button inside a button is
 * not a layout preference the browser is willing to negotiate. The NAME is the
 * control; the manifest line beside it stays readable text with its own
 * affordances intact.
 *
 * -----------------------------------------------------------------------------
 * WHAT EACH RUNG'S REGISTER ACTUALLY CARRIES
 * -----------------------------------------------------------------------------
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

import { useEffect, useState } from 'react';

import type { Asset, Continent, GraphNode, Island, Passage, Rung, ViewKey } from '@/engine';
import { COPY, resolutionCopy } from '@/copy';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Hash, Num, SectionLabel, Tip, cx } from '@/ui/primitives';

import { descend } from './descent';
import { rungBelow } from './rungGeometry';

/**
 * Rows shown before the ledger stops and says so.
 *
 * Not a styling number: a ledger that scrolls for three hundred rows has stopped
 * being a readout and become a database client. When it binds, the row count and
 * the total are both printed, so the cap is a stated fact rather than a silent
 * truncation — and the filter above the rows is what stops "stated" from being
 * the end of the story.
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
  const { rung, assetId, assetTiling, view, selection, focus, scope } = useAtlasStore((s) => ({
    rung: s.rung,
    assetId: s.assetId,
    assetTiling: s.assetTiling,
    view: s.view,
    selection: s.selection,
    focus: s.focus,
    // The body this level is scoped INSIDE. The ledger has always listed the
    // current scope and never said so, which is how `20 of 2,207` could be read
    // as a sample of the corpus rather than a full count of one document.
    scope: s.stack.length === 0 ? null : s.stack[s.stack.length - 1],
  }));

  const [filter, setFilter] = useState('');

  /* A NEW PLACE IS A NEW REGISTER. Carrying a filter across a descent would
     leave a rail that says `matching 0` about a level the reader has only just
     arrived at, with the reason two components away. The filter belongs to the
     list it was typed over. */
  const scopeId = scope?.id ?? null;
  useEffect(() => {
    setFilter('');
  }, [rung, scopeId, assetTiling]);

  const nodes: readonly GraphNode[] = view?.nodes ?? [];
  /* WHAT THE MAP IS DRAWING BODIES OF — which is no longer the same question
     as "what rung am I on". Standing on a floor in the reading covering, the
     bodies are the asset's spans; everywhere else they are the rung's own. */
  const bodyKind: ViewKey = assetId !== null && assetTiling === 'reading' ? 'passage' : rung;
  const bodies = inRungOrder(bodyKind, nodes);

  /* THE FILTER IS OVER EVERY BODY AT THIS LEVEL, NOT OVER THE TWENTY ON SHOW.
     Filtering the visible rows would be a search that can only find what you can
     already see — which is the defect, restated as a feature. */
  const needle = filter.trim().toLowerCase();
  const matched =
    needle.length === 0 ? bodies : bodies.filter((n) => n.label.toLowerCase().includes(needle));
  const shown = matched.slice(0, cap);
  const capped = matched.length > shown.length;

  const marked = new Set(selection);
  if (focus !== null) marked.add(focus);

  const below = rungBelow(rung);

  if (bodies.length === 0) {
    return (
      <div className={cx('rg', className)}>
        <p className="t-13 ink-dim">{COPY.hud.emptyRung}</p>
      </div>
    );
  }

  return (
    <div className={cx('rg', `rg-${rung}`, className)}>
      <header className="rg-hd">
        <SectionLabel>{headingFor(rung)}</SectionLabel>
        <span className="rg-of">
          <Num value={shown.length} format="int" tone="dim" />
          <span className="ink-dim">{COPY.common.ofLabel}</span>
          <Num value={needle.length === 0 ? bodies.length : matched.length} format="int" tone="dim" />
          {needle.length > 0 ? (
            <span className="rg-matching caps">{COPY.navigation.ledger.matching}</span>
          ) : null}
        </span>
      </header>

      {/* ---- WHAT THIS REGISTER COVERS ---------------------------------- *
       * One line, and it is the difference between a census and a listing:
       * `20 of 2,207` inside a named document is a complete count of that
       * document, while the same string with no scope on screen reads as a 1%
       * sample of the archive. */}
      <p className="rg-scope t-13" title={COPY.navigation.ledger.scope.tip}>
        <span className="rg-scope-label caps">{COPY.navigation.ledger.scope.label}</span>
        <span className="ink">
          {scope === null ? COPY.navigation.breadcrumb.unscoped : scope.label}
        </span>
      </p>

      {/* ---- THE FILTER -------------------------------------------------- *
       * ESCAPE CLEARS THE FILTER AND NOTHING ELSE, WHICH TOOK A HANDLER.
       * `type="search"` invites Escape-to-clear, and `matchBinding` (keys.ts)
       * deliberately lets Escape through from an editable target so nobody can
       * be trapped in a field — it routes to `clear-focus`, which drops the
       * selection, closes the overlays and releases the rail's tab pin. So the
       * one key this field advertises was silently costing the reader the node
       * they were holding, three components away from the field they typed in.
       *
       * The field claims Escape only while it HAS something to clear. Empty, it
       * lets the event through untouched, because "leave the field I am trapped
       * in" is the exact case that exception exists for. */}
      <div className="rg-find">
        <input
          className="rg-filter t-13"
          type="search"
          value={filter}
          spellCheck={false}
          autoComplete="off"
          aria-label={COPY.navigation.ledger.filter.label}
          placeholder={COPY.navigation.ledger.filter.placeholder}
          title={COPY.navigation.ledger.filter.tip}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || filter.length === 0) return;
            e.preventDefault();
            e.stopPropagation();
            setFilter('');
          }}
        />
        {needle.length > 0 ? (
          <Btn
            variant="ghost"
            size="sm"
            tone="dim"
            onClick={() => setFilter('')}
            title={COPY.navigation.ledger.clear.title}
          >
            {COPY.navigation.ledger.clear.label}
          </Btn>
        ) : null}
      </div>

      {matched.length === 0 ? (
        <p className="rg-empty t-13 ink-dim">{COPY.navigation.ledger.noMatch}</p>
      ) : null}

      <ol className="rg-rows">
        {shown.map((node) => {
          const held = marked.has(node.id);
          return (
            <li key={node.id} className={cx('rg-row', held && 'is-marked')}>
              {rung === 'continent' ? (
                <ContinentRow node={node as Continent} held={held} />
              ) : null}
              {bodyKind === 'island' ? <IslandRow node={node as Island} held={held} /> : null}
              {bodyKind === 'asset' ? <AssetRow node={node as Asset} held={held} /> : null}
              {bodyKind === 'passage' ? (
                <PassageRow node={node as Passage} held={held} widest={widestPassage(nodes)} />
              ) : null}

              {/* THE SECOND VERB. Present only where there is a level below —
                  a passage has no inside, and an `Enter` that refuses is a
                  control teaching people not to trust controls. */}
              {below === null ? null : (
                <Btn
                  variant="ghost"
                  size="sm"
                  tone="dim"
                  className="rg-enter"
                  // The atlas module's `descend`, not the store's bare action:
                  // same navigation underneath, plus the four beats of the
                  // descent, so entering from the rail and entering from the
                  // map are one event rather than two that look different.
                  onClick={() => void descend(node.id)}
                  title={COPY.navigation.ledger.descend.title}
                >
                  {COPY.navigation.ledger.descend.label}
                </Btn>
              )}
            </li>
          );
        })}
      </ol>

      {/* ---- THE CAP, AND WHAT TO DO ABOUT IT ---------------------------- */}
      {capped ? <p className="rg-capped t-13 ink-dim">{COPY.navigation.ledger.capped}</p> : null}
    </div>
  );
}

/**
 * The name, as the control that holds this body.
 *
 * ONE ACTION, THROUGH THE STORE'S OWN VERB. `selectNode` is what a click on the
 * terrain calls, so the rail and the map cannot end up holding different things
 * — and it is the reason this is a real `<button>` rather than a `<li>` with a
 * click handler: a div that responds to a pointer is invisible to every other
 * way of operating a computer.
 */
function RowName({
  node,
  held,
  title,
}: {
  node: GraphNode;
  held: boolean;
  title?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      /* ONE CLASS, BECAUSE THERE IS ONE TREATMENT. This was
         `cx('rg-name', held && 'is-held')` and there is no `.rg-name.is-held`
         rule — no `.is-held` rule at all — in atlas.css or anywhere under
         src/styles. The held state is carried by `.rg-row.is-marked`, by the
         `.rg-held` chip and by `aria-pressed`; a fourth hook that paints nothing
         is a dead affordance the next edit will style on the belief that it is
         already wired. */
      className="rg-name"
      onClick={() => useAtlas.getState().selectNode(node.id)}
      title={title ?? COPY.navigation.ledger.select.title}
      aria-pressed={held}
    >
      {node.label}
      {held ? <span className="rg-held caps">{COPY.navigation.ledger.held}</span> : null}
    </button>
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
function inRungOrder(bodyKind: ViewKey, nodes: readonly GraphNode[]): GraphNode[] {
  const bodies = nodes.filter((n) => n.kind === bodyKind);
  if (bodyKind !== 'passage') return bodies;
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

function ContinentRow({ node, held }: { node: Continent; held: boolean }): JSX.Element {
  return (
    <span className="rg-body">
      <RowName node={node} held={held} title={node.summary} />
      {/* WHAT THIS LANDMASS CONTAINS, transitively, each figure next to the word
          for what it counts. Three unlabelled numerals under three glyphs was
          the compliance-table read, and a viewer could not tell 5/93/388 apart
          from any other triple. */}
      <span className="rg-figs">
        <Fig label={COPY.rungs.levels.continent.contains} value={node.island_ids.length} />
        <Fig label={COPY.rungs.levels.island.contains} value={node.asset_count} />
        <Fig label={COPY.rungs.levels.asset.contains} value={node.passage_count} />
      </span>
    </span>
  );
}

/* =============================================================================
 * ⬢ ISLAND — the cluster ledger. The strait count is the interesting figure.
 * ========================================================================== */

function IslandRow({ node, held }: { node: Island; held: boolean }): JSX.Element {
  const bridges = node.bridge_entity_ids.length;
  return (
    <span className="rg-body">
      <RowName node={node} held={held} title={node.summary} />
      <span className="rg-figs">
        <Fig label={COPY.rungs.levels.island.contains} value={node.asset_ids.length} />
        <Fig label={COPY.rungs.levels.asset.contains} value={node.passage_count} />
        {/* The only figure at this rung that is about LEAVING. It is drawn in
            the question light because a strait is the thing you do not yet know
            the far side of.

            THE PLAIN NAME LEADS AND THE TECHNICAL ONE FOLLOWS. `6 STRAITS` used
            the engine's word for a reader who has not been given it yet, twenty
            rows at a time. The visible label is the plain half in the COUNTED
            form — every other figure in this ledger sits beside a plural noun,
            and this one once read `6 strait` — and the full pair plus the
            definition is one hover away, which is the same shape the staged
            panel uses for `Verified sample answer · By construction`.

            THE HOVER JOINS THE COUNTED PAIR, WHICH IT DID NOT DO. It called
            `dual('strait')`, and `dual()` renders the SINGULAR canonical pair:
            the label said `Cross-cluster connections` and the tooltip answered
            `Cross-cluster connection · Strait`, switching number under the
            reader's cursor. Worse, `COPY.rungs.strait.plural` — the technical
            half of the counted form, and the string navigation.ts names as the
            reason its own `straits.counted` exists — was referenced by no
            component in src/ at all. An invariant guarding a string nothing
            renders is not guarding anything. Same interpunct `dual()` uses,
            because it is the same pair, counted. */}
        {/* NAMED FOR WHAT IT COUNTS. This read `Cross-cluster connections ·
            Straits`, which names the RELATIONS; the value is
            `bridge_entity_ids.length`, which counts the ENTITIES. One shared
            entity can carry several connections or none, so the two figures are
            genuinely different and the label was asserting the one nobody had
            measured. */}
        <Fig
          label={COPY.navigation.bridges.label}
          title={COPY.navigation.bridges.tip}
          value={bridges}
          tone={bridges > 0 ? 'curiosity' : 'dim'}
        />
      </span>
    </span>
  );
}

/* =============================================================================
 * ▮ ASSET — the manifest. Somebody declared this to be one thing, and when.
 * ========================================================================== */

function AssetRow({ node, held }: { node: Asset; held: boolean }): JSX.Element {
  return (
    <span className="rg-body">
      <RowName node={node} held={held} title={node.summary} />
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
        <span className="rg-declared mono t-11" title={COPY.rungs.boundary.declaredAt.tip}>
          {dayOf(node.boundary_declared_at)}
        </span>
        <Fig
          label={COPY.rungs.levels.asset.contains}
          title={COPY.inspector.rows.mentions.tip}
          value={node.passage_ids.length}
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

function PassageRow({
  node,
  held,
  widest,
}: {
  node: Passage;
  held: boolean;
  widest: number;
}): JSX.Element {
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
          line about it — is now true at all four.

          AND THE TOOLTIP CAME ACROSS WITH THE OLD SPAN. It was
          `COPY.inspector.rows.seq.tip` — "Index of this span inside its
          document…" — which was correct while it hung on the ordinal and is
          wrong the moment the ordinal is gone: the one row control in this
          ledger whose hover did not say what pressing it does, describing a
          number deliberately not on screen. A passage has no `summary` to put
          there, so it takes the same default every other row control takes. */}
      <RowName node={node} held={held} />
      <span className="rg-span mono t-11" title={COPY.inspector.rows.span.tip}>
        <Num value={node.char_start} format="int" tone="dim" unit="" />
        <span className="rg-dash ink-dim" aria-hidden="true">
          –
        </span>
        <Num value={node.char_end} format="int" tone="dim" unit="" />
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
 *
 * `faint` IS NOT IN THE TONE UNION, and the omission is the point. A measured
 * figure is never decoration — `--ink-faint` is a 3:1 step reserved for exactly
 * that — and a `tone` prop that accepts it is a hole through which the ledger's
 * third column ends up below the contrast floor while looking deliberate. The
 * discipline check bans the faint tone on the numeric primitive at the call
 * site; this bans it one level up, where it was being laundered through a prop.
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
  tone?: 'dim' | 'render' | 'curiosity';
}): JSX.Element {
  return (
    <span className="rg-fig" title={title ?? label}>
      <Num value={value} format={format} tone={tone} />
      <span className="rg-of-what caps">{label}</span>
    </span>
  );
}

/** Re-exported so a caller can size a container without re-deriving the cap. */
export { ROW_CAP as LEDGER_ROW_CAP };
