/**
 * =============================================================================
 * INSPECTOR BODY — the dense detail, and the only place it is allowed to be
 * =============================================================================
 *
 * The right rail is the ONLY place in this product where density is permitted.
 * The terrain gets negative space and four labels; everything a node knows about
 * itself gets crammed in here, on the mono rail, in rows, because a person
 * reading this has already chosen to look closely.
 *
 * It is composed from the other trust parts rather than reimplementing them: a
 * passage opens into the full `PassageDrilldown`, hashes go through `<Hash>`,
 * every measured figure goes through `<Num>`. Six node kinds, each showing what
 * it actually has — and NOT showing what it does not. An asset has a declared
 * boundary and a token count; an entity has aliases, mentions and islands; a
 * source has segments. Printing an empty `Aliases —` row on a continent would be
 * a form pretending to be an instrument.
 *
 * -----------------------------------------------------------------------------
 * FACTS ARE A READOUT, NOT A COMPLIANCE TABLE
 * -----------------------------------------------------------------------------
 * The small integers every node carries — centrality, degree, mentions, islands
 * — used to be six full-width ruled label/value rows, which is the form an audit
 * questionnaire takes and the reason the rail read as bolted to the right edge
 * rather than designed. They are now a FACT STRIP: a caps micro-label with the
 * figure under it, three to a line, no rules between them.
 *
 * It is a third of the height, it puts four numbers in one fixation instead of
 * four, and — the part that actually mattered — the label can no longer be
 * elided to fit the value, because it is not competing with the value for the
 * same line. Rows are kept for the facts that are STRINGS: a locator, a
 * timestamp, a boundary kind. Those need the full measure.
 *
 * -----------------------------------------------------------------------------
 * NO DEAD CONTROLS
 * -----------------------------------------------------------------------------
 * The action row renders only the actions that are actually wired. `Focus`,
 * `Descend` and `Ask about this` map onto real store actions;
 * `Neighbourhood` needs an edge-policy change this module does not own, so it
 * appears only when a host passes a handler for it. A button that does nothing
 * teaches the user that buttons here might do nothing.
 * =============================================================================
 */

import { useMemo } from 'react';

import { COPY } from '@/copy';
import type { GraphNode, LodState } from '@/engine';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Chip, Divider, Glyph, Hash, LodChip, Num, Row, SectionLabel, Tip, cx } from '@/ui/primitives';

import { RepudiationLayer } from './RepudiationLayer';
import { Code, Empty, Fact, NodeId, Note, Why } from './bits';
import { PassageDrilldown } from './PassageDrilldown';

/** Rung glyph for a node kind. Entities and sources are not rungs and get none. */
function glyphFor(node: GraphNode): 'continent' | 'island' | 'asset' | 'passage' | null {
  switch (node.kind) {
    case 'continent':
    case 'island':
    case 'asset':
    case 'passage':
      return node.kind;
    default:
      return null;
  }
}

export interface InspectorBodyProps {
  /** Defaults to the focused node, else the first selected, else the hovered. */
  node?: GraphNode | null;
  /** The tier this node is admitted at. Defaults to the store's resolution map. */
  lod?: LodState | null;
  /** Optional: draw the one-hop neighbourhood. Rendered only when provided. */
  onNeighbourhood?: (nodeId: string) => void;
  className?: string;
}

