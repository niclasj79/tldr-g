/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — LABELS, MAP-CITY STYLE
 * =============================================================================
 *
 * A city map shows STOCKHOLM at every zoom and the side streets only when you
 * are close. It does not show every street name at every altitude and then
 * apologise for the clutter. This layer does exactly that, and it is the
 * difference between a readable terrain and a label storm.
 *
 * Three rules, all of them hard:
 *
 *   ALTITUDE-GATED   Only nodes the current view actually contains are eligible,
 *                    plus whatever the pointer is on. Descending a rung changes
 *                    which names exist, not just which ones fit.
 *   CENTRALITY-RANKED  Candidates are sorted by how much the graph leans on them,
 *                    with selection and hover promoted above everything. When
 *                    labels have to be dropped, the ones that survive are the
 *                    ones that carry the map.
 *   COLLISION-CULLED A screen-space occupancy grid means two labels never
 *                    overlap. Overlapping text is not "dense", it is unreadable,
 *                    and it makes the whole instrument look approximate.
 *
 * The ceiling is `--label-max` on screen at once. Not a soft target: the loop
 * stops when it is reached.
 *
 * -----------------------------------------------------------------------------
 * WHY THE DOM
 * -----------------------------------------------------------------------------
 * Text in WebGL means a glyph atlas, a font pipeline, and either a draw call per
 * batch or a texture upload per label change. The browser already has a
 * subpixel-accurate text renderer with the right font metrics, and forty
 * absolutely-positioned spans updated by transform cost nothing. Crucially it
 * costs ZERO WebGL draw calls, which is the constraint that mattered.
 *
 * Nothing here touches React. The spans are pooled and mutated directly, so a
 * camera pan never re-renders a component.
 * ========================================================================== */

import './labels.css';

import type { TerrainCameraImpl } from '@/graph/camera';
import type { Palette } from '@/graph/palette';
import type { Rung } from '@/engine';

/** One nameable thing. Supplied by the terrain from the current view payload. */
export interface LabelCandidate {
  id: string;
  text: string;
  /** Rung glyph, drawn before the name so the kind is readable without a legend. */
  glyph: string;
  /** World position of the node this label names. */
  x: number;
  y: number;
  /** World radius, so the label clears the node's own disc or boundary. */
  r: number;
  /**
   * HOW BIG THE MARK UNDER THIS NAME IS DRAWN, in CSS px.
   *
   * Supplied by the terrain because the terrain is what draws it: the point
   * layer's sizing rules (primary body vs capital vs leaf dot) live there, and a
   * label layer that guessed would be guessing about another module's geometry.
   *
   * It is here because A LABEL MUST NOT LAND ON SOMEONE ELSE'S MARK. The
   * occupancy grid only ever knew about other LABELS, so "Nordic Balancing
   * Model" was free to print its last four letters straight through the capital
   * of the island next door — two things the map is making, drawn on top of each
   * other, which reads as a rendering fault rather than as density.
   */
  mark: number;
  /** 0..1 centrality within the view. The ranking key. */
  centrality: number;
  /** Region nodes are drawn as boundaries; their label hangs off the capital. */
  region: boolean;
}

/** Extra promotion applied at update time — hover, selection, constellation. */
export interface LabelState {
  hover: string | null;
  selected: ReadonlySet<string>;
  constellation: ReadonlySet<string>;
  focus: string | null;
}

const EMPTY_STATE: LabelState = {
  hover: null,
  selected: new Set(),
  constellation: new Set(),
  focus: null,
};

interface Slot {
  el: HTMLSpanElement;
  glyph: HTMLSpanElement;
  text: Text;
  id: string;
  cls: string;
  visible: boolean;
}

/**
 * Break points a name may be shortened AT, in preference order.
 *
 * NEVER AN ELLIPSIS. "Control-room thread — holding period, …" is not a label,
 * it is the announcement that the layer gave up: the reader cannot tell whether
 * two truncated names are the same document, and a truncated proper noun in the
 * only place that noun appears is worse than no label at all.
 *
 * So a name that does not fit is either shortened at a boundary its author
 * already put there — before the em-dash, before the subtitle colon, before the
 * first comma — or it is DROPPED. Both are honest; the ellipsis is not.
 */
const BREAKS = [' — ', ' – ', ' - ', ': ', ', '];

