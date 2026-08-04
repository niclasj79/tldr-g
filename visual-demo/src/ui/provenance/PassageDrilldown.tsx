/**
 * =============================================================================
 * PASSAGE DRILLDOWN — the provenance floor
 * =============================================================================
 *
 * The bottom of the trust stack. Everything above this — the answer, the path,
 * the receipt, the signature — is a claim ABOUT bytes. This is the bytes.
 *
 * -----------------------------------------------------------------------------
 * IT DOES THE CHECK RATHER THAN DESCRIBING IT
 * -----------------------------------------------------------------------------
 * The citation row promises: "slice the source at the stated offsets, hash it,
 * and it matches". So this component slices the source at the stated offsets,
 * hashes it with the corpus's own `contentHash`, and prints both digests. When
 * they agree the row is quiet --ok; when they disagree it is --alarm with the
 * two hashes side by side. A panel that repeats the promise and does not perform
 * it is worth less than no panel, because it teaches the reader that the promise
 * has already been kept by somebody.
 *
 * -----------------------------------------------------------------------------
 * THE RESOLUTION DISCLOSURE, AS CONFIDENCE
 * -----------------------------------------------------------------------------
 * A cited span may be a RESOLVED RENDERING: pronouns replaced with referents,
 * aliases normalised. That is not a footnote to bury. When `resolution` is not
 * `verbatim` this component shows BOTH texts, diffed inline, so the substitution
 * is a thing you can look at — `the licensee` struck through, `Norrfjärd Energi
 * A/S` marked in its place.
 *
 * The framing matters. This is not a disclaimer; it is the system volunteering
 * the one fact that would most damage it if somebody else found it first. A
 * corpus where 18% of passages are resolved and the interface says so on every
 * single one is more trustworthy than a corpus where none of them admits it.
 *
 * -----------------------------------------------------------------------------
 * SEGMENT 0 IS THE ONLY LEGAL LAYER
 * -----------------------------------------------------------------------------
 * Sources carry derived layers — normalisations, corrections — at `seq > 0`.
 * They are listed here, labelled as derived, and never used to satisfy the
 * citation. Showing that they exist and are not being used is the point.
 * =============================================================================
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { COPY } from '@/copy';
import { contentHash, engine } from '@/engine';
import type { Citation, Passage, Source, SourceSegment } from '@/engine';
import {
  Btn,
  Divider,
  Glyph,
  Hash,
  Num,
  Row,
  SectionLabel,
  StateDot,
  Tip,
  cx,
} from '@/ui/primitives';

import { Code, NodeId, Note, ResolutionBadge, Why, resolutionTone } from './bits';
import { coalesce, diffWords, substitutionShare, type DiffRun } from './diff';

/* =============================================================================
 * 1. LOADING THE BYTES
 * ========================================================================== */

export interface Loaded {
  passage: Passage;
  source: Source;
  /** The `seq === 0` layer. `null` when the source ships no verbatim segment. */
  verbatimSegment: SourceSegment | null;
  /** `segment.text.slice(char_start, char_end)` — the bytes the hash covers. */
  span: string | null;
}

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: Loaded }
  | { status: 'failed'; what: string };

/**
 * Fetch the passage and its source through the real client.
 *
 * Both calls go through `EngineClient`, so they are cached by bake id and they
 * behave identically against a live engine. Nothing here reaches into the
 * fixtures directly — a trust panel that reads the corpus by a private route is
 * a trust panel that would keep working after the engine stopped agreeing.
 *
 * EXPORTED because the citation card needs the same bytes. A card whose quote
 * has been rewritten has to show what the document actually said, and the only
 * honest place to get that is the source — not a second copy of it kept beside
 * the citation, which could drift.
 */