/** A BODY. The Inspector's own glass belongs to whoever owns the rail. */
export function InspectorBody({
  node,
  lod,
  onNeighbourhood,
  className,
}: InspectorBodyProps): JSX.Element {
  const store = useAtlasStore((s) => ({
    focus: s.focus,
    selected: s.selection.length > 0 ? s.selection[0] : null,
    hover: s.hover,
    nodes: s.view?.nodes ?? null,
    lod: s.lod,
  }));

  const wantedId = store.focus ?? store.selected ?? store.hover;
  const resolved = useMemo(() => {
    if (node !== undefined) return node;
    if (wantedId === null || store.nodes === null) return null;
    return store.nodes.find((n) => n.id === wantedId) ?? null;
  }, [node, wantedId, store.nodes]);

  if (resolved === null) {
    return (
      <div className={cx('pv-insp', className)}>
        <Empty title={COPY.inspector.emptyTitle} body={COPY.inspector.empty} />
      </div>
    );
  }

  const n = resolved;
  const tier = lod !== undefined && lod !== null ? lod : store.lod[n.id];
  const glyph = glyphFor(n);

  const act = useAtlas.getState();
  const canDescend = n.kind === 'continent' || n.kind === 'island' || n.kind === 'asset';

  return (
    <div className={cx('pv-insp', className)}>
      {/* THE MAP'S REPUDIATION TRAVELS WITH EVERY PROVENANCE SURFACE. The
          Inspector is the tab a reader is most likely to have open while looking
          at the terrain, and it is the one place the trust panels are NOT
          mounted — so without this, tampering and switching tabs left the map
          vouching for a receipt the store had already disproved. Exactly one
          instance draws, whichever surfaces happen to be mounted. */}
      <RepudiationLayer />

      {/* ---- identity ---------------------------------------------------- */}
      <header className="pv-insp-hd">
        {glyph === null ? null : <Glyph kind={glyph} tone="render" />}
        <span className="pv-insp-label">{n.label}</span>
        {tier === undefined ? null : (
          <Tip content={COPY.inspector.rows.lod.tip}>
            <LodChip state={tier} tone="neutral" />
          </Tip>
        )}
      </header>

      <div className="pv-insp-sub">
        <NodeId id={n.id} />
        <Code code={COPY.rungs.kinds[n.kind]} />
        {n.kind === 'entity' && n.is_bridge ? (
          <Tip content={COPY.inspector.bridgeTip}>
            <span className="pv-bridge tone-render">{COPY.inspector.bridgeBadge}</span>
          </Tip>
        ) : null}
      </div>

      {/* ---- what every node has ----------------------------------------- */}
      <section className="pv-sec">
        <div className="pv-facts">
          <Fact
            label={COPY.inspector.rows.centrality.label}
            tip={COPY.inspector.rows.centrality.tip}
          >
            <Num value={n.centrality} format="float2" tone="neutral" />
          </Fact>
          <Fact label={COPY.inspector.rows.degree.label} tip={COPY.inspector.rows.degree.tip}>
            <Num value={n.degree} format="int" tone="neutral" />
          </Fact>
          <Fact
            label={COPY.inspector.rows.community.label}
            tip={COPY.inspector.rows.community.tip}
            wide
          >
            <span className="pv-fact-s">{n.community_id}</span>
          </Fact>
        </div>
      </section>

      {/* ---- what this KIND has ------------------------------------------ */}
      {n.kind === 'continent' ? (
        <section className="pv-sec">
          <Row
            label={COPY.rungs.levels.continent.contains}
            title={COPY.rungs.levels.continent.short}
            value={<Num value={n.island_ids.length} format="int" tone="dim" />}
          />
          <Row
            label={COPY.rungs.levels.island.contains}
            title={COPY.rungs.levels.island.short}
            value={<Num value={n.asset_count} format="tokens" tone="dim" />}
          />
          <Row
            label={COPY.rungs.levels.asset.contains}
            title={COPY.rungs.levels.asset.short}
            value={<Num value={n.passage_count} format="tokens" tone="dim" />}
          />
          <Note>{n.summary}</Note>
        </section>
      ) : null}

      {n.kind === 'island' ? (
        <section className="pv-sec">
          <Row
            label={COPY.rungs.levels.island.contains}
            title={COPY.rungs.levels.island.short}
            value={<Num value={n.asset_ids.length} format="tokens" tone="dim" />}
          />
          <Row
            label={COPY.rungs.levels.asset.contains}
            title={COPY.rungs.levels.asset.short}
            value={<Num value={n.passage_count} format="tokens" tone="dim" />}
          />
          <Row
            label={COPY.answer.bridge.label}
            title={COPY.answer.bridge.tip}
            value={<Num value={n.bridge_entity_ids.length} format="int" tone="dim" />}
          />
          <Note>{n.summary}</Note>
        </section>
      ) : null}

      {n.kind === 'asset' ? (
        <section className="pv-sec">
          <Row
            label={COPY.rungs.boundary.label}
            title={COPY.rungs.boundary.tip}
            value={<Code code={COPY.rungs.boundary.kinds[n.boundary_kind]} />}
          />
          <Row
            label={COPY.rungs.boundary.declaredAt.label}
            title={COPY.rungs.boundary.declaredAt.tip}
            value={n.boundary_declared_at}
            mono
            tone="dim"
          />
          <Row
            label={COPY.rungs.levels.asset.contains}
            title={COPY.rungs.levels.asset.short}
            value={<Num value={n.passage_ids.length} format="int" tone="dim" />}
          />
          <Row
            label={COPY.inspector.rows.tokens.label}
            title={COPY.inspector.rows.tokens.tip}
            value={
              <Num
                value={n.token_count}
                format="tokens"
                unit={COPY.common.units.tokens}
                tone="dim"
              />
            }
          />
          <Row
            label={COPY.receipt.citations.rows.source.label}
            title={COPY.receipt.citations.rows.source.tip}
            value={<NodeId id={n.source_id} />}
          />
          {/* The summary is the node's own sentence and stays. The paragraph
              explaining what a summary IS moves onto it. */}
          <Why note={COPY.inspector.rows.summary.tip}>
            <Note>{n.summary}</Note>
          </Why>
        </section>
      ) : null}

      {n.kind === 'entity' ? (
        <section className="pv-sec">
          <div className="pv-facts">
            {/* A COUNT OF MENTIONS IS NOT AN EVIDENCE ANCHOR. It was --evidence,
                which put the old-light amber on a degree-like integer in a panel
                that carries no evidence at all — one of the places the gold went
                categorical. The passages themselves are still amber; this is a
                number about them. */}
            <Fact
              label={COPY.inspector.rows.mentions.label}
              tip={COPY.inspector.rows.mentions.tip}
            >
              <Num value={n.mentions.length} format="int" tone="neutral" />
            </Fact>
            <Fact label={COPY.inspector.rows.islands.label} tip={COPY.inspector.rows.islands.tip}>
              <Num
                value={n.island_ids.length}
                format="int"
                tone={n.is_bridge ? 'render' : 'neutral'}
              />
            </Fact>
            <Fact
              label={COPY.inspector.rows.entityType.label}
              tip={COPY.inspector.rows.entityType.tip}
            >
              <span className="pv-fact-s">{n.entity_type}</span>
            </Fact>
          </div>
          {n.aliases.length === 0 ? null : (
            <>
              <SectionLabel>{COPY.inspector.rows.aliases.label}</SectionLabel>
              <div className="pv-aliases">
                {n.aliases.map((alias) => (
                  <Chip key={alias} tone="dim" title={COPY.inspector.rows.aliases.tip}>
                    {alias}
                  </Chip>
                ))}
              </div>
            </>
          )}
          <Note>{n.summary}</Note>
        </section>
      ) : null}

      {n.kind === 'source' ? (
        <section className="pv-sec">
          <Row
            label={COPY.inspector.rows.locator.label}
            title={COPY.inspector.rows.locator.tip}
            value={n.locator}
            mono
          />
          <Row
            label={COPY.inspector.rows.mediaType.label}
            title={COPY.inspector.rows.mediaType.tip}
            value={n.media_type}
            mono
            tone="dim"
          />
          <Row
            label={COPY.inspector.rows.ingestedAt.label}
            title={COPY.inspector.rows.ingestedAt.tip}
            value={n.ingested_at}
            mono
            tone="dim"
          />
          <Row
            label={COPY.trust.hash.label}
            title={COPY.trust.hash.tip}
            value={<Hash value={n.content_hash} />}
          />
          <Why note={COPY.trust.sourceSegment.tip}>
            <SectionLabel>{COPY.trust.sourceSegment.label}</SectionLabel>
          </Why>
          {n.segments.map((seg) => (
            <Row
              key={seg.seq}
              label={
                <span className="pv-seg-row">
                  <span className={cx('pv-seg-badge', seg.seq === 0 ? 'tone-dim' : 'tone-dim')}>
                    {seg.seq === 0
                      ? COPY.trust.sourceSegment.verbatimBadge
                      : COPY.trust.sourceSegment.derivedBadge}
                  </span>
                  <Code code={seg.kind} />
                </span>
              }
              value={<Hash value={seg.content_hash} chars={8} />}
            />
          ))}
        </section>
      ) : null}

      {/* ---- a passage opens into the provenance floor -------------------- */}
      {n.kind === 'passage' ? (
        <>
          <section className="pv-sec">
            <Row
              label={COPY.receipt.citations.rows.asset.label}
              title={COPY.receipt.citations.rows.asset.tip}
              value={<NodeId id={n.asset_id} />}
            />
            <Row
              label={COPY.inspector.rows.mentions.label}
              title={COPY.inspector.rows.mentions.tip}
              value={<Num value={n.entity_ids.length} format="int" tone="dim" />}
            />
            {/* NO `Resolution disclosure` ROW HERE. It was a full-width ruled row
                whose label is a section title and whose value was the same badge
                the drilldown prints forty pixels below it — the passage id and
                its resolution, twice, inside one panel and inside one glance.
                The drilldown's own heading owns both, and its badge carries the
                substitution COUNT, which this row could not: it had no bytes to
                count against. Deleting a duplicate is the cheapest way a panel
                stops reading as a form. */}
          </section>
          <Divider />
          {/* The header and sub-line above have already named this passage, so
              the drilldown's heading carries the resolution and the substitution
              count and nothing else. See `alreadyNamed`. */}
          <PassageDrilldown passageId={n.id} alreadyNamed />
        </>
      ) : null}

      {/* ---- the actions that are actually wired -------------------------- */}
      <div className="pv-actions">
        <Btn
          variant="quiet"
          size="sm"
          tone="render"
          onClick={() => act.selectNode(n.id)}
          title={COPY.inspector.actions.focus.title}
        >
          {COPY.inspector.actions.focus.label}
        </Btn>
        {canDescend ? (
          <Btn
            variant="ghost"
            size="sm"
            tone="render"
            onClick={() => void act.descend(n.id)}
            title={COPY.inspector.actions.descend.title}
          >
            {COPY.inspector.actions.descend.label}
          </Btn>
        ) : null}
        {n.kind === 'passage' ? (
          <Btn
            variant="ghost"
            size="sm"
            tone="neutral"
            onClick={() => void act.openPassage(n.id)}
            title={COPY.receipt.citations.open.title}
          >
            {COPY.receipt.citations.open.label}
          </Btn>
        ) : null}
        {onNeighbourhood === undefined ? null : (
          <Btn
            variant="ghost"
            size="sm"
            tone="render"
            onClick={() => onNeighbourhood(n.id)}
            title={COPY.inspector.actions.neighbours.title}
          >
            {COPY.inspector.actions.neighbours.label}
          </Btn>
        )}
        <Btn
          variant="ghost"
          size="sm"
          tone="curiosity"
          onClick={() => act.stageQuery(n.label)}
          title={COPY.inspector.actions.ask.title}
        >
          {COPY.inspector.actions.ask.label}
        </Btn>
      </div>
    </div>
  );
}
