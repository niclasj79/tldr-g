/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — TOKEN BRIDGE (CSS -> TypeScript / WebGL)
 * =============================================================================
 *
 * ZERO HEX LITERALS LIVE HERE BY DESIGN.
 * If you need a colour, add it to `design-tokens.css` first, then read it back
 * through this module. This file contains no `#RRGGBB` strings and no numeric
 * colour constants — it only *parses* what the stylesheet already declared.
 *
 * Why this exists at all: THREE.js and the 2D overlay canvas cannot read CSS
 * custom properties. Without a bridge, every WebGL material would re-declare
 * its own colour and the DOM and the terrain would drift apart within a week.
 * This module is the ONE place where a computed style becomes a number.
 *
 * Usage:
 *   const t = readTokens();                       // memoised
 *   material.color.setRGB(...t.color.render);     // linear rgb, THREE-ready
 *   el.style.borderColor = t.hex.line;            // hex, DOM-ready
 *   const h = hueForCommunity(node.community_id, t);
 *
 * After changing `data-density`, `data-theme`, or hot-reloading the stylesheet,
 * call `invalidateTokens()`.
 * =============================================================================
 */

import type { LodState } from '@/engine/types';

/* ---------------------------------------------------------------------------
 * 1. The colour token roster.
 * ---------------------------------------------------------------------------
 * These strings are EXACTLY the CSS custom property names minus the leading
 * `--`. That is deliberate: `--${name}` and `--${name}-rgb` must resolve, so
 * adding a name here without adding the property to design-tokens.css is a
 * loud, immediate failure rather than a silent black node.
 * ------------------------------------------------------------------------- */
export const TOKEN_COLOR_NAMES = [
  // ground
  'void',
  'surface',
  'surface-2',
  'line',
  // ink ramp
  'ink',
  'ink-dim',
  'ink-faint',
  // the three lights
  'render',
  'render-deep',
  'evidence',
  'curiosity',
  // instrument states
  'ok',
  'warn',
  'alarm',
] as const;

/** Every colour the visual demo is allowed to draw with, by name. */
export type TokenColorName = (typeof TOKEN_COLOR_NAMES)[number];

/** Number of community hue families. Fixed at 8 — see design-tokens.css §5. */
export const HUE_COUNT = 8;

/** An rgb triple in 0..1. Linear-light for THREE, or sRGB — see field docs. */
export type Rgb01 = [number, number, number];

/**
 * The parsed token snapshot. Everything downstream needs from the stylesheet,
 * and nothing else. Treat as immutable; call `invalidateTokens()` and re-read
 * rather than mutating.
 */
export interface Tokens {
  /**
   * Linear-light 0..1 rgb triples, ready for `THREE.Color.setRGB` /
   * shader uniforms. sRGB -> linear conversion is applied so that colours
   * composited by the GPU match the colours composited by the browser.
   */
  color: Record<TokenColorName, Rgb01>;
  /** The same colours as the raw `#RRGGBB` strings, for DOM/canvas2d writes. */
  hex: Record<TokenColorName, string>;
  /**
   * The 8 community hue families, index-addressable and in declaration order
   * (`--hue-0` .. `--hue-7`). Linear-light, same convention as `color`.
   * Index via `hueForCommunity()` — never by array position you computed
   * yourself, or colours will not survive a re-bake.
   */
  hue: Rgb01[];
  /** The same 8 hues as `#RRGGBB` strings. */
  hueHex: string[];
  /** Motion budget in milliseconds. Already reflects `prefers-reduced-motion`. */
  ms: { fast: number; ui: number; scene: number };
  /**
   * The resolution ramp. `opacity` is the authored opacity for each state.
   * `latent` at 0.12 is load-bearing: the terrain never has holes.
   */
  lod: Record<LodState, { opacity: number }>;
  /**
   * True when the user has asked for reduced motion. Camera flights and panel
   * choreography must collapse to `ms.fast`. Instrument readouts are never
   * animated in any mode, so this flag must not gate data updates.
   */
  reducedMotion: boolean;
}

/* ---------------------------------------------------------------------------
 * 2. Parsing primitives. No colour knowledge, just string -> number.
 * ------------------------------------------------------------------------- */

/** Read one custom property, trimmed. Returns '' when unset. */
function raw(cs: CSSStyleDeclaration, prop: string): string {
  return cs.getPropertyValue(prop).trim();
}

/**
 * Parse a space- or comma-separated 0..255 triple, e.g. `46 230 208`.
 * This is the preferred path: every colour token in design-tokens.css ships a
 * companion `-rgb` triple precisely so nothing downstream has to parse hex.
 */
function parseTriple255(value: string): Rgb01 | null {
  const parts = value.split(/[\s,/]+/).filter(Boolean).slice(0, 3);
  if (parts.length !== 3) return null;
  const out = parts.map((p) => Number(p));
  if (out.some((n) => !Number.isFinite(n))) return null;
  return [out[0] / 255, out[1] / 255, out[2] / 255];
}

