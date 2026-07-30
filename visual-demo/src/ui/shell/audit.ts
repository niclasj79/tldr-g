/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE AUDIT SURFACE
 * =============================================================================
 *
 * `window.__atlas.audit()` measures the LIVE DOM and the LIVE store, and returns
 * the half of the critic's checklist that cannot be decided by reading source.
 *
 * The whole point is that it is adversarial towards its own product. Every
 * function here is written to FIND a violation, not to certify its absence:
 *
 *   viewportPct            UNOBSTRUCTED terrain against the real window. The
 *                          brief fixes a floor of 70% and this is the number
 *                          that either clears it or does not.
 *
 *                          IT USED TO BE A LIE, AND IT WAS THE WORST ONE IN THE
 *                          TREE. It measured the canvas RECT and stopped there,
 *                          so a 300px panel floating on top of the terrain cost
 *                          the reading nothing: Atlas Mode reported 80.4% while
 *                          the terrain a person could actually see was 69.7% —
 *                          under the floor. A metric that can certify a
 *                          violation is worse than no metric, because it is the
 *                          instrument that gets quoted. So this number now
 *                          subtracts every piece of chrome that PAINTS OVER the
 *                          canvas, `terrainRectPct` keeps the old layout-only
 *                          reading beside it, and `occluders` names what took
 *                          the difference so a failure arrives with its cause.
 *   hasLeftSidebar         geometric, not nominal. `check-discipline.mjs` greps
 *                          for the WORD; this looks for the SHAPE, so a left
 *                          rail called `.ins-rail` is still caught.
 *   labelsOccluded         terrain labels with chrome sitting on them. The label
 *                          layer and the dock do not know about each other, so
 *                          nothing but a measurement can catch a legend parked
 *                          on top of `Board Governance`.
 *   rampAgrees             the HUD's five resolution chips, READ BACK OFF THE
 *                          SCREEN and summed against the node count printed four
 *                          cells away. Three instruments once printed three
 *                          totals for one population inside 110px; this is the
 *                          check that says so before a critic has to.
 *   labelsVisible/Total    against the label layer's own DOM, not the renderer's
 *                          self-report, because the ceiling is a claim the
 *                          screen either honours or does not.
 *   monoViolations         every measured-looking numeral in the chrome that is
 *                          not sitting on the mono rail. This is the rule that
 *                          does more for instrument credibility than any other,
 *                          so it is the one worth catching mechanically.
 *   animationsWithoutState every RUNNING animation with no end. A finite
 *                          transition depicts a state change; an infinite one
 *                          depicts nothing, which is the definition of
 *                          decorative motion in this product.
 *
 * NOTHING HERE READS A CACHED COPY OF ANYTHING. If the audit and the screen ever
 * disagree, the audit is measuring the wrong element — it is not reporting a
 * remembered number.
 *
 * -----------------------------------------------------------------------------
 * IT DOES NOT DECIDE WHETHER A READING IS ALLOWED
 * -----------------------------------------------------------------------------
 * `viewportPct` is 0 during INGESTING, because the ingest plate is a modal and a
 * modal covers the map — that is what the screen is doing and the audit says so.
 * It is not the function's job to decide that some obstructions are excused; a
 * measurement with an exemption list is a measurement that can be argued with.
 * So it reports the number and NAMES THE CAUSE in `occluders`, and whoever reads
 * the table can see `div.ingest 93.9%` and know exactly what took the frame.
 * =============================================================================
 */

import type { FrameStats } from '@/graph';
import { motionViolations } from '@/motion';
import { useAtlas } from '@/state';

/* =============================================================================
 * THE SHAPE
 * ========================================================================== */

/** One piece of chrome painting over the terrain, and what it costs. */
export interface Occluder {
  /** A short human path — `aside.am`, `section.rl` — enough to go and find it. */
  what: string;
  /** Its own footprint over the terrain, as a percentage of the window. */
  pct: number;
}

