/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — FUZZY MATCHING
 * =============================================================================
 *
 * Subsequence matching with positional bonuses. Pure, allocation-light, no
 * dependency: `Bruntorp`, `tesf` and `tf` all reach `Bruntorp Facility`, and
 * `bruntorpf` beats `testing framework` because the match is contiguous and starts
 * at a word boundary.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not score by "relevance". There is
 * no popularity term, no click history, no learned weighting. The rank is a
 * function of the query and the label and nothing else, so the same keystrokes
 * always produce the same list — which is what makes a command palette a tool
 * rather than a slot machine.
 *
 * -----------------------------------------------------------------------------
 * THE COMPACTNESS GATE, AND WHY A SCORE IS NOT ENOUGH
 * -----------------------------------------------------------------------------
 * A bare subsequence test matches almost anything once the haystack is a
 * sentence. Typing `Bruntorp` into the palette returned all five staged questions,
 * because t-e-s-s-i-n can be picked out of "Put the dated sessions on Recycling
 * and Black Mass in order…" without difficulty. Ranking them below the real hits
 * is not a fix: they were still five rows of noise above the fold.
 *
 * So a match is REJECTED, not merely penalised, unless every matched character is
 * either contiguous with the one before it or sits at a word boundary. That
 * single rule keeps the two things people actually type — a prefix (`bruntorp f`)
 * and an acronym (`bzc` for "Bidding Zone SE3 Congestion") — and throws out
 * letters scavenged from the middles of unrelated words.
 * ========================================================================== */

/** A match, with the character indices that matched so they can be marked up. */
export interface FuzzyMatch {
  score: number;
  /** Indices into the ORIGINAL haystack string that the query characters landed on. */
  indices: number[];
}

const BONUS_START = 12; // matched at the very beginning of the string
const BONUS_WORD = 8; // matched at the start of a word
const BONUS_CONTIGUOUS = 6; // matched immediately after the previous match
const PENALTY_GAP = 1; // per skipped character between matches
const PENALTY_LEAD = 2; // per skipped character before the first match

function isBoundary(prev: string): boolean {
  return prev === ' ' || prev === '-' || prev === '_' || prev === '.' || prev === ':' || prev === '/';
}

/**
 * Score `query` against `haystack`, or `null` when the query is not a
 * subsequence of it. Case-insensitive; the returned indices address the original
 * string so a caller can bold exactly what matched.
 */
export function fuzzyMatch(query: string, haystack: string): FuzzyMatch | null {
  if (haystack.length === 0) return null;

  const q = query.toLowerCase().replace(/\s+/g, ''); // spaces separate, they do not match
  if (q.length === 0) return { score: 0, indices: [] };
  const h = haystack.toLowerCase();

  /**
   * Every position the first query character could start at is tried, and the
   * best complete match wins.
   *
   * The greedy single pass this replaced would commit to the FIRST occurrence of
   * the query's opening character and never reconsider. On a long staged
   * question — "Which group acquired the operator that runs Bruntorp Facility?" —
   * an early accidental match consumes the run, leaves the remaining characters
   * scattered far apart, and the question that genuinely matched scores worse
   * than one that barely does. Starting over from each candidate position finds
   * the real, compact run.
   */
  let best: FuzzyMatch | null = null;
  for (let startAt = 0; startAt < h.length; startAt++) {
    if (h[startAt] !== q[0]) continue;
    const attempt = matchFrom(q, h, startAt);
    if (attempt !== null && (best === null || attempt.score > best.score)) best = attempt;
  }
  return best;
}

/** One complete attempt, anchored at `startAt`. `null` when it cannot finish. */
function matchFrom(q: string, h: string, startAt: number): FuzzyMatch | null {
  const indices: number[] = [startAt];
  // The first character may sit anywhere — an infix search is a legitimate thing
  // to type. Everything after it has to be compact.
  let score = startAt === 0 ? BONUS_START : isBoundary(h[startAt - 1]) ? BONUS_WORD : 0;
  score -= startAt * PENALTY_LEAD;
  let prev = startAt;

  for (let qi = 1; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let i = prev + 1; i < h.length; i++) {
      if (h[i] !== ch) continue;
      // THE COMPACTNESS GATE. Keep scanning past a character that only appears
      // in the middle of an unrelated word; it is not a match at any score.
      if (i !== prev + 1 && !isBoundary(h[i - 1])) continue;
      found = i;
      break;
    }
    if (found < 0) return null;

    if (found === prev + 1) score += BONUS_CONTIGUOUS;
    else score += BONUS_WORD - (found - prev - 1) * PENALTY_GAP;

    indices.push(found);
    prev = found;
  }

  // Shorter haystacks win ties: an exact label beats the same word buried in a
  // longer one. Length is a tiebreak, never the dominant term.
  score -= h.length * 0.05;
  return { score, indices };
}

/** The best match of `query` across several strings — a label plus its aliases. */
export function fuzzyBest(query: string, haystacks: readonly string[]): FuzzyMatch | null {
  let best: FuzzyMatch | null = null;
  for (let i = 0; i < haystacks.length; i++) {
    const m = fuzzyMatch(query, haystacks[i]);
    if (m === null) continue;
    // Only the primary string's indices are usable for mark-up, so an alias hit
    // scores but does not claim to know where in the label it matched.
    const scored: FuzzyMatch = i === 0 ? m : { score: m.score - 4, indices: [] };
    if (best === null || scored.score > best.score) best = scored;
  }
  return best;
}

/** Split a label into matched / unmatched runs, for rendering without regexes. */
export function markRuns(label: string, indices: readonly number[]): { text: string; hit: boolean }[] {
  if (indices.length === 0) return [{ text: label, hit: false }];
  const set = new Set(indices);
  const runs: { text: string; hit: boolean }[] = [];
  let buf = '';
  let hit = set.has(0);
  for (let i = 0; i < label.length; i++) {
    const h = set.has(i);
    if (h !== hit) {
      if (buf.length > 0) runs.push({ text: buf, hit });
      buf = '';
      hit = h;
    }
    buf += label[i];
  }
  if (buf.length > 0) runs.push({ text: buf, hit });
  return runs;
}