function fitText(text: string, fits: (s: string) => boolean): string | null {
  if (fits(text)) return text;
  for (const b of BREAKS) {
    const i = text.indexOf(b);
    if (i > 2) {
      const head = text.slice(0, i);
      if (fits(head)) return head;
    }
  }
  return null;
}

export class LabelLayer {
  private readonly host: HTMLDivElement;
  private readonly slots: Slot[] = [];
  private candidates: LabelCandidate[] = [];
  /** Candidate order, sorted once per view rather than once per frame. */
  private order: number[] = [];
  private widths = new Map<string, number>();

  private maxLabels: number;
  private cellPx: number;
  private offsetPx: number;

  private grid = new Uint8Array(0);
  private gridCols = 0;
  private gridRows = 0;

  /**
   * THE MARKS A LABEL HAS TO KEEP OFF, in screen space, rebuilt each pass.
   *
   * Not in the occupancy grid, and deliberately: a candidate has to be allowed
   * to sit beside ITS OWN mark, which a grid cannot express — it would have to
   * be cleared and re-stamped per candidate. Four parallel typed arrays and an
   * exact circle/rect test are both cheaper and precise. Preallocated once and
   * refilled, so a pass over them allocates nothing.
   */
  private markX = new Float32Array(0);
  private markY = new Float32Array(0);
  private markR = new Float32Array(0);
  private markOwner = new Int32Array(0);
  private markCount = 0;

  private measure: CanvasRenderingContext2D | null = null;
  private fontMinor = '';
  private fontMajor = '';
  private lineHeight = 14;

  /** How many labels survived the last pass. Reported in `FrameStats`. */
  visible = 0;
  /** How many were eligible. `visible / total` is the honest suppression rate. */
  total = 0;

  private maxWidthPx: number;

  /* --- constellation ranking (see `setRank`) ------------------------------ */
  private pathCore: ReadonlySet<string> = new Set();
  private answerId: string | null = null;
  private constellationCap = 8;
  /** The regions the answer path stands on. See `setLandfall`. */
  private landfall: ReadonlySet<string> = new Set();
  /** Text actually painted, per candidate, after the no-truncation rule. */
  private fitted = new Map<string, string | null>();

  /** `--node-answer` and `--node-path`: what the path's own marks are drawn at. */
  private readonly answerMarkPx: number;
  private readonly pathMarkPx: number;

  constructor(
    parent: HTMLElement,
    private palette: Palette,
    tokens: {
      max: number;
      cell: number;
      offset: number;
      maxWidth: number;
      answerMark: number;
      pathMark: number;
    },
  ) {
    this.host = document.createElement('div');
    this.host.className = 'tg-labels';
    parent.appendChild(this.host);
    this.maxLabels = tokens.max;
    this.cellPx = Math.max(2, tokens.cell);
    this.offsetPx = tokens.offset;
    this.maxWidthPx = tokens.maxWidth;
    // Both of those marks are drawn with a halo of 0.62 of their own radius. The
    // name has to clear what the eye sees, not the disc alone, so the halo is
    // folded in here once rather than at each of the four sites that read them.
    this.answerMarkPx = tokens.answerMark * 1.25;
    this.pathMarkPx = tokens.pathMark * 1.25;
    this.initMeasure();
  }

  private initMeasure(): void {
    const cs = getComputedStyle(document.documentElement);
    const family = cs.getPropertyValue('--ff-ui').trim() || 'sans-serif';
    const weight = cs.getPropertyValue('--fw-500').trim() || '500';
    const minor = cs.getPropertyValue('--fs-11').trim() || '11px';
    const major = cs.getPropertyValue('--fs-12-5').trim() || '12.5px';
    this.fontMinor = `${weight} ${minor} ${family}`;
    this.fontMajor = `${weight} ${major} ${family}`;
    this.lineHeight = Math.ceil(Number.parseFloat(major) * 1.25);
    const canvas = document.createElement('canvas');
    this.measure = canvas.getContext('2d');
  }

  /** The ceiling on labels on screen. `labels.setDensity(n)` in the contract. */
  setDensity(n: number): void {
    this.maxLabels = Math.max(0, Math.floor(n));
  }

