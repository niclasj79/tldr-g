/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE ENGINE CLIENT
 * =============================================================================
 *
 * ONE CLIENT. TWO TRANSPORTS. IDENTICAL SIGNATURES AND IDENTICAL RESPONSE
 * SHAPES EITHER WAY.
 *
 *   VITE_TLDRG_BASE_URL unset  ->  FixtureTransport, serving the baked corpus
 *                                  from memory (`@/engine/fixtures`).
 *   VITE_TLDRG_BASE_URL set    ->  HttpTransport, `fetch` against that origin,
 *                                  same paths, same params, same envelopes.
 *
 * That is the claim this file exists to make INSPECTABLE: swapping the demo for
 * a live engine is a base-URL change, not a rewrite. The HTTP half is therefore
 * real code — real URL construction, real headers, real error mapping, real
 * abort plumbing, real provenance checking — and not a `throw new Error('TODO')`
 * wearing a comment. If you want to test the claim, point the env var at
 * anything that speaks these paths and watch nothing else change.
 *
 * -----------------------------------------------------------------------------
 * EDGES ARE EARNED, NEVER ALL-ON.
 * THIS IS THE STRUCTURAL DEFENCE AGAINST THE HAIRBALL.
 * -----------------------------------------------------------------------------
 * `getGraphView()` NEVER returns every edge. The corpus has ~12,900 relations;
 * drawing them is not a rendering problem to be solved with better shaders, it
 * is a semantic failure — a picture of everything is a picture of nothing, and
 * the user learns that the map cannot be read. So the policy lives HERE, in the
 * engine seam, where a renderer cannot opt out of it by being clever:
 *
 *   'trade-route-skeleton'  the high-weight BUNDLED corridors between regions.
 *                           Precomputed once in `@/engine/fixtures`. At the
 *                           region rungs this is the ONLY thing drawn.
 *   'hover-neighborhood'    the k-hop neighbourhood of the pointer target,
 *                           intersected with what is on screen.
 *   'query-constellation'   exactly the edges on and adjacent to an answer path.
 *
 * Every response says which rule it used (`stats.drawn_reason`) and reports
 * `stats.edges_drawn` against `stats.edge_count`, so the HUD can state how much
 * was withheld instead of implying that what is on screen is all there is. At
 * the region rungs the corridors carry their own totals (`EdgeBundle.count`), so
 * "37 corridors carrying 4,812 relations, 74 shipped as exemplars" is a sentence
 * the UI can write from the payload alone.
 *
 * Quarantined edges SHIP but are NOT stroked. They render `latent` so the
 * terrain shows what the truth gate rejected rather than hiding it; that is why
 * `edges_drawn` is smaller than `edge_count` even inside the payload.
 *
 * -----------------------------------------------------------------------------
 * THE LATENCY NUMBER IS A MEASUREMENT
 * -----------------------------------------------------------------------------
 * `latency_ms` is a `performance.now()` delta around the whole call — the real
 * cost of assembling the payload, serialising it, and (for the fixture
 * transport) moving it across a DECLARED wire model. There is no fake spinner
 * delay and there is no fake progress anywhere in this file. The wire model is
 * one documented constant, it is derived from the payload's real byte count, and
 * it can be switched off. See `WIRE`.
 *
 * -----------------------------------------------------------------------------
 * THE CACHE COUNTERS ARE REAL COUNTERS
 * -----------------------------------------------------------------------------
 * `engine.cacheStats()` reports actual hits and lookups of an actual LRU keyed
 * by `(bake_id, method, path, params, body)`. Note this is the CLIENT's response
 * cache and is a different thing from `RenderStats.cache_hits`, which is the
 * ENGINE's own render cache for one query. Both are real; they count different
 * work, and the UI must not present one as the other.
 * =============================================================================
 */

import {
  boundsOfNodes,
  edgesById,
  getFixtures,
  nodesById,
  prepareFixtures,
} from '@/engine/fixtures';
import type { Fixtures } from '@/engine/fixtures';

import type { StagedQuery } from '@/engine/corpus/world';

import { canonicalize, signTrace, verifyTrace as verifyTraceLocally } from '@/engine/trust/sign';
import {
  buildDemoRenderStats,
  buildDemoRenderTrace,
  buildRenderTrace,
  citationCost,
  demoConstellationNodeIds,
  deriveRenderStats,
  pointerCost,
  summaryCost,
  DEMO_ANSWER,
  DEMO_BRIDGE_ENTITY_ID,
  DEMO_PATH,
  DEMO_QUERY_ID,
  DEMO_TRACE_ID,
} from '@/engine/trust/trace';
import type { ConstellationEdge, CounterfactualAsset } from '@/engine/trust/trace';

import { CORPUS_PROVENANCE, RUNGS, byFamily } from '@/engine/types';
import type {
  AdmissionRecord,
  Asset,
  CorpusProvenance,
  DegradedReason,
  DrawnReason,
  Edge,
  EdgeBundle,
  Entity,
  GraphNode,
  GraphViewResponse,
  GraphViewStats,
  IntegrityResponse,
  IsoTimestamp,
  LayoutBake,
  NodeKind,
  PassageResolution,
  PathStep,
  Pointer,
  QueryIntent,
  QueryMode,
  QueryRenderResponse,
  RelationFamily,
  RenderTraceV1,
  Rung,
  SigmaClass,
  Source,
  VerifyResult,
} from '@/engine/types';

/* =============================================================================
 * 1. CONFIGURATION
 * ========================================================================== */

/** `import.meta.env`, read defensively so this module also loads under plain node. */
function viteEnv(): Record<string, string | undefined> {
  return (
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}
  );
}

/** The env var that decides which transport is used. Documented in `vite.config.ts`. */
export const BASE_URL_ENV_KEY = 'VITE_TLDRG_BASE_URL';

/**
 * The fixture transport's declared WIRE MODEL.
 *
 * A payload does not arrive for free over HTTP and it should not arrive for free
 * here either, or the demo teaches that a graph API is instantaneous and every
 * loading state in the product looks like a bug. So the fixture transport waits
 * for a duration DERIVED FROM THE PAYLOAD'S REAL BYTE COUNT, at a declared rate.
 *
 * This is the only synthetic millisecond in the client, it is named, it is
 * bounded, and `simulateWire: false` removes it entirely. Everything else in
 * `latency_ms` is real work being timed.
 */
export const WIRE = Object.freeze({
  /** Throughput of the modelled link. ~3 MB/s: a modest local connection. */
  bytes_per_ms: 3072,
  /** Connection setup + server handling floor, in ms. */
  fixed_ms: 4,
  /** Ceiling. A demo that stalls for a second teaches impatience, not architecture. */
  max_ms: 140,
});

/**
 * The three edge rules, as a runtime list.
 *
 * The TYPE is the contract's (`DrawnReason`); this is the guard, so a hand-built
 * query string cannot smuggle a fourth rule past the policy in section 9.
 */
export const DRAWN_REASONS: readonly DrawnReason[] = Object.freeze([
  'trade-route-skeleton',
  'hover-neighborhood',
  'query-constellation',
]);

/** Options for constructing an `EngineClient`. Every field has a documented default. */
export interface EngineClientOptions {
  /**
   * Origin of a live engine, e.g. `https://engine.internal:8443`. Defaults to
   * `import.meta.env.VITE_TLDRG_BASE_URL`. Pass `null` to force the fixture
   * transport even when the env var is set.
   */
  baseUrl?: string | null;
  /** Injectable `fetch`, for tests and for a worker with its own binding. */
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every HTTP request (auth, tracing). Ignored by the fixture transport. */
  headers?: Readonly<Record<string, string>>;
  /** LRU capacity of the response cache. Default 64 entries. */
  cacheCapacity?: number;
  /** Apply the declared wire model to fixture responses. Default `true`. */
  simulateWire?: boolean;
  /** Override `WIRE.bytes_per_ms`. Fixture transport only. */
  wireBytesPerMs?: number;
}

/* =============================================================================
 * 2. ERRORS
 * -----------------------------------------------------------------------------
 * "Something went wrong" is not a message, it is an apology. Every failure that
 * leaves this module carries a machine code, what concretely failed, and an
 * imperative remedy — the three fields of `DegradedReason` — so the UI can never
 * be reduced to a shrug.
 * ========================================================================== */

export class EngineError extends Error {
  /** Stable machine code, e.g. `NOT_FOUND`, `TRANSPORT_FAILED`, `QUERY_NO_EVIDENCE`. */
  readonly code: string;
  /** What failed, naming the component and the operation. */
  readonly what_failed: string;
  /** An action the user can actually take, phrased as an imperative. */
  readonly exact_remedy: string;
  /** HTTP status when one was involved, else `null`. */
  readonly status: number | null;
  /** The engine path that failed, e.g. `/graph/view/island`. */
  readonly path: string | null;

  constructor(init: {
    code: string;
    what_failed: string;
    exact_remedy: string;
    status?: number | null;
    path?: string | null;
    cause?: unknown;
  }) {
    super(`[engine] ${init.code}: ${init.what_failed}`, { cause: init.cause });
    this.name = 'EngineError';
    this.code = init.code;
    this.what_failed = init.what_failed;
    this.exact_remedy = init.exact_remedy;
    this.status = init.status ?? null;
    this.path = init.path ?? null;
  }

  /** The contract shape the DEGRADED screen renders. Never a generic toast. */
  toDegradedReason(): DegradedReason {
    return {
      code: this.code,
      what_failed: this.what_failed,
      exact_remedy: this.exact_remedy,
    };
  }
}

/**
 * Turn any thrown value into a `DegradedReason`. Use this at the boundary of
 * every screen: an unmapped exception reaching a user as a blank panel is the
 * same failure as a generic toast, one layer deeper.
 */
export function toDegradedReason(err: unknown): DegradedReason {
  if (err instanceof EngineError) return err.toDegradedReason();
  if (err instanceof Error) {
    return {
      code: 'ENGINE_UNCAUGHT',
      what_failed: `The engine client threw an unmapped error: ${err.message}`,
      exact_remedy: 'Reload the page. If it repeats, open the browser console and report the stack trace.',
    };
  }
  return {
    code: 'ENGINE_UNCAUGHT',
    what_failed: `The engine client threw a non-Error value: ${String(err)}`,
    exact_remedy: 'Reload the page and report this in the console.',
  };
}

/* =============================================================================
 * 3. TRANSPORT CONTRACT
 * ========================================================================== */

/** Query-string / body-safe parameter values. */
export type ParamValue = string | number | boolean | undefined;

