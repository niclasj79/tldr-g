/**
 * =============================================================================
 * THE RECEIPT — the render trace made legible
 * =============================================================================
 *
 * Three numbers and the ratio between them are the entire product claim:
 *
 *   Budget            10 000 tok   the ceiling, and it binds
 *   Rendered           5 040 tok   summed from the admission rows below
 *   Stuffed context   21 044 tok   what the naive alternative would have cost
 *   Saved               76.1 %     one minus the second over the third
 *
 * Not one of them is asserted anywhere. `tokens_rendered` is a sum over
 * `admitted[].tokens`; `counterfactual_tokens` is a sum over the real per-asset
 * token counts of the 32 assets the constellation touches; the percentage is
 * computed from the other two. `assertDemoReceipt()` throws if they ever stop
 * adding up — so this panel can print them without a hedge.
 *
 * -----------------------------------------------------------------------------
 * THE ONE CELEBRATORY MOMENT IN THE PRODUCT, AND WHERE IT SITS
 * -----------------------------------------------------------------------------
 * It is the FIRST THING IN THE RAIL after a render. It used to be the fourth —
 * under the answer, the confidence gauge and the path — and the measurement was
 * unambiguous: in the 1440p frame named `receipt`, the four numbers the entire
 * thesis rests on sat at 70% of the way down the column, printed at 12.5px,
 * bracketed by two paragraphs of justification. The product's one celebratory
 * moment was, in the scene named after it, the least prominent thing on screen.
 *
 * So the block is now four figures on one right-hand column and nothing else:
 *
 *   Stuffed context   21 044 tok    what the naive alternative would have cost
 *   Rendered           5 040 tok    the hero, 28px, counted down from the above
 *   ────────────────────────────    a rule, because this is a receipt
 *   Saved                 76.1 %    the bottom line
 *   Budget            [▓▓▓▓░░░░]    the ceiling, and that it binds
 *
 * That is a receipt: an itemisation, a rule, a total. Right-aligned on one
 * column so the subtraction is a thing the eye performs rather than a thing the
 * copy asserts.
 *
 * The COUNT-DOWN is the state transition itself, not an entrance animation: the
 * naive number becoming the real one. While it runs the block carries a --render
 * inset rail on its leading edge — the same in-flight mark a citation card wears
 * — and drops it when the figure settles. Both endpoints stay printed, so
 * nothing here is only ever seen moving.
 *
 * It is guarded at MODULE scope by `query_id`, not by component state, so
 * switching tabs and coming back does not replay it. A celebration that fires
 * every time you look at the panel is a celebration of nothing.
 *
 * Its duration is `--t-scene`, read by `<Num countFrom>` from the stylesheet.
 * The brief said 800ms; the token file says 700ms and the token file wins — a
 * fourth duration in this product would be a fourth duration forever.
 *
 * -----------------------------------------------------------------------------
 * IT STOPS CELEBRATING WHEN THE PAYLOAD MOVES
 * -----------------------------------------------------------------------------
 * `tokens_rendered` is a sum over the admission list, and the admission list is
 * inside the signed payload. So a payload-hash failure means this arithmetic was
 * measured over bytes that are no longer on screen. The figures stay — they are
 * still what is drawn — but the lights come off them and the block says which
 * half failed. A receipt that keeps printing 76.1% at full strength over a
 * payload it has just disproved is worse than no receipt.
 *
 * -----------------------------------------------------------------------------
 * WHERE THE LIGHTS ARE SPENT IN THIS PANEL, AND WHERE THEY ARE NOT
 * -----------------------------------------------------------------------------
 * ONE light, on ONE figure: `Rendered` is --render, because it is literally the
 * count of what the engine attended to. `Saved` — the bottom line, and the most
 * tempting thing on the screen to paint — is INK. It is a ratio this panel
 * computed, not old light from a source, and gold on it is gold spent on a
 * result. Hierarchy here is size, weight and the rule above the total, which is
 * how a receipt has always done it.
 *
 * The LOD tags, the admission tiers and the σ-classes are chrome and read as
 * chrome. They were teal and gold; five adjacent figures in three lights is not
 * an instrument, it is a legend for a palette.
 *
 * -----------------------------------------------------------------------------
 * ONE OWNER PER FACT
 * -----------------------------------------------------------------------------
 * RENDER CONFIDENCE AND ITS DECOMPOSITION ARE NOT HERE. The answer panel prints
 * L and its four signals directly under the sentence they qualify, and this
 * panel printed the identical gauge and the identical four tracks 400px below —
 * two instruments, one reading, in a rail that was already too long to reach the
 * signature block. The weights survive, inside the trace disclosure, which is
 * where an arithmetic detail belongs.
 * =============================================================================
 */