  /**
   * WHICH CONSTELLATION MEMBERS ARE ALLOWED A NAME, AND IN WHAT ORDER.
   *
   * A bridge answer is twenty-six nodes. Promoting all twenty-six put fifteen
   * names into one corner of the map in a single cramped mass — the label storm
   * the whole layer exists to prevent, committed by the layer itself, in the
   * frame that goes in the deck.
   *
   * So membership is not a promotion any more, RANK is: the answer wins, then
   * the bridge and the path endpoints, then the cap runs out and the remaining
   * context nodes stay lit but unnamed. They are still on the map, still in the
   * rail, and still one hover away from their name.
   */
  setRank(pathCore: ReadonlySet<string>, answerId: string | null, cap: number): void {
    this.pathCore = pathCore;
    this.answerId = answerId;
    this.constellationCap = Math.max(0, Math.floor(cap));
  }

  /**
   * THE REGIONS THE ANSWER PATH STANDS ON, which must be NAMED.
   *
   * A bridge answer's whole claim is "these two islands, joined through this
   * entity". The frame was lighting the right ground and then labelling seven
   * other islands and neither of those two, so the one question the picture is
   * making — WHICH islands does it span — had no answer in the picture. These
   * outrank the ambient queue and sit just under the path's own names.
   */
  setLandfall(ids: Iterable<string>): void {
    this.landfall = new Set(ids);
  }

  /** Replace the eligible set. Called on a view change, never per frame. */
  setCandidates(list: LabelCandidate[]): void {
    this.candidates = list;
    this.widths.clear();
    this.fitted.clear();
    this.order = list.map((_, i) => i);
    // Regions before leaves, then by centrality. A stable id tie-break keeps the
    // surviving set from flickering between two equally-central nodes.
    this.order.sort((a, b) => {
      const A = list[a];
      const B = list[b];
      if (A.region !== B.region) return A.region ? -1 : 1;
      if (B.centrality !== A.centrality) return B.centrality - A.centrality;
      return A.id < B.id ? -1 : 1;
    });
    this.total = list.length;
    this.resolveTexts();
  }

  /**
   * WHAT EACH CANDIDATE MAY BE PAINTED WITH — decided once per view, for the
   * whole set at once, because the rule is about the set.
   *
   * A name is either drawn whole, shortened at a break its own author wrote, or
   * dropped (see `BREAKS`). There is a fourth failure the per-candidate version
   * could not see: two DIFFERENT documents whose shortened forms are the same
   * string. The asset rung was printing "Control-room thread" twice and
   * "Chapter 4" twice, for four different documents, in a product whose entire
   * claim is that you can tell which artifact a mark came from. Two identical
   * labels on two different things is not a shortened name, it is a wrong one.
   *
   * So a painted string has to be UNIQUE across the view. The highest-ranked
   * claimant keeps it — the order is already regions-then-centrality — and every
   * later collision is dropped. Dropped, not ellipsed, and not disambiguated
   * with a suffix the author never wrote.
   *
   * AND WHEN A SHORTENING COLLIDES, NOBODY GETS IT — not "the first claimant
   * wins". Three documents named "Thread: Ludvikaberg Depot…", "Thread: holding
   * period…" and "Thread: use of proceeds…" all shorten to "Thread", and letting
   * the highest-ranked one keep it put the bare word THREAD on the asset rung
   * next to a mark, naming a KIND where a name was promised. The reader cannot
   * tell which of the three it is, which is the same failure as printing it
   * twice — it just hides better. A shortened form that more than one document
   * would answer to is not a name of any of them, so all of them go unwritten
   * and the honest full names take the slots instead. A name that fits WHOLE is
   * never subject to this: if two documents really are called the same thing,
   * that is the corpus's ambiguity and not the label layer's to correct.
   */
  private resolveTexts(): void {
    const measure = this.measure;
    if (measure !== null) measure.font = this.fontMajor;

    // Pass one: what each candidate would be painted with, and how many
    // different documents each SHORTENED form would answer to.
    const wanted: (string | null)[] = new Array(this.candidates.length).fill(null);
    const shortenedUses = new Map<string, number>();
    for (const idx of this.order) {
      const c = this.candidates[idx];
      const fits = (s: string): boolean =>
        measure === null
          ? `${c.glyph} ${s}`.length * 6.2 + 12 <= this.maxWidthPx
          : measure.measureText(`${c.glyph} ${s}`).width + 2 <= this.maxWidthPx;
      const out = fitText(c.text, fits);
      wanted[idx] = out;
      if (out !== null && out !== c.text) {
        shortenedUses.set(out, (shortenedUses.get(out) ?? 0) + 1);
      }
    }

    // Pass two: claim.
    const claimed = new Set<string>();
    for (const idx of this.order) {
      const c = this.candidates[idx];
      const out = wanted[idx];
      const ambiguous = out !== null && out !== c.text && (shortenedUses.get(out) ?? 0) > 1;
      if (out === null || ambiguous || claimed.has(out)) {
        this.fitted.set(c.id, null);
        continue;
      }
      claimed.add(out);
      this.fitted.set(c.id, out);
    }
  }

