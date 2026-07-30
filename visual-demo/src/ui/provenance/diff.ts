/**
 * =============================================================================
 * THE RESOLUTION DIFF
 * =============================================================================
 *
 * A citation whose `resolution` is not `verbatim` has been REWRITTEN — pronouns
 * replaced with their referents, aliases normalised to canonical names. The
 * schema says so in a field; this module is what turns that field into something
 * a reader can actually check, by putting the two strings next to each other and
 * marking the exact words that moved.
 *
 * WHY A DIFF AND NOT A BADGE. A badge that says "coreference resolved" asks to
 * be believed. A diff that shows `the licensee` -> `Norrfjärd Energi A/S` can be
 * disagreed with. The whole trust argument of this product is the difference
 * between those two, so the panel does the expensive thing.
 *
 * WORD-LEVEL, NOT CHARACTER-LEVEL. Coreference resolution substitutes NOUN
 * PHRASES. A character diff of `it` -> `Norrfjärd Energi A/S` finds a shared `n`
 * in the middle and produces confetti; a word diff produces one deletion and one
 * insertion, which is what actually happened.
 *
 * WHITESPACE IS CARRIED, NEVER COMPARED. Tokens alternate word / gap so the
 * rendered diff reconstructs both strings byte for byte — a diff view that
 * silently renormalises spacing is a diff view that can hide a change.
 *
 * The algorithm is a plain LCS table. It is O(n·m) in time and memory, which for
 * two paragraphs is a few tens of thousands of cells and about a millisecond.
 * Beyond `MAX_TOKENS` it declines to run and says so, rather than locking the
 * frame: `diffWords()` returns `null` and the caller shows both strings whole.
 * =============================================================================
 */

/** What happened to one run of tokens. */
export type DiffOp = 'same' | 'del' | 'ins';

/** One run of the diff, already joined back into a string. */
export interface DiffRun {
  op: DiffOp;
  /** The text of this run, including the whitespace that belonged to it. */
  text: string;
}

/**
 * Token ceiling per side. Two 900-token paragraphs would be an 810,000-cell
 * table; that is still fast, but a passage that large is a document and the
 * inline diff has stopped being readable long before it becomes slow. The cap
 * exists so the failure mode is an honest refusal rather than a stalled frame.
 */
export const MAX_TOKENS = 1200;

/**
 * Split into alternating word / whitespace tokens.
 *
 * Whitespace runs are their own tokens so that a substitution of one word does
 * not drag the space in front of it into the diff, and so that joining every
 * token in order returns the input unchanged.
 */
export function tokenize(text: string): string[] {
  const out = text.split(/(\s+)/);
  // `split` with a capturing group emits '' at the ends when the string starts
  // or finishes with whitespace. Empty tokens would inflate the table without
  // carrying anything.
  return out.filter((t) => t.length > 0);
}

/**
 * Word-level diff from `before` to `after`.
 *
 * Returns `null` when either side exceeds `MAX_TOKENS`; the caller must then
 * render the two strings side by side instead of pretending it aligned them.
 */
export function diffWords(before: string, after: string): DiffRun[] | null {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;

  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  // Stored as one flat Int32Array: (n+1)*(m+1) cells, row-major.
  const w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * w + (j + 1)] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + (j + 1)]);
    }
  }

  const runs: DiffRun[] = [];
  const push = (op: DiffOp, text: string): void => {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.op === op) last.text += text;
    else runs.push({ op, text });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + (j + 1)]) {
      push('del', a[i]);
      i++;
    } else {
      push('ins', b[j]);
      j++;
    }
  }
  while (i < n) push('del', a[i++]);
  while (j < m) push('ins', b[j++]);

  return runs;
}

/**
 * Collapse a change region into one deletion followed by one insertion.
 *
 * WHY THIS EXISTS — a defect caught by reading the rendered diff, not the code.
 *
 * Raw LCS output interleaves at word granularity. `The applicant accepted` ->
 * `Tollstrand Battery accepted` comes back as
 *
 *     del(The) ins(Tollstrand) same( ) del(applicant) ins(Battery) same( accepted)
 *
 * which renders on screen as `TheTollstrand applicantBattery accepted`. Every run
 * is correct and the whole thing is unreadable — the reader cannot see either
 * the original phrase or the substituted one, which is the only reason the diff
 * is on the page.
 *
 * So consecutive changes are gathered: all deleted text, then all inserted text,
 * with the whitespace that sits BETWEEN them carried into both sides (it belongs
 * to both strings) and a shared trailing space handed back to the unchanged
 * stream so the strikethrough does not run past the phrase it strikes.
 *
 * The result reads `The applicant Tollstrand Battery accepted` with one struck
 * noun phrase and one marked one — which is what actually happened.
 */
export function coalesce(runs: DiffRun[]): DiffRun[] {
  const out: DiffRun[] = [];
  let del = '';
  let ins = '';

  const flush = (): void => {
    // A trailing space common to both sides belongs to neither change.
    const dTail = /\s+$/.exec(del)?.[0] ?? '';
    const iTail = /\s+$/.exec(ins)?.[0] ?? '';
    let tail = '';
    if (dTail.length > 0 && dTail === iTail) {
      tail = dTail;
      del = del.slice(0, del.length - dTail.length);
      ins = ins.slice(0, ins.length - iTail.length);
    }
    if (del.length > 0) out.push({ op: 'del', text: del });
    if (ins.length > 0) out.push({ op: 'ins', text: ins });
    if (tail.length > 0) out.push({ op: 'same', text: tail });
    del = '';
    ins = '';
  };

  for (const run of runs) {
    if (run.op === 'del') {
      del += run.text;
      continue;
    }
    if (run.op === 'ins') {
      ins += run.text;
      continue;
    }
    // Unchanged whitespace inside a change region is part of both phrases.
    if ((del.length > 0 || ins.length > 0) && !/\S/.test(run.text)) {
      del += run.text;
      ins += run.text;
      continue;
    }
    flush();
    out.push(run);
  }
  flush();
  return out;
}

