/**
 * =============================================================================
 * CITATION LIST — provenance you watch happen
 * =============================================================================
 *
 * Five quotes, each carrying everything a third party needs to check it without
 * trusting this application: the passage, the asset, the source, the SHA-256
 * over the verbatim bytes, the resolution disclosure, the token cost, and the
 * renderer's own justification for spending on it.
 *
 * -----------------------------------------------------------------------------
 * THE TRACE PING
 * -----------------------------------------------------------------------------
 * Opening a citation does not simply navigate. It fires a dot down the citation
 * edge — from the node on the answer path to the passage that evidences it —
 * over `--t-ui`, leaving a 1px --evidence hairline, and THEN the map goes there.
 * Consecutive dots are offset by a third of `--t-ui`.
 *
 * The endpoints are not chosen for the animation's convenience. They are read
 * out of `PathStep.evidence_passage_ids`, which is the receipt's own statement
 * about which quote carries which hop. A citation no hop cites gets no dot, and
 * the row says so in the engine's vocabulary rather than inventing a journey.
 *
 * The card's in-flight state begins when the ping promise starts and ends when
 * it resolves. Nothing here runs on a timer that could keep moving after the
 * work stopped.
 *
 * -----------------------------------------------------------------------------
 * QUOTES ARE NOT HIDDEN BEHIND A DISCLOSURE
 * -----------------------------------------------------------------------------
 * A provenance panel whose evidence is one click away is a provenance panel that
 * is embarrassed about its evidence. The quote is on the card, clamped to three
 * lines so five of them fit in a rail, and it opens in place.
 *
 * -----------------------------------------------------------------------------
 * AND NEITHER IS THE SUBSTITUTION
 * -----------------------------------------------------------------------------
 * The same argument, applied to the one place it was not being applied. A quote
 * whose `resolution` is not `verbatim` HAS BEEN REWRITTEN, and this card used to
 * report that with a three-word chip and the rewritten text — the reader could
 * learn THAT something had been changed and never what. The proof was two clicks
 * away, inside `Show the source bytes`, which is exactly the shape of a claim
 * asking to be believed.
 *
 * So the card fetches the verbatim segment, diffs the cited text against the
 * bytes on disk, and shows the substitution itself: `The applicant` struck in
 * --evidence, `Tollstrand Battery` marked in --render, with the unchanged prose
 * between the changes elided so the disclosure survives the three-line clamp.
 * Press `Show more` and the whole stream unfolds in place.
 *
 * It is the most trust-building object this product owns, and it now costs
 * nothing to find. Only resolved citations pay for the fetch; a verbatim quote
 * asks the engine for nothing, because there is nothing to compare it to.
 * =============================================================================
 */

import { useCallback, useMemo, useState } from 'react';

import { COPY, citationReasonText, humaniseCode } from '@/copy';
import type { Citation, PathStep } from '@/engine';
import { firePingVolley, type PingRun } from '@/motion';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Glyph, Hash, LodChip, Num, StateDot, Tip, cx } from '@/ui/primitives';

import { Code, NodeId, Note, ResolutionBadge, resolutionTone } from './bits';
import { DiffStream, PassageDrilldown, usePassage } from './PassageDrilldown';
import { coalesce, diffWords, focusChanges } from './diff';
import { citationEdges, type PingEdge } from './tracePing';

/**
 * Status token for the one condition this component can be in that the engine
 * has no code for: the page has no terrain to draw a dot on.
 *
 * It is written as a machine code rather than as a sentence on purpose. The
 * interface's rule is that codes are shown and translated, never replaced — so
 * a condition that has no engine code gets one shaped like the engine's, and the
 * translator turns it into words the same way it turns `budget_exhausted` into
 * words. What it must never do is stay silent and let a dead control look live.
 */
const NO_TERRAIN = 'terrain_not_attached';

/* =============================================================================
 * ONE CARD
 * ========================================================================== */

interface CitationCardProps {
  citation: Citation;
  /** The citation edges this quote would ping down. Empty means it evidences no hop. */
  edges: readonly PingEdge[];
  /** True while this card's dot volley is in the air. */
  flying: boolean;
  /** What the last volley actually did, once it has landed. */
  ping: PingRun | undefined;
  onOpen: () => void;
}

