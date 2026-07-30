/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — COPY SHAPES
 * =============================================================================
 *
 * The small vocabulary of shapes every string in the deck is poured into.
 *
 * They exist so that a panel cannot half-document a control: a `RowCopy` without
 * a `tip` will not compile, and a row in an instrument that does not say why its
 * number is trustworthy is a row that is asking to be believed rather than read.
 * =============================================================================
 */

/** A label with the explanation that earns it. `tip` is a full sentence. */
export interface RowCopy {
  /** What the row is called. A stranger must understand it without the tip. */
  label: string;
  /** Why the number is trustworthy, or how it was derived. Shown on hover. */
  tip: string;
  /** Optional unit word for the mono primitive, e.g. `tok`, `ms`. */
  unit?: string;
}

/** A control: the word on it, and the longer sentence on hover. */
export interface ActionCopy {
  label: string;
  /** Tooltip / `title`. States the consequence, not the mechanism. */
  title: string;
}

/** A named thing with two depths of explanation. Legends and chips use this. */
export interface TermCopy {
  /** Display name. Lowercase unless it is a proper noun or an engine token. */
  label: string;
  /** One clause. Fits on a legend row. */
  short: string;
  /** Two or three sentences. Fits in a tooltip or a disclosure. */
  long: string;
}

/** A whole screen state: what it is, and what to do about it. */
export interface StateCopy {
  title: string;
  /** One or two sentences. Never an apology, never a shrug. */
  body: string;
  /** The single control this state offers, when it offers one. */
  action?: ActionCopy;
  /** A quieter second line: context, a limitation, a pointer. */
  note?: string;
}

/** One failure the interface knows by name. The engine supplies the rest. */
export interface FailureCopy {
  /** Human headline. Names the failure, never the feeling. */
  title: string;
  /** One line of context the engine's own `what_failed` does not carry. */
  meaning: string;
}

/** A glossary entry. `short` is the tooltip; `long` is the overlay. */
export interface GlossaryEntry {
  term: string;
  short: string;
  long: string;
  /** Other terms worth reading next. Must be `term` values in this glossary. */
  see?: readonly string[];
}