  /**
   * The text this candidate may actually be painted with, or `null` when it
   * cannot be painted honestly at all. See `resolveTexts`.
   */
  private textOf(c: LabelCandidate): string | null {
    return this.fitted.get(c.id) ?? null;
  }

  private widthOf(c: LabelCandidate, text: string, major: boolean): number {
    const key = `${major ? '1' : '0'}|${c.id}`;
    const hit = this.widths.get(key);
    if (hit !== undefined) return hit;
    let w = Math.min(this.maxWidthPx, text.length * 6.2 + 12);
    if (this.measure) {
      this.measure.font = major ? this.fontMajor : this.fontMinor;
      w = Math.min(this.maxWidthPx, this.measure.measureText(`${c.glyph} ${text}`).width + 2);
    }
    this.widths.set(key, w);
    return w;
  }

  /**
   * Place the labels for the current camera. Runs at most once per rendered
   * frame and allocates nothing: the occupancy grid and the span pool are both
   * reused, and the sort happened at `setCandidates` time.
   */
  update(camera: TerrainCameraImpl, viewW: number, viewH: number, state: LabelState = EMPTY_STATE): void {
    const cols = Math.max(1, Math.ceil(viewW / this.cellPx));
    const rows = Math.max(1, Math.ceil(viewH / this.cellPx));
    if (cols !== this.gridCols || rows !== this.gridRows) {
      this.gridCols = cols;
      this.gridRows = rows;
      this.grid = new Uint8Array(cols * rows);
    } else {
      this.grid.fill(0);
    }

    const zoom = camera.get().zoom;
    let placed = 0;
    let slotIndex = 0;
    let constellationPlaced = 0;
    const fogging = state.constellation.size > 0;

    /* RANKED, NOT MERELY PROMOTED. Lower is better:
     *   0  the answer — the thing the question asked to have named
     *   1  the bridge entity and the path endpoints
     *   2  hover / focus / selection: what the user is pointing at
     *   3  the regions the answer path STANDS ON — see `setLandfall`
     *   4  every other constellation member, up to the cap
     * Everything else falls through to the ordinary centrality queue. */
    const rankOf = (c: LabelCandidate): number => {
      if (c.id === this.answerId) return 0;
      if (this.pathCore.has(c.id)) return 1;
      if (c.id === state.hover || c.id === state.focus || state.selected.has(c.id)) return 2;
      if (this.landfall.has(c.id)) return 3;
      if (state.constellation.has(c.id)) return 4;
      return 9;
    };

    const promoted: number[] = [];
    for (let k = 0; k < this.order.length; k++) {
      if (rankOf(this.candidates[this.order[k]]) < 9) promoted.push(this.order[k]);
    }
    promoted.sort((a, b) => {
      const ra = rankOf(this.candidates[a]);
      const rb = rankOf(this.candidates[b]);
      if (ra !== rb) return ra - rb;
      return this.candidates[b].centrality - this.candidates[a].centrality;
    });

    this.reserveMarks(camera, viewW, viewH, promoted, rankOf, zoom);

    const walk = (idx: number): boolean => {
      if (placed >= this.maxLabels) return false;
      const c = this.candidates[idx];
      const rank = rankOf(c);
      // The cap applies to CONTEXT members only. The answer, the bridge, the
      // path endpoints and the ground they stand on are never dropped for want
      // of a slot.
      if (rank === 4 && constellationPlaced >= this.constellationCap) return true;

      const text = this.textOf(c);
      // A name that cannot be drawn whole is not drawn. See `BREAKS`.
      if (text === null) return true;

      const [sx, syUp] = camera.worldToScreen(c.x, c.y);
      const sy = viewH - syUp; // DOM y is down; the camera speaks y-up.
      if (sx < -200 || sx > viewW + 200 || sy < -60 || sy > viewH + 60) return true;

      // The map-city rule: only the handful that carry the map get the larger,
      // brighter treatment. Everything else is a side street.
      const major = rank <= 3 || (c.region && c.centrality >= 0.66 && !fogging);
      const w = this.widthOf(c, text, major);
      const h = this.lineHeight;

      /* Clear the node's own mark. A region hangs its name off its capital, not
       * off its boundary, or an island's label would fly off into the sea — but
       * the capital of the rung you are standing on is a BODY sized across
       * --node-body-min..max, and the answer is drawn at --node-answer, so a
       * flat ten-pixel offset put the last two letters of "Nordic Balancing
       * Model" inside its own island's disc and printed the answer's own name
       * across the answer's own mark. The offset is measured from what is
       * actually drawn, and never tightens below what it used to be. */
      const own =
        rank === 0
          ? Math.max(c.mark, this.answerMarkPx)
          : rank <= 2
            ? Math.max(c.mark, this.pathMarkPx)
            : c.mark;
      const clearance = Math.max(
        this.offsetPx + 3,
        own * 0.92 + 4,
        c.region ? 0 : Math.min(14, c.r * zoom) + this.offsetPx,
      );

      /* HOW MUCH AIR THIS NAME KEEPS AROUND IT.
       *
       * Two names one pixel apart do not overlap and are still unreadable: the
       * eye runs them together into one string, which at the island rung meant
       * "Nordic Balancing Model" and "Land Access and Easements" reading as a
       * single caption belonging to neither island.
       *
       * And a name on the answer path keeps MORE air, because the worst case is
       * not two names touching, it is two names touching whose subjects are
       * nearly homonyms — "Rimsdal Holdings" the island stacked on
       * "Rimsdal Group" the answer. When the constellation and the terrain
       * contend, the constellation is placed first and claims the wider berth;
       * the terrain name yields and goes somewhere else, or it goes unwritten. */
      const air = rank <= 3 ? this.offsetPx + 3 : 3;

      /* Six candidate positions, not four. Two region nodes can sit ten pixels
       * apart — a continent and the continent whose centroid nearly coincides
       * with it — and with only the four cardinal offsets the second name loses
       * every one of them to the first name's own box and is dropped. The map
       * then shows five of six continents while the panel beside it says six,
       * which reads as a rendering bug rather than as a collision. */
      const tries: Array<[number, number]> = [
        [sx + clearance, sy - h / 2],
        [sx - clearance - w, sy - h / 2],
        [sx - w / 2, sy - clearance - h],
        [sx - w / 2, sy + clearance],
        [sx + clearance * 0.7, sy + clearance],
        [sx - clearance * 0.7 - w, sy - clearance - h],
      ];

      /* A SECOND RING, FOR THE NAMES THAT MAY NOT BE DROPPED.
       *
       * The answer, the path core, what the pointer is on and the ground the
       * answer stands on are promised a name — "never dropped for want of a
       * slot". Six positions at one radius is not a promise, it is a hope: an
       * answer that lands in a crowded island can lose all six to its own
       * neighbours' names and then the frame's subject is unlabelled. So those
       * four ranks get one wider ring before they give up. Nothing else does,
       * because a context name floating forty pixels from its mark is a caption
       * pointing at nothing. */
      if (rank <= 3) {
        const far = clearance * 2.1;
        tries.push(
          [sx + far, sy - h / 2],
          [sx - far - w, sy - h / 2],
          [sx - w / 2, sy - far - h],
          [sx - w / 2, sy + far],
        );
      }

      for (const [lx, ly] of tries) {
        if (lx < 2 || ly < 2 || lx + w > viewW - 2 || ly + h > viewH - 2) continue;
        if (!this.free(lx, ly, w, h)) continue;
        if (this.hitsMark(lx, ly, w, h, idx)) continue;
        this.occupy(lx - air, ly - air, w + air * 2, h + air * 2);
        slotIndex = this.paint(slotIndex, c, text, lx, ly, major, rank, fogging);
        placed++;
        if (rank === 4) constellationPlaced++;
        return true;
      }
      return true;
    };

    const seen = new Set<number>();
    for (const idx of promoted) {
      seen.add(idx);
      if (!walk(idx)) break;
    }
    /* FOG APPLIES TO NAMES TOO. Once an answer is on screen the thirty-three
     * island names are context, and thirty-three full-ink names around a lit
     * constellation is why 'home' and 'receipt' were indistinguishable in
     * luminance. They stay — nothing is hidden — in --ink-faint and only a
     * handful of them.
     *
     * And under fog only PLACES are named. An unattended entity is drawn at
     * `--fog-node`, which is a mark you cannot see at label distance, so its
     * name would be a caption floating over empty black — the interface
     * labelling something it is not showing. A region always has a visible body
     * under its name. */
    const ambientCeiling = fogging ? Math.min(this.maxLabels, placed + 8) : this.maxLabels;
    if (placed < ambientCeiling) {
      for (const idx of this.order) {
        if (seen.has(idx)) continue;
        if (fogging && !this.candidates[idx].region) continue;
        if (placed >= ambientCeiling) break;
        if (!walk(idx)) break;
      }
    }

    for (let i = slotIndex; i < this.slots.length; i++) this.hide(this.slots[i]);
    this.visible = placed;
  }

