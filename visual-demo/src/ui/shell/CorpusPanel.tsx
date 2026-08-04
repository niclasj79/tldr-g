/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — WHAT THE RAIL HOLDS BEFORE ANYTHING HAS BEEN ASKED
 * =============================================================================
 *
 * The resting frame is the one everybody sees first, and its right third was
 * ~700px of void under a single QUESTION panel. This file is what now stands in
 * that space, and the rule it was built under is the only one that matters here:
 * EVERYTHING IN IT IS A MEASUREMENT OR A CONTROL. No invented metric, no chart
 * for texture, nothing that competes with the terrain.
 *
 * -----------------------------------------------------------------------------
 * TWO PANELS, AND WHY THESE TWO
 * -----------------------------------------------------------------------------
 * STAGED QUESTIONS  The corpus ships a set of questions that have
 *                   by-construction answers — that is what makes this engine
 *                   scoreable instead of believable. Exactly one of them was
 *                   visible, in the command bar; the rest were behind a `/`
 *                   palette nobody knows about on their first frame. They are
 *                   the most useful thing that can occupy this column at rest,
 *                   because they are what turns a resting map into a render.
 *
 * CORPUS            The census of the spine and the identity of the bake, both
 *                   read off `LayoutBake.positions` and the bake header. Nothing
 *                   else in the product prints either: the HUD's `NODES` is the
 *                   CURRENT VIEW's node count at one rung, and this is the whole
 *                   world at all four. Two different quantities, and the labels
 *                   say which is which.
 *
 * -----------------------------------------------------------------------------
 * WHAT WAS DELIBERATELY LEFT OUT
 * -----------------------------------------------------------------------------
 *   the integrity rows       `QuarantinePanel` owns them and prints five of them
 *                            with a rate. Reprinting `Relations extracted /
 *                            Admitted / Quarantined` here would put two panels in
 *                            one column reciting one report.
 *   the resolution ramp      the HUD prints the live partition, per tier, with
 *                            the counts. A second legend for it in the rail is
 *                            the same sentence twice, 800px apart.
 *   the staged question that is currently loaded
 *                            it is already on screen twice — in the command bar
 *                            and in the QUESTION panel directly above this list.
 *                            A third copy in a menu is how the floating staged
 *                            card got deleted, and it is not coming back under a
 *                            different name. The list is THE OTHERS.
 *
 * -----------------------------------------------------------------------------
 * CLICKING A QUESTION STAGES IT. IT DOES NOT RUN IT.
 * -----------------------------------------------------------------------------
 * The whole ten-second thesis is that the engine has not spent a token yet and
 * the first render is the user's own act. A menu item that quietly spends the
 * budget takes that act away and replaces it with a list of results. So a click
 * loads the question into the command bar and the QUESTION panel above — where
 * the Render button is, next to the sentence that says nothing has been spent.
 * =============================================================================
 */

import { useMemo } from 'react';

import { COPY, intentCopy } from '@/copy';
import { RUNGS } from '@/engine';
import type { LayoutBake, Rung } from '@/engine';
import { useAtlas, useAtlasStore } from '@/state';
import { Chip, Divider, Hash, Num, Panel, Row, SectionLabel, Tip } from '@/ui/primitives';

/* =============================================================================
 * THE SPINE CENSUS
 * ========================================================================== */

type Census = Readonly<Record<Rung, number>>;

/**
 * Count the bake's own positions by rung.
 *
 * The bake is the right thing to count, not the current view: `view.nodes` is
 * one rung under one scope and is exactly what the HUD already reports. The bake
 * is every node in the world, at its baked position, which is the only object in
 * the client that can answer "how big is this corpus".
 *
 * ENTITIES ARE NOT COUNTED HERE, and that is not an omission. They are not a
 * rung — they are the cross-cutting layer above the spine — and a column headed
 * `The spine` with a fifth row in it that is not on the spine would be the
 * product contradicting its own doctrine to fill a panel. The note under the
 * census says so in the deck's own words.
 */
function censusOf(bake: LayoutBake | null): Census | null {
  if (bake === null) return null;
  const out: Record<Rung | 'passage', number> = { continent: 0, island: 0, asset: 0, passage: 0 };
  for (const p of bake.positions) {
    if (p.kind === 'continent' || p.kind === 'island' || p.kind === 'asset' || p.kind === 'passage') {
      out[p.kind] += 1;
    }
  }
  return out;
}

export interface CorpusPanelProps {
  className?: string;
}

/**
 * The corpus, measured: what is in it, and which bake the positions came from.
 */