export function usePassage(passageId: string | null): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    if (passageId === null) return;
    let live = true;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const node = await engine.getNode(passageId);
        if (!live) return;
        if (node.kind !== 'passage') {
          setState({
            status: 'failed',
            what: `${passageId} is a ${node.kind}, not a passage`,
          });
          return;
        }
        const source = await engine.getSource(node.source_id);
        if (!live) return;
        const verbatimSegment = source.segments.find((s) => s.seq === 0) ?? null;
        const span =
          verbatimSegment === null
            ? null
            : verbatimSegment.text.slice(node.char_start, node.char_end);
        setState({ status: 'ready', data: { passage: node, source, verbatimSegment, span } });
      } catch (err) {
        if (!live) return;
        setState({
          status: 'failed',
          what: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      live = false;
    };
  }, [passageId]);

  return state;
}

/* =============================================================================
 * 2. THE INLINE DIFF
 * ========================================================================== */

export function DiffStream({ runs, className }: { runs: DiffRun[]; className?: string }): JSX.Element {
  return (
    <p className={cx('pv-diff', className)}>
      {runs.map((run, i) =>
        run.op === 'same' ? (
          <span key={i}>{run.text}</span>
        ) : run.op === 'del' ? (
          <del key={i} className="pv-del">
            {run.text}
          </del>
        ) : (
          <ins key={i} className="pv-ins">
            {run.text}
          </ins>
        ),
      )}
    </p>
  );
}

/* =============================================================================
 * 3. THE SOURCE WINDOW
 * ========================================================================== */

/**
 * How much of the document to show on each side of the cited span by default.
 *
 * Enough that the quote is visibly IN something — a paragraph before it and a
 * paragraph after — and not so much that the mark is lost in a wall. The whole
 * segment is one press away.
 */
const CONTEXT_CHARS = 420;

interface SourceWindowProps {
  segment: SourceSegment;
  from: number;
  to: number;
  whole: boolean;
}

/**
 * How much of the lead-in to keep above the mark once the window has scrolled to
 * it. Two lines: enough that the quote is visibly continuing a sentence rather
 * than starting the box, and not so much that the mark is off the first screen
 * of it again.
 */
const LEAD_IN_PX = 44;

/**
 * The document, with the cited span marked in place.
 *
 * The offsets are not decorative: `from` and `to` index this exact string, and
 * the mark is produced by slicing it. If the offsets were wrong the highlight
 * would land on the wrong words, in public, which is precisely the property that
 * makes showing it worth doing.
 *
 * -----------------------------------------------------------------------------
 * AND THE WINDOW OPENS ON THE MARK, NOT 420 CHARACTERS ABOVE IT
 * -----------------------------------------------------------------------------
 * A defect found by reading the screenshot rather than the code. The box is five
 * lines tall and the lead-in is 420 characters, so the mark started at 185px
 * inside a 238px box: the panel's whole promise — here are the bytes, here is
 * where your quote sits in them — was rendered correctly and then parked below
 * the fold of its own container. Every reader had to find and drag a nested
 * scrollbar to see the thing the section exists to show, and a screenshot of it
 * showed grey context and no highlight at all.
 *
 * So the container scrolls to the mark on mount and whenever the span moves,
 * keeping two lines of lead-in above it. Instant, never animated: this is not a
 * transition, it is where the box was always supposed to be pointing.
 */
function SourceWindow({ segment, from, to, whole }: SourceWindowProps): JSX.Element {
  const start = whole ? 0 : Math.max(0, from - CONTEXT_CHARS);
  const end = whole ? segment.text.length : Math.min(segment.text.length, to + CONTEXT_CHARS);
  const before = segment.text.slice(start, from);
  const cited = segment.text.slice(from, to);
  const after = segment.text.slice(to, end);

  const box = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const b = box.current;
    const m = mark.current;
    if (b === null || m === null) return;
    const offset = m.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop;
    b.scrollTop = Math.max(0, offset - LEAD_IN_PX);
  }, [segment.content_hash, from, to, whole]);

  return (
    <div className="pv-src u-scroll" ref={box}>
      {start > 0 ? <span className="pv-src-cut">…</span> : null}
      <span className="pv-src-txt">{before}</span>
      <mark className="pv-mark" ref={mark}>
        {cited}
      </mark>
      <span className="pv-src-txt">{after}</span>
      {end < segment.text.length ? <span className="pv-src-cut">…</span> : null}
    </div>
  );
}

/* =============================================================================
 * 4. THE COMPONENT
 * ========================================================================== */

