/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — SHAREABLE SCENE STATE
 * =============================================================================
 *
 * A terrain you cannot send to somebody is a terrain you cannot argue about. So
 * the whole scene — where you are standing, what you are looking at, what you
 * asked, what you filtered out and how dense your chrome is — round-trips
 * through one URL-safe string that lives in `location.hash`.
 *
 *   #view=<base64url of a versioned, short-keyed JSON payload>
 *
 * -----------------------------------------------------------------------------
 * WHY THE BREADCRUMB IS NOT IN THE PAYLOAD
 * -----------------------------------------------------------------------------
 * The rung stack is the ancestor chain of the current parent id — it is
 * DERIVABLE from `(rung, parent_id)` by walking `parent_id` up the spine, which
 * the store does with real `GET /node/{id}` calls on load. Encoding the labels
 * as well would triple the string length AND freeze labels that the corpus may
 * have since re-authored, so the link would show one name and the panel another.
 * Store the id; resolve the name from the engine; the two can never disagree.
 *
 * -----------------------------------------------------------------------------
 * DECODING FAILS LOUD
 * -----------------------------------------------------------------------------
 * A corrupt or truncated link is a real failure with an exact remedy, not a
 * reason to silently open the default view and pretend the link was honoured.
 * `decodeSavedView` throws `SavedViewError`, which already carries the three
 * `DegradedReason` fields, so the store can route it straight to the DEGRADED
 * screen.
 * =============================================================================
 */

import { DENSITY_MODES, RUNGS, SIGMA_CLASSES } from '@/engine';
import type { DegradedReason, DensityMode, Rung, SigmaClass } from '@/engine';

/** Format version. Bump when the payload shape changes; never redefine `1` in place. */
export const SAVED_VIEW_VERSION = 1 as const;

/** The `location.hash` key. `#view=...` so other hash consumers can coexist. */
export const SAVED_VIEW_HASH_KEY = 'view';

/** The decoded scene. Everything needed to reconstruct what somebody was looking at. */
export interface SavedView {
  version: typeof SAVED_VIEW_VERSION;
  /** Which rung the terrain is showing. */
  rung: Rung;
  /**
   * The containing node the rung is scoped to, or `null` for the whole rung.
   * The breadcrumb stack is rebuilt from this by walking the spine.
   */
  parentId: string | null;
  /** Camera TARGET. The renderer owns the current camera and interpolates to this. */
  camera: { x: number; y: number; zoom: number };
  selection: string[];
  focus: string | null;
  /** The query id, so the receipt can be addressed even if the text is long. */
  queryId: string | null;
  /** The question as asked. Re-running it is what restores the constellation. */
  query: string | null;
  filters: { sigma: SigmaClass[]; families: string[]; showQuarantined: boolean };
  density: DensityMode;
}

/** A corrupt link, in the shape the DEGRADED screen already knows how to render. */
export class SavedViewError extends Error implements DegradedReason {
  readonly code = 'SAVED_VIEW_CORRUPT';
  readonly what_failed: string;
  readonly exact_remedy: string;

  constructor(what_failed: string) {
    super(`[state/savedView] ${what_failed}`);
    this.name = 'SavedViewError';
    this.what_failed = what_failed;
    this.exact_remedy =
      'Open the visual demo without the #view= fragment to get the default scene, then re-share the link from the current view.';
  }
}

/* =============================================================================
 * 1. THE WIRE SHAPE
 * -----------------------------------------------------------------------------
 * Short keys, because this ends up in a URL that people paste into chat. The
 * mapping is declared once, here, in both directions.
 * ========================================================================== */

interface Wire {
  v: number;
  r: Rung;
  p: string | null;
  /** `[x, y, zoom]`, rounded — sub-pixel camera precision in a shared link is noise. */
  c: [number, number, number];
  s: string[];
  f: string | null;
  qi: string | null;
  q: string | null;
  /** sigma classes, as indices into `SIGMA_CLASSES` — six short numbers beat six words. */
  fs: number[];
  ff: string[];
  fq: 0 | 1;
  d: DensityMode;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/* =============================================================================
 * 2. BASE64URL — hand-rolled, so this module has no runtime dependencies and
 *    behaves identically in the browser, in a worker and under node.
 * ========================================================================== */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function bytesToB64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64[a >> 2];
    out += B64[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += B64[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += B64[c & 0x3f];
  }
  return out;
}

function b64urlToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9\-_]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]);
    const b = B64.indexOf(clean[i + 1] ?? 'A');
    const c = clean[i + 2] === undefined ? -1 : B64.indexOf(clean[i + 2]);
    const d = clean[i + 3] === undefined ? -1 : B64.indexOf(clean[i + 3]);
    if (a < 0 || b < 0) throw new SavedViewError('The shared view string contains characters that are not base64url.');
    out[o++] = (a << 2) | (b >> 4);
    if (c >= 0) out[o++] = ((b & 0x0f) << 4) | (c >> 2);
    if (d >= 0) out[o++] = ((c & 0x03) << 6) | d;
  }
  return out.subarray(0, o);
}