/**
 * A card is its own component because it does its own WORK: a resolved quote has
 * to be diffed against the source bytes, and that is a hook. Held in the parent's
 * map it would have been one fetch decision for five cards, or five hooks in a
 * loop — both of which are the kind of shortcut that ends with a card showing
 * another card's substitution.
 */
function CitationCard({ citation: c, edges, flying, ping, onOpen }: CitationCardProps): JSX.Element {
  const [openQuote, setOpenQuote] = useState(false);
  const [openSource, setOpenSource] = useState(false);
  // Opening the source bytes opens the quote with them: the drilldown renders
  // non-standalone precisely so this card is the one place the passage is named
  // and the one place the text appears, in full.
  const quoteOpen = openQuote || openSource;

  /* THE BYTES ON DISK, FETCHED ONLY WHEN THERE IS SOMETHING TO COMPARE.
     `null` is a real argument to this hook: a verbatim citation asks the engine
     for nothing, because the cited text IS the source text and a diff of a
     string against itself is a paragraph of noise. */
  const resolved = c.resolution !== 'verbatim';
  const bytes = usePassage(resolved ? c.passage_id : null);
  const span = bytes.status === 'ready' ? bytes.data.span : null;

  const runs = useMemo(() => {
    if (!resolved || span === null) return null;
    const raw = diffWords(span, c.quote);
    return raw === null ? null : coalesce(raw);
  }, [resolved, span, c.quote]);

  /* HOW MANY SPANS THE ENGINE TOUCHED, counted rather than described. A chip
     that reads the same whether three phrases were rewritten or one encodes zero
     distance, which is the one thing a resolution disclosure exists to encode. */
  const substitutions = runs === null ? 0 : runs.filter((r) => r.op === 'ins').length;
  const shown = runs === null ? null : quoteOpen ? runs : focusChanges(runs);

  return (
    <article className={cx('pv-cit', flying && 'is-pinging', openSource && 'is-open')}>
      {/* ---- what this quote is ------------------------------------------ */}
      <header className="pv-cit-hd">
        <Glyph kind="passage" tone={resolutionTone(c.resolution)} />
        <NodeId id={c.passage_id} />
        <ResolutionBadge resolution={c.resolution} count={substitutions} />
        <Tip content={COPY.receipt.citations.rows.lod.tip}>
          <LodChip state={c.lod} tone="neutral" />
        </Tip>
      </header>

      {/* ---- the evidence itself, and what was done to it ------------------
          A verbatim quote is printed. A rewritten one is DIFFED — the document's
          words struck, the engine's marked — because the card's claim about it is
          precisely that words were changed, and a claim about words is checkable
          only next to the words. */}
      {/* NO LEGEND ON THE CARD. The drilldown's disclosure section earns one —
          it is that section's whole subject. Here the badge two lines above
          already says `coreference resolved`, so a key printing the same three
          words a third time in 60px was the instrument explaining a convention
          the reader had just been told. The strike and the mark carry it. */}
      {shown === null ? (
        <blockquote className={cx('pv-quote', !quoteOpen && 'is-clamped')}>{c.quote}</blockquote>
      ) : (
        <DiffStream runs={shown} className="pv-cit-diff" />
      )}
      <div className="pv-cit-more">
        <Btn variant="ghost" size="sm" tone="neutral" onClick={() => setOpenQuote(!quoteOpen)}>
          {quoteOpen ? COPY.common.less : COPY.common.more}
        </Btn>
      </div>

      {/* ---- why the renderer spent on it -------------------------------- */}
      <Tip content={COPY.receipt.citations.rows.why.tip}>
        <Code code={c.why_admitted} text={citationReasonText(c.why_admitted)} />
      </Tip>

      {/* ---- the checkable part ------------------------------------------ */}
      <div className="pv-cit-meta">
        <Tip content={COPY.receipt.citations.rows.hash.tip}>
          <Hash value={c.content_hash} />
        </Tip>
        <Tip content={COPY.receipt.citations.rows.tokens.tip}>
          <Num value={c.tokens} format="tokens" unit={COPY.common.units.tokens} tone="dim" />
        </Tip>
      </div>

      {/* ---- the actions ------------------------------------------------- */}
      <div className="pv-actions">
        <Btn
          variant="quiet"
          size="sm"
          tone="neutral"
          onClick={onOpen}
          title={COPY.receipt.citations.open.title}
        >
          {COPY.receipt.citations.open.label}
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          tone="neutral"
          onClick={() => setOpenSource(!openSource)}
          title={COPY.receipt.citations.openSource.title}
        >
          {COPY.receipt.citations.openSource.label}
        </Btn>
        {flying ? <StateDot state="pending" tone="render" /> : null}
        {/* The honest report of what the ping actually did. A control that
            cannot do its job says so; it does not pretend to have done it. */}
        {!flying && ping !== undefined && !ping.attached ? (
          <Code code={NO_TERRAIN} text={humaniseCode(NO_TERRAIN)} />
        ) : null}
        {!flying && edges.length === 0 ? (
          <Tip content={COPY.answer.path.noEvidence}>
            <StateDot state="off" tone="faint" />
          </Tip>
        ) : null}
      </div>

      {/* ---- the source bytes, in place ---------------------------------- */}
      {openSource ? (
        <PassageDrilldown
          passageId={c.passage_id}
          citation={c}
          standalone={false}
          className="pv-cit-src"
        />
      ) : null}
    </article>
  );
}