/**
 * The changed phrases, with a few words of context, and the rest elided.
 *
 * WHY THIS EXISTS. A citation card carries a nine-line quote clamped to three
 * lines so five of them fit in a rail. Rendering the diff into that clamp put
 * the one thing the card had to disclose — `The applicant` struck, `Tollstrand
 * Battery` marked, in the last sentence of the paragraph — six lines below the
 * cut. The card would have carried a correct diff that nobody could see, which
 * is indistinguishable from the badge it was supposed to replace.
 *
 * So the collapsed card shows the SUBSTITUTIONS and elides the unchanged prose
 * between them; the expanded card shows the whole stream, in place, in order.
 * Nothing is invented and nothing is reordered — the ellipsis stands for words
 * that are identical on both sides, and a run with no changes in it at all is
 * returned untouched, because there would be nothing to focus on.
 */
export function focusChanges(runs: DiffRun[], contextWords = 5): DiffRun[] {
  const changed = runs.some((r) => r.op !== 'same');
  if (!changed) return runs;

  /** Take `n` words from an end of a same-run, carrying their whitespace. */
  const clip = (text: string, n: number, fromStart: boolean): { text: string; cut: boolean } => {
    const tokens = tokenize(text);
    const words = tokens.filter((t) => /\S/.test(t)).length;
    if (words <= n) return { text, cut: false };
    let seen = 0;
    if (fromStart) {
      const out: string[] = [];
      for (const t of tokens) {
        if (/\S/.test(t)) {
          if (seen === n) break;
          seen++;
        }
        out.push(t);
      }
      return { text: out.join(''), cut: true };
    }
    const out: string[] = [];
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i] as string;
      if (/\S/.test(t)) {
        if (seen === n) break;
        seen++;
      }
      out.unshift(t);
    }
    return { text: out.join(''), cut: true };
  };

  const ELLIPSIS = ' … ';
  const out: DiffRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i] as DiffRun;
    if (run.op !== 'same') {
      out.push(run);
      continue;
    }
    const before = runs.slice(0, i).some((r) => r.op !== 'same');
    const after = runs.slice(i + 1).some((r) => r.op !== 'same');
    if (before && after) {
      const head = clip(run.text, contextWords, true);
      const tail = clip(run.text, contextWords, false);
      if (!head.cut) out.push(run);
      else out.push({ op: 'same', text: `${head.text}${ELLIPSIS}${tail.text}` });
      continue;
    }
    if (before) {
      const head = clip(run.text, contextWords, true);
      out.push({ op: 'same', text: head.cut ? `${head.text}${ELLIPSIS}` : head.text });
      continue;
    }
    const tail = clip(run.text, contextWords, false);
    out.push({ op: 'same', text: tail.cut ? `${ELLIPSIS}${tail.text}` : tail.text });
  }
  return out;
}

/**
 * How much of `after` is not literally present in `before`, 0..1.
 *
 * Measured in TOKENS, not characters, because the unit the substitution happened
 * in is the word. Used to state the size of the rewrite next to the diff, so a
 * one-pronoun resolution and a wholesale reword are not both filed under the
 * same three-word label.
 */
export function substitutionShare(runs: DiffRun[] | null): number {
  if (runs === null) return NaN;
  let kept = 0;
  let added = 0;
  for (const run of runs) {
    const count = tokenize(run.text).filter((t) => /\S/.test(t)).length;
    if (run.op === 'same') kept += count;
    else if (run.op === 'ins') added += count;
  }
  const total = kept + added;
  return total === 0 ? 0 : added / total;
}

/**
 * The first character position at which two strings differ, or `-1` when they
 * are identical.
 *
 * This is the tamper control's other half: `diffWords` explains a rewritten
 * sentence, and this locates a single mutated byte inside a signature or a
 * quote, so the panel can point at the character that changed rather than
 * asserting that one did.
 */
export function firstDifference(before: string, after: string): number {
  const limit = Math.min(before.length, after.length);
  for (let i = 0; i < limit; i++) {
    if (before[i] !== after[i]) return i;
  }
  return before.length === after.length ? -1 : limit;
}

/** A mutated string, split for display around the character that changed. */
export interface MutationSlice {
  /** Characters before the change, already trimmed to `context` on the left. */
  head: string;
  /** The changed character (or `''` when the string only grew or shrank). */
  at: string;
  /** Characters after the change, trimmed to `context` on the right. */
  tail: string;
  /** True when the head was cut. */
  headCut: boolean;
  /** True when the tail was cut. */
  tailCut: boolean;
  /** The index the change was found at, or `-1`. */
  index: number;
}

/**
 * Slice a string around `index` so the changed character can be shown in place
 * with a readable amount of context on each side.
 */
export function sliceAround(text: string, index: number, context = 34): MutationSlice {
  if (index < 0) {
    return { head: text, at: '', tail: '', headCut: false, tailCut: false, index };
  }
  const from = Math.max(0, index - context);
  const to = Math.min(text.length, index + context + 1);
  return {
    head: text.slice(from, index),
    at: index < text.length ? text[index] : '',
    tail: text.slice(Math.min(index + 1, text.length), to),
    headCut: from > 0,
    tailCut: to < text.length,
    index,
  };
}