import { useState } from 'react';

import { COPY, admissionReasonText, omissionReasonText } from '@/copy';
import { CONFIDENCE_WEIGHTS, SIGMA_CLASSES, byFamily } from '@/engine';
import type {
  QueryRenderResponse,
  RelationFamily,
  RenderStats,
  RenderTraceV1,
  SigmaClass,
  VerifyResult,
} from '@/engine';
import { useReceiptCelebration } from '@/motion';
import { useAtlasStore } from '@/state';
import {
  Btn,
  Chip,
  Disclosure,
  Divider,
  Hash,
  LodChip,
  Meter,
  Num,
  Panel,
  Row,
  SectionLabel,
  Tip,
  cx,
  type Tone,
} from '@/ui/primitives';

import { CitationList } from './CitationList';
import { RepudiationLayer } from './RepudiationLayer';
import { Code, Empty, NodeId, Note, ProvenanceChip, Why } from './bits';
import { VerifyBadge } from './VerificationPanel';

/* =============================================================================
 * 1. THE CELEBRATION GUARD
 * -----------------------------------------------------------------------------
 * IT LIVES IN `@/motion`, NOT HERE, AND THAT IS THE FIX.
 *
 * The rule is once per QUERY: the count is the state transition — 21 044 tokens
 * becoming 5 040 — and a transition happens once. Held in this file it was a
 * rule about this panel, which is a different and weaker thing: the panel is not
 * the only surface that can show a receipt, and two copies of a once-per-query
 * guard is a once-per-query guard that fires twice.
 *
 * The hook keeps every property this one had — the module-scope id set, the seed
 * computed in the `useState` initialiser so the first painted frame is already
 * the figure the count starts from, and the per-instance ref that survives
 * StrictMode's double effect — and adds the two this file could not have: the
 * count is registered on the shared timeline, so `settled()` waits for it and
 * `motionLog()` reports the duration it MEASURED rather than the one it asked
 * for; and it carries a witness, so a count that fires without a rendered query
 * behind it is reported by `audit().animationsWithoutState` instead of looking
 * like a feature.
 * ========================================================================== */

/* =============================================================================
 * 2. SMALL PARTS
 * ========================================================================== */

/** The four signals of L, in weighting order. Keys of the engine's own composite. */
const SIGNALS = ['semantic', 'topology', 'temporal', 'authorial'] as const;
type SignalKey = (typeof SIGNALS)[number];

/**
 * One line of the receipt: a caps label on the left, a figure on the right, both
 * on the same baseline and every figure on the same right edge.
 *
 * It is not a `<Row>`. A Row truncates its label to fit its value, which is the
 * correct trade in a dense readout table and the wrong one here: these four
 * labels are the argument, and `Stuffed cont…` next to `21 044 tok` is the
 * priority inverted. This one wraps its label and never elides it.
 */
function ReceiptLine({
  label,
  tip,
  size,
  children,
}: {
  label: string;
  tip: string;
  size: 'sm' | 'md' | 'lg';
  children: JSX.Element;
}): JSX.Element {
  return (
    <div className={cx('pv-rl', `is-${size}`)}>
      <Tip content={tip}>
        <span className="pv-rl-l">{label}</span>
      </Tip>
      <span className="pv-rl-v">{children}</span>
    </div>
  );
}