/** One engine call, transport-independent. Both transports consume exactly this. */
export interface EngineRequest {
  method: 'GET' | 'POST';
  /** Engine-relative path with no query string, e.g. `/graph/view/asset`. */
  path: string;
  params?: Readonly<Record<string, ParamValue>>;
  body?: unknown;
  signal?: AbortSignal;
}

/** What a transport hands back: the payload plus the two numbers the HUD needs. */
export interface TransportResult<T> {
  data: T;
  /** Wall-clock ms measured inside the transport. */
  latency_ms: number;
  /** Real serialised size of the payload, in bytes-as-UTF-16-code-units. */
  bytes: number;
}

/** The seam. Two implementations; the client cannot tell them apart. */
export interface Transport {
  readonly kind: 'fixture' | 'http';
  /** The origin being talked to, or `null` for the in-memory fixtures. */
  readonly baseUrl: string | null;
  request<T>(req: EngineRequest): Promise<TransportResult<T>>;
}

/* =============================================================================
 * 4. SHARED PLUMBING
 * ========================================================================== */

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function ms2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Params -> a stable, sorted query string. Same key order on both transports, so cache keys agree. */
function queryString(params: Readonly<Record<string, ParamValue>> | undefined): string {
  if (params === undefined) return '';
  const entries = Object.entries(params).filter(
    (kv): kv is [string, string | number | boolean] => kv[1] !== undefined,
  );
  if (entries.length === 0) return '';
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const usp = new URLSearchParams();
  for (const [k, v] of entries) usp.set(k, String(v));
  return usp.toString();
}

function throwIfAborted(signal: AbortSignal | undefined, path: string): void {
  if (signal?.aborted === true) {
    throw new EngineError({
      code: 'REQUEST_ABORTED',
      what_failed: `The request to ${path} was aborted before it completed.`,
      exact_remedy: 'Re-run the action. Nothing was left in a partial state.',
      path,
    });
  }
}

/**
 * FAIL LOUD, DO NOT REWRITE. Every top-level envelope must carry
 * `corpus_provenance`, and the UI is required to surface it. If a response
 * arrives without one, or with a value this build does not know, we say so on
 * the console and pass the value through UNTOUCHED — silently stamping our own
 * provenance onto somebody else's payload is exactly the forgery the field
 * exists to prevent.
 */
function checkProvenance(data: unknown, path: string): void {
  if (data === null || typeof data !== 'object') return;
  if (!('corpus_provenance' in data)) {
    // eslint-disable-next-line no-console
    console.error(
      `[engine/api] the response from ${path} has no corpus_provenance. Every envelope must ` +
        `declare where its content came from, and the UI is required to show it.`,
    );
    return;
  }
  const value = (data as { corpus_provenance: unknown }).corpus_provenance;
  if (value !== CORPUS_PROVENANCE) {
    // eslint-disable-next-line no-console
    console.error(
      `[engine/api] the response from ${path} declares corpus_provenance "${String(value)}"; ` +
        `this build's contract pins "${CORPUS_PROVENANCE}". The value has been passed through ` +
        `unchanged. When the contract grows a second provenance, src/engine/types.ts is the ` +
        `one place that has to change.`,
    );
  }
}

/* =============================================================================
 * 5. THE RESPONSE CACHE
 * -----------------------------------------------------------------------------
 * Content-addressed on `(bake_id, method, path, sorted params, canonical body)`.
 * `bake_id` is in the key because a re-bake moves every coordinate in the world:
 * a cached view keyed without it would render new labels at old positions, which
 * is the most convincing kind of wrong.
 * ========================================================================== */

/** Real counters. `engine.cacheStats()` is what the HUD prints. */
export interface CacheStats {
  hits: number;
  misses: number;
  lookups: number;
  /** `hits / lookups`, 0 when nothing has been looked up yet. */
  hit_rate: number;
  /** Entries currently held. */
  size: number;
  capacity: number;
  evictions: number;
}

class ResponseCache {
  private readonly map = new Map<string, unknown>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly capacity: number) {}

  static key(bakeId: string, req: EngineRequest): string {
    const qs = queryString(req.params);
    const body = req.body === undefined ? '' : canonicalize(req.body);
    return `${bakeId}|${req.method} ${req.path}${qs === '' ? '' : `?${qs}`}|${body}`;
  }

  get<T>(key: string): { hit: true; value: T } | { hit: false } {
    if (this.map.has(key)) {
      const value = this.map.get(key) as T;
      // LRU: touching an entry moves it to the young end.
      this.map.delete(key);
      this.map.set(key, value);
      this.hits++;
      return { hit: true, value };
    }
    this.misses++;
    return { hit: false };
  }

  set(key: string, value: unknown): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) break;
      this.map.delete(oldest.value);
      this.evictions++;
    }
  }

  clear(): void {
    this.map.clear();
  }

  stats(): CacheStats {
    const lookups = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      lookups,
      hit_rate: lookups === 0 ? 0 : this.hits / lookups,
      size: this.map.size,
      capacity: this.capacity,
      evictions: this.evictions,
    };
  }
}

/* =============================================================================
 * 6. HTTP TRANSPORT
 * -----------------------------------------------------------------------------
 * Real code, written to work. This is the half of the file that makes the
 * "base-URL change, not a rewrite" claim checkable rather than aspirational.
 * ========================================================================== */

export class HttpTransport implements Transport {
  readonly kind = 'http' as const;
  readonly baseUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(baseUrl: string, opts: { fetch?: typeof globalThis.fetch; headers?: Readonly<Record<string, string>> } = {}) {
    // Trailing slash normalised once, so `/graph/view` never becomes `//graph/view`.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    const bound = opts.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
    if (bound === undefined) {
      throw new EngineError({
        code: 'NO_FETCH',
        what_failed: `An engine base URL is configured (${baseUrl}) but this runtime has no global fetch.`,
        exact_remedy: 'Pass a fetch implementation via `new EngineClient({ fetch })`, or unset ' + BASE_URL_ENV_KEY + ' to use the in-memory corpus.',
      });
    }
    this.doFetch = bound;
    this.headers = opts.headers ?? {};
  }

  async request<T>(req: EngineRequest): Promise<TransportResult<T>> {
    const qs = queryString(req.params);
    const url = `${this.baseUrl}${req.path}${qs === '' ? '' : `?${qs}`}`;

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.headers,
    };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.body);
    }

    const started = nowMs();
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method: req.method,
        headers,
        body,
        signal: req.signal,
        credentials: 'same-origin',
        // The response cache lives in this client, keyed by bake_id. Letting the
        // browser cache on top of it would produce two caches that disagree
        // about which bake is current, and the newer one would lose.
        cache: 'no-store',
      });
    } catch (cause) {
      if (req.signal?.aborted === true) throwIfAborted(req.signal, req.path);
      throw new EngineError({
        code: 'TRANSPORT_FAILED',
        what_failed: `${req.method} ${url} did not complete: ${cause instanceof Error ? cause.message : String(cause)}`,
        exact_remedy: `Check that the engine at ${this.baseUrl} is reachable, then re-run the action. To fall back to the bundled corpus, unset ${BASE_URL_ENV_KEY} and reload.`,
        path: req.path,
        cause,
      });
    }

    const text = await res.text();
    const latency_ms = ms2(nowMs() - started);

    if (!res.ok) {
      throw new EngineError({
        code: res.status === 404 ? 'NOT_FOUND' : 'ENGINE_REJECTED',
        what_failed: `${req.method} ${url} returned ${res.status} ${res.statusText}. Body: ${text.slice(0, 240)}`,
        exact_remedy:
          res.status === 404
            ? 'The engine does not know that id. Re-open the view from the breadcrumb so the ids come from the current bake.'
            : `Check the engine log at ${this.baseUrl} for this request, then re-run the action.`,
        status: res.status,
        path: req.path,
      });
    }

    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch (cause) {
      throw new EngineError({
        code: 'MALFORMED_RESPONSE',
        what_failed: `${req.method} ${url} returned ${text.length} bytes that are not JSON.`,
        exact_remedy: `Confirm ${this.baseUrl} is an engine and not a proxy or a login page, then re-run the action.`,
        path: req.path,
        cause,
      });
    }

    checkProvenance(data, req.path);
    return { data, latency_ms, bytes: text.length };
  }
}

/* =============================================================================
 * 7. FIXTURE TRANSPORT
 * -----------------------------------------------------------------------------
 * Serves the baked corpus from memory over the SAME paths and params. It
 * serialises and re-parses every payload, which is not ceremony: it is what
 * makes the fixture responses behave exactly like wire responses — detached
 * object identity, `undefined` fields dropped, Maps rejected — so a component
 * that works here cannot break the day the base URL is set.
 * ========================================================================== */

export class FixtureTransport implements Transport {
  readonly kind = 'fixture' as const;
  readonly baseUrl = null;
  private readonly simulateWire: boolean;
  private readonly bytesPerMs: number;

  constructor(opts: { simulateWire?: boolean; wireBytesPerMs?: number } = {}) {
    this.simulateWire = opts.simulateWire ?? true;
    this.bytesPerMs = opts.wireBytesPerMs ?? WIRE.bytes_per_ms;
  }

  async request<T>(req: EngineRequest): Promise<TransportResult<T>> {
    throwIfAborted(req.signal, req.path);
    const started = nowMs();

    const fx = getFixtures();
    const payload = route(fx, req);

    // Real serialisation. This is the byte count the wire model is derived from,
    // and re-parsing hands the caller a detached copy exactly as HTTP would.
    const text = JSON.stringify(payload);
    const data = JSON.parse(text) as T;

    if (this.simulateWire) {
      const wire = Math.min(WIRE.max_ms, WIRE.fixed_ms + text.length / this.bytesPerMs);
      await sleep(wire);
    } else {
      await Promise.resolve();
    }

    throwIfAborted(req.signal, req.path);
    checkProvenance(data, req.path);
    return { data, latency_ms: ms2(nowMs() - started), bytes: text.length };
  }
}