  /**
   * STAMP THE MARKS THIS PASS HAS TO WRITE AROUND.
   *
   * The set is bounded, not "every node": at a hundred thousand nodes an
   * exhaustive reservation would be both unaffordable and wrong — a 1.2px
   * ambient dot under a letter is grain, not a collision. What matters is the
   * marks the eye reads as OBJECTS: the bodies of the current rung, the region
   * capitals, and everything the answer path lit. Those are exactly the head of
   * the candidate order plus the promoted set, so the walk is over a fixed
   * prefix and costs the same at 6k as at 100k.
   */
  private reserveMarks(
    camera: TerrainCameraImpl,
    viewW: number,
    viewH: number,
    promoted: readonly number[],
    rankOf: (c: LabelCandidate) => number,
    zoom: number,
  ): void {
    const cap = Math.max(64, this.maxLabels * 4);
    if (this.markX.length !== cap) {
      this.markX = new Float32Array(cap);
      this.markY = new Float32Array(cap);
      this.markR = new Float32Array(cap);
      this.markOwner = new Int32Array(cap);
    }
    this.markCount = 0;

    const add = (idx: number): void => {
      if (this.markCount >= cap) return;
      const c = this.candidates[idx];
      const rank = rankOf(c);
      /* ONLY WHAT THE EYE READS AS AN OBJECT.
       *
       * A body of the current rung, a region capital, and whatever the answer
       * path lit. NOT the ambient entity layer: a 6px unattended dot under a
       * letter is grain, and reserving all of them turned a dense island into a
       * surface with no legal position on it — the answer's own name was pushed
       * off its node and the island it stands on lost its name entirely, which
       * is a worse lie than the overprint this exists to prevent. */
      if (!c.region && rank > 2) return;
      // The path's own marks are drawn at --node-path / --node-answer, which
      // clear every ordinary ceiling; a reservation that used the resting size
      // would be reserving a disc the renderer does not draw.
      let r = c.mark;
      if (rank === 0) r = Math.max(r, this.answerMarkPx);
      else if (rank <= 2) r = Math.max(r, this.pathMarkPx);
      if (r < 3) return;
      const [sx, syUp] = camera.worldToScreen(c.x, c.y);
      const sy = viewH - syUp;
      if (sx < -r || sy < -r || sx > viewW + r || sy > viewH + r) return;
      const i = this.markCount++;
      this.markX[i] = sx;
      this.markY[i] = sy;
      this.markR[i] = r;
      this.markOwner[i] = idx;
    };

    for (const idx of promoted) add(idx);
    const prefix = Math.min(this.order.length, cap);
    for (let k = 0; k < prefix && this.markCount < cap; k++) add(this.order[k]);
  }