export interface AtlasAudit {
  /**
   * UNOBSTRUCTED terrain as a percentage of the window. The brief's floor is 70,
   * and this is the number that clears it or does not: the canvas rect MINUS
   * every overlay painting on top of it, unioned so two overlapping panels are
   * not charged twice.
   */
  viewportPct: number;
  /** The canvas rect alone, as the layout allocates it. Never the floor test. */
  terrainRectPct: number;
  /** What the overlays took, as a percentage of the window. */
  occludedPct: number;
  /** Every overlay over the terrain, largest first. A failure names its cause. */
  occluders: Occluder[];
  /** True if anything shaped like a left rail is docked against the left edge. */
  hasLeftSidebar: boolean;
  /** Labels actually painted on the terrain right now. */
  labelsVisible: number;
  /** Nodes in the payload that could have carried one. */
  labelsTotal: number;
  /** Painted labels with a piece of chrome sitting on top of them. */
  labelsOccluded: number;
  /**
   * STROKES THE RENDERER LAID DOWN THIS FRAME, counted by the renderer.
   *
   * This is the draw count. `edgesAdmitted` below is a PAYLOAD count and the two
   * are routinely an order of magnitude apart — 38 strokes carrying 254 admitted
   * relations at the island rung — which is exactly why they may never be
   * printed under one word.
   */
  strokes: number;
  /** Relations the truth gate admitted into the payload. NOT a draw count. */
  edgesAdmitted: number;
  /** Relations in the payload, admitted or not. */
  edgeTotal: number;
  /** The engine's own name for the rule that chose the subset. */
  drawnReason: string | null;
  /** Measured-looking numerals rendered outside the mono primitive. */
  monoViolations: string[];
  /** Running animations with no end — decorative motion, if any exists. */
  animationsWithoutState: string[];

  /* ---- one owner per fact, checked off the screen ------------------------ */
  /** The node count the HUD actually printed, read back out of the DOM. */
  nodesPrinted: number;
  /** The HUD's five resolution chips, summed off the DOM. */
  rampSum: number;
  /** Whether the partition holds. False is a product defect, not a rounding. */
  rampAgrees: boolean;

  /* ---- context the critic needs to read the rest ------------------------- */
  /** The lifecycle state the measurements were taken in. */
  app: string;
  /** Rail width in px, 0 when collapsed. The other half of `terrainRectPct`. */
  railPx: number;
  /** The renderer's own frame stats, for cross-checking `labelsVisible`. */
  frame: FrameStats;
}

/* =============================================================================
 * GEOMETRY
 * ========================================================================== */

function windowArea(): number {
  return Math.max(1, window.innerWidth * window.innerHeight);
}

/**
 * The terrain surface, whichever one is currently mounted.
 *
 * On FIRST-RUN there is no WebGL terrain — the screen is the latent field, which
 * is the same claim drawn at the tier where nothing has been resolved. It is
 * still the terrain for the purpose of this measurement, and reporting 0% for it
 * would say the chrome had taken the frame when the chrome is not even there.
 */
function terrainCanvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>('.shell__stage canvas, .shell--bare canvas');
}

function terrainRect(): DOMRect | null {
  const canvas = terrainCanvas();
  return canvas === null ? null : canvas.getBoundingClientRect();
}

/* =============================================================================
 * OCCLUSION — what the chrome actually took
 * ========================================================================== */

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function intersect(a: Box, b: Box): Box | null {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  return x1 - x0 < 0.5 || y1 - y0 < 0.5 ? null : { x0, y0, x1, y1 };
}

function boxArea(b: Box): number {
  return (b.x1 - b.x0) * (b.y1 - b.y0);
}

/**
 * The area of a UNION of boxes, exactly.
 *
 * Summing the boxes would charge two overlapping panels twice and could report
 * more obstruction than there is terrain — an audit that overshoots is no more
 * trustworthy than one that flatters. Coordinate compression is exact and the
 * box count here is single digits, so there is no reason to approximate.
 */
function unionArea(boxes: readonly Box[]): number {
  if (boxes.length === 0) return 0;
  const xs = [...new Set(boxes.flatMap((b) => [b.x0, b.x1]))].sort((a, b) => a - b);
  const ys = [...new Set(boxes.flatMap((b) => [b.y0, b.y1]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i += 1) {
    for (let j = 0; j < ys.length - 1; j += 1) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      const covered = boxes.some((b) => cx > b.x0 && cx < b.x1 && cy > b.y0 && cy < b.y1);
      if (covered) area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
    }
  }
  return area;
}

/** The alpha channel of a computed colour. `transparent` parses to 0. */
function alphaOf(color: string): number {
  const m = color.match(/^rgba?\(([^)]+)\)$/);
  if (m === null) return color === 'transparent' ? 0 : 1;
  const parts = m[1].split(/[,/]/).map((p) => Number(p.trim()));
  return parts.length < 4 || !Number.isFinite(parts[3]) ? 1 : parts[3];
}