export interface CitationListProps {
  /** Defaults to the active trace's citations. */
  citations?: readonly Citation[];
  /** The answer path, for resolving which hop each quote evidences. */
  path?: readonly PathStep[];
  /** The constellation's bridge entity, for the one `why_admitted` that names it. */
  bridgeEntityId?: string | null;
  /** Called after the ping lands. Defaults to the store's `openPassage`. */
  onOpenPassage?: (passageId: string) => void;
  className?: string;
}

/** A BODY. It composes into the receipt; it does not bring its own glass. */
export function CitationList({
  citations,
  path,
  bridgeEntityId,
  onOpenPassage,
  className,
}: CitationListProps): JSX.Element {
  const store = useAtlasStore((s) => ({
    citations: s.trace?.citations ?? null,
    path: s.query.active?.constellation.path ?? null,
    bridge: s.query.active?.constellation.bridge_entity_id ?? null,
    /* THE WITNESS. The volley declares which receipt it is travelling on behalf
       of, and `@/motion` fails it against the live store if that receipt does
       not cite the passage the dot is flying to. A dot with no citation behind
       it is precisely the failure this panel exists to make impossible. */
    traceId: s.trace?.trace_id ?? null,
  }));

  const list = citations ?? store.citations ?? [];
  const steps = path ?? store.path ?? [];
  const bridge = bridgeEntityId !== undefined ? bridgeEntityId : store.bridge;

  const [inFlight, setInFlight] = useState<string | null>(null);
  const [lastPing, setLastPing] = useState<Record<string, PingRun>>({});

  const traceId = store.traceId;
  const open = useCallback(
    async (citation: Citation) => {
      const edges = citationEdges(citation, steps, bridge);
      setInFlight(citation.citation_id);
      // The volley resolves WHEN THE LAST DOT LANDS. The hairline it leaves is
      // held and released by the motion layer's own run, so opening the passage
      // is not made to wait for a mark to finish being looked at.
      const result = await firePingVolley(edges, traceId ?? '');
      setLastPing((prev) => ({ ...prev, [citation.citation_id]: result }));
      setInFlight(null);
      if (onOpenPassage) onOpenPassage(citation.passage_id);
      else void useAtlas.getState().openPassage(citation.passage_id);
    },
    [steps, bridge, onOpenPassage, traceId],
  );

  if (list.length === 0) {
    return <Note className={className}>{COPY.receipt.citations.empty}</Note>;
  }

  return (
    <div className={cx('pv-cits', className)}>
      {list.map((c) => (
        <CitationCard
          key={c.citation_id}
          citation={c}
          edges={citationEdges(c, steps, bridge)}
          flying={inFlight === c.citation_id}
          ping={lastPing[c.citation_id]}
          onOpen={() => void open(c)}
        />
      ))}
    </div>
  );
}