/** Wait `ms`. Sub-millisecond waits collapse to a microtask rather than a timer. */
function sleep(ms: number): Promise<void> {
  if (ms < 1) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/* =============================================================================
 * 8. THE ROUTER
 * -----------------------------------------------------------------------------
 * One switch, mirroring the paths a live engine would expose. Adding a method to
 * `EngineClient` means adding a case here AND a route on the server; that
 * symmetry is the whole point.
 * ========================================================================== */

function route(fx: Fixtures, req: EngineRequest): unknown {
  const { method, path } = req;
  const p = (name: string): string | undefined => {
    const v = req.params?.[name];
    return v === undefined ? undefined : String(v);
  };
  const pn = (name: string, fallback: number): number => {
    const v = req.params?.[name];
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const pb = (name: string, fallback: boolean): boolean => {
    const v = req.params?.[name];
    if (v === undefined) return fallback;
    return v === true || v === 'true' || v === 1 || v === '1';
  };

  if (method === 'GET' && path.startsWith('/graph/view/')) {
    const rung = path.slice('/graph/view/'.length) as Rung;
    if (!(RUNGS as readonly string[]).includes(rung)) {
      throw new EngineError({
        code: 'BAD_RUNG',
        what_failed: `"${rung}" is not a rung. The spine has exactly four: ${RUNGS.join(', ')}.`,
        exact_remedy: 'Request one of the four rungs. There is no universe rung and evidence is not a rung.',
        path,
      });
    }
    const reason = p('drawn_reason') ?? 'trade-route-skeleton';
    if (!DRAWN_REASONS.includes(reason as DrawnReason)) {
      throw new EngineError({
        code: 'BAD_DRAWN_REASON',
        what_failed: `"${reason}" is not an edge rule. Edges are earned; the three rules are ${DRAWN_REASONS.join(', ')}.`,
        exact_remedy: 'Pass one of the three drawn reasons, or omit it and get the trade-route skeleton.',
        path,
      });
    }
    return graphView(fx, {
      rung,
      parentId: p('parent_id') ?? null,
      drawnReason: reason as DrawnReason,
      maxEdges: pn('max_edges', 512),
      // The whole world has 170 straits; the default shows all of them, because
      // a skeleton that is silently truncated is not a skeleton. Lowering this
      // is the caller's deliberate choice, not the engine's quiet one.
      maxBundles: pn('max_bundles', 256),
      exemplarsPerBundle: pn('exemplars_per_bundle', 2),
      includeEntities: req.params?.include_entities === undefined ? null : pb('include_entities', false),
      hoverNodeId: p('hover_node_id') ?? null,
      hops: pn('hops', 1),
      queryId: p('query_id') ?? null,
    });
  }

  if (method === 'GET' && path.startsWith('/graph/neighborhood/')) {
    const nodeId = decodeURIComponent(path.slice('/graph/neighborhood/'.length));
    return neighborhood(fx, nodeId, pn('hops', 1), pn('max_edges', 512), pn('max_nodes', 400));
  }

  if (method === 'GET' && path === '/graph/path') {
    const from = p('from');
    const to = p('to');
    if (from === undefined || to === undefined) {
      throw new EngineError({
        code: 'BAD_REQUEST',
        what_failed: 'GET /graph/path needs both `from` and `to`.',
        exact_remedy: 'Pass two node ids: findPath(fromId, toId).',
        path,
      });
    }
    return { steps: findPathSteps(fx, from, to), corpus_provenance: CORPUS_PROVENANCE };
  }

  if (method === 'GET' && path === '/layout/bake') return fx.bake;
  if (method === 'GET' && path === '/integrity') return fx.integrity;
  if (method === 'GET' && path === '/query/staged') {
    return { queries: fx.stagedQueries, corpus_provenance: CORPUS_PROVENANCE };
  }

  /* `Source` and `GraphNode` are node shapes, not response envelopes, so they
     carry no provenance of their own. They are wrapped rather than stamped: a
     provenance field spliced onto a node would be a field the contract does not
     declare, and downstream would start reading it off nodes that never have it. */
  if (method === 'GET' && path.startsWith('/source/')) {
    const id = decodeURIComponent(path.slice('/source/'.length));
    const node = fx.world.node_by_id.get(id);
    if (node === undefined || node.kind !== 'source') {
      throw notFound('source', id, path);
    }
    return { source: node, corpus_provenance: CORPUS_PROVENANCE };
  }

  if (method === 'GET' && path.startsWith('/node/')) {
    const id = decodeURIComponent(path.slice('/node/'.length));
    const node = fx.world.node_by_id.get(id);
    if (node === undefined) throw notFound('node', id, path);
    return { node, corpus_provenance: CORPUS_PROVENANCE };
  }

  if (method === 'GET' && path.startsWith('/trace/')) {
    const id = decodeURIComponent(path.slice('/trace/'.length));
    const trace = traceById(id);
    if (trace === null) throw notFound('render trace', id, path);
    return trace;
  }

  if (method === 'GET' && path === '/timeline') {
    return timeline(fx, {
      from: p('from') ?? null,
      to: p('to') ?? null,
      scopeId: p('scope_id') ?? null,
      limit: pn('limit', 200),
      includeQuarantined: pb('include_quarantined', false),
    });
  }

  if (method === 'POST' && path === '/query/render') {
    const body = (req.body ?? {}) as {
      query?: string;
      token_budget?: number;
      intent?: QueryIntent;
      mode?: QueryMode;
      max_citations?: number;
    };
    if (typeof body.query !== 'string' || body.query.trim().length === 0) {
      throw new EngineError({
        code: 'BAD_REQUEST',
        what_failed: 'POST /query/render was called with an empty question.',
        exact_remedy: 'Type a question, or pick one of the staged questions from the command bar.',
        path,
      });
    }
    return renderQuery(fx, body.query, {
      tokenBudget: body.token_budget ?? 10_000,
      maxCitations: body.max_citations ?? 5,
      mode: body.mode ?? 'deterministic',
    });
  }

  if (method === 'POST' && path === '/trace/verify') {
    const body = (req.body ?? {}) as { trace?: RenderTraceV1 };
    if (body.trace === undefined) {
      throw new EngineError({
        code: 'BAD_REQUEST',
        what_failed: 'POST /trace/verify was called without a trace.',
        exact_remedy: 'Send `{ trace }`, or verify locally with engine.verifyTraceSync(trace).',
        path,
      });
    }
    return verifyTraceLocally(body.trace);
  }

  throw new EngineError({
    code: 'NO_SUCH_ROUTE',
    what_failed: `The engine has no route for ${method} ${path}.`,
    exact_remedy: 'Call one of the EngineClient methods rather than constructing a path by hand.',
    path,
  });
}

function notFound(what: string, id: string, path: string): EngineError {
  return new EngineError({
    code: 'NOT_FOUND',
    what_failed: `No ${what} with id "${id}" exists in this bake.`,
    exact_remedy: 'Re-open the view from the breadcrumb so the ids come from the current bake, then try again.',
    status: 404,
    path,
  });
}

/* =============================================================================
 * 9. GRAPH VIEWS — where the edge policy is enforced
 * ========================================================================== */

/** Resolved, non-optional view parameters. The router fills in every default. */
interface ViewParams {
  rung: Rung;
  parentId: string | null;
  drawnReason: DrawnReason;
  maxEdges: number;
  maxBundles: number;
  exemplarsPerBundle: number;
  /** `null` means "use the per-rung default". */
  includeEntities: boolean | null;
  hoverNodeId: string | null;
  hops: number;
  queryId: string | null;
}

/**
 * Entities are the cross-cutting layer, not a rung. They are drawn OVER a rung
 * when the rung is fine enough for a named concept to mean something in place:
 *
 *   continent  no  — an entity dot on a landmass is noise at that zoom.
 *   island     no  — the island's bridge entities are already summarised by the
 *                    corridors; drawing them individually pre-empts the descent.
 *   asset      yes — this is the extraction context. Entities belong here.
 *   passage    yes — the mentions ARE the point of a passage view.
 */
function defaultIncludeEntities(rung: Rung): boolean {
  return rung === 'asset' || rung === 'passage';
}

function graphView(fx: Fixtures, v: ViewParams): GraphViewResponse {
  const includeEntities = v.includeEntities ?? defaultIncludeEntities(v.rung);

  /* ---- the rung's own nodes ------------------------------------------- */
  const rungNodes: GraphNode[] = [];
  for (const node of fx.world.nodes) {
    if (node.kind !== v.rung) continue;
    if (v.parentId !== null && spineParentOf(node) !== v.parentId) continue;
    rungNodes.push(node);
  }
  if (rungNodes.length === 0 && v.parentId !== null && !fx.world.node_by_id.has(v.parentId)) {
    throw notFound('node', v.parentId, `/graph/view/${v.rung}`);
  }
  rungNodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const inView = new Set(rungNodes.map((n) => n.id));

  /* ---- the entity layer, when this rung earns it ----------------------- */
  const nodes: GraphNode[] = [...rungNodes];
  if (includeEntities) {
    const entities: Entity[] = [];
    for (const entity of fx.world.entities) {
      const relevant =
        entity.asset_ids.some((id) => inView.has(id)) ||
        entity.mentions.some((id) => inView.has(id)) ||
        entity.island_ids.some((id) => inView.has(id));
      if (relevant) entities.push(entity);
    }
    entities.sort((a, b) => b.centrality - a.centrality || (a.id < b.id ? -1 : 1));
    for (const entity of entities) {
      nodes.push(entity);
      inView.add(entity.id);
    }
  }

  /* ---- EDGES ARE EARNED. Choose the drawable subset, never the whole set. */
  let bundles: EdgeBundle[] = [];
  let edges: Edge[] = [];

  const isRegionRung = v.rung === 'continent' || v.rung === 'island';

  if (v.drawnReason === 'trade-route-skeleton') {
    if (isRegionRung) {
      const all = v.rung === 'continent' ? fx.bundles.continent : fx.bundles.island;
      bundles = all
        .filter((b) => inView.has(b.from_id) && inView.has(b.to_id))
        .slice(0, v.maxBundles);
      // Exemplars, so hovering a corridor shows real relations without a round
      // trip. The corridor's own `count` remains the truth about how many it
      // carries; these are a sample and the HUD must say so.
      edges = exemplarEdges(fx, bundles, v.exemplarsPerBundle, v.maxEdges);
    } else {
      edges = topEdgesAmong(fx, inView, v.maxEdges);
    }
  } else if (v.drawnReason === 'hover-neighborhood') {
    const seeds = v.hoverNodeId === null ? [] : [v.hoverNodeId];
    const closure = hopClosure(fx, seeds, Math.max(1, v.hops), 4096);
    edges = edgesWithin(fx, inView, (e) => closure.has(e.from_id) || closure.has(e.to_id), v.maxEdges);
    if (isRegionRung) {
      const all = v.rung === 'continent' ? fx.bundles.continent : fx.bundles.island;
      bundles = all
        .filter(
          (b) =>
            inView.has(b.from_id) &&
            inView.has(b.to_id) &&
            (b.from_id === v.hoverNodeId || b.to_id === v.hoverNodeId),
        )
        .slice(0, v.maxBundles);
    }
  } else {
    // 'query-constellation'
    const staged = v.queryId === null ? undefined : fx.stagedQueries.find((q) => q.id === v.queryId);
    const wanted = new Set(staged?.gold_edge_ids ?? []);
    const constellation = new Set(staged?.gold_node_ids ?? []);
    edges = edgesWithin(
      fx,
      inView,
      (e) => wanted.has(e.id) || (constellation.has(e.from_id) && constellation.has(e.to_id)),
      v.maxEdges,
    );
  }

  /* Quarantined relations ship so the terrain can show what the gate rejected;
     they render `latent` and are never stroked as a route. That is the whole
     reason `edges_drawn` is not simply `edges.length`. */
  const edges_drawn = edges.reduce((n, e) => n + (e.quarantined ? 0 : 1), 0);

  const stats: GraphViewStats = {
    node_count: nodes.length,
    edge_count: edges.length,
    edges_drawn,
    drawn_reason: v.drawnReason,
  };

  return {
    rung: v.rung,
    parent_id: v.parentId,
    nodes,
    edges,
    bundles,
    bounds: boundsOfNodes(fx, nodes.map((n) => n.id)),
    bake_id: fx.bake.bake_id,
    stats,
    corpus_provenance: CORPUS_PROVENANCE,
  };
}

/** The spine parent of a node, or `null` for the kinds that float above the spine. */
function spineParentOf(node: GraphNode): string | null {
  switch (node.kind) {
    case 'island':
    case 'asset':
    case 'passage':
      return node.parent_id;
    case 'continent':
    case 'entity':
    case 'source':
      return null;
  }
}

/** The heaviest few real relations behind each corridor. A sample, never the corridor's truth. */
function exemplarEdges(
  fx: Fixtures,
  bundles: readonly EdgeBundle[],
  perBundle: number,
  cap: number,
): Edge[] {
  const out: Edge[] = [];
  const seen = new Set<string>();
  for (const bundle of bundles) {
    const picked = edgesById(fx, bundle.edge_ids)
      .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1))
      .slice(0, Math.max(0, perBundle));
    for (const edge of picked) {
      if (seen.has(edge.id) || out.length >= cap) continue;
      seen.add(edge.id);
      out.push(edge);
    }
  }
  return out;
}

