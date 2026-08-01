/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE LOOKUP VIEW
 * =============================================================================
 *
 * One hop, stated as one claim, with the passage it rests on underneath it.
 *
 * THE FLOOR CASE, AND THE ONE MOST EASILY OVERREACHED. The corpus's own note on
 * this staged question is `One hop, one citation. The floor case: the engine
 * should spend almost nothing to answer it.` The interface was spending far more
 * than the engine: the same confidence gauge, the same four-signal decomposition,
 * the same numbered hop list and the same re-derivation block that a two-hop
 * cross-island bridge answer gets — around a single `operated_by` edge. A layout
 * that costs the same for a one-hop answer as for a four-hop one is a layout that
 * is not reading its own input.
 *
 * So this view is three things and stops: the claim as a sentence, one source,
 * and the line saying where the arrangement came from.
 *
 * -----------------------------------------------------------------------------
 * WHY THE QUOTE IS HERE AND THE OTHER SOURCES ARE NOT
 * -----------------------------------------------------------------------------
 * "Direct answer plus ONE evidence link" is the whole brief for this intent, and
 * the first citation the render admitted is the honest thing to show — labelled
 * with its resolution, because a coref- or term-resolved span is no longer
 * literally what the document says and presenting it as verbatim is the exact
 * failure the schema's disclosure field exists to prevent. Every other source for
 * the hop is one press away in the evidence trail; duplicating that list here
 * would make the floor case the heaviest surface in the product again.
 * =============================================================================
 */

import { COPY, resolutionCopy } from '@/copy';
import type { Citation, PathStep } from '@/engine';
import { Hash, Num, Tip } from '@/ui/primitives';

import {
  DerivedNote,
  EvidenceChip,
  IntentHead,
  NoEvidence,
  NodeName,
  Relation,
  StraitMark,
  hopEvidence,
  type IntentViewProps,
} from './BridgeView';

/**
 * The first citation the render admitted for this hop, or `null`.
 *
 * MATCHED BY PASSAGE ID, NOT BY POSITION. `citations[0]` is whatever the receipt
 * happened to list first, which for a multi-hop render is frequently a different
 * hop's source entirely — and a quote shown under the wrong claim is a fabricated
 * pairing even though both halves are real.
 */
function firstCitation(trace: IntentViewProps['trace'], step: PathStep): Citation | null {
  if (trace === null) return null;
  const wanted = new Set(step.evidence_passage_ids);
  return trace.citations.find((c) => wanted.has(c.passage_id)) ?? null;
}

export function LookupView({
  active,
  nodes,
  trace,
  disputed,
  className,
}: IntentViewProps): JSX.Element {
  const path = active.constellation.path;

  return (
    <div
      className={['iv', 'iv-lk', className].filter(Boolean).join(' ')}
      data-disputed={disputed}
    >
      <IntentHead
        intent="lookup"
        disputed={disputed}
        aside={
          path.length > 1 ? (
            <Num value={path.length} format="int" tone="dim" unit={COPY.common.units.hops} />
          ) : undefined
        }
      />

      {/* FREE TEXT LANDS HERE TOO, AND IT DOES NOT ALWAYS RETURN ONE HOP.
          An ad-hoc question is answered from three or four edges incident to the
          matched entity. That is a different thing from the staged one-hop case
          and the difference is stated rather than smoothed over by a layout that
          looks the same either way. */}
      {path.length > 1 ? (
        <p className="iv__note t-12-5 ink-dim" data-prose>
          {COPY.intentViews.lookup.several}
        </p>
      ) : null}

      <ul className="iv__claims">
        {path.map((step) => {
          const citation = firstCitation(trace, step);
          return (
            <li key={step.edge_id} className="iv-lk__claim">
              <p className="iv-lk__stmt t-14" data-prose>
                <NodeName id={step.from_id} nodes={nodes} />
                <Relation step={step} />
                <NodeName id={step.to_id} nodes={nodes} />
                {step.crosses_strait ? <StraitMark /> : null}
              </p>

              {step.evidence_passage_ids.length === 0 ? (
                <NoEvidence />
              ) : (
                <div className="iv-lk__ev">
                  {citation === null ? null : (
                    <>
                      <blockquote className="iv-lk__quote t-13" data-prose>
                        {citation.quote}
                      </blockquote>
                      <div className="iv-lk__meta">
                        <Tip content={COPY.intentViews.lookup.quote.tip}>
                          {/* THE ONLY CONTROL IN THIS VIEW, AND THE PRIMITIVE'S
                              SMALLEST. `button.hash` floors at --hit-floor (24px)
                              — the WCAG 2.2 minimum rather than this product's
                              own 32/36 — because a digest set inline beside a
                              label cannot be padded to 36 without becoming a
                              button. Here it is not inline in a sentence: it has
                              its own row under the quote, so the stylesheet
                              beside this file raises it to --hit-row. Measured
                              24px before, 32px after, with the type unmoved. */}
                          <Hash value={citation.content_hash} />
                        </Tip>
                        {/* THE RESOLUTION DISCLOSURE TRAVELS WITH THE QUOTE.
                            `verbatim` is the guarantee and needs no badge; the
                            other two are transformations and are named where the
                            text is, not in a legend elsewhere. */}
                        {citation.resolution === 'verbatim' ? null : (
                          <Tip content={resolutionCopy(citation.resolution).long}>
                            <span className="caps ink-dim">
                              {resolutionCopy(citation.resolution).label}
                            </span>
                          </Tip>
                        )}
                      </div>
                    </>
                  )}
                  <EvidenceChip evidence={hopEvidence(trace, step)} />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <DerivedNote intent="lookup" />
    </div>
  );
}