function utf8Encode(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  // Minimal fallback for runtimes without TextEncoder. Correct for the BMP,
  // which is every character a node label can contain in this corpus.
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    }
  }
  return out;
}

/* =============================================================================
 * 3. ENCODE / DECODE
 * ========================================================================== */

/** The scene as one URL-safe token. Deterministic: the same scene always encodes identically. */
export function encodeSavedView(view: SavedView): string {
  const wire: Wire = {
    v: SAVED_VIEW_VERSION,
    r: view.rung,
    p: view.parentId,
    c: [round(view.camera.x, 2), round(view.camera.y, 2), round(view.camera.zoom, 4)],
    s: [...view.selection],
    f: view.focus,
    qi: view.queryId,
    q: view.query,
    fs: view.filters.sigma.map((s) => SIGMA_CLASSES.indexOf(s)).filter((i) => i >= 0),
    ff: [...view.filters.families],
    fq: view.filters.showQuarantined ? 1 : 0,
    d: view.density,
  };
  return bytesToB64url(utf8Encode(JSON.stringify(wire)));
}

/** Parse a token back into a scene. Throws `SavedViewError` on anything malformed. */
export function decodeSavedView(token: string): SavedView {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new SavedViewError('The shared view string is empty.');
  }

  let wire: Wire;
  try {
    wire = JSON.parse(utf8Decode(b64urlToBytes(token.trim()))) as Wire;
  } catch (cause) {
    if (cause instanceof SavedViewError) throw cause;
    throw new SavedViewError(
      `The shared view string did not decode to JSON (${cause instanceof Error ? cause.message : String(cause)}). It was probably truncated by whatever it travelled through.`,
    );
  }

  if (wire === null || typeof wire !== 'object') {
    throw new SavedViewError('The shared view string decoded to something that is not an object.');
  }
  if (wire.v !== SAVED_VIEW_VERSION) {
    throw new SavedViewError(
      `The shared view declares format version ${String(wire.v)}; this build reads version ${SAVED_VIEW_VERSION}.`,
    );
  }
  if (!(RUNGS as readonly string[]).includes(wire.r)) {
    throw new SavedViewError(
      `"${String(wire.r)}" is not a rung. The spine has exactly four: ${RUNGS.join(', ')}.`,
    );
  }
  if (!Array.isArray(wire.c) || wire.c.length !== 3 || wire.c.some((n) => !Number.isFinite(n))) {
    throw new SavedViewError('The shared view has no usable camera triple [x, y, zoom].');
  }
  if (!(DENSITY_MODES as readonly string[]).includes(wire.d)) {
    throw new SavedViewError(`"${String(wire.d)}" is not a density mode.`);
  }

  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

  const sigma = Array.isArray(wire.fs)
    ? wire.fs
        .map((i) => SIGMA_CLASSES[i])
        .filter((s): s is SigmaClass => typeof s === 'string')
    : [...SIGMA_CLASSES];

  return {
    version: SAVED_VIEW_VERSION,
    rung: wire.r,
    parentId: typeof wire.p === 'string' ? wire.p : null,
    camera: { x: wire.c[0], y: wire.c[1], zoom: wire.c[2] },
    selection: strings(wire.s),
    focus: typeof wire.f === 'string' ? wire.f : null,
    queryId: typeof wire.qi === 'string' ? wire.qi : null,
    query: typeof wire.q === 'string' ? wire.q : null,
    filters: {
      sigma: sigma.length > 0 ? sigma : [...SIGMA_CLASSES],
      families: strings(wire.ff),
      showQuarantined: wire.fq === 1,
    },
    density: wire.d,
  };
}

/* =============================================================================
 * 4. THE HASH
 * ========================================================================== */

/** Pull the `view=` token out of a hash string. `null` when there is not one. */
export function readSavedViewFromHash(hash?: string): string | null {
  const raw = hash ?? (typeof location === 'undefined' ? '' : location.hash);
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const params = new URLSearchParams(raw.replace(/^#/, ''));
  const token = params.get(SAVED_VIEW_HASH_KEY);
  return token === null || token.length === 0 ? null : token;
}

/**
 * Write the token into `location.hash` WITHOUT adding a history entry.
 *
 * `replaceState` rather than assignment: saving a view is not navigation, and a
 * back button that walks through forty auto-saved camera positions is a back
 * button nobody can use.
 */
export function writeSavedViewToHash(token: string): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const hash = `#${SAVED_VIEW_HASH_KEY}=${token}`;
  if (location.hash === hash) return;
  history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
}

/** Remove the fragment, again without a history entry. */
export function clearSavedViewHash(): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  if (location.hash === '') return;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
}
