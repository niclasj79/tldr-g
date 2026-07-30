/**
 * =============================================================================
 * PROVENANCE BITS — the small shared parts of the trust surface
 * =============================================================================
 *
 * Five pieces that appear in more than one trust panel. They are here rather
 * than duplicated because two panels disagreeing about how a machine code is
 * rendered is the same class of defect as two panels disagreeing about a number:
 * it makes the instrument look assembled instead of built.
 *
 * -----------------------------------------------------------------------------
 * THE ONE COLOUR DECISION IN THIS FILE, STATED OUT LOUD
 * -----------------------------------------------------------------------------
 * A `verbatim` quote's RULE wears --evidence: the bar down the left of the
 * blockquote is the document's own bytes, and amber is old light.
 *
 * The BADGE does not. A badge that says `verbatim` in --evidence puts the
 * evidence light on the 82% of passages where nothing happened, and by the time
 * five of them are stacked in a rail the light has stopped meaning anything —
 * which is exactly how gold decayed into a categorical palette. So the badge
 * ramp is DISTANCE TRAVELLED, and only travel gets a colour:
 *
 *   verbatim          --ink-faint   nothing happened. Stated, not lit.
 *   *_resolved        --render      the engine's hand is on this one, and the
 *                                   badge carries HOW MANY spans it touched.
 *
 * The diff underneath it then shows exactly where the hand fell. A chip that
 * looks identical whether or not the text was rewritten encodes zero distance,
 * which is the one thing this disclosure exists to encode.
 * =============================================================================
 */

import type { ReactNode } from 'react';

import { COPY, resolutionCopy } from '@/copy';
import type { PassageResolution } from '@/engine';
import { Chip, Hash, Num, Tip, cx, type Tone } from '@/ui/primitives';

/* =============================================================================
 * 1. THE SYNTHETIC-CORPUS MARKER
 * ========================================================================== */

/**
 * The provenance badge. Every panel that shows generated content carries one.
 *
 * It states the engine's own field name and value, because "synthetic corpus"
 * on its own is a claim about this interface and `corpus_provenance:
 * synthetic-design-concept` is a claim about the payload — and the payload is
 * the thing a reader can check.
 *
 * IT IS INK. It wore --curiosity, which reads "the engine does not know this" —
 * and the engine knows exactly what this corpus is; that is the entire content
 * of the badge. A standing label on a property of the build is chrome, and the
 * question light is not for chrome. What it says has not changed at all.
 */
export function ProvenanceChip({ className }: { className?: string }): JSX.Element {
  return (
    <Tip
      content={
        <>
          <span className="pv-tip-code">
            {COPY.provenance.field}: {COPY.provenance.value}
          </span>
          <span className="pv-tip-body">{COPY.provenance.long}</span>
        </>
      }
    >
      <Chip tone="dim" className={cx('pv-prov', className)}>
        {COPY.provenance.badge}
      </Chip>
    </Tip>
  );
}

/* =============================================================================
 * 2. THE RESOLUTION DISCLOSURE BADGE
 * ========================================================================== */

export interface ResolutionBadgeProps {
  resolution: PassageResolution;
  /**
   * How many spans the engine substituted. Rendered inside the badge when the
   * caller has diffed the bytes and can count them. Omitted where it cannot —
   * a badge never guesses at a number it did not measure.
   */
  count?: number;
  className?: string;
}

/**
 * The tone of the QUOTE — the rule down its left edge, and the glyph beside it.
 * Amber for the document's bytes, cyan when the engine's hand is on them.
 */
export function resolutionTone(resolution: PassageResolution): Tone {
  return resolution === 'verbatim' ? 'evidence' : 'render';
}

/**
 * The tone of the BADGE, which is a different question: not "whose bytes are
 * these" but "how far have they travelled". Nothing travelled means nothing
 * lights up. See the header.
 */