export function CorpusPanel({ className }: CorpusPanelProps): JSX.Element | null {
  const bake = useAtlasStore((s) => s.bake);

  /* The bake carries every position in the world, so this is a loop over
     thousands of records. It runs once per bake and never on a hover. */
  const census = useMemo(() => censusOf(bake), [bake]);
  if (bake === null || census === null) return null;

  return (
    <Panel title={COPY.topbar.corpus.label} className={className}>
      <SectionLabel>{COPY.rungs.title}</SectionLabel>

      {RUNGS.map((rung) => (
        <Row
          key={rung}
          label={COPY.rungs.levels[rung].plural}
          title={COPY.rungs.levels[rung].short}
          value={<Num value={census[rung]} format="tokens" tone="dim" />}
        />
      ))}

      {/* Why there is no fifth row. */}
      <p className="t-12-5 ink-dim" data-prose>
        {COPY.rungs.entityNote}
      </p>

      {/* NO SECOND SECTION LABEL. A `BAKE` heading over a row labelled `Bake` is
          the same word twice in 20px; the rule is the grouping. */}
      <Divider />

      {/* MONO, NOT `Hash`. The receipt's own convention: an ID is a machine
          string on the mono rail, and `Hash` — which is amber, because amber is
          the evidence light — is reserved for a digest somebody can recompute.
          `bake_<16 hex>` is a name for a layout, not a claim about bytes. */}
      <Row
        label={COPY.topbar.bake.label}
        title={COPY.topbar.bake.tip}
        mono
        tone="dim"
        value={bake.bake_id}
      />
      {/* NO TOOLTIP ON THIS ROW ON PURPOSE. The deck's `trust.hash` tip is about
          a PASSAGE's hash — SHA-256 over verbatim source bytes — and this hash
          covers the corpus content the bake was computed from. Borrowing the
          sentence would describe the wrong object, and the `Hash` primitive
          already carries the full value in its own title. */}
      <Row label={COPY.trust.hash.label} value={<Hash value={bake.content_hash} chars={10} />} />

      {/* ANCHOR DRIFT ONLY EXISTS AFTER A SECOND BAKE. `anchor_alignment` is
          null for a first layout because there was nothing to align to, and
          printing a zero there would claim a measurement that was never taken. */}
      {bake.anchor_alignment === null ? null : (
        <Row
          label={COPY.topbar.bake.drift.label}
          title={COPY.topbar.bake.drift.tip}
          value={
            <Num
              value={bake.anchor_alignment.mean_drift}
              format="float2"
              tone="dim"
              unit={COPY.topbar.bake.drift.unit}
            />
          }
        />
      )}
    </Panel>
  );
}

/* =============================================================================
 * THE STAGED QUESTIONS
 * ========================================================================== */

export interface StagedQuestionsProps {
  className?: string;
}

/**
 * The corpus's own question set, minus the one already loaded.
 *
 * Each row is the real `StagedQuery` payload: the engine's declared intent for
 * it, and the corpus's own one-line reason for the question existing. Nothing
 * here is a suggestion this interface made up.
 */
export function StagedQuestions({ className }: StagedQuestionsProps): JSX.Element | null {
  const { stagedQueries, staged, app } = useAtlasStore((s) => ({
    stagedQueries: s.stagedQueries,
    staged: s.query.staged,
    app: s.app,
  }));

  const loaded = staged.trim();
  const others = stagedQueries.filter((q) => q.query !== loaded);
  if (others.length === 0) return null;

  return (
    <Panel title={COPY.command.menu.title} tone="curiosity" className={className}>
      <p className="t-12-5 ink-dim" data-prose>
        {COPY.command.menu.note}
      </p>

      <ul className="sq">
        {others.map((q) => (
          <li key={q.query}>
            {/* `u-block` because `.tip-anchor` is inline-flex and would otherwise
                shrink-to-fit around a control that is meant to be the width of
                the column. */}
            <Tip content={q.why} className="u-block">
              {/* LIVE IN DEGRADED, ON PURPOSE. `QUERY_NO_MATCH`'s remedy is
                  literally "try one of the staged questions", and the alarm band
                  carrying that sentence is 12px above this list. A menu that
                  greys itself out at the moment its own remedy names it would be
                  the interface refusing to perform what it just prescribed.
                  Only a render in flight disables it, because staging a second
                  question under a running one is the one case that would leave
                  the command bar disagreeing with the answer that lands. */}
              <button
                type="button"
                className="sq__item"
                disabled={app === 'QUERYING'}
                onClick={() => useAtlas.getState().stageQuery(q.query)}
              >
                <span className="sq__q t-12-5" data-prose>
                  {q.query}
                </span>
                <Chip tone="curiosity">{intentCopy(q.intent).label}</Chip>
              </button>
            </Tip>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