/**
 * σ-class tone. TWO STEPS OF INK, AND NO LIGHT AT ALL.
 *
 * `authorial` used to wear --evidence, on the argument that it is the class the
 * evidence light is drawn from. The argument is true and the decision was still
 * wrong: it put gold on a CATEGORY, so a filled amber `attributed to 1` chip sat
 * eleven pixels from the amber content hash it was supposed to be distinguished
 * from. A light spent on a taxonomy is a light that has stopped meaning anything
 * — which is precisely how this product's gold decayed the first time.
 *
 * So a σ-class is chrome and reads as chrome. `structural` is set one step
 * further back because it is exempt from the truth gate and asserts nothing
 * about the world; everything else is --ink-dim. No σ-class gets a colour.
 */
function sigmaTone(sigma: SigmaClass): Tone {
  return sigma === 'structural' ? 'faint' : 'dim';
}

interface FamilyGroup {
  sigma: SigmaClass;
  families: { family: RelationFamily; count: number }[];
  uses: number;
}

/** Group the family usage by σ-class, in the vocabulary's own class order. */
function groupFamilies(stats: RenderStats): FamilyGroup[] {
  return SIGMA_CLASSES.map((sigma) => {
    const families = stats.families_used
      .filter((f) => f.sigma === sigma)
      .map((f) => ({ family: f.family, count: f.count }));
    return { sigma, families, uses: families.reduce((n, f) => n + f.count, 0) };
  }).filter((g) => g.families.length > 0);
}

/** Group the omitted frontier by the engine's own `why_omitted` code. */
function groupOmitted(trace: RenderTraceV1): { code: string; ids: string[] }[] {
  const map = new Map<string, string[]>();
  for (const pointer of trace.omitted_but_connected) {
    const list = map.get(pointer.why_omitted) ?? [];
    list.push(pointer.node_id);
    map.set(pointer.why_omitted, list);
  }
  return [...map.entries()]
    .map(([code, ids]) => ({ code, ids }))
    .sort((a, b) => b.ids.length - a.ids.length || (a.code < b.code ? -1 : 1));
}

/* =============================================================================
 * 3. THE PANEL
 * ========================================================================== */

export interface ReceiptPanelProps {
  trace?: RenderTraceV1 | null;
  /** Defaults to `active.render_stats`. */
  stats?: RenderStats | null;
  active?: QueryRenderResponse | null;
  verify?: VerifyResult | null;
  /** Forwarded to the citation list. Defaults to the store's `openPassage`. */
  onOpenPassage?: (passageId: string) => void;
  className?: string;
}