export interface PassageDrilldownProps {
  /** The passage to open. `null` renders nothing at all. */
  passageId: string | null;
  /**
   * The receipt's own citation for this passage, when it was opened from one.
   * Its `quote` is what the answer was actually built from, so it — not the
   * node's `text` — is what gets diffed against the source bytes.
   */
  citation?: Citation | null;
  /**
   * True when this block owns the passage's identity — its own heading line and
   * its own copy of the cited text.
   *
   * Set `false` when the CALLER already shows both, which is exactly the case
   * inside a citation card: the card's header names the passage and the card's
   * blockquote carries the quote, so a standalone drilldown printed the id, the
   * resolution badge and the first three lines of the text a second time, four
   * lines below the first. Everything below the quote — offsets, the live hash
   * check, the source bytes — is what the caller opened it for.
   */
  standalone?: boolean;
  /**
   * True when the HOST has already printed the passage id on screen.
   *
   * The Inspector does: its header names the node and its sub-line prints
   * `p:storage.tollstrand-cluster.000.2` — and then this block printed the same
   * 34-character identifier again, six rows below, at the head of the quote. One
   * string, twice, inside one glance, is how a panel starts reading as a form.
   *
   * The heading does not disappear; it stops repeating. What is left is the one
   * fact only this block can produce, because only this block has the source
   * bytes: the resolution, and how many spans the engine moved.
   */
  alreadyNamed?: boolean;
  className?: string;
}

/**
 * A BODY, not a panel. It is dropped inside the Inspector, inside a citation
 * card, or inside a panel of its own, and it never brings its own glass.
 */