/** Every edge whose BOTH endpoints are on screen, filtered and capped by weight. */
function edgesWithin(
  fx: Fixtures,
  inView: ReadonlySet<string>,
  keep: (edge: Edge) => boolean,
  cap: number,
): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const nodeId of inView) {
    for (const edgeId of fx.world.adjacency.get(nodeId) ?? []) {
      if (seen.has(edgeId)) continue;
      seen.add(edgeId);
      const edge = fx.world.edge_by_id.get(edgeId);
      if (edge === undefined) continue;
      if (!inView.has(edge.from_id) || !inView.has(edge.to_id)) continue;
      if (!keep(edge)) continue;
      out.push(edge);
    }
  }
  out.sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1));
  return out.slice(0, cap);
}

/** The skeleton inside a fine rung: the highest-weight relations among the nodes on screen. */
function topEdgesAmong(fx: Fixtures, inView: ReadonlySet<string>, cap: number): Edge[] {
  return edgesWithin(fx, inView, () => true, cap);
}

/** BFS closure over non-quarantined relations. A rejected claim may not extend a neighbourhood. */
function hopClosure(fx: Fixtures, seeds: readonly string[], hops: number, cap: number): Set<string> {
  const seen = new Set<string>(seeds.filter((id) => fx.world.node_by_id.has(id)));
  let frontier = [...seen];
  for (let h = 0; h < hops && frontier.length > 0 && seen.size < cap; h++) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      for (const edgeId of fx.world.adjacency.get(nodeId) ?? []) {
        const edge = fx.world.edge_by_id.get(edgeId);
        if (edge === undefined || edge.quarantined) continue;
        const other = edge.from_id === nodeId ? edge.to_id : edge.from_id;
        if (seen.has(other) || seen.size >= cap) continue;
        seen.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return seen;
}

/**
 * The k-hop neighbourhood of one node, as a graph view.
 *
 * `rung` reports the rung at which the payload should be READ. Entities and
 * sources are not rungs — they hang off the asset, which is the extraction
 * context — so a neighbourhood seeded from one is read at the asset rung.
 */
function neighborhood(
  fx: Fixtures,
  nodeId: string,
  hops: number,
  maxEdges: number,
  maxNodes: number,
): GraphViewResponse {
  const seed = fx.world.node_by_id.get(nodeId);
  if (seed === undefined) throw notFound('node', nodeId, `/graph/neighborhood/${nodeId}`);

  const closure = hopClosure(fx, [nodeId], Math.max(1, hops), maxNodes);
  const nodes = nodesById(fx, closure);
  nodes.sort((a, b) => b.centrality - a.centrality || (a.id < b.id ? -1 : 1));

  const inView = new Set(nodes.map((n) => n.id));
  const edges = topEdgesAmong(fx, inView, maxEdges);
  const edges_drawn = edges.reduce((n, e) => n + (e.quarantined ? 0 : 1), 0);

  const readAt: Rung =
    seed.kind === 'continent' || seed.kind === 'island' || seed.kind === 'asset' || seed.kind === 'passage'
      ? seed.kind
      : 'asset';

  return {
    rung: readAt,
    parent_id: spineParentOf(seed),
    nodes,
    edges,
    bundles: [],
    bounds: boundsOfNodes(fx, inView),
    bake_id: fx.bake.bake_id,
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      edges_drawn,
      drawn_reason: 'hover-neighborhood',
    },
    corpus_provenance: CORPUS_PROVENANCE,
  };
}

/* =============================================================================
 * 10. PATHFINDING
 * ========================================================================== */

/** Maximum hops before `findPath` gives up. Deeper than any chain a user can read. */
const MAX_PATH_HOPS = 24;

/**
 * How good a hop is as EVIDENCE, 0..1. Extraction confidence, halved when the
 * relation has no citable passage behind it.
 */
function hopQuality(edge: Edge): number {
  const confidence = Math.min(1, Math.max(0, edge.confidence));
  return edge.evidence_passage_ids.length > 0 ? confidence : confidence * 0.5;
}

/**
 * Shortest — and, among equally short, best-evidenced — chain of ADMITTED
 * relations between two nodes.
 *
 * Quarantined edges are excluded from traversal, full stop. An answer routed
 * through a claim the truth gate rejected is not a shorter answer, it is a wrong
 * one, and the whole receipt downstream would be built on it.
 *
 * WHY THIS IS NOT PLAIN BFS. It was, and the benchmark caught it: asked for
 * `e:rimsdal-group` -> `e:bruntorp-facility`, plain BFS returned
 * `has_member` + `divested` rather than the gold `acquired` + `operates`. Both
 * routes are two hops, so BFS picked whichever adjacency list it happened to
 * scan first — and the path readout then disagreed with the citations sitting
 * underneath it on the same screen. Two panels contradicting each other about
 * the same two nodes is exactly the failure this product cannot afford.
 *
 * So the search is lexicographic: HOP COUNT FIRST, always — that is what
 * "shortest" means and it is never traded away — then, within one depth level,
 * the route whose relations carry the most confident citable evidence. The level
 * is fully relaxed before the next one begins, so the predecessor recorded for a
 * node is the best one at that depth, not the first one seen.
 *
 * Returns `[]` when the two nodes are not connected by admitted relations. That
 * is a real result about the terrain, not an error.
 */
function findPathSteps(fx: Fixtures, fromId: string, toId: string): PathStep[] {
  if (!fx.world.node_by_id.has(fromId)) throw notFound('node', fromId, '/graph/path');
  if (!fx.world.node_by_id.has(toId)) throw notFound('node', toId, '/graph/path');
  if (fromId === toId) return [];

  const cameFrom = new Map<string, { via: Edge; prev: string }>();
  const depth = new Map<string, number>([[fromId, 0]]);
  const cost = new Map<string, number>([[fromId, 0]]);
  let frontier: string[] = [fromId];
  let level = 0;
  let reached = false;

  while (frontier.length > 0 && level < MAX_PATH_HOPS) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      const base = cost.get(nodeId) ?? 0;
      for (const edgeId of fx.world.adjacency.get(nodeId) ?? []) {
        const edge = fx.world.edge_by_id.get(edgeId);
        if (edge === undefined || edge.quarantined) continue;
        const other = edge.from_id === nodeId ? edge.to_id : edge.from_id;
        const seenAt = depth.get(other);
        // Already settled at this depth or shallower: a longer route can never win.
        if (seenAt !== undefined && seenAt <= level) continue;
        const candidate = base + (1 - hopQuality(edge));
        if (seenAt === undefined) {
          depth.set(other, level + 1);
          cost.set(other, candidate);
          cameFrom.set(other, { via: edge, prev: nodeId });
          next.push(other);
        } else if (candidate < (cost.get(other) ?? Infinity)) {
          // Same depth, better-evidenced predecessor. Take it.
          cost.set(other, candidate);
          cameFrom.set(other, { via: edge, prev: nodeId });
        }
      }
    }
    if (depth.has(toId)) {
      reached = true;
      break;
    }
    frontier = next;
    level++;
  }

  if (!reached) return [];

  const chain: { edge: Edge; from: string; to: string }[] = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const step = cameFrom.get(cursor);
    if (step === undefined) return [];
    chain.push({ edge: step.via, from: step.prev, to: cursor });
    cursor = step.prev;
  }
  chain.reverse();

  return chain.map((hop, index) => toPathStep(fx, hop.edge, index, hop.from, hop.to));
}

/**
 * One hop, oriented in TRAVERSAL order rather than in storage order.
 *
 * When the walk crossed the edge backwards, the family reported is the edge's
 * declared `inverse_family` — `operated_by` rather than `operates` — because the
 * path readout is a sentence the user reads left to right, and printing the
 * stored direction would make half of them read backwards.
 */
function toPathStep(fx: Fixtures, edge: Edge, index: number, fromId: string, toId: string): PathStep {
  const forward = edge.from_id === fromId;
  const family: RelationFamily = forward ? edge.family : (edge.inverse_family ?? edge.family);
  return {
    index,
    from_id: fromId,
    to_id: toId,
    edge_id: edge.id,
    family,
    sigma: byFamily[family].sigma,
    crosses_strait: edge.crosses_strait,
    evidence_passage_ids: [...edge.evidence_passage_ids],
  };
}