export function ReceiptPanel({
  trace,
  stats,
  active,
  verify,
  onOpenPassage,
  className,
}: ReceiptPanelProps): JSX.Element {
  const store = useAtlasStore((s) => ({
    trace: s.trace,
    active: s.query.active,
    verify: s.verify,
    tampered: s.tampered,
  }));

  const t = trace !== undefined ? trace : store.trace;
  const a = active !== undefined ? active : store.active;
  const v = verify !== undefined ? verify : store.verify;
  const st = stats !== undefined ? stats : (a?.render_stats ?? null);

  const [copied, setCopied] = useState(false);

  const { countFrom, counting } = useReceiptCelebration(
    t === null || st === null ? null : t.query_id,
    st?.counterfactual_tokens ?? NaN,
  );

  if (t === null || st === null) {
    return (
      <Panel
        title={COPY.receipt.title}
        className={cx('pv-panel', 'pv-receipt', className)}
        actions={<ProvenanceChip />}
      >
        <Empty title={COPY.receipt.emptyTitle} body={COPY.receipt.empty} />
      </Panel>
    );
  }

  /* THE ARITHMETIC IS INSIDE THE SIGNED PAYLOAD. `tokens_rendered` is a sum over
     the admission list; the admission list is what the payload hash covers. If
     that hash stopped matching, this block is measuring bytes that are gone, so
     it keeps its figures — they are still what is drawn — and loses its lights. */
  const payloadMoved = store.tampered || (v !== null && !v.payload_hash_matches);
  const failure = payloadMoved ? COPY.trust.verify.invalidPayload : null;

  const families = groupFamilies(st);
  const omitted = groupOmitted(t);
  const cacheRate = st.cache_lookups === 0 ? NaN : (st.cache_hits / st.cache_lookups) * 100;

  const copyTrace = (): void => {
    const write = navigator.clipboard?.writeText(JSON.stringify(t, null, 2));
    Promise.resolve(write)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  return (
    <>
    {/* The map's half of the repudiation. Rendered from here as well as from the
        signature panel because either can be the only trust panel a host mounts,
        and the terrain must not go on vouching for a disproved receipt just
        because a tab is closed. Exactly one of the two ever draws. */}
    <RepudiationLayer />

    {/* ===== THE RECEIPT — ITS OWN PANE, AT THE HEAD OF THE COLUMN =========
        TWO PANELS, TWO JOBS. The four figures are a different instrument from
        the audit under them: one is the claim the product makes, the other is
        the evidence for it, and they want opposite positions in a rail. Kept as
        one panel, putting the arithmetic first also put eight hundred pixels of
        citations, families and admissions between the reader and the ANSWER —
        which is a worse frame than the one it fixed.

        So the arithmetic leads, the answer follows it, and the audit sits under
        the answer. `<ReceiptPanel />` still mounts both; a host does not have to
        know there are two. No subtitle above the figures and no justification
        under them — both used to bracket these four numbers in grey prose. The
        argument is on the title, one hover away. */}
    <Panel
      title={
        <Why note={COPY.receipt.budget.note}>
          <span>{COPY.receipt.budget.title}</span>
        </Why>
      }
      tone="evidence"
      className={cx('pv-panel', 'pv-receipt', payloadMoved && 'is-disputed', className)}
      /* THE VERDICT, AS A POINTER RATHER THAN AS A SECOND COPY OF IT. The
         signature panel owns the diagnosis and prints it in full; this is one
         dot and one word, on the pane that leads the column, so that no reader
         can look at a receipt in this product without also learning whether it
         verified. The badge reads `verify.valid` and nothing else — it cannot
         disagree with the panel below, because it is the same boolean. */
      actions={<VerifyBadge verify={v} />}
    >
      <section
        className={cx('pv-sec', 'pv-receipt-blk')}
        data-counting={counting ? '1' : '0'}
        data-disputed={payloadMoved ? '1' : '0'}
      >
        <ReceiptLine
          label={COPY.receipt.budget.rows.counterfactual_tokens.label}
          tip={COPY.receipt.budget.rows.counterfactual_tokens.tip}
          size="sm"
        >
          <Num
            value={st.counterfactual_tokens}
            format="tokens"
            unit={COPY.common.units.tokens}
            tone="dim"
          />
        </ReceiptLine>

        <ReceiptLine
          label={COPY.receipt.budget.rows.tokens_rendered.label}
          tip={COPY.receipt.budget.rows.tokens_rendered.tip}
          size="lg"
        >
          <Num
            value={st.tokens_rendered}
            countFrom={payloadMoved ? undefined : countFrom}
            format="tokens"
            unit={COPY.common.units.tokens}
            tone={payloadMoved ? 'dim' : 'render'}
            className="pv-rl-hero"
          />
        </ReceiptLine>

        {/* The rule under the subtraction. This is a receipt; a receipt has one. */}
        <Divider className="pv-rl-rule" />

        <ReceiptLine
          label={COPY.receipt.budget.rows.savings_pct.label}
          tip={COPY.receipt.budget.rows.savings_pct.tip}
          size="md"
        >
          <Num
            value={st.savings_pct}
            format="pct1"
            tone={payloadMoved ? 'dim' : 'neutral'}
            className="pv-rl-total"
          />
        </ReceiptLine>

        {/* The ceiling, and that it binds. The gauge carries the budget figure
            as its own readout rather than repeating it in a row underneath. */}
        <Meter
          value={st.tokens_rendered}
          max={st.token_budget}
          tone={payloadMoved ? 'dim' : 'render'}
          label={COPY.receipt.budget.rows.token_budget.label}
          readout={
            <Num
              value={st.token_budget}
              format="tokens"
              unit={COPY.common.units.tokens}
              tone="dim"
            />
          }
        />

        {/* IT STOPS VOUCHING. Not a second alarm — the signature panel owns the
            accusation — but this block may not go on presenting arithmetic over
            bytes that moved as though nothing had. */}
        {failure === null ? null : (
          <p className="pv-rl-void tone-alarm" data-prose>
            {failure.title}
          </p>
        )}
      </section>
    </Panel>

    {/* ===== THE AUDIT UNDER IT ============================================
        Everything a sceptic reaches for after the four figures: what resolution
        was spent, which relation families carried it, the quotes, the admission
        list, what was reached and declined, the cache, and the signed header. */}
    <Panel
      title={COPY.receipt.title}
      tone="evidence"
      className={cx('pv-panel', 'pv-trace', className)}
      actions={<ProvenanceChip />}
      scroll
    >
      {/* ===== RESOLUTION SPENT ============================================ */}
      <section className="pv-sec">
        <Why note={COPY.receipt.resolution.note}>
          <SectionLabel>{COPY.receipt.resolution.title}</SectionLabel>
        </Why>
        <Row
          label={
            <span className="pv-lod-l">
              <LodChip state="lod-0" tone="neutral" />
              {COPY.receipt.resolution.rows.lod0_passages.label}
            </span>
          }
          title={COPY.receipt.resolution.rows.lod0_passages.tip}
          value={<Num value={st.lod0_passages} format="int" tone="neutral" />}
        />
        <Row
          label={
            <span className="pv-lod-l">
              <LodChip state="lod-1" tone="neutral" />
              {COPY.receipt.resolution.rows.lod1_context_nodes.label}
            </span>
          }
          title={COPY.receipt.resolution.rows.lod1_context_nodes.tip}
          value={<Num value={st.lod1_context_nodes} format="int" tone="neutral" />}
        />
        <Row
          label={
            <span className="pv-lod-l">
              <LodChip state="lod-2" tone="neutral" />
              {COPY.receipt.resolution.rows.lod2_pointer_nodes.label}
            </span>
          }
          title={COPY.receipt.resolution.rows.lod2_pointer_nodes.tip}
          value={<Num value={st.lod2_pointer_nodes} format="int" tone="neutral" />}
        />
      </section>

      <Divider />

      {/* ===== CITATIONS ===================================================
          THE QUOTES COME SECOND, NOT THIRD. They used to sit under 536px of
          relation-family chips — a census of the traversal, standing between the
          reader and the evidence it was a census of. Measured cost at 1440p: the
          citation list started 1 904px down a scrolling rail and the ONE citation
          in this receipt that carries a substitution began below the fold of a
          4K frame. A receipt puts its itemisation next to its total.

          It also reads better against the block above it: `lod-0 · Verbatim
          passages · 5`, and then the five verbatim passages. The families, the
          admission list and the omitted frontier are all statements about the
          MACHINERY, and they now sit together, under the evidence they describe. */}
      <section className="pv-sec">
        <div className="pv-sec-hd">
          <Why note={COPY.receipt.citations.note}>
            <SectionLabel>{COPY.receipt.citations.title}</SectionLabel>
          </Why>
          <Num value={t.citations.length} format="int" tone="dim" />
        </div>
        <CitationList
          citations={t.citations}
          path={a?.constellation.path ?? []}
          bridgeEntityId={a?.constellation.bridge_entity_id ?? null}
          {...(onOpenPassage === undefined ? {} : { onOpenPassage })}
        />
      </section>

      <Divider />

      {/* ===== RELATION FAMILIES =========================================== */}
      <section className="pv-sec">
        <Why note={COPY.receipt.families.note}>
          <SectionLabel>{COPY.receipt.families.title}</SectionLabel>
        </Why>
        {families.length === 0 ? (
          <Note>{COPY.receipt.families.empty}</Note>
        ) : (
          families.map((group) => (
            <div className="pv-fam-group" key={group.sigma}>
              <div className="pv-fam-hd">
                <Tip
                  content={
                    <>
                      <span className="pv-tip-title">{COPY.sigma.classes[group.sigma].short}</span>
                      <span className="pv-tip-body">{COPY.sigma.classes[group.sigma].long}</span>
                    </>
                  }
                >
                  <span className={cx('pv-fam-sigma', `tone-${sigmaTone(group.sigma)}`)}>
                    {COPY.sigma.classes[group.sigma].label}
                  </span>
                </Tip>
                <Num value={group.uses} format="int" tone="dim" />
              </div>
              <div className="pv-fams">
                {group.families.map((f) => (
                  <Chip
                    key={f.family}
                    tone={sigmaTone(group.sigma)}
                    active
                    count={f.count}
                    title={f.family}
                  >
                    {byFamily[f.family].label}
                  </Chip>
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      <Divider />

      {/* ===== ADMITTED ==================================================== */}
      <section className="pv-sec">
        <Disclosure
          summary={
            <span className="pv-disc-sum">
              {COPY.receipt.admitted.title}
              <Num value={t.admitted.length} format="int" tone="dim" />
            </span>
          }
        >
          <Note>{COPY.receipt.admitted.note}</Note>
          <ul className="pv-adms">
            {t.admitted.map((rec) => (
              <li className="pv-adm" key={rec.node_id}>
                <div className="pv-adm-hd">
                  <NodeId id={rec.node_id} />
                  <Tip content={COPY.receipt.admitted.rows.lod.tip}>
                    <LodChip state={rec.lod} tone="neutral" />
                  </Tip>
                  <Tip content={COPY.receipt.admitted.rows.tokens.tip}>
                    <Num
                      value={rec.tokens}
                      format="tokens"
                      unit={COPY.common.units.tokens}
                      tone="dim"
                    />
                  </Tip>
                </div>
                <div className="pv-adm-ft">
                  <Tip content={COPY.receipt.admitted.rows.reason.tip}>
                    <Code code={rec.reason} text={admissionReasonText(rec.reason)} />
                  </Tip>
                  <Tip content={COPY.receipt.admitted.rows.score.tip}>
                    <Num value={rec.score} format="float2" tone="dim" />
                  </Tip>
                </div>
              </li>
            ))}
          </ul>
        </Disclosure>
      </section>

      <Divider />

      {/* ===== OMITTED BUT CONNECTED — the honesty mechanism =============== */}
      <section className="pv-sec pv-omit tone-curiosity">
        <div className="pv-sec-hd">
          {/* THE ONE NOTE THAT SURVIVES ON THE RAIL. Every other justification
              moved onto its heading; this one stays printed because it is not a
              justification — it is the mechanism, and a reader who never hovers
              anything still has to meet it. */}
          <Why note={COPY.receipt.omitted.inTerrain}>
            <SectionLabel>{COPY.receipt.omitted.title}</SectionLabel>
          </Why>
          <Num value={t.omitted_but_connected.length} format="int" tone="curiosity" />
        </div>
        <Note>{COPY.receipt.omitted.note}</Note>
        {omitted.length === 0 ? (
          <Note>{COPY.receipt.omitted.empty}</Note>
        ) : (
          omitted.map((group) => (
            <Disclosure
              key={group.code}
              summary={
                <span className="pv-disc-sum">
                  <Code code={group.code} text={omissionReasonText(group.code)} />
                  <Num value={group.ids.length} format="int" tone="curiosity" />
                </span>
              }
            >
              <ul className="pv-omit-ids">
                {group.ids.map((id) => (
                  <li key={id}>
                    <NodeId id={id} />
                  </li>
                ))}
              </ul>
            </Disclosure>
          ))
        )}
      </section>

      <Divider />

      {/* ===== RENDER CACHE ================================================ */}
      <section className="pv-sec">
        <SectionLabel>{COPY.receipt.cache.title}</SectionLabel>
        <Row
          label={COPY.receipt.cache.hits.label}
          title={COPY.receipt.cache.hits.tip}
          value={<Num value={st.cache_hits} format="int" tone="dim" />}
        />
        <Row
          label={COPY.receipt.cache.lookups.label}
          title={COPY.receipt.cache.lookups.tip}
          value={<Num value={st.cache_lookups} format="int" tone="dim" />}
        />
        <Row
          label={COPY.receipt.cache.rate.label}
          title={COPY.receipt.cache.rate.tip}
          value={<Num value={cacheRate} format="pct1" tone="dim" />}
        />
      </section>

      <Divider />

      {/* ===== THE TRACE HEADER ============================================ */}
      <section className="pv-sec">
        <Disclosure summary={<span className="pv-disc-sum mono">{t.trace_id}</span>}>
          <Row
            label={COPY.receipt.header.traceId.label}
            title={COPY.receipt.header.traceId.tip}
            value={t.trace_id}
            mono
            tone="dim"
          />
          <Row
            label={COPY.receipt.header.queryId.label}
            title={COPY.receipt.header.queryId.tip}
            value={t.query_id}
            mono
            tone="dim"
          />
          <Row
            label={COPY.receipt.header.model.label}
            title={COPY.receipt.header.model.tip}
            value={t.model}
            mono
          />
          <Row
            label={COPY.receipt.header.createdAt.label}
            title={COPY.receipt.header.createdAt.tip}
            value={t.created_at}
            mono
            tone="dim"
          />
          <Row
            label={COPY.receipt.header.latency.label}
            title={COPY.receipt.header.latency.tip}
            value={<Num value={a?.latency_ms ?? NaN} format="ms" tone="dim" />}
          />
          <Row
            label={COPY.receipt.header.version.label}
            title={COPY.receipt.header.version.tip}
            value={t.version}
            mono
            tone="dim"
          />
          <Row
            label={COPY.trust.signature.rows.payloadHash.label}
            title={COPY.trust.signature.rows.payloadHash.tip}
            value={<Hash value={t.payload_hash} />}
          />
          <Row
            label={COPY.provenance.field}
            title={COPY.provenance.why}
            value={t.corpus_provenance}
            mono
            tone="dim"
          />

          {/* THE WEIGHTS OF L, WHICH HAVE NOWHERE ELSE TO LIVE.
              The answer panel owns the composite and its four measured signals;
              it deliberately does not print how each is weighted, because signal,
              value and weight on one 320px row wraps every label. So the weights
              come here, inside a disclosure, next to the format version and the
              payload hash — the other three facts nobody needs until they are
              checking the arithmetic. */}
          <SectionLabel>{COPY.receipt.confidence.weightsLabel}</SectionLabel>
          {SIGNALS.map((key: SignalKey) => (
            <Row
              key={key}
              label={COPY.receipt.confidence.signals[key].label}
              title={COPY.receipt.confidence.signals[key].tip}
              value={<Num value={CONFIDENCE_WEIGHTS[key] * 100} format="pct1" tone="dim" />}
            />
          ))}
        </Disclosure>
        <div className="pv-actions">
          <Tip content={COPY.receipt.export.note}>
            <Btn
              variant="quiet"
              size="sm"
              tone="neutral"
              onClick={copyTrace}
              title={COPY.receipt.export.action.title}
            >
              {copied ? COPY.receipt.export.copied : COPY.receipt.export.action.label}
            </Btn>
          </Tip>
        </div>
      </section>
    </Panel>
    </>
  );
}