export function resolutionBadgeTone(resolution: PassageResolution): Tone {
  return resolution === 'verbatim' ? 'faint' : 'render';
}

/**
 * How far this quote has travelled from the bytes on disk — printed on EVERY
 * quote, including the ones that have not travelled at all.
 *
 * A label that only appears when something has been changed reads as an
 * admission. A label that is always present reads as a method, and it is the
 * method that earns the trust. What changes between the two cases is WEIGHT,
 * not presence: an untouched span states itself in --ink-faint and gets out of
 * the way; a rewritten one is lit and says how many spans were rewritten.
 */
export function ResolutionBadge({ resolution, count, className }: ResolutionBadgeProps): JSX.Element {
  const copy = resolutionCopy(resolution);
  return (
    <Tip
      content={
        <>
          <span className="pv-tip-title">{copy.short}</span>
          <span className="pv-tip-body">{copy.long}</span>
          <span className="pv-tip-code">resolution: {resolution}</span>
        </>
      }
    >
      <span className={cx('pv-res', `tone-${resolutionBadgeTone(resolution)}`, className)}>
        {copy.label}
        {count === undefined || count <= 0 ? null : (
          <Num value={count} format="int" tone={resolutionBadgeTone(resolution)} className="pv-res-n" />
        )}
      </span>
    </Tip>
  );
}

/* =============================================================================
 * 2b. THE RATIONALE SEAM
 * ========================================================================== */

/**
 * A sentence that ARGUES rather than reports, attached to the label it belongs
 * to instead of printed under it.
 *
 * The rail was carrying five grey justification paragraphs in a single scroll —
 * why the decomposition sits beside the gauge, why an engine that reports only
 * its successes is an advertisement, why verification runs locally — while the
 * data it was justifying got four-character field labels. That is design-doc
 * voice shipped as product chrome, and the priority exactly inverted.
 *
 * None of it is deleted: every one of those sentences is still one hover away,
 * on the heading it explains. What is deleted is its claim on vertical space
 * next to the numbers. The rail reports; the tip argues.
 */
export function Why({ note, children }: { note: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <Tip content={<span className="pv-tip-body">{note}</span>} className="pv-why">
      {children}
    </Tip>
  );
}

/* =============================================================================
 * 2c. A DIGEST YOU CAN ACTUALLY LIFT
 * ========================================================================== */

export interface DigestProps {
  value: string;
  label: string;
  tone?: Tone;
  className?: string;
}

/**
 * A hash, signature or key printed IN FULL, wrapped, click-to-copy.
 *
 * `<Hash>` truncates for the eye, which is right in a row of five citations and
 * wrong in the one panel whose entire job is to hand a third party the bytes
 * they need to check this without trusting us. `e72a68455ebb …` is not
 * provenance, it is the appearance of provenance: a verifier who cannot lift
 * the digest cannot verify. So the trust panel spends four lines on it.
 */
export function Digest({ value, label, tone = 'evidence', className }: DigestProps): JSX.Element {
  return (
    <div className={cx('pv-digest', `tone-${tone}`, className)}>
      <span className="pv-digest-l">{label}</span>
      <Hash value={value} chars={value.length} className="pv-digest-v" />
    </div>
  );
}

/* =============================================================================
 * 3. MACHINE CODES
 * ========================================================================== */

export interface CodeProps {
  /** The engine's own token, e.g. `evidences_hop_0_operates`. */
  code: string;
  /** The translation, when the caller has one. Shown BESIDE the code, never instead. */
  text?: string;
  className?: string;
}

/**
 * A machine code, and the sentence it means.
 *
 * Both, always, in that visual order: the readable sentence leads and the code
 * sits under it in mono. The code is what you would grep for and what a support
 * conversation would quote; deleting it in favour of nice words is how an
 * instrument turns into a brochure.
 */