/* =============================================================================
 * 11. TIMELINE
 * -----------------------------------------------------------------------------
 * `Rung`, `Edge`, `NodeKind` and friends come from the contract. `TimelineEvent`
 * and `TimelineResponse` do not exist there, so they are declared here — built
 * ONLY out of contract types, in the same envelope style, carrying
 * `corpus_provenance` like every other response.
 * ========================================================================== */

/** One dated thing: an asset's declared boundary, or a relation that makes a temporal/episodic claim. */
export interface TimelineEvent {
  /** The asset whose boundary this is, or the subject of the relation. */
  node_id: string;
  kind: NodeKind;
  label: string;
  /** The instant. For assets this is `boundary_declared_at` — when somebody said "this is one thing". */
  at: IsoTimestamp;
  /** The relation family for a claim event; `null` for a boundary declaration. */
  family: RelationFamily | null;
  /** Denormalised sigma of `family`; `null` for a boundary declaration. */
  sigma: SigmaClass | null;
  /** The edge behind a claim event; `null` for a boundary declaration. */
  edge_id: string | null;
  island_id: string | null;
  evidence_passage_ids: string[];
  /** True when the truth gate rejected the claim. Shipped anyway; render `latent`. */
  quarantined: boolean;
}

/** `GET /timeline` — a window over the corpus's own clock. */
export interface TimelineResponse {
  /** Window start, inclusive. */
  from: IsoTimestamp;
  /** Window end, inclusive. */
  to: IsoTimestamp;
  /** The continent / island / asset the window was taken over, or `null` for the whole world. */
  scope_id: string | null;
  events: TimelineEvent[];
  /** Events inside the window that `limit` cut off. Never silently dropped. */
  truncated: number;
  bake_id: string;
  corpus_provenance: CorpusProvenance;
}

interface TimelineParams {
  from: string | null;
  to: string | null;
  scopeId: string | null;
  limit: number;
  includeQuarantined: boolean;
}

/**
 * The corpus's own clock span: earliest and latest DECLARED BOUNDARY.
 *
 * This is the default window, and it exists so `/timeline` never reports a
 * sentinel. An axis labelled `0000-01-01 -> 9999-12-31` is not a window, it is a
 * placeholder that escaped into an instrument, and the reader has no way to tell
 * it from a real measurement.
 */
let corpusSpanMemo: { bake_id: string; span: [IsoTimestamp, IsoTimestamp] } | null = null;
function corpusSpan(fx: Fixtures): [IsoTimestamp, IsoTimestamp] {
  if (corpusSpanMemo !== null && corpusSpanMemo.bake_id === fx.bake.bake_id) return corpusSpanMemo.span;
  let lo = fx.world.built_at;
  let hi = fx.world.built_at;
  let seen = false;
  const observe = (at: IsoTimestamp): void => {
    if (!seen) {
      lo = at;
      hi = at;
      seen = true;
      return;
    }
    if (at < lo) lo = at;
    if (at > hi) hi = at;
  };
  // Both kinds of event this endpoint can return, or the default window would
  // silently filter out the half it forgot to measure.
  for (const asset of fx.world.assets) observe(asset.boundary_declared_at);
  for (const edge of fx.world.edges) {
    const sigma = byFamily[edge.family].sigma;
    if (sigma === 'temporal' || sigma === 'episodic') observe(edge.created_at);
  }
  corpusSpanMemo = { bake_id: fx.bake.bake_id, span: [lo, hi] };
  return corpusSpanMemo.span;
}

function timeline(fx: Fixtures, t: TimelineParams): TimelineResponse {
  const [spanFrom, spanTo] = corpusSpan(fx);
  const from = t.from ?? spanFrom;
  const to = t.to ?? spanTo;

  /* Scope resolution walks DOWN the spine, so a continent id admits every asset
     beneath it without the caller having to enumerate islands. */
  let scope: Set<string> | null = null;
  if (t.scopeId !== null) {
    const node = fx.world.node_by_id.get(t.scopeId);
    if (node === undefined) throw notFound('node', t.scopeId, '/timeline');
    scope = new Set<string>();
    if (node.kind === 'continent') {
      for (const asset of fx.world.assets) if (asset.continent_id === node.id) scope.add(asset.id);
    } else if (node.kind === 'island') {
      for (const id of node.asset_ids) scope.add(id);
    } else if (node.kind === 'asset') {
      scope.add(node.id);
    } else {
      const owner = fx.assetOf.get(node.id);
      if (owner !== undefined) scope.add(owner);
      else scope.add(node.id);
    }
  }

  const events: TimelineEvent[] = [];

  for (const asset of fx.world.assets) {
    if (scope !== null && !scope.has(asset.id)) continue;
    const at = asset.boundary_declared_at;
    if (at < from || at > to) continue;
    events.push({
      node_id: asset.id,
      kind: 'asset',
      label: asset.label,
      at,
      family: null,
      sigma: null,
      edge_id: null,
      island_id: asset.parent_id,
      evidence_passage_ids: [],
      quarantined: false,
    });
  }

  for (const edge of fx.world.edges) {
    const def = byFamily[edge.family];
    if (def.sigma !== 'temporal' && def.sigma !== 'episodic') continue;
    if (edge.quarantined && !t.includeQuarantined) continue;
    const at = edge.created_at;
    if (at < from || at > to) continue;
    if (scope !== null) {
      const a = fx.assetOf.get(edge.from_id);
      const b = fx.assetOf.get(edge.to_id);
      const inScopeByAsset = (a !== undefined && scope.has(a)) || (b !== undefined && scope.has(b));
      const inScopeByEvidence = edge.evidence_passage_ids.some((pid) => {
        const owner = fx.assetOf.get(pid);
        return owner !== undefined && scope !== null && scope.has(owner);
      });
      if (!inScopeByAsset && !inScopeByEvidence) continue;
    }
    const subject = fx.world.node_by_id.get(edge.from_id);
    events.push({
      node_id: edge.from_id,
      kind: subject?.kind ?? 'entity',
      label: subject?.label ?? edge.from_id,
      at,
      family: edge.family,
      sigma: edge.sigma,
      edge_id: edge.id,
      island_id: fx.islandOf.get(edge.from_id) ?? null,
      evidence_passage_ids: [...edge.evidence_passage_ids],
      quarantined: edge.quarantined,
    });
  }

  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.node_id < b.node_id ? -1 : 1));
  const limit = Math.max(1, Math.floor(t.limit));
  const truncated = Math.max(0, events.length - limit);

  return {
    from,
    to,
    scope_id: t.scopeId,
    events: events.slice(0, limit),
    truncated,
    bake_id: fx.bake.bake_id,
    corpus_provenance: CORPUS_PROVENANCE,
  };
}

/* =============================================================================
 * 12. QUERY RENDERING
 * -----------------------------------------------------------------------------
 * The headline query is the CONTRACTUAL demo receipt from `@/engine/trust/trace`
 * — real passages, real hashes, real edges, and figures that `assertDemoReceipt`
 * throws over if they ever stop adding up.
 *
 * Every other question is rendered here, from the world, by traversal: real
 * edges, real evidence passages, real entity counts, a budget that actually
 * binds, and a signed trace. Nothing is narrated. If a question cannot be
 * answered with at least one checkable quote, this refuses to answer it rather
 * than producing a confident paragraph with nothing underneath.
 * ========================================================================== */

interface RenderOptions {
  tokenBudget: number;
  maxCitations: number;
  mode: QueryMode;
}

/** Memoised so the demo receipt is assembled and signed once, not per keystroke. */
let demoTraceMemo: RenderTraceV1 | null = null;
function demoTrace(): RenderTraceV1 {
  if (demoTraceMemo === null) demoTraceMemo = buildDemoRenderTrace();
  return demoTraceMemo;
}

/** Any trace this build can serve by id. Extends naturally to a trace store. */
function traceById(traceId: string): RenderTraceV1 | null {
  if (traceId === DEMO_TRACE_ID) return demoTrace();
  return renderedTraces.get(traceId) ?? null;
}

/**
 * Traces produced by `renderQuery` in this session, so `GET /trace/{id}` can
 * serve them back. Bounded and FIFO: a receipt store that grows without limit is
 * a memory leak wearing an audit trail's clothes.
 */
const renderedTraces = new Map<string, RenderTraceV1>();
const RENDERED_TRACE_CAPACITY = 32;

function rememberTrace(trace: RenderTraceV1): void {
  renderedTraces.delete(trace.trace_id);
  renderedTraces.set(trace.trace_id, trace);
  while (renderedTraces.size > RENDERED_TRACE_CAPACITY) {
    const oldest = renderedTraces.keys().next();
    if (oldest.done === true) break;
    renderedTraces.delete(oldest.value);
  }
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Words that carry no retrieval signal. Small on purpose: a long stoplist starts deleting meaning. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'what', 'which', 'who', 'whom', 'whose',
  'how', 'why', 'when', 'where', 'are', 'was', 'were', 'has', 'have', 'had', 'does', 'did',
  'say', 'says', 'said', 'name', 'missing', 'complete', 'entity', 'between', 'them', 'about',
  'into', 'over', 'under', 'their', 'they', 'its', 'put', 'order',
]);

/** The question's content terms: lowercased, deduped, stopwords and stubs dropped. */
function contentTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of normalise(query).split(/[^a-z0-9åäöæøéèüß-]+/i)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/**
 * How well a passage answers the question, 0..1.
 *
 * THIS IS A LEXICAL STAND-IN AND IT IS NAMED AS ONE.
 * `RenderStats.composite.semantic` is specified as embedding-space fit between
 * the question and the admitted passages. This build ships no embedding model,
 * so what is actually measured is the share of the question's content terms that
 * literally appear in the cited text.
 *
 * It is a weaker signal than a cosine and it reads LOW on paraphrase — which is
 * the correct direction for a substitute to err. The alternative, which this
 * code did until the harness printed the composite, was to feed the passage's
 * centrality into the gauge: a number that is real, that is 1.00 surprisingly
 * often, and that has nothing whatsoever to do with whether the quote answers
 * the question. A gauge fed the wrong quantity is worse than a missing gauge,
 * because it is confidently wrong and nothing on screen says so.
 */
function questionFit(terms: readonly string[], text: string): number {
  if (terms.length === 0) return 0;
  const hay = normalise(text);
  let hits = 0;
  for (const term of terms) if (hay.includes(term)) hits++;
  return hits / terms.length;
}

