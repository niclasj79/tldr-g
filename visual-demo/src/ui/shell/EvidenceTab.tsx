/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE EVIDENCE TRAIL
 * =============================================================================
 *
 * EVERY SOURCE THE ANSWER STANDS ON, GROUPED BY THE HOP IT SUPPORTS.
 *
 * The count promised a choice and the click did not honour it. `Evidence 3` on a
 * hop of the answer path opened `evidence_passage_ids[0]` — always the first,
 * never a choice — and did it by navigating the whole application to the passage
 * rung, replacing the view, the scope, the breadcrumb and the camera. Two of the
 * three sources the badge had just counted were unreachable from the control
 * that counted them, and the reader arrived somewhere else entirely without
 * having chosen to go.
 *
 * So the count now opens THIS: a list of all of them, grouped by hop, each with
 * three explicit verbs rather than one implicit one.
 *
 *   READ SOURCE      the verbatim bytes and their hash. This is the one that
 *                    genuinely travels — and it leaves a `Back` behind it now.
 *   LOCATE ON MAP    holds the passage on the terrain WITHOUT leaving this
 *                    surface. "Where is this?" and "what does it say?" are two
 *                    different questions and used to have one answer.
 *   COMPARE          only appears where a hop has more than one source, because
 *                    that is the only place it means anything. Two independent
 *                    documents supporting one claim is the strongest thing this
 *                    corpus can say, and it had no affordance at all.
 *
 * -----------------------------------------------------------------------------
 * THE RECEIPT IS UNDER THE SOURCES, AND IT IS FOLDED
 * -----------------------------------------------------------------------------
 * The render trace was 3,022px of the old rail's 6,409. It is not less important
 * for being folded — it is the thing a sceptic opens second, after seeing which
 * documents the answer rests on. Arithmetic, admissions, omissions and the
 * signature each open on their own.
 * =============================================================================
 */

import { useState } from 'react';

import { COPY, citationReasonText } from '@/copy';
import type { Citation, PathStep } from '@/engine';
import { useAtlas, useAtlasStore } from '@/state';
import { ReceiptPanel, VerificationPanel } from '@/ui/provenance';
import { Btn, Disclosure, Hash, Num, Panel, SectionLabel, Tip } from '@/ui/primitives';

/* -----------------------------------------------------------------------------
 * Grouping. One hop, its relation family, and every citation that evidences it.
 * -------------------------------------------------------------------------- */

interface HopGroup {
  step: PathStep;
  citations: Citation[];
}

/**
 * Group the trace's citations under the hops they were admitted for.
 *
 * THE HOP INDEX COMES FROM THE ENGINE, NOT FROM A GUESS. `why_admitted` carries
 * it (`on_answer_path_hop_2`, `evidences_hop_1_operated_by`), and where it does
 * not, the passage id is matched against the step's own `evidence_passage_ids`.
 * A citation that matches neither is NOT silently dropped — it lands in the
 * unattached group below, because a quote the answer paid for and this view
 * cannot place is exactly the thing a reader should be told about.
 */
function groupByHop(
  path: readonly PathStep[],
  citations: readonly Citation[],
): { groups: HopGroup[]; unattached: Citation[] } {
  const groups: HopGroup[] = path.map((step) => ({ step, citations: [] }));
  const unattached: Citation[] = [];

  for (const c of citations) {
    const m = /_hop_(\d+)/.exec(c.why_admitted);
    const byCode = m === null ? -1 : Number(m[1]);
    const byId = path.findIndex((s) => s.evidence_passage_ids.includes(c.passage_id));
    const index = byCode >= 0 && byCode < groups.length ? byCode : byId;
    if (index >= 0 && index < groups.length) groups[index].citations.push(c);
    else unattached.push(c);
  }
  return { groups, unattached };
}

/* -----------------------------------------------------------------------------
 * One source, with its three verbs.
 * -------------------------------------------------------------------------- */