/**
 * Below this effective alpha a surface is a tint, not an obstruction.
 *
 * The marquee lays 6% of the render light over whatever it selects and the
 * terrain reads straight through it; every panel in this product is 72% glass
 * with a blur behind it and the terrain does not. One threshold, between them.
 */
const OBSTRUCTION_ALPHA = 0.2;

/** Does this element PAINT — enough that terrain behind it stops being legible? */
function paints(style: CSSStyleDeclaration): boolean {
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const opacity = Number(style.opacity);
  if (!Number.isFinite(opacity) || opacity < 0.05) return false;
  // A blur behind glass destroys the terrain under it whatever the fill says.
  if (style.backdropFilter !== 'none' && style.backdropFilter !== '') return true;
  return alphaOf(style.backgroundColor) * opacity >= OBSTRUCTION_ALPHA;
}

/**
 * Every piece of chrome painting over the terrain, measured off the live DOM.
 *
 * Two exclusions, and they are the whole correctness of the function:
 *
 *   THE TERRAIN'S OWN SUBTREE   the canvas, the label layer and every label are
 *                               the terrain, not chrome on top of it.
 *   ANY ANCESTOR OF THE CANVAS  `.shell` is opaque and window-sized. It is what
 *                               the terrain is drawn ON, not what is drawn over
 *                               it, and counting it would report 0% everywhere.
 *
 * Nested painted children are folded into the outermost painted ancestor so the
 * named list reads as instruments rather than as a hundred panel internals. The
 * AREA is a union either way, so nesting can never inflate the total.
 */
function findOccluders(terrain: Box): { boxes: Box[]; named: Occluder[] } {
  const canvas = terrainCanvas();
  const boxes: Box[] = [];
  const named: Occluder[] = [];
  const counted: Element[] = [];

  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
    if (canvas !== null && el.contains(canvas)) continue;
    if (el.closest('.tg-terrain') !== null) continue;
    if (counted.some((c) => c.contains(el))) continue;

    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const hit = intersect(terrain, { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom });
    if (hit === null) continue;
    if (!paints(getComputedStyle(el))) continue;

    counted.push(el);
    boxes.push(hit);
    named.push({ what: describeElement(el), pct: (boxArea(hit) * 100) / windowArea() });
  }

  named.sort((a, b) => b.pct - a.pct);
  return { boxes, named };
}

/**
 * A left sidebar, detected by SHAPE.
 *
 * The forbidden thing is a persistent column of chrome pinned to the left edge
 * that takes horizontal away from the terrain. So: an element touching the left
 * edge, at least 160px wide, at least 40% of the window tall, that is not the
 * terrain stage or one of its full-bleed overlays. Nothing in this product
 * matches; if something ever does, this says so before the critic has to.
 */
function detectLeftSidebar(): boolean {
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
    const r = el.getBoundingClientRect();
    if (r.left > 8 || r.width < 160 || r.width > w * 0.6) continue;
    if (r.height < h * 0.4) continue;
    // Full-bleed things are not sidebars: they are the stage, the shell, or an
    // overlay that covers everything rather than docking to one side.
    if (r.width > w * 0.5) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (style.pointerEvents === 'none' && style.position === 'absolute') continue;
    return true;
  }
  return false;
}

/* =============================================================================
 * THE LABEL LAYER
 * ========================================================================== */

function visibleLabelBoxes(): Box[] {
  const out: Box[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.tg-label'))) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (Number(style.opacity) <= 0.01) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom });
  }
  return out;
}

/* =============================================================================
 * ONE OWNER PER FACT — checked by reading the screen back
 * ========================================================================== */