  /**
   * Would this box print over a mark that is not its own?
   *
   * Exact circle/rect, because the whole point is that a name may sit BESIDE its
   * own node and must not sit on anybody else's.
   */
  private hitsMark(x: number, y: number, w: number, h: number, owner: number): boolean {
    for (let i = 0; i < this.markCount; i++) {
      if (this.markOwner[i] === owner) continue;
      const cx = this.markX[i];
      const cy = this.markY[i];
      const r = this.markR[i];
      const nx = cx < x ? x : cx > x + w ? x + w : cx;
      const ny = cy < y ? y : cy > y + h ? y + h : cy;
      const dx = cx - nx;
      const dy = cy - ny;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }

  private free(x: number, y: number, w: number, h: number): boolean {
    const c0 = Math.max(0, Math.floor(x / this.cellPx));
    const c1 = Math.min(this.gridCols - 1, Math.floor((x + w) / this.cellPx));
    const r0 = Math.max(0, Math.floor(y / this.cellPx));
    const r1 = Math.min(this.gridRows - 1, Math.floor((y + h) / this.cellPx));
    for (let r = r0; r <= r1; r++) {
      const base = r * this.gridCols;
      for (let c = c0; c <= c1; c++) if (this.grid[base + c] !== 0) return false;
    }
    return true;
  }

  private occupy(x: number, y: number, w: number, h: number): void {
    const c0 = Math.max(0, Math.floor(x / this.cellPx));
    const c1 = Math.min(this.gridCols - 1, Math.floor((x + w) / this.cellPx));
    const r0 = Math.max(0, Math.floor(y / this.cellPx));
    const r1 = Math.min(this.gridRows - 1, Math.floor((y + h) / this.cellPx));
    for (let r = r0; r <= r1; r++) {
      const base = r * this.gridCols;
      for (let c = c0; c <= c1; c++) this.grid[base + c] = 1;
    }
  }

  private paint(
    slotIndex: number,
    c: LabelCandidate,
    text: string,
    x: number,
    y: number,
    major: boolean,
    rank: number,
    fogging: boolean,
  ): number {
    const slot = this.slot(slotIndex);
    let cls = 'tg-label';
    if (major) cls += ' tg-label--major';
    /* --render IS RESERVED FOR THE PATH, not for constellation membership.
     * Colouring fourteen names teal is how the render light stopped meaning
     * anything: the answer's own name had no way left to be brighter than its
     * neighbours. The path core is lit; the rest of the constellation is white
     * with rank; the unattended world is faint. */
    if (rank <= 1) cls += ' tg-label--render';
    else if (rank === 2 || rank === 3) cls += ' tg-label--attend';
    else if (rank > 4 && fogging) cls += ' tg-label--fog';
    if (rank === 0) cls += ' tg-label--answer';
    if (slot.cls !== cls) {
      slot.el.className = cls;
      slot.cls = cls;
    }
    if (slot.id !== c.id || slot.text.nodeValue !== text) {
      slot.glyph.textContent = c.glyph;
      slot.text.nodeValue = text;
      slot.id = c.id;
    }
    slot.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    if (!slot.visible) {
      slot.el.style.display = '';
      slot.visible = true;
    }
    return slotIndex + 1;
  }

  private slot(i: number): Slot {
    let slot = this.slots[i];
    if (slot !== undefined) return slot;
    const el = document.createElement('span');
    el.className = 'tg-label';
    const glyph = document.createElement('span');
    glyph.className = 'tg-label__glyph';
    const text = document.createTextNode('');
    el.appendChild(glyph);
    el.appendChild(text);
    this.host.appendChild(el);
    slot = { el, glyph, text, id: '', cls: 'tg-label', visible: true };
    this.slots[i] = slot;
    return slot;
  }

  private hide(slot: Slot): void {
    if (!slot.visible) return;
    slot.el.style.display = 'none';
    slot.visible = false;
  }

  dispose(): void {
    this.host.remove();
    this.slots.length = 0;
  }
}

/** The rung glyph for a node kind. Entities and sources are not rungs. */
export function glyphForKind(kind: string, rungGlyph: Readonly<Record<Rung, string>>): string {
  switch (kind) {
    case 'continent':
      return rungGlyph.continent;
    case 'island':
      return rungGlyph.island;
    case 'asset':
      return rungGlyph.asset;
    case 'passage':
      return rungGlyph.passage;
    default:
      // Entities and sources are the cross-cutting layer, not rungs, and giving
      // them a rung glyph would be a lie about the grain.
      return '';
  }
}