/** Fallback parser for `#RGB` / `#RRGGBB`, used only if the `-rgb` triple is absent. */
function parseHexToSrgb01(value: string): Rgb01 | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** sRGB (0..1) -> linear-light (0..1). The exact IEC 61966-2-1 transfer curve. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function toLinear(rgb: Rgb01): Rgb01 {
  return [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
}

/** Parse a CSS time (`120ms`, `.7s`) to milliseconds. */
function parseMs(value: string, fallback: number): number {
  const m = /^(-?[\d.]+)(ms|s)?$/.exec(value);
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return fallback;
  return m[2] === 's' ? n * 1000 : n;
}

/** Parse a unitless number token (`.85`). */
function parseNum(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * FAIL LOUD. A missing token is a contract violation, not a styling nit — it
 * means a downstream agent referenced a colour that was never declared. We
 * still return a value so the frame renders, but we shout in the console and
 * fall back to `--ink` so the artefact is visibly wrong rather than invisibly
 * black-on-black.
 */
function missing(prop: string): void {
  // eslint-disable-next-line no-console
  console.error(
    `[tokens] Missing CSS custom property "${prop}". ` +
      `Every value must be declared in src/styles/design-tokens.css first. ` +
      `Zero hardcoded hex is permitted outside that file.`,
  );
}

function readColor(cs: CSSStyleDeclaration, name: string): { rgb: Rgb01; hex: string } {
  const hex = raw(cs, `--${name}`);
  const triple = raw(cs, `--${name}-rgb`);
  const srgb = parseTriple255(triple) ?? parseHexToSrgb01(hex);
  if (!srgb) {
    missing(`--${name}-rgb (or --${name})`);
    const fb = parseHexToSrgb01(raw(cs, '--ink')) ?? [1, 0, 1];
    return { rgb: toLinear(fb), hex: hex || raw(cs, '--ink') };
  }
  return { rgb: toLinear(srgb), hex };
}

/* ---------------------------------------------------------------------------
 * 3. The read, memoised.
 * ------------------------------------------------------------------------- */

const cache = new WeakMap<HTMLElement, Tokens>();

/**
 * Read the authoritative token set off an element's computed style.
 *
 * Memoised per element. `getComputedStyle` + ~40 property reads is cheap once
 * and ruinous inside a render loop, so NEVER call this per frame — call it
 * once per bake / per density change and pass the `Tokens` object down.
 *
 * @param el the element to resolve against. Defaults to `<html>`, which is
 *           where `:root`, `[data-density]` and the reduced-motion overrides
 *           all land.
 */
export function readTokens(el: HTMLElement = document.documentElement): Tokens {
  const hit = cache.get(el);
  if (hit) return hit;

  const cs = getComputedStyle(el);

  const color = {} as Record<TokenColorName, Rgb01>;
  const hex = {} as Record<TokenColorName, string>;
  for (const name of TOKEN_COLOR_NAMES) {
    const c = readColor(cs, name);
    color[name] = c.rgb;
    hex[name] = c.hex;
  }

  const hue: Rgb01[] = [];
  const hueHex: string[] = [];
  for (let i = 0; i < HUE_COUNT; i++) {
    const c = readColor(cs, `hue-${i}`);
    hue.push(c.rgb);
    hueHex.push(c.hex);
  }

  const ms = {
    fast: parseMs(raw(cs, '--t-fast'), 120),
    ui: parseMs(raw(cs, '--t-ui'), 240),
    scene: parseMs(raw(cs, '--t-scene'), 700),
  };

  const lod = {
    'lod-0': { opacity: parseNum(raw(cs, '--lod-0-opacity'), 1) },
    'lod-1': { opacity: parseNum(raw(cs, '--lod-1-opacity'), 0.85) },
    'lod-2': { opacity: parseNum(raw(cs, '--lod-2-opacity'), 0.55) },
    ghost: { opacity: parseNum(raw(cs, '--ghost-opacity'), 0.28) },
    latent: { opacity: parseNum(raw(cs, '--latent-opacity'), 0.12) },
  } as Record<LodState, { opacity: number }>;

  const reducedMotion =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

  const tokens: Tokens = { color, hex, hue, hueHex, ms, lod, reducedMotion };
  cache.set(el, tokens);
  return tokens;
}

/**
 * Drop the memoised snapshot. Call after anything that can change computed
 * custom properties:
 *   - `data-density` switch (comfortable / compact / touch)
 *   - a theme switch
 *   - stylesheet HMR in dev
 *   - a `prefers-reduced-motion` change event
 * Omit `el` to clear the default `<html>` entry.
 */
export function invalidateTokens(el: HTMLElement | null = null): void {
  if (el) {
    cache.delete(el);
    return;
  }
  if (typeof document !== 'undefined') cache.delete(document.documentElement);
}

/* ---------------------------------------------------------------------------
 * 4. Stable community colouring.
 * ------------------------------------------------------------------------- */

/**
 * FNV-1a, 32-bit. A stable, dependency-free string hash.
 *
 * Stability is the entire point. Community colour must be a pure function of
 * the community id so that a re-bake — new layout, new positions, new bake_id
 * — leaves every community the colour the user already memorised. Anything
 * order-dependent (array index, insertion order, Map iteration) would silently
 * repaint the world and destroy spatial memory.
 *
 * Returns an unsigned 32-bit integer.
 */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i) & 0xff;
    // h *= 16777619, in 32-bit space without overflowing the float mantissa.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * The hue-family index (0..7) for a community id. Use this when you need to
 * address the CSS variable directly from the DOM, e.g. `var(--hue-3)` /
 * `rgb(var(--hue-3-rgb) / .45)`.
 */
export function hueIndexForCommunity(id: string): number {
  return fnv1a32(id) % HUE_COUNT;
}

/**
 * The community hue as a linear-light rgb triple, for THREE materials and
 * shader uniforms.
 *
 * Remember the family rule (design-tokens.css §5): the *hue* is constant down
 * the containment spine, only its strength changes — continent renders it as a
 * ~10% region wash, island at ~45%, member assets at full. Reading the hue
 * tells you where you are without labels, so never remap it per rung.
 */
export function hueForCommunity(id: string, tokens: Tokens): Rgb01 {
  return tokens.hue[hueIndexForCommunity(id)];
}