function SourceRow({
  citation,
  comparing,
  onCompare,
  canCompare,
}: {
  citation: Citation;
  comparing: boolean;
  onCompare: () => void;
  canCompare: boolean;
}): JSX.Element {
  return (
    <li className="ev__src" data-comparing={comparing}>
      <blockquote className="ev__quote t-13" data-prose>
        {citation.quote}
      </blockquote>

      <div className="ev__meta">
        <Tip content={COPY.receipt.citations.rows.hash.tip}>
          <Hash value={citation.content_hash} />
        </Tip>
        <Tip content={citationReasonText(citation.why_admitted)}>
          <span className="ev__why t-11 ink-dim" data-prose>
            {citationReasonText(citation.why_admitted)}
          </span>
        </Tip>
      </div>

      {/* THREE VERBS, AND EACH ONE SAYS WHAT IT COSTS YOU.
          Only the first leaves this surface, and its title says so. */}
      <div className="ev__acts">
        <Btn
          variant="quiet"
          size="sm"
          onClick={() => void useAtlas.getState().openPassage(citation.passage_id)}
          title={COPY.evidence.read.title}
        >
          {COPY.evidence.read.label}
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          onClick={() => {
            /* HOLD IT, DO NOT TRAVEL TO IT. `selectNode` would switch the rail to
               Inspect and take the reader off the list they are working through;
               framing alone would move the camera to a node that is not lit. So:
               `highlightNode` lights it and leaves the rail where it is, and the
               frame is a second, deliberate call. Both halves of "where is this",
               neither half of "what does it say". */
            const st = useAtlas.getState();
            st.highlightNode(citation.passage_id);
            void st.frameIds([citation.passage_id], 140);
          }}
          title={COPY.evidence.locate.title}
        >
          {COPY.evidence.locate.label}
        </Btn>
        {canCompare ? (
          <Btn variant="ghost" size="sm" onClick={onCompare} title={COPY.evidence.compare.title}>
            {comparing ? COPY.evidence.compare.stop : COPY.evidence.compare.label}
          </Btn>
        ) : null}
      </div>
    </li>
  );
}

/* =============================================================================
 * THE TAB
 * ========================================================================== */

export interface EvidenceTabProps {
  className?: string;
}

export function EvidenceTab({ className }: EvidenceTabProps): JSX.Element {
  const { path, citations, hasTrace } = useAtlasStore((s) => ({
    path: s.query.active?.constellation.path ?? [],
    citations: s.trace?.citations ?? [],
    hasTrace: s.trace !== null,
  }));

  /** Which hop is in side-by-side mode. At most one, because a comparison is a pair. */
  const [comparing, setComparing] = useState<number | null>(null);

  const { groups, unattached } = groupByHop(path, citations);
  const total = citations.length;

  return (
    <div className={['ev', className].filter(Boolean).join(' ')}>
      <Panel
        title={
          <>
            {COPY.tabs.evidence.label}
            <span className="ev__tech ink-faint"> · {COPY.tabs.evidence.technical}</span>
          </>
        }
        tone="evidence"
        actions={<Num value={total} format="int" tone="evidence" />}
      >
        {total === 0 ? (
          <p className="t-13 ink-dim" data-prose>
            {COPY.receipt.citations.empty}
          </p>
        ) : (
          <ol className="ev__hops">
            {groups.map((g, i) => (
              <li key={g.step.edge_id} className="ev__hop" data-comparing={comparing === i}>
                <SectionLabel>
                  {COPY.answer.path.hop}
                  <Num value={g.step.index + 1} format="int" tone="dim" /> · {g.step.family}
                </SectionLabel>
                {g.citations.length === 0 ? (
                  <p className="t-12-5 tone-alarm u-tone" data-prose>
                    {COPY.answer.path.noEvidence}
                  </p>
                ) : (
                  <ul className="ev__srcs">
                    {g.citations.map((c) => (
                      <SourceRow
                        key={c.citation_id}
                        citation={c}
                        canCompare={g.citations.length > 1}
                        comparing={comparing === i}
                        onCompare={() => setComparing((prev) => (prev === i ? null : i))}
                      />
                    ))}
                  </ul>
                )}
              </li>
            ))}
            {unattached.length === 0 ? null : (
              <li className="ev__hop">
                {/* NOT DROPPED. A quote the budget paid for that this view cannot
                    place on the path is a fact about the render, and hiding it
                    would make the grouping look tidier than the render was. */}
                <SectionLabel>{COPY.evidence.unattached}</SectionLabel>
                <ul className="ev__srcs">
                  {unattached.map((c) => (
                    <SourceRow key={c.citation_id} citation={c} canCompare={false} comparing={false} onCompare={() => {}} />
                  ))}
                </ul>
              </li>
            )}
          </ol>
        )}
      </Panel>

      {/* ---- the receipt, folded. See the header. ------------------------
              THE SUMMARY IS A REASON TO OPEN, NOT A SECOND TITLE. A disclosure
              labelled `Render trace` wrapping a panel titled `Render trace`
              prints one heading twice and teaches the reader that the fold is
              chrome. The fold says what opening it gets you; the panel inside
              says what the thing is called.

              AND THE CITATION LIST IS NOT REPEATED HERE. `ReceiptPanel` renders
              it already — the sources above are grouped by HOP, which is the
              reading a sceptic wants first, and the receipt's own list is
              grouped by ADMISSION, which is the engine's accounting. Two
              groupings of one set is a feature; two copies of one list is not. */}
      {!hasTrace ? null : (
        <>
          <Disclosure summary={COPY.evidence.receiptFold} className="ev__fold">
            <ReceiptPanel />
          </Disclosure>
          <Disclosure summary={COPY.evidence.signatureFold} className="ev__fold">
            <VerificationPanel />
          </Disclosure>
        </>
      )}
    </div>
  );
}