function renderQuery(fx: Fixtures, query: string, opts: RenderOptions): QueryRenderResponse {
  const asked = normalise(query);

  /* ---- the headline: contractual, asserted, signed --------------------- */
  const demoQuery = fx.world.staged_queries.find((q) => q.id === DEMO_QUERY_ID);
  if (
    demoQuery !== undefined &&
    (asked === normalise(demoQuery.query) || asked === DEMO_QUERY_ID)
  ) {
    const trace = demoTrace();
    const stats = buildDemoRenderStats(trace);
    rememberTrace(trace);
    return {
      query_id: DEMO_QUERY_ID,
      query: demoQuery.query,
      intent: demoQuery.intent,
      mode: demoQuery.mode,
      answer: DEMO_ANSWER,
      gold: demoQuery.gold,
      latency_ms: 0, // stamped by the client with the real measured round trip
      render_stats: stats,
      constellation: {
        node_ids: demoConstellationNodeIds(),
        path: DEMO_PATH.map((s) => ({ ...s, evidence_passage_ids: [...s.evidence_passage_ids] })),
        bridge_entity_id: DEMO_BRIDGE_ENTITY_ID,
      },
      trace_id: trace.trace_id,
      corpus_provenance: CORPUS_PROVENANCE,
    };
  }

  /* ---- the other staged questions -------------------------------------- */
  const staged = fx.world.staged_queries.find(
    (q) => q.id === asked || normalise(q.query) === asked,
  );
  if (staged !== undefined) return renderStaged(fx, staged, opts);

  /* ---- free text -------------------------------------------------------- */
  return renderFreeText(fx, query, opts);
}

/** A staged question, answered from its by-construction gold edges. */
function renderStaged(fx: Fixtures, sq: StagedQuery, opts: RenderOptions): QueryRenderResponse {
  const pathEdges = edgesById(fx, sq.gold_edge_ids);
  const seeds = new Set<string>();
  for (const id of sq.gold_node_ids) {
    const node = fx.world.node_by_id.get(id);
    if (node !== undefined && node.kind !== 'passage') seeds.add(id);
  }
  for (const edge of pathEdges) {
    seeds.add(edge.from_id);
    seeds.add(edge.to_id);
  }

  const chain = sq.chain
    .map(([subject, family, object]) => `${subject} ${byFamily[family].label} ${object}`)
    .join('; ');
  const answer = chain.length > 0 ? `${sq.gold}. ${chain}.` : `${sq.gold}.`;

  return assemble(fx, {
    query_id: sq.id,
    trace_id: `trace:${sq.id}`,
    query: sq.query,
    intent: sq.intent,
    mode: sq.mode,
    gold: sq.gold,
    answer,
    pathEdges,
    seedNodeIds: [...seeds],
    bridgeEntityId: sq.bridge_entity_id,
  }, opts);
}

/**
 * A free-text question, answered by lexical match onto the entity layer and then
 * by traversal. Deterministic, and honest about being shallow: no model
 * participates, so `mode` stays `deterministic` and there is no `gold`.
 */
function renderFreeText(fx: Fixtures, query: string, opts: RenderOptions): QueryRenderResponse {
  const terms = normalise(query)
    .split(/[^a-z0-9åäöæøéèüß-]+/i)
    .filter((t) => t.length > 2);

  let best: Entity | null = null;
  let bestScore = 0;
  let second: Entity | null = null;

  for (const entity of fx.world.entities) {
    const haystack = normalise(`${entity.label} ${entity.aliases.join(' ')}`);
    let score = 0;
    for (const term of terms) if (haystack.includes(term)) score += term.length;
    if (score === 0) continue;
    score += entity.centrality;
    if (score > bestScore) {
      second = best;
      best = entity;
      bestScore = score;
    }
  }

  if (best === null) {
    throw new EngineError({
      code: 'QUERY_NO_MATCH',
      what_failed: `Nothing in this corpus matches "${query.slice(0, 120)}". No entity label or alias contains any of its terms.`,
      exact_remedy: 'Name something that is on the map — try one of the staged questions in the command bar, or click an entity and ask about it by name.',
    });
  }

  const focus = best;
  const incident = (fx.world.adjacency.get(focus.id) ?? [])
    .map((id) => fx.world.edge_by_id.get(id))
    .filter((e): e is Edge => e !== undefined && !e.quarantined && e.evidence_passage_ids.length > 0)
    .sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : 1));

  const pathEdges = incident.slice(0, second === null ? 3 : 4);
  const seeds = new Set<string>([focus.id]);
  if (second !== null) seeds.add(second.id);
  for (const edge of pathEdges) {
    seeds.add(edge.from_id);
    seeds.add(edge.to_id);
  }

  const sentences = pathEdges.slice(0, 3).map((edge) => {
    const a = fx.world.node_by_id.get(edge.from_id)?.label ?? edge.from_id;
    const b = fx.world.node_by_id.get(edge.to_id)?.label ?? edge.to_id;
    return `${a} ${byFamily[edge.family].label} ${b}`;
  });
  const answer =
    sentences.length > 0
      ? `${focus.label}. ${focus.summary} ${sentences.join('; ')}.`
      : `${focus.label}. ${focus.summary}`;

  return assemble(fx, {
    query_id: `q:adhoc:${focus.id}`,
    trace_id: `trace:adhoc:${focus.id}`,
    query,
    intent: focus.is_bridge && second !== null ? 'bridge' : 'lookup',
    mode: opts.mode,
    gold: null,
    answer,
    pathEdges,
    seedNodeIds: [...seeds],
    bridgeEntityId: focus.is_bridge ? focus.id : null,
  }, opts);
}

/* ---------------------------------------------------------------------------
 * The shared renderer. Everything below this line is derived from the world.
 * ------------------------------------------------------------------------- */

interface RenderPlan {
  query_id: string;
  trace_id: string;
  query: string;
  intent: QueryIntent;
  mode: QueryMode;
  gold: string | null;
  answer: string;
  pathEdges: Edge[];
  seedNodeIds: string[];
  bridgeEntityId: string | null;
}