export function Code({ code, text, className }: CodeProps): JSX.Element {
  return (
    <span className={cx('pv-code', className)}>
      {text === undefined ? null : <span className="pv-code-text">{text}</span>}
      <span className="pv-code-raw">{code}</span>
    </span>
  );
}

/* =============================================================================
 * 4. NODE IDS
 * ========================================================================== */

export interface NodeIdProps {
  id: string;
  className?: string;
}

/**
 * A node id on the mono rail, with its kind prefix (`e:`, `p:`, `a:`, `src:`)
 * set back in --ink-faint.
 *
 * The prefix is a type tag rather than part of the name, and at 12.5px it eats
 * a quarter of the width of a short entity id. Setting it back is the same
 * decision `Hash` makes about `sha256:`, for the same reason.
 */
export function NodeId({ id, className }: NodeIdProps): JSX.Element {
  const cut = id.indexOf(':');
  const prefix = cut > 0 ? id.slice(0, cut + 1) : '';
  const rest = cut > 0 ? id.slice(cut + 1) : id;
  return (
    <span className={cx('pv-id', className)} title={id}>
      {prefix ? <span className="pv-id-prefix">{prefix}</span> : null}
      <span className="pv-id-v">{rest}</span>
    </span>
  );
}

/* =============================================================================
 * 4b. THE FACT STRIP — a label above its value, never beside it
 * ========================================================================== */

export interface FactProps {
  label: string;
  tip: string;
  /**
   * Span the whole strip. For a value that must not be elided and must not be
   * squeezed: a decentralised identifier, a key id, a timestamp.
   */
  wide?: boolean;
  /**
   * The value is MACHINE TEXT — an identifier, a timestamp, an algorithm name —
   * and belongs on the mono rail with everything else the engine emitted. It is
   * not a measurement, so it does not go through `<Num>`: a monospaced string is
   * not the same claim as a monospaced number, and pretending otherwise is how
   * an identifier ends up formatted with thousands separators.
   */
  mono?: boolean;
  /** Defaults to `dim`. Reaches the VALUE only; the label stays structural. */
  tone?: Tone;
  children: ReactNode;
  className?: string;
}

/**
 * One cell of a fact strip: a micro-label, and the value UNDER it.
 *
 * This exists because of what a `<Row>` does to a long machine string. A Row
 * puts the label left and the value hard right, which is exactly right for a
 * column of comparable figures and exactly wrong for an identifier — the trust
 * panel was printing `did:web:tldr-g.example#atlas-demo-` / `key-1` as two
 * right-aligned mono lines, a key id ragged against the wrong edge and broken in
 * the middle. Nobody can lift that, and a signature block whose key cannot be
 * lifted is a signature block that cannot be checked.
 *
 * So identifiers get the full measure, left-aligned, wrapping, under a label
 * that has stopped competing with them for the same line.
 */
export function Fact({
  label,
  tip,
  wide = false,
  mono = false,
  tone = 'dim',
  children,
  className,
}: FactProps): JSX.Element {
  return (
    <Tip content={tip} className={cx('pv-fact', wide && 'is-wide', className)}>
      <span className="pv-fact-l">{label}</span>
      <span className={cx('pv-fact-v', mono && 'is-mono', `tone-${tone}`)}>{children}</span>
    </Tip>
  );
}

/* =============================================================================
 * 5. PROSE AND EMPTY STATES
 * ========================================================================== */

/** A note under a section head. Capped to a measure by the stylesheet. */
export function Note({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <p className={cx('pv-note', className)}>{children}</p>;
}

export interface EmptyProps {
  title: string;
  body: string;
  children?: ReactNode;
}

/**
 * A panel with nothing in it yet. Never a blank rectangle and never a shimmer:
 * it says what would be here and what produces it.
 */
export function Empty({ title, body, children }: EmptyProps): JSX.Element {
  return (
    <div className="pv-empty">
      <span className="pv-empty-title">{title}</span>
      <p className="pv-note">{body}</p>
      {children}
    </div>
  );
}