export function PassageDrilldown({
  passageId,
  citation = null,
  standalone = true,
  alreadyNamed = false,
  className,
}: PassageDrilldownProps): JSX.Element | null {
  const state = usePassage(passageId);
  const [whole, setWhole] = useState(false);

  /* OPENING A PASSAGE BRINGS THE PASSAGE INTO VIEW.
     `Open the passage` moved the map and mounted this block — 3 000px down a
     scrolling rail, off the bottom of the frame. Pressing a control named after
     a thing and not being shown the thing is the interface disagreeing with its
     own label, and it is why the scene named `passage-drilldown` photographed a
     receipt with no drilldown in it.

     The nearest scrolling ancestor is moved, never the window: this block is
     always inside a column that owns its own scroll, and reaching past that
     column would yank the whole page around the rail. Instant, so nothing here
     is registered on the motion timeline or waited on by `settled()`. */
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!standalone || passageId === null) return;
    const el = root.current;
    if (el === null) return;
    let host: HTMLElement | null = el.parentElement;
    while (host !== null) {
      const overflow = getComputedStyle(host).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && host.scrollHeight > host.clientHeight) break;
      host = host.parentElement;
    }
    if (host === null) return;
    const offset = el.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
    host.scrollTop = Math.max(0, offset - LEAD_IN_PX);
  }, [passageId, standalone, state.status]);

  const ready = state.status === 'ready' ? state.data : null;

  /** The text the answer rests on: the receipt's quote, else the node's own. */
  const cited = citation?.quote ?? ready?.passage.text ?? '';
  const resolution = citation?.resolution ?? ready?.passage.resolution ?? 'verbatim';

  /* The check, performed rather than described. Recomputed from the bytes this
     component is holding, with the corpus's own hash function. */
  const recomputed = useMemo(
    () => (ready?.span === null || ready?.span === undefined ? null : contentHash(ready.span)),
    [ready?.span],
  );
  const hashMatches = recomputed !== null && ready !== null && recomputed === ready.passage.content_hash;

  /* The substitution, when there is one. Diffed against the SOURCE BYTES, never
     against the node's rendered text — the bytes are the thing under dispute. */
  const runs = useMemo(() => {
    if (ready === null || ready.span === null) return null;
    if (resolution === 'verbatim') return null;
    const raw = diffWords(ready.span, cited);
    return raw === null ? null : coalesce(raw);
  }, [ready, cited, resolution]);
  const share = substitutionShare(runs);
  /* HOW MANY SPANS THE ENGINE TOUCHED, counted rather than described. The badge
     took it from here: a chip that reads the same whether three phrases were
     rewritten or none encodes zero distance, which is the one thing a resolution
     disclosure exists to encode. */
  const substitutions = runs === null ? 0 : runs.filter((r) => r.op === 'ins').length;

  if (passageId === null) return null;

  if (state.status === 'loading') {
    return (
      <div className={cx('pv-pass', className)} ref={root}>
        <StateDot state="pending" label={passageId} />
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div className={cx('pv-pass', className)} ref={root}>
        <StateDot state="fail" label={COPY.common.unknown} />
        <Code code={state.what} />
      </div>
    );
  }

  const { passage, source, verbatimSegment } = state.data;
  const derived = source.segments.filter((s) => s.seq !== 0);

  return (
    <div className={cx('pv-pass', className)} ref={root}>
      {/* ---- what this is ------------------------------------------------ */}
      {standalone ? (
        <div className="pv-pass-hd">
          <Glyph kind="passage" tone={resolutionTone(resolution)} />
          {alreadyNamed ? null : <NodeId id={passage.id} />}
          <ResolutionBadge resolution={resolution} count={substitutions} />
        </div>
      ) : null}

      {/* ---- the text the answer rests on --------------------------------
          Suppressed when a diff is about to render it: the diff stream already
          contains every word of the cited text, marked. Printing the paragraph
          plainly and then again with marks put nine identical lines on screen
          twice and made the column look padded rather than thorough. */}
      {runs === null && standalone ? (
        <blockquote className={cx('pv-quote', `tone-${resolutionTone(resolution)}`)}>
          {cited}
        </blockquote>
      ) : null}

      {/* ---- the resolution disclosure ----------------------------------- */}
      {resolution === 'verbatim' ? null : (
        <section className="pv-sec">
          {/* THE FIGURE SITS ON THE HEADING THAT NAMES IT. `1.6 %` used to float
              at the end of the legend between two colour specimens, with nothing
              on screen saying what it was a percentage OF — a measured number
              whose provenance was one hover away, in a panel whose entire
              argument is that numbers state where they came from. On the section
              head it is read as the size of the resolution, which is what it is:
              the share of the cited words that are not literally in the source
              bytes. */}
          <div className="pv-sec-hd">
            <Why note={`${COPY.trust.disclosure.note} ${COPY.trust.disclosure.why}`}>
              <SectionLabel>{COPY.trust.disclosure.title}</SectionLabel>
            </Why>
            {runs === null ? null : (
              <Tip content={COPY.trust.disclosure.note}>
                <Num value={share * 100} format="pct1" tone="render" />
              </Tip>
            )}
          </div>
          {/* THE STREAM BELONGS TO WHOEVER OWNS THE QUOTE. Inside a citation
              card the card already carries the diff — it is the card's headline
              — so rendering it again here printed the same fifteen-line
              paragraph twice, twenty pixels apart, the moment somebody pressed
              `Show the source bytes`. What this section adds in that position is
              the figure on its heading and the definition on its tip, both of
              which the card does not have. */}
          {runs === null ? (
            <Note>{COPY.trust.disclosure.levels[resolution].long}</Note>
          ) : !standalone ? null : (
            <>
              <div className="pv-diff-legend">
                <span className="pv-diff-key">
                  <del className="pv-del">{COPY.trust.disclosure.levels.verbatim.label}</del>
                </span>
                <span className="pv-diff-key">
                  <ins className="pv-ins">{COPY.trust.disclosure.levels[resolution].label}</ins>
                </span>
              </div>
              <DiffStream runs={runs} />
            </>
          )}
        </section>
      )}

      {/* ---- the provenance rows ----------------------------------------- */}
      <section className="pv-sec">
        <Why note={COPY.trust.hash.tip}>
          <SectionLabel>{COPY.trust.hash.label}</SectionLabel>
        </Why>
        <Row
          label={COPY.inspector.rows.span.label}
          title={COPY.inspector.rows.span.tip}
          value={
            <span className="pv-span">
              <Num value={passage.char_start} format="int" tone="neutral" />
              <span className="pv-span-dash">–</span>
              <Num value={passage.char_end} format="int" tone="neutral" />
            </span>
          }
        />
        <Row
          label={COPY.inspector.rows.seq.label}
          title={COPY.inspector.rows.seq.tip}
          value={<Num value={passage.seq} format="int" tone="dim" />}
        />
        {/* THE CHECK, IN THE ROW ITSELF. The stored digest, and beside it the
            verdict of recomputing it from the bytes above. Not a claim that it
            matches — the recomputation, run in this component, just now. */}
        <Row
          label={COPY.receipt.citations.rows.hash.label}
          title={COPY.receipt.citations.rows.hash.tip}
          value={
            <span className="pv-hash-check">
              {/* TWELVE CHARACTERS IS THE RAIL'S MEASURE, NOT A CARD'S. Inside a
                  citation card this row also carries the recomputation verdict,
                  and the digest clipped to `95346e99… …` — the CSS ellipsis and
                  the primitive's own one, adjacent. Eight characters still
                  distinguishes every digest in a receipt and the full value is
                  one click away, on the clipboard. */}
              <Hash value={passage.content_hash} chars={standalone ? 12 : 8} />
              <StateDot
                state={hashMatches ? 'on' : 'fail'}
                tone={hashMatches ? 'ok' : 'alarm'}
                label={
                  hashMatches ? COPY.trust.verify.valid.badge : COPY.trust.verify.invalidPayload.badge
                }
              />
            </span>
          }
        />
        {hashMatches || recomputed === null ? null : (
          <div className="pv-mismatch tone-alarm">
            <Hash value={recomputed} label={COPY.common.derived} />
          </div>
        )}
        <Row
          label={COPY.receipt.citations.rows.tokens.label}
          title={COPY.receipt.citations.rows.tokens.tip}
          value={
            <Num
              value={citation?.tokens ?? passage.token_count}
              format="tokens"
              unit={COPY.common.units.tokens}
              tone="dim"
            />
          }
        />
      </section>

      <Divider />

      {/* ---- the document itself ----------------------------------------- */}
      <section className="pv-sec">
        <div className="pv-sec-hd">
          <Why note={COPY.trust.sourceSegment.tip}>
            <SectionLabel>{COPY.trust.sourceSegment.label}</SectionLabel>
          </Why>
          <Tip content={COPY.trust.sourceSegment.tip}>
            <span className="pv-seg-badge tone-dim">{COPY.trust.sourceSegment.verbatimBadge}</span>
          </Tip>
        </div>
        {/* The locator gets its own line rather than a Row's right column. A
            60-character URI right-aligned and wrapped over two ragged lines is
            unreadable, and it is the one string on this panel somebody might
            actually retype. */}
        <Tip content={COPY.inspector.rows.locator.tip}>
          <span className="pv-uri-l">{COPY.inspector.rows.locator.label}</span>
        </Tip>
        <span className="pv-uri">{source.locator}</span>
        <Row
          label={COPY.receipt.citations.rows.source.label}
          title={COPY.receipt.citations.rows.source.tip}
          value={<Hash value={source.content_hash} chars={standalone ? 12 : 8} />}
        />
        {verbatimSegment === null ? (
          <Note>{COPY.trust.sourceSegment.tip}</Note>
        ) : (
          <>
            <SourceWindow
              segment={verbatimSegment}
              from={passage.char_start}
              to={passage.char_end}
              whole={whole}
            />
            <div className="pv-actions">
              <Btn variant="ghost" size="sm" tone="neutral" onClick={() => setWhole((v) => !v)}>
                {whole ? COPY.common.less : COPY.common.more}
              </Btn>
            </div>
          </>
        )}
        {derived.length === 0 ? null : (
          <div className="pv-derived">
            {derived.map((seg) => (
              <Row
                key={seg.seq}
                label={
                  <span className="pv-seg-row">
                    <span className="pv-seg-badge tone-dim">{COPY.trust.sourceSegment.derivedBadge}</span>
                    <Code code={seg.kind} />
                  </span>
                }
                value={<Hash value={seg.content_hash} chars={8} />}
                title={COPY.trust.sourceSegment.tip}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