function assemble(fx: Fixtures, plan: RenderPlan, opts: RenderOptions): QueryRenderResponse {
  /* The engine's own render cache. A real memo with real counters — every
     resolve of a node during this render is a lookup, and a repeat is a hit.
     This is NOT the client's HTTP response cache; the two count different work
     and the UI must not present one as the other. */
  let cache_lookups = 0;
  let cache_hits = 0;
  const resolved = new Map<string, GraphNode | undefined>();
  const resolve = (id: string): GraphNode | undefined => {
    cache_lookups++;
    if (resolved.has(id)) {
      cache_hits++;
      return resolved.get(id);
    }
    const node = fx.world.node_by_id.get(id);
    resolved.set(id, node);
    return node;
  };

  const path: PathStep[] = plan.pathEdges.map((edge, index) =>
    toPathStep(fx, edge, index, edge.from_id, edge.to_id),
  );

  /* ---- citations: real passages, real hashes ---------------------------- */
  const citationSeeds: {
    passage_id: string;
    asset_id: string;
    source_id: string;
    content_hash: string;
    seq: number;
    /** TRUST GUARANTEE, carried straight through from the passage. Never upgraded to `verbatim`. */
    resolution: PassageResolution;
    quote: string;
    why_admitted: string;
    score: number;
    tokens: number;
  }[] = [];

  /* The admission score of a citation is HALF question-fit, HALF extraction
     confidence: "does this quote address what was asked" and "do we trust the
     relation it was pulled through" are different questions and the gauge needs
     both. `questionFit` documents what it is and is not. */
  const terms = contentTerms(plan.query);
  const scoreFor = (text: string, confidence: number): number =>
    Math.min(1, Math.max(0, 0.5 * questionFit(terms, text) + 0.5 * Math.min(1, Math.max(0, confidence))));

  const wantedPassages: { id: string; why: string; confidence: number }[] = [];
  plan.pathEdges.forEach((edge, hop) => {
    for (const pid of edge.evidence_passage_ids) {
      wantedPassages.push({ id: pid, why: `on_answer_path_hop_${hop}`, confidence: edge.confidence });
    }
  });
  if (wantedPassages.length === 0) {
    // No relation carried evidence — a structural fiber, or a summarise-shaped
    // question. Fall back to the assets' own text, which is still a checkable
    // quote from a real document, and say so in `why_admitted`.
    for (const seedId of plan.seedNodeIds) {
      const node = resolve(seedId);
      if (node === undefined) continue;
      if (node.kind === 'asset') {
        const first = node.passage_ids[0];
        if (first !== undefined) {
          wantedPassages.push({ id: first, why: 'boundary_declaration', confidence: node.centrality });
        }
      } else if (node.kind === 'entity') {
        for (const pid of node.mentions.slice(0, 2)) {
          wantedPassages.push({ id: pid, why: 'mentions_focus_entity', confidence: node.centrality });
        }
      }
    }
  }

  let spent = 0;
  const seenPassages = new Set<string>();
  for (const want of wantedPassages) {
    if (citationSeeds.length >= opts.maxCitations) break;
    if (seenPassages.has(want.id)) continue;
    seenPassages.add(want.id);
    const passage = resolve(want.id);
    if (passage === undefined || passage.kind !== 'passage') continue;
    const cost = citationCost(passage.text);
    if (spent + cost > opts.tokenBudget) break;
    spent += cost;
    citationSeeds.push({
      passage_id: passage.id,
      asset_id: passage.asset_id,
      source_id: passage.source_id,
      content_hash: passage.content_hash,
      seq: passage.seq,
      resolution: passage.resolution,
      quote: passage.text,
      why_admitted: want.why,
      score: scoreFor(passage.text, want.confidence),
      tokens: cost,
    });
  }

  if (citationSeeds.length === 0) {
    throw new EngineError({
      code: 'QUERY_NO_EVIDENCE',
      what_failed: `"${plan.query.slice(0, 120)}" reached the graph but no admitted relation carried a quotable passage, so there is nothing to cite.`,
      exact_remedy: 'Ask about a named entity with mentions — open the Integrity panel to see which relations were quarantined and why.',
    });
  }

  /* ---- admissions: the answer path first, then by centrality, until the
          budget actually binds. Everything that does not fit is REPORTED as
          omitted rather than quietly dropped. ---------------------------- */
  const onPath = new Set<string>();
  for (const step of path) {
    onPath.add(step.from_id);
    onPath.add(step.to_id);
  }

  const candidateIds = new Set<string>([...onPath, ...plan.seedNodeIds]);
  for (const step of path) {
    for (const nodeId of [step.from_id, step.to_id]) {
      for (const edgeId of fx.world.adjacency.get(nodeId) ?? []) {
        const edge = fx.world.edge_by_id.get(edgeId);
        if (edge === undefined || edge.quarantined) continue;
        candidateIds.add(edge.from_id === nodeId ? edge.to_id : edge.from_id);
      }
    }
  }

  /* Entities are the constellation. Assets join it only when the answer path
     runs THROUGH one — the structural reading-order fibre does exactly that, and
     leaving those endpoints unadmitted would make the topology signal report a
     disconnected answer that is in fact perfectly connected. */
  const candidates: (Entity | Asset)[] = [];
  for (const id of candidateIds) {
    const node = resolve(id);
    if (node === undefined) continue;
    if (node.kind === 'entity') candidates.push(node);
    else if (node.kind === 'asset' && onPath.has(node.id)) candidates.push(node);
  }
  candidates.sort((a, b) => {
    const pathA = onPath.has(a.id) ? 1 : 0;
    const pathB = onPath.has(b.id) ? 1 : 0;
    if (pathA !== pathB) return pathB - pathA;
    return b.centrality - a.centrality || (a.id < b.id ? -1 : 1);
  });

  const admitted: AdmissionRecord[] = [];
  const admittedIds = new Set<string>(citationSeeds.map((c) => c.passage_id));
  const evicted: (Entity | Asset)[] = [];
  const LOD1_SLOTS = 8;

  for (const node of candidates) {
    if (admittedIds.has(node.id)) continue;
    const [mentions, assets] = admissionSize(node);
    const asSummary = onPath.has(node.id) || admitted.length < LOD1_SLOTS;
    const cost = asSummary ? summaryCost(mentions, assets) : pointerCost(mentions, assets);
    if (spent + cost > opts.tokenBudget) {
      evicted.push(node);
      continue;
    }
    spent += cost;
    admittedIds.add(node.id);
    admitted.push({
      node_id: node.id,
      kind: node.kind,
      lod: asSummary ? 'lod-1' : 'lod-2',
      reason: onPath.has(node.id)
        ? 'on_answer_path'
        : node.kind === 'entity' && node.is_bridge
          ? 'bridge_neighbor'
          : 'constellation_neighbor',
      tokens: cost,
      score: Math.min(1, Math.max(0, node.centrality)),
    });
  }

  /* ---- omitted-but-connected: the honesty mechanism --------------------- */
  const omitted: Pointer[] = [];
  const omittedIds = new Set<string>();
  const pushPointer = (nodeId: string, kind: NodeKind, why: string): void => {
    if (admittedIds.has(nodeId) || omittedIds.has(nodeId)) return;
    omittedIds.add(nodeId);
    omitted.push({ node_id: nodeId, kind, why_omitted: why, hop_distance: 1 });
  };
  for (const node of evicted) pushPointer(node.id, node.kind, 'budget_exhausted');
  for (const nodeId of admittedIds) {
    if (omitted.length >= 128) break;
    for (const edgeId of fx.world.adjacency.get(nodeId) ?? []) {
      const edge = fx.world.edge_by_id.get(edgeId);
      if (edge === undefined) continue;
      const other = edge.from_id === nodeId ? edge.to_id : edge.from_id;
      if (admittedIds.has(other)) continue;
      const node = resolve(other);
      if (node === undefined) continue;
      pushPointer(
        other,
        node.kind,
        edge.quarantined
          ? 'reached_only_through_quarantined_edge'
          : byFamily[edge.family].sigma === 'structural'
            ? 'structural_link_only'
            : 'below_threshold',
      );
      if (omitted.length >= 128) break;
    }
  }

  /* ---- the trace, assembled and signed ---------------------------------- */
  const unsigned = buildRenderTrace({
    trace_id: plan.trace_id,
    query_id: plan.query_id,
    query: plan.query,
    model: 'deterministic-traversal',
    created_at: new Date().toISOString(),
    citations: citationSeeds,
    admitted,
    omitted_but_connected: omitted,
  });
  const trace = signTrace(unsigned);
  rememberTrace(trace);

  /* ---- the counterfactual: the naive stuffed context, really summed ----- */
  const touchedAssets = new Set<string>();
  for (const citation of citationSeeds) touchedAssets.add(citation.asset_id);
  for (const record of admitted) {
    const node = resolve(record.node_id);
    if (node !== undefined && node.kind === 'entity') {
      for (const assetId of node.asset_ids) touchedAssets.add(assetId);
    }
  }
  let counterfactual = assetInventory(fx, touchedAssets, resolve);
  let counterfactualTokens = counterfactual.reduce((sum, a) => sum + a.tokens, 0);
  if (counterfactualTokens < spent) {
    // The naive baseline must genuinely be the more expensive option or the
    // savings figure means nothing. Widen it to every asset on the islands the
    // constellation touches — still a real inventory, just a coarser one.
    const islands = new Set<string>();
    for (const assetId of touchedAssets) {
      const island = fx.islandOf.get(assetId);
      if (island !== undefined) islands.add(island);
    }
    const wider = new Set<string>();
    for (const asset of fx.world.assets) if (islands.has(asset.parent_id)) wider.add(asset.id);
    counterfactual = assetInventory(fx, wider, resolve);
    counterfactualTokens = counterfactual.reduce((sum, a) => sum + a.tokens, 0);
  }

  /* ---- constellation edges for the stats derivation --------------------- */
  const constellationIds = new Set<string>(admittedIds);
  const seenEdges = new Set<string>();
  const constellationEdges: ConstellationEdge[] = [];
  for (const nodeId of constellationIds) {
    for (const edgeId of fx.world.adjacency.get(nodeId) ?? []) {
      if (seenEdges.has(edgeId)) continue;
      seenEdges.add(edgeId);
      const edge = fx.world.edge_by_id.get(edgeId);
      if (edge === undefined) continue;
      if (!constellationIds.has(edge.from_id) || !constellationIds.has(edge.to_id)) continue;
      constellationEdges.push({
        edge_id: edge.id,
        from_id: edge.from_id,
        to_id: edge.to_id,
        family: edge.family,
        quarantined: edge.quarantined,
        crosses_strait: edge.crosses_strait,
      });
    }
  }

  const mention_links = citationSeeds.map((citation) => {
    const passage = resolve(citation.passage_id);
    const entityIds =
      passage !== undefined && passage.kind === 'passage'
        ? passage.entity_ids.filter((id) => admittedIds.has(id))
        : [];
    return { passage_id: citation.passage_id, entity_ids: entityIds };
  });

  const render_stats = deriveRenderStats({
    trace,
    counterfactual,
    edges: constellationEdges,
    mention_links,
    path,
    token_budget: opts.tokenBudget,
    cache_hits,
    cache_lookups,
  });

  const response: QueryRenderResponse = {
    query_id: plan.query_id,
    query: plan.query,
    intent: plan.intent,
    mode: plan.mode,
    answer: plan.answer,
    latency_ms: 0, // stamped by the client with the real measured round trip
    render_stats,
    constellation: {
      node_ids: [...admittedIds],
      path,
      bridge_entity_id: plan.bridgeEntityId,
    },
    trace_id: trace.trace_id,
    corpus_provenance: CORPUS_PROVENANCE,
  };
  if (plan.gold !== null) response.gold = plan.gold;
  return response;
}

/** The per-asset inventory a naive full-context retrieval would have had to stuff. Real token counts. */
function assetInventory(
  fx: Fixtures,
  assetIds: ReadonlySet<string>,
  resolve: (id: string) => GraphNode | undefined,
): CounterfactualAsset[] {
  const out: CounterfactualAsset[] = [];
  for (const assetId of assetIds) {
    const asset = resolve(assetId);
    if (asset === undefined || asset.kind !== 'asset') continue;
    out.push({
      asset_id: asset.id,
      island_id: asset.parent_id,
      passages: asset.passage_ids.length,
      tokens: asset.token_count,
    });
  }
  out.sort((a, b) => (a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0));
  return out;
}

/** How many tokens a node costs to render, as `[mentions, assets]` for the cost model. */
function admissionSize(node: Entity | Asset): [number, number] {
  return node.kind === 'entity'
    ? [node.mentions.length, node.asset_ids.length]
    : [node.passage_ids.length, 1];
}

/* =============================================================================
 * 13. THE CLIENT
 * ========================================================================== */

/** Options accepted by `getGraphView`. Serialised verbatim onto the query string. */
export interface GraphViewOptions {
  /** Which edge rule this view is allowed to use. Default `'trade-route-skeleton'`. */
  drawnReason?: DrawnReason;
  /** Hard cap on edges in the payload. Default 512. */
  maxEdges?: number;
  /** Hard cap on corridors at a region rung. Default 256 — enough to show the whole skeleton. */
  maxBundles?: number;
  /** Real relations shipped per corridor, as a sample. Default 2. */
  exemplarsPerBundle?: number;
  /** Override the per-rung default (asset and passage rungs include entities). */
  includeEntities?: boolean;
  /** Required by `'hover-neighborhood'`: the node the pointer is on. */
  hoverNodeId?: string;
  /** Hops for `'hover-neighborhood'`. Default 1. */
  hops?: number;
  /** Required by `'query-constellation'`: a staged query id. */
  queryId?: string;
  signal?: AbortSignal;
}

/** Options accepted by `postQuery`. */
export interface QueryOptions {
  /** Tokens the renderer may spend. Default 10,000. It is a ceiling and it binds. */
  tokenBudget?: number;
  /** Maximum verbatim quotes. Default 5. */
  maxCitations?: number;
  /** Default `'deterministic'`. `'llm_augmented'` must be disclosed in the UI. */
  mode?: QueryMode;
  signal?: AbortSignal;
}

/** Options accepted by `getTimeline`. */
export interface TimelineOptions {
  /** ISO instant, inclusive. Default: the beginning of the corpus. */
  from?: IsoTimestamp;
  /** ISO instant, inclusive. Default: the end of the corpus. */
  to?: IsoTimestamp;
  /** A continent, island or asset id to scope the window to. Default: the whole world. */
  scopeId?: string;
  /** Maximum events returned. Default 200; the overflow is reported as `truncated`. */
  limit?: number;
  /** Include claims the truth gate rejected, so they can render `latent`. Default false. */
  includeQuarantined?: boolean;
  signal?: AbortSignal;
}

/**
 * The engine client.
 *
 * Construct one, or use the `engine` singleton. Every method is `async` and
 * returns a contract envelope; every method has the same signature and the same
 * response shape whether it is talking to the in-memory fixtures or to a live
 * engine over HTTP.
 */
