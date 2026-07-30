/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — TERRAIN PALETTE (the renderer's half of the token bridge)
 * =============================================================================
 *
 * `@/styles/tokens.ts` is the ONE place a computed style becomes a number, and
 * it is locked. This module does not invent anything: it calls `readTokens()`
 * and then reads the handful of extra custom properties the WebGL layer needs
 * that the bridge does not expose (stroke widths, the glow ceiling, wash
 * strengths, the two easing curves, the node hit slop). Every one of them is
 * read from `design-tokens.css` at runtime through `getComputedStyle`. There is
 * no colour, no duration and no easing constant declared in this file.
 *
 * -----------------------------------------------------------------------------
 * WHY sRGB AND NOT LINEAR
 * -----------------------------------------------------------------------------
 * The visual demo is a 2D instrument. Its WebGL terrain composites underneath a DOM
 * label layer and behind thin-glass DOM panels, and those composite in sRGB
 * because that is what a browser does with an 8-bit framebuffer. If the terrain
 * blended in linear light and the panels blended in sRGB, the same token would
 * produce two different colours a pixel apart — the one drift this whole token
 * system exists to prevent.
 *
 * So the terrain runs a fully manual sRGB pipeline: `THREE.ColorManagement` is
 * disabled, `outputColorSpace` is `LinearSRGBColorSpace` (i.e. "do not touch my
 * numbers"), and every uniform carries sRGB 0..1. `readTokens()` hands out
 * linear-light triples, so this module applies the exact inverse of the transfer
 * curve `tokens.ts` exports. That round trip is lossless to within 1e-7 — it
 * recovers the byte values that were in the stylesheet.
 * =============================================================================
 */

import { hueIndexForCommunity, invalidateTokens, readTokens, HUE_COUNT } from '@/engine';
import type { LodState, Rgb01, TokenColorName, Tokens } from '@/engine';

/* =============================================================================
 * 1. THE RESOLUTION RAMP AS A NUMBER LINE
 * -----------------------------------------------------------------------------
 * The ramp is a five-state machine, and the shader needs it as a scalar so a LOD
 * change can CROSSFADE THROUGH the ramp instead of popping between two states.
 * Index order is the ramp order, sharpest first, exactly as `LOD_STATES`.
 * ========================================================================== */

/** The ramp, sharpest first. Same order and same members as `LOD_STATES`. */
export const LOD_ORDER: readonly LodState[] = ['lod-0', 'lod-1', 'lod-2', 'ghost', 'latent'];

/** `lod-0` -> 0 ... `latent` -> 4. The scalar the shader interpolates along. */
export const LOD_INDEX: Readonly<Record<LodState, number>> = Object.freeze({
  'lod-0': 0,
  'lod-1': 1,
  'lod-2': 2,
  ghost: 3,
  latent: 4,
});

/** The number of ramp states. Sized here so the shader's arrays cannot drift. */
export const LOD_COUNT = LOD_ORDER.length;

/* =============================================================================
 * 2. PARSING HELPERS — string -> number, and nothing else
 * ========================================================================== */

/** The exact inverse of `srgbToLinear` from the token bridge (IEC 61966-2-1). */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function toSrgb(rgb: Rgb01): Rgb01 {
  return [linearToSrgb(rgb[0]), linearToSrgb(rgb[1]), linearToSrgb(rgb[2])];
}

/**
 * FAIL LOUD, exactly as the token bridge does. A missing custom property means
 * the renderer is about to draw with a number nobody declared, and a silent
 * fallback is how a terrain ends up with a private dialect of the design system.
 */
function missing(prop: string, fallback: string): void {
  // eslint-disable-next-line no-console
  console.error(
    `[graph/palette] Missing CSS custom property "${prop}". Declare it in ` +
      `src/styles/design-tokens.css first — the terrain reads every value from there. ` +
      `Falling back to ${fallback}, which is visibly wrong on purpose.`,
  );
}

/** Parse a `<length>` in px. Returns `fallback` and shouts if the token is absent. */
function px(cs: CSSStyleDeclaration, prop: string, fallback: number): number {
  const raw = cs.getPropertyValue(prop).trim();
  if (raw === '') {
    missing(prop, `${fallback}px`);
    return fallback;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a unitless number token. */
function num(cs: CSSStyleDeclaration, prop: string, fallback: number): number {
  const raw = cs.getPropertyValue(prop).trim();
  if (raw === '') {
    missing(prop, String(fallback));
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** The four control points of a `cubic-bezier()` token. */
export type Bezier = readonly [number, number, number, number];

/** Linear. Used ONLY when an easing token is missing, so the loss is visible. */
const LINEAR_FALLBACK: Bezier = [0, 0, 1, 1];

function bezier(cs: CSSStyleDeclaration, prop: string): Bezier {
  const raw = cs.getPropertyValue(prop).trim();
  const m = /cubic-bezier\(([^)]+)\)/.exec(raw);
  if (!m) {
    missing(prop, 'linear');
    return LINEAR_FALLBACK;
  }
  const parts = m[1].split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    missing(prop, 'linear');
    return LINEAR_FALLBACK;
  }
  return [parts[0], parts[1], parts[2], parts[3]] as Bezier;
}

/* =============================================================================
 * 3. EASING EVALUATION
 * -----------------------------------------------------------------------------
 * The camera has to interpolate with the SAME curve the CSS transitions use, or
 * a panel and the terrain arrive at different times and the product feels like
 * two applications. Newton with a bisection fallback: 8 iterations is exact to
 * well under a pixel, and it never diverges.
 * ========================================================================== */

function bezierAxis(p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

function bezierAxisSlope(p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/** Evaluate a `cubic-bezier(x1,y1,x2,y2)` timing function at progress `p` in 0..1. */
export function ease(curve: Bezier, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const [x1, y1, x2, y2] = curve;
  if (x1 === y1 && x2 === y2) return p; // linear, no solve needed

  let t = p;
  for (let i = 0; i < 8; i++) {
    const x = bezierAxis(x1, x2, t) - p;
    if (Math.abs(x) < 1e-6) return bezierAxis(y1, y2, t);
    const d = bezierAxisSlope(x1, x2, t);
    if (Math.abs(d) < 1e-6) break;
    t -= x / d;
  }
  let lo = 0;
  let hi = 1;
  t = p;
  for (let i = 0; i < 20; i++) {
    const x = bezierAxis(x1, x2, t);
    if (Math.abs(x - p) < 1e-6) break;
    if (x < p) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return bezierAxis(y1, y2, t);
}

/* =============================================================================
 * 4. THE PALETTE SNAPSHOT
 * ========================================================================== */

/**
 * Everything the WebGL layer and the label overlay need from the stylesheet,
 * resolved once. Treat as immutable; call `invalidatePalette()` and re-read
 * after a density switch, a theme switch or a reduced-motion change.
 */
export interface Palette {
  /** The locked bridge's snapshot, kept so callers never have to read twice. */
  tokens: Tokens;
  /** Every named colour token as sRGB 0..1, ready for a uniform. */
  srgb: Record<TokenColorName, Rgb01>;
  /** The 8 community hue families as sRGB 0..1, in declaration order. */
  hue: Rgb01[];
  /** The same colours as `#RRGGBB`, for the DOM label layer. */
  hex: Record<TokenColorName, string>;
  /** Motion budget in ms, already reflecting `prefers-reduced-motion`. */
  ms: { fast: number; ui: number; scene: number };
  /** Ramp opacity per state, indexed by `LOD_INDEX`. */
  lodOpacity: Float32Array;
  /** Ramp stroke width in CSS px per state, indexed by `LOD_INDEX`. */
  lodStroke: Float32Array;
  /** Glow radius in CSS px per state. Only `lod-0` is non-zero — glow is earned. */
  lodGlow: Float32Array;
  /** `--ghost-blur`, in CSS px. Applied as edge softness, not as a blur pass. */
  ghostBlur: number;
  /** Region-wash strengths for the containment spine. */
  wash: { continent: number; island: number; asset: number };
  /** `--ease-ui` control points. */
  easeUi: Bezier;
  /** `--ease-camera` control points. */
  easeCamera: Bezier;
  /** `--hit-slop-node` in CSS px. Grows with `touch` density. */
  hitSlop: number;
  /** True when the user asked for reduced motion. */
  reducedMotion: boolean;
}

let cache: Palette | null = null;

/**
 * Read the terrain palette. Memoised — `getComputedStyle` plus ~40 property
 * reads is cheap once and ruinous inside a frame loop. NEVER call this per
 * frame; call it per bake / per density change and hold the result.
 */
export function readPalette(el: HTMLElement = document.documentElement): Palette {
  if (cache !== null) return cache;

  const tokens = readTokens(el);
  const cs = getComputedStyle(el);

  const srgb = {} as Record<TokenColorName, Rgb01>;
  for (const name of Object.keys(tokens.color) as TokenColorName[]) {
    srgb[name] = toSrgb(tokens.color[name]);
  }

  const hue: Rgb01[] = [];
  for (let i = 0; i < HUE_COUNT; i++) hue.push(toSrgb(tokens.hue[i]));

  const lodOpacity = new Float32Array(LOD_COUNT);
  const lodStroke = new Float32Array(LOD_COUNT);
  const lodGlow = new Float32Array(LOD_COUNT);
  const glowCeiling = px(cs, '--lod-0-glow', 6);
  for (let i = 0; i < LOD_COUNT; i++) {
    const state = LOD_ORDER[i];
    lodOpacity[i] = tokens.lod[state].opacity;
    lodStroke[i] = px(cs, `--${state}-stroke`, 1);
    // The glow ceiling is a HARD CAP and it belongs to lod-0 alone. Every other
    // state is 0 — the product never blooms, and glow is earned by selection.
    lodGlow[i] = state === 'lod-0' ? glowCeiling : 0;
  }

  cache = {
    tokens,
    srgb,
    hue,
    hex: tokens.hex,
    ms: tokens.ms,
    lodOpacity,
    lodStroke,
    lodGlow,
    ghostBlur: px(cs, '--ghost-blur', 1),
    wash: {
      continent: num(cs, '--wash-continent', 0.1),
      island: num(cs, '--wash-island', 0.45),
      asset: num(cs, '--wash-asset', 1),
    },
    easeUi: bezier(cs, '--ease-ui'),
    easeCamera: bezier(cs, '--ease-camera'),
    hitSlop: px(cs, '--hit-slop-node', 6),
    reducedMotion: tokens.reducedMotion,
  };
  return cache;
}

/**
 * Drop the memoised palette AND the underlying token snapshot. Call after a
 * density switch, a theme switch, stylesheet HMR, or a reduced-motion change.
 */
export function invalidatePalette(el: HTMLElement | null = null): void {
  cache = null;
  invalidateTokens(el);
}

/* =============================================================================
 * 5. FLAT UNIFORM BUFFERS
 * -----------------------------------------------------------------------------
 * Shaders want `vec3[8]`, not an array of arrays. Built once per palette read
 * and handed straight to the material, so no per-frame allocation happens on the
 * way to the GPU.
 * ========================================================================== */

/** Pack the 8 community hues into the flat `vec3[8]` a shader uniform expects. */
export function hueUniformArray(p: Palette): Float32Array {
  const out = new Float32Array(HUE_COUNT * 3);
  for (let i = 0; i < HUE_COUNT; i++) {
    out[i * 3] = p.hue[i][0];
    out[i * 3 + 1] = p.hue[i][1];
    out[i * 3 + 2] = p.hue[i][2];
  }
  return out;
}

/** The hue-family index for a community id. Re-exported so callers need one import. */
export function hueIndexOf(communityId: string): number {
  return hueIndexForCommunity(communityId);
}