/** Every numeral in a subtree, in order. Reads what was PRINTED, not what was passed. */
function figuresIn(root: Element | null): number[] {
  if (root === null) return [];
  const out: number[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.num'))) {
    const n = Number((el.textContent ?? '').replace(/[^\d.-]/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/* =============================================================================
 * THE MONO RULE
 * ========================================================================== */

/**
 * Elements whose text is allowed to contain a numeral without the mono rail.
 *
 *   .num .mono .hash        the primitive itself, and its rails
 *   .key .keys              a keyboard glyph is a key cap, not a measurement
 *   .tg-label               engine labels are STRINGS; `Tollstrand 2` is a name
 *   blockquote              a verbatim source span is evidence, not a readout —
 *                           and re-setting the corpus's own bytes in a mono
 *                           figure is exactly the rewriting the receipt forbids
 *   [data-prose]            explanatory copy. The deck guarantees it carries no
 *                           figure; the attribute marks the containers that
 *                           render it.
 */
const MONO_EXEMPT =
  '.num, .mono, .hash, .key, .keys, .tg-label, blockquote, [data-prose], svg, script, style';

/**
 * A MEASURED-LOOKING numeral, which is a narrower thing than "a digit".
 *
 * The first version of this test flagged `hop 1` and `evidences hop 0 operates`
 * — an ordinal inside a sentence and a hop index inside a machine code, neither
 * of which is a measurement. Twelve false positives is worse than none: a check
 * nobody believes is a check nobody reads.
 *
 * So a violation has to LOOK LIKE AN INSTRUMENT READING: a decimal, a grouped
 * thousand, three or more digits, or a figure carrying one of the product's own
 * units. A bare one- or two-digit number in running text is a count in a
 * sentence and is left alone.
 */
const FIGURE =
  /(?:^|[\s(\[/·|,>])[-+]?(?:\d+\.\d+|\d{1,3}[\s ,]\d{3}|\d{3,}|\d+\s*(?:%|ms|tok|fps|×))(?=$|[\s)\]/·|,.])/;

/** Past this many characters a text node is prose. A readout is never a paragraph. */
const PROSE_CHARS = 120;

/**
 * Up to this length, a run of text carrying a figure IS the figure — `5 040`,
 * `76.1 %` — and belongs on the mono rail whatever else is in it.
 */
const READOUT_CHARS = 16;

/**
 * Below this share of digits, a text run is a NAME rather than a READING.
 *
 * `Board minutes, 17 June 2023 — Storfors Hydro Station` and
 * `corpus://nordic-energy/storage/tollstrand-cluster/2023/kva-004` are an engine
 * label and an engine locator. Both contain a four-digit year, neither is a
 * measurement, and setting either in mono would be the check making the product
 * worse. A readout is mostly digits; a name is mostly letters.
 */
const DIGIT_SHARE = 0.2;

function digitShare(text: string): number {
  const digits = text.replace(/\D+/g, '').length;
  return text.length === 0 ? 0 : digits / text.length;
}

/** A short human path for a violating element. Enough to find it, not a stack trace. */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls = typeof el.className === 'string' && el.className.length > 0
    ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
    : '';
  return `${tag}${cls}`;
}

/**
 * Every measured-looking numeral in the chrome that is not on the mono rail.
 *
 * Walks TEXT NODES rather than elements, because the failure this catches is a
 * figure interpolated straight into a sentence — which is invisible to a
 * selector-based check and is exactly how a product stops looking machined.
 */
function findMonoViolations(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    const text = node.nodeValue ?? '';
    const parent = node.parentElement;
    node = walker.nextNode();
    const trimmed = text.trim();
    if (parent === null || trimmed.length === 0) continue;
    // A paragraph is prose whether or not it remembered to say so.
    if (trimmed.length > PROSE_CHARS) continue;
    if (!FIGURE.test(` ${text} `)) continue;
    // A name that happens to contain a year is not a reading.
    if (trimmed.length > READOUT_CHARS && digitShare(trimmed) < DIGIT_SHARE) continue;
    if (parent.closest(MONO_EXEMPT) !== null) continue;
    const where = `${describeElement(parent)}: ${text.trim().slice(0, 60)}`;
    if (seen.has(where)) continue;
    seen.add(where);
    out.push(where);
  }
  return out;
}

/* =============================================================================
 * MOTION
 * ========================================================================== */

/**
 * Running animations that never end.
 *
 * A transition depicts a state change and then stops. An animation set to loop
 * forever depicts nothing that is happening — it is decoration, a skeleton
 * shimmer or a fake progress crawl, all three of which this product forbids.
 * So the test is not "is anything animating" but "is anything animating with no
 * state to arrive at".
 *
 * THIS IS ONLY HALF THE CHECK, and it is the half the DOM can answer. The other
 * half is `motionViolations()` from `@/motion`: every run on the shared timeline
 * declares the engine fact it depicts — a query_id, a place, a trace_id, the ids
 * an ingest admitted — and the witness is checked against the live store when
 * the run starts and again when it ends. A finite, perfectly well-behaved 700ms
 * animation of something that never happened is invisible to `getAnimations()`
 * and is exactly the failure this product is most exposed to: a celebration
 * firing on a tab switch rather than on the render it celebrates. The two lists
 * are concatenated because they are the same defect measured from two sides.
 */
function findEndlessAnimations(): string[] {
  if (typeof document.getAnimations !== 'function') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const anim of document.getAnimations()) {
    if (anim.playState !== 'running') continue;
    const effect = anim.effect;
    if (effect === null) continue;
    const timing = effect.getTiming();
    const endless = timing.iterations === Infinity || timing.iterations === undefined;
    if (!endless) continue;
    const target = (effect as KeyframeEffect).target;
    const where = target === null || target === undefined ? 'detached' : describeElement(target);
    if (seen.has(where)) continue;
    seen.add(where);
    out.push(where);
  }
  return out;
}

/* =============================================================================
 * THE AUDIT
 * ========================================================================== */

export function auditNow(frame: FrameStats): AtlasAudit {
  const s = useAtlas.getState();
  const rect = terrainRect();
  const rail = document.querySelector<HTMLElement>('.shell__rail');
  const railRect = rail === null ? null : rail.getBoundingClientRect();

  const terrain: Box | null =
    rect === null ? null : { x0: rect.left, y0: rect.top, x1: rect.right, y1: rect.bottom };
  const { boxes, named } = terrain === null ? { boxes: [], named: [] } : findOccluders(terrain);

  const terrainArea = terrain === null ? 0 : boxArea(terrain);
  // Clamped because a union can only ever cover the terrain it was intersected
  // with — a negative unobstructed figure would be arithmetic, not a reading.
  const occluded = Math.min(terrainArea, unionArea(boxes));

  const labels = visibleLabelBoxes();
  const labelsOccluded = labels.filter((l) => boxes.some((b) => intersect(l, b) !== null)).length;

  /* THE PARTITION, READ BACK OFF THE SCREEN. Not recomputed from the store —
     recomputing it here would only prove that two copies of one expression
     agree. What has to be true is that the five chips a person can see sum to
     the node count a person can see, four cells to their left. */
  const nodesPrinted = figuresIn(document.querySelector('[data-hud="nodes"]'))[0] ?? Number.NaN;
  const rampFigures = figuresIn(document.querySelector('[data-hud="ramp"]'));
  const rampSum = rampFigures.reduce((a, b) => a + b, 0);

  return {
    viewportPct: terrainArea === 0 ? 0 : ((terrainArea - occluded) * 100) / windowArea(),
    terrainRectPct: (terrainArea * 100) / windowArea(),
    occludedPct: (occluded * 100) / windowArea(),
    occluders: named,
    hasLeftSidebar: detectLeftSidebar(),
    labelsVisible: labels.length,
    labelsTotal: s.view?.nodes.length ?? 0,
    labelsOccluded,
    strokes: frame.edges,
    edgesAdmitted: s.view?.stats.edges_drawn ?? 0,
    edgeTotal: s.view?.stats.edge_count ?? 0,
    drawnReason: s.view?.stats.drawn_reason ?? null,
    monoViolations: findMonoViolations(),
    animationsWithoutState: [...findEndlessAnimations(), ...motionViolations()],
    nodesPrinted,
    rampSum,
    rampAgrees: rampFigures.length === 0 || rampSum === nodesPrinted,
    app: s.app,
    railPx: railRect === null ? 0 : Math.round(railRect.width),
    frame,
  };
}