export class EngineClient {
  readonly transport: Transport;
  private readonly cache: ResponseCache;
  private lastLatencyMs = 0;

  constructor(options: EngineClientOptions = {}) {
    const fromEnv = viteEnv()[BASE_URL_ENV_KEY];
    const baseUrl =
      options.baseUrl === undefined ? (fromEnv ?? null) : options.baseUrl;

    this.transport =
      baseUrl !== null && baseUrl.trim().length > 0
        ? new HttpTransport(baseUrl.trim(), { fetch: options.fetch, headers: options.headers })
        : new FixtureTransport({
            simulateWire: options.simulateWire,
            wireBytesPerMs: options.wireBytesPerMs,
          });

    this.cache = new ResponseCache(Math.max(1, options.cacheCapacity ?? 64));
  }

  /** `'fixture'` or `'http'`. The HUD is expected to show this — it is a provenance fact. */
  get mode(): 'fixture' | 'http' {
    return this.transport.kind;
  }

  /** The origin being talked to, or `null` when the bundled corpus is being served. */
  get baseUrl(): string | null {
    return this.transport.baseUrl;
  }

  /** Real counters over the client's response cache. */
  cacheStats(): CacheStats {
    return this.cache.stats();
  }

  /** Drop every cached response. Call after a re-bake, or when a live engine says its corpus moved. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Wall-clock ms of the most recent call. The number the HUD prints next to the last action. */
  get lastLatency(): number {
    return this.lastLatencyMs;
  }

  /** Materialise the corpus without issuing a request. No-op against a live engine. */
  async warm(): Promise<void> {
    if (this.transport.kind === 'fixture') await prepareFixtures();
  }

  /* ---- the calls ------------------------------------------------------- */

  /**
   * `GET /graph/view/{rung}?parent_id=...` — one rung of the spine, in place.
   *
   * `parentId` omitted or `null` returns the WHOLE rung: every continent, or
   * every island in the world, which is the view the strait crossing is read at.
   *
   * EDGES ARE EARNED. See the file header: this never returns the full edge set,
   * and `response.stats` says which rule chose what you got.
   */
  async getGraphView(
    rung: Rung,
    parentId: string | null = null,
    opts: GraphViewOptions = {},
  ): Promise<GraphViewResponse> {
    return this.send<GraphViewResponse>({
      method: 'GET',
      path: `/graph/view/${rung}`,
      params: {
        parent_id: parentId ?? undefined,
        drawn_reason: opts.drawnReason,
        max_edges: opts.maxEdges,
        max_bundles: opts.maxBundles,
        exemplars_per_bundle: opts.exemplarsPerBundle,
        include_entities: opts.includeEntities,
        hover_node_id: opts.hoverNodeId,
        hops: opts.hops,
        query_id: opts.queryId,
      },
      signal: opts.signal,
    });
  }

  /** `POST /query/render` — the answer, plus everything needed to distrust it. */
  async postQuery(query: string, opts: QueryOptions = {}): Promise<QueryRenderResponse> {
    const response = await this.send<QueryRenderResponse>({
      method: 'POST',
      path: '/query/render',
      body: {
        query,
        token_budget: opts.tokenBudget ?? 10_000,
        max_citations: opts.maxCitations ?? 5,
        mode: opts.mode ?? 'deterministic',
      },
      signal: opts.signal,
    });
    // `latency_ms` is the wall clock the USER waited, measured by this client.
    // It is stamped here rather than inside the engine so that a cache hit
    // honestly reports a cache hit's latency instead of replaying the original.
    return { ...response, latency_ms: this.lastLatencyMs };
  }

  /** `GET /trace/{id}` — the signed receipt for a render. */
  async getRenderTrace(traceId: string, opts: { signal?: AbortSignal } = {}): Promise<RenderTraceV1> {
    return this.send<RenderTraceV1>({
      method: 'GET',
      path: `/trace/${encodeURIComponent(traceId)}`,
      signal: opts.signal,
    });
  }

  /** `GET /integrity` — the truth gate's report card. */
  async getIntegrity(opts: { signal?: AbortSignal } = {}): Promise<IntegrityResponse> {
    return this.send<IntegrityResponse>({ method: 'GET', path: '/integrity', signal: opts.signal });
  }

  /**
   * Verify a render trace.
   *
   * BY DEFAULT THIS IS LOCAL AND SYNCHRONOUS UNDERNEATH, even when a live engine
   * is configured. That is the entire point of a detached signature: you do not
   * ask the party that produced the receipt whether the receipt is good. Pass
   * `{ local: false }` to force `POST /trace/verify` and compare the two — a
   * disagreement between them is itself the finding.
   */
  async verifyTrace(
    trace: RenderTraceV1,
    opts: { local?: boolean; signal?: AbortSignal } = {},
  ): Promise<VerifyResult> {
    if (opts.local !== false) return verifyTraceLocally(trace);
    return this.send<VerifyResult>({
      method: 'POST',
      path: '/trace/verify',
      body: { trace },
      signal: opts.signal,
    });
  }

  /** Synchronous local verification, for a badge that must not blink through an `await`. */
  verifyTraceSync(trace: RenderTraceV1): VerifyResult {
    return verifyTraceLocally(trace);
  }

  /** `GET /source/{id}` — the ingested document, verbatim segment and all. */
  async getSource(sourceId: string, opts: { signal?: AbortSignal } = {}): Promise<Source> {
    const response = await this.send<{ source: Source }>({
      method: 'GET',
      path: `/source/${encodeURIComponent(sourceId)}`,
      signal: opts.signal,
    });
    return response.source;
  }

  /** `GET /graph/neighborhood/{id}?hops=` — the k-hop neighbourhood, as a graph view. */
  async getNeighborhood(
    nodeId: string,
    hops = 1,
    opts: { maxEdges?: number; maxNodes?: number; signal?: AbortSignal } = {},
  ): Promise<GraphViewResponse> {
    return this.send<GraphViewResponse>({
      method: 'GET',
      path: `/graph/neighborhood/${encodeURIComponent(nodeId)}`,
      params: { hops, max_edges: opts.maxEdges, max_nodes: opts.maxNodes },
      signal: opts.signal,
    });
  }

  /**
   * `GET /graph/path?from=&to=` — the shortest chain of ADMITTED relations.
   *
   * Returns `[]` when there is no route. That is a real answer about the terrain,
   * not a failure, and the UI should say "no admitted route" rather than spin.
   */
  async findPath(fromId: string, toId: string, opts: { signal?: AbortSignal } = {}): Promise<PathStep[]> {
    const response = await this.send<{ steps: PathStep[]; corpus_provenance: CorpusProvenance }>({
      method: 'GET',
      path: '/graph/path',
      params: { from: fromId, to: toId },
      signal: opts.signal,
    });
    return response.steps;
  }

  /** `GET /timeline` — a window over the corpus's own clock. */
  async getTimeline(opts: TimelineOptions = {}): Promise<TimelineResponse> {
    return this.send<TimelineResponse>({
      method: 'GET',
      path: '/timeline',
      params: {
        from: opts.from,
        to: opts.to,
        scope_id: opts.scopeId,
        limit: opts.limit,
        include_quarantined: opts.includeQuarantined,
      },
      signal: opts.signal,
    });
  }

  /* ---- the three extras the required nine cannot live without ---------- */

  /**
   * `GET /layout/bake` — the frozen positions every coordinate is expressed
   * against. `GraphViewResponse` carries `bake_id` but not geometry; this is
   * where the geometry comes from, fetched once and held next to the store.
   */
  async getLayoutBake(opts: { signal?: AbortSignal } = {}): Promise<LayoutBake> {
    return this.send<LayoutBake>({ method: 'GET', path: '/layout/bake', signal: opts.signal });
  }

  /** `GET /node/{id}` — one node of any kind, for an inspector opened from a pick. */
  async getNode(nodeId: string, opts: { signal?: AbortSignal } = {}): Promise<GraphNode> {
    const response = await this.send<{ node: GraphNode }>({
      method: 'GET',
      path: `/node/${encodeURIComponent(nodeId)}`,
      signal: opts.signal,
    });
    return response.node;
  }

  /** `GET /query/staged` — the questions with by-construction answers. The command bar's real menu. */
  async getStagedQueries(opts: { signal?: AbortSignal } = {}): Promise<StagedQuery[]> {
    const response = await this.send<{ queries: StagedQuery[]; corpus_provenance: CorpusProvenance }>({
      method: 'GET',
      path: '/query/staged',
      signal: opts.signal,
    });
    return response.queries;
  }

  /* ---- the one place a request is actually issued --------------------- */

  private async send<T>(req: EngineRequest): Promise<T> {
    const started = nowMs();
    const bakeId =
      this.transport.kind === 'fixture' ? getFixtures().bake.bake_id : this.cacheEpoch;
    const key = ResponseCache.key(bakeId, req);

    const hit = this.cache.get<T>(key);
    if (hit.hit) {
      this.lastLatencyMs = ms2(nowMs() - started);
      return hit.value;
    }

    const result = await this.transport.request<T>(req);
    this.observeBakeId(result.data);
    this.cache.set(key, result.data);
    this.lastLatencyMs = ms2(nowMs() - started);
    return result.data;
  }

  /**
   * Cache epoch for the HTTP transport, where the client cannot see a bake id
   * until a response carries one.
   *
   * Every envelope that has a `bake_id` updates it, so a server-side re-bake
   * invalidates the cache on the first response that mentions the new bake
   * rather than on a timer. This matters more than it looks: a cached view keyed
   * without the bake would render new labels at old coordinates, which is the
   * most convincing kind of wrong a map can be.
   */
  private cacheEpoch = 'bake_unknown';

  private observeBakeId(data: unknown): void {
    if (data === null || typeof data !== 'object' || !('bake_id' in data)) return;
    const value = (data as { bake_id: unknown }).bake_id;
    if (typeof value !== 'string' || value === this.cacheEpoch) return;
    if (this.cacheEpoch !== 'bake_unknown') {
      // The world was re-baked underneath us. Everything held is stale geometry.
      this.cache.clear();
    }
    this.cacheEpoch = value;
  }
}

/* =============================================================================
 * 14. THE SINGLETON
 * ========================================================================== */

/**
 * The client every downstream module should import.
 *
 *   import { engine } from '@/engine';
 *   const view = await engine.getGraphView('island');
 *
 * Constructed at module load, which reads the env var once. Construct your own
 * `EngineClient` when you need a second configuration (a test, a worker, a
 * side-by-side comparison against a live engine).
 */
export const engine = new EngineClient();
