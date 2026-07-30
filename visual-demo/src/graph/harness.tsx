/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — GRAPH HARNESS (development entry, not shipped in the app)
 * =============================================================================
 *
 * VERIFY BY LOOKING, NOT BY REASONING.
 *
 * This is its own Vite entry (`graph-harness.html`). It does not touch
 * `src/main.tsx` or `src/App.tsx` and it imports nothing from any other agent's
 * module, so the renderer can be driven into every state and photographed long
 * before there is a shell to put it in.
 *
 * It drives the REAL engine through the REAL client. There is no mock payload
 * anywhere in this file: the views come from `engine.getGraphView`, the
 * positions from `engine.getLayoutBake`, the constellation from a staged query's
 * by-construction gold node and edge ids.
 *
 * THE ONE SYNTHETIC THING, AND IT IS LABELLED: the 100k stress toggle. It
 * replicates the real bake's positions with deterministic sub-radius jitter to
 * reach 100,000 instances. That is a RENDERER stress test — same spatial
 * distribution, 16x the nodes — and not a claim that the corpus has 100k nodes.
 * The readout says so on screen while it is on.
 * ========================================================================== */

import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/jetbrains-mono/400.css';
import '@/styles/design-tokens.css';
import './harness.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { TerrainCanvas } from '@/graph/TerrainCanvas';
import type { FrameStats, Terrain } from '@/graph/terrain';
import { engine, fnv1a32 } from '@/engine';
import type {
  DrawnReason,
  GraphViewResponse,
  LayoutBake,
  NodePosition,
  PathStep,
  Rung,
  StagedQuery,
} from '@/engine';

/* =============================================================================
 * THE MONO PRIMITIVE
 * -----------------------------------------------------------------------------
 * Every number that MEASURES is monospaced, including in a dev rig. The rule is
 * mechanical: if it came out of the engine or the renderer, it is mono.
 * ========================================================================== */
function Mono(props: { value: number | string; digits?: number; unit?: string; warn?: boolean }): JSX.Element {
  const text =
    typeof props.value === 'number'
      ? props.value.toFixed(props.digits ?? 0)
      : props.value;
  return (
    <span className={props.warn ? 'hx__mono hx__mono--warn' : 'hx__mono'}>
      {text}
      {props.unit ? <span className="hx__note"> {props.unit}</span> : null}
    </span>
  );
}

/* =============================================================================
 * THE 100K STRESS CLOUD
 * ========================================================================== */

/**
 * Replicate a bake up to `target` positions.
 *
 * Deterministic (FNV-seeded), sub-radius, and it never touches the region or
 * spine kinds — replicating a continent would produce sixteen overlapping
 * landmasses, which would flatter the fill-rate numbers rather than stress them.
 */
function stressBake(bake: LayoutBake, target: number): LayoutBake {
  const source = bake.positions;
  if (source.length >= target) return bake;
  const leaves = source.filter((p) => p.kind === 'passage' || p.kind === 'asset' || p.kind === 'entity');
  if (leaves.length === 0) return bake;

  const out: NodePosition[] = source.slice();
  let k = 0;
  while (out.length < target) {
    const src = leaves[k % leaves.length];
    const h = fnv1a32(`stress|${k}|${src.id}`);
    const ang = ((h & 0xffff) / 0x10000) * Math.PI * 2;
    const rad = (((h >>> 16) & 0xffff) / 0x10000) * src.r * 5.5;
    out.push({
      ...src,
      id: `stress:${k}`,
      x: src.x + Math.cos(ang) * rad,
      y: src.y + Math.sin(ang) * rad,
    });
    k++;
  }
  return { ...bake, bake_id: `${bake.bake_id}+stress${target}`, positions: out };
}

/* =============================================================================
 * THE HARNESS
 * ========================================================================== */

type SceneName =
  | 'home'
  | 'atlas-continent'
  | 'atlas-island'
  | 'atlas-asset'
  | 'atlas-passage'
  | 'constellation'
  | 'query-render'
  | 'quarantine'
  | 'hover'
  | 'settling'
  | 'trace'
  | 'stress';

const SCENES: SceneName[] = [
  'home',
  'atlas-continent',
  'atlas-island',
  'atlas-asset',
  'atlas-passage',
  'constellation',
  'query-render',
  'quarantine',
  'hover',
  'settling',
  'trace',
  'stress',
];

function raf(): Promise<number> {
  return new Promise((r) => requestAnimationFrame(r));
}

function Harness(): JSX.Element {
  const terrainRef = useRef<Terrain | null>(null);
  const [bake, setBake] = useState<LayoutBake | null>(null);
  const [realBake, setRealBake] = useState<LayoutBake | null>(null);
  const [view, setView] = useState<GraphViewResponse | null>(null);
  const [rung, setRung] = useState<Rung>('island');
  const [parentId, setParentId] = useState<string | null>(null);
  const [policy, setPolicy] = useState<DrawnReason | null>(null);
  const [dimmed, setDimmed] = useState(false);
  const [stress, setStress] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [constellation, setConstellation] = useState<{
    node_ids: string[];
    path: PathStep[];
    bridge_entity_id: string | null;
  } | null>(null);
  const [stats, setStats] = useState<FrameStats>({
    fps: 0,
    frameMs: 0,
    points: 0,
    edges: 0,
    drawCalls: 0,
    labels: 0,
  });
  const [staged, setStaged] = useState<StagedQuery[]>([]);
  /* The scene hook is installed ONCE and reads live state through refs.
   * Closing over `staged` instead meant the hook captured the empty array from
   * the first render, and the constellation scene silently drew nothing while
   * reporting success — the exact class of failure the scene hook exists to
   * catch, hiding inside the scene hook. */
  const stagedRef = useRef<StagedQuery[]>([]);
  stagedRef.current = staged;
  /* The corpus takes ~900ms to build. Without this gate a scene driven before
   * boot finishes wins the race and is then silently overwritten by the boot's
   * own first view — the screenshot shows one rung while the controls claim
   * another. A scene hook that can report a state it is not in is worse than no
   * scene hook at all. */
  const bootedRef = useRef(false);
  const [buildMs, setBuildMs] = useState(0);
  const [busy, setBusy] = useState(true);

  /* ---- boot -------------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const t0 = performance.now();
      await engine.warm();
      const [b, v, q] = await Promise.all([
        engine.getLayoutBake(),
        engine.getGraphView('island', null, { maxBundles: 256 }),
        engine.getStagedQueries(),
      ]);
      if (cancelled) return;
      setBuildMs(performance.now() - t0);
      setRealBake(b);
      setBake(b);
      setView(v);
      setStaged(q);
      setBusy(false);
      bootedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---- view loader ------------------------------------------------------- */
  const load = useCallback(
    async (nextRung: Rung, nextParent: string | null, drawn?: DrawnReason, hoverId?: string) => {
      setBusy(true);
      const v = await engine.getGraphView(nextRung, nextParent, {
        drawnReason: drawn,
        hoverNodeId: hoverId,
        maxBundles: 256,
        maxEdges: 512,
      });
      setRung(nextRung);
      setParentId(nextParent);
      setView(v);
      setBusy(false);
      return v;
    },
    [],
  );

  /* ---- first child of a rung, so descent works without a shell ----------- */
  const firstChild = useCallback(
    async (parentRung: Rung, childRung: Rung, parent: string | null): Promise<string | null> => {
      const v = await engine.getGraphView(parentRung, parent, { maxBundles: 8, maxEdges: 8 });
      const candidates = v.nodes.filter((n) => n.kind === parentRung);
      candidates.sort((a, b) => b.centrality - a.centrality);
      const pick = candidates[0];
      if (!pick) return null;
      void childRung;
      return pick.id;
    },
    [],
  );

  /* ---- stress ------------------------------------------------------------ */
  useEffect(() => {
    if (realBake === null) return;
    const next = stress > 0 ? stressBake(realBake, stress) : realBake;
    (window as unknown as Record<string, unknown>).__hxBounds = next.bounds;
    setBake(next);
  }, [stress, realBake]);

  /* ---- frame stats ------------------------------------------------------- */
  const onReady = useCallback((t: Terrain | null) => {
    terrainRef.current = t;
    // Exposed so the frame-budget probe measures the renderer's OWN stats
    // during a real camera flight, rather than timing it from outside.
    (window as unknown as Record<string, unknown>).__hxTerrain = t;
    if (t === null) return;
    t.onFrame((s) => setStats({ ...s }));
  }, []);

  /* ---- the scene hook ---------------------------------------------------- */
  useEffect(() => {
    const settled = async (): Promise<void> => {
      for (let i = 0; i < 240; i++) {
        await raf();
        const t = terrainRef.current;
        if (t && t.camera.idle()) {
          await raf();
          await raf();
          if (t.camera.idle()) return;
        }
      }
    };

    const scene = async (name: string): Promise<void> => {
      for (let i = 0; i < 600 && !bootedRef.current; i++) await raf();
      const t = terrainRef.current;
      setDimmed(false);
      setSelection([]);
      setHover(null);
      setConstellation(null);
      setPolicy(null);
      switch (name as SceneName) {
        case 'home':
        case 'atlas-island':
          setStress(0);
          await load('island', null);
          break;
        case 'atlas-continent':
          setStress(0);
          await load('continent', null);
          break;
        case 'atlas-asset': {
          setStress(0);
          const island = await firstChild('island', 'asset', null);
          await load('asset', island);
          break;
        }
        case 'atlas-passage': {
          setStress(0);
          const island = await firstChild('island', 'asset', null);
          const asset = island === null ? null : await firstChild('asset', 'passage', island);
          await load('passage', asset);
          break;
        }
        case 'constellation':
        case 'query-render': {
          setStress(0);
          const v = await load('island', null);
          const q = stagedRef.current[0];
          if (q) {
            // The REAL query path, not a reconstruction of it: whatever the
            // engine actually rendered is what the terrain must light up, or
            // the constellation and the receipt would disagree on screen.
            const answer = await engine.postQuery(q.query);
            setConstellation(answer.constellation);
            setSelection(
              answer.constellation.bridge_entity_id ? [answer.constellation.bridge_entity_id] : [],
            );
          }
          if (name === 'query-render') setDimmed(true);
          void v;
          break;
        }
        case 'quarantine': {
          setStress(0);
          const island = await firstChild('island', 'asset', null);
          await load('asset', island);
          break;
        }
        case 'hover': {
          setStress(0);
          const v = await load('island', null);
          const target = [...v.nodes].sort((a, b) => b.centrality - a.centrality)[0];
          if (target) {
            await load('island', null, 'hover-neighborhood', target.id);
            setHover(target.id);
          }
          break;
        }
        case 'settling': {
          // INGESTING / SETTLING: topology resolving out of `latent` in arrival
          // order. Nothing moves — position is baked — so what is animated is
          // resolution, which is the only thing ingestion actually changes.
          setStress(0);
          const v = await load('island', null);
          await t?.settleIngest(v.nodes.map((n) => n.id));
          break;
        }
        case 'trace': {
          // A provenance trace along the REAL answer path, hop by hop.
          setStress(0);
          await load('island', null);
          const q = stagedRef.current[0];
          if (q && t) {
            const answer = await engine.postQuery(q.query);
            setConstellation(answer.constellation);
            for (const step of answer.constellation.path) {
              await t.tracePing(step.from_id, step.to_id);
            }
          }
          break;
        }
        case 'stress':
          await load('island', null);
          setStress(100_000);
          break;
        default:
          break;
      }
      await settled();
    };

    window.__atlas = {
      scenes: SCENES,
      scene,
      settled,
      perf: () => terrainRef.current?.perf(),
    };
  }, [load, firstChild]);

  /* ---- pointer ----------------------------------------------------------- */
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const t = terrainRef.current;
    if (t === null) return;
    setHover(t.pick(e.clientX, e.clientY));
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const t = terrainRef.current;
    if (t === null) return;
    const id = t.pick(e.clientX, e.clientY);
    setSelection(id === null ? [] : [id]);
  }, []);

  /* ---- a real, measurable pan for the frame-budget number ----------------- */
  const benchmark = useCallback(async () => {
    const t = terrainRef.current;
    if (t === null || bake === null) return;
    const b = bake.bounds;
    const cx = (b.min_x + b.max_x) / 2;
    const cy = (b.min_y + b.max_y) / 2;
    const span = Math.max(b.max_x - b.min_x, b.max_y - b.min_y);
    const z = t.camera.get().zoom;
    await t.camera.moveTo(cx - span * 0.2, cy + span * 0.12, z * 2.4, 2400, 'camera');
    await t.camera.moveTo(cx, cy, z, 2400, 'camera');
  }, [bake]);

  const nodeCount = bake?.positions.length ?? 0;
  const edgeStats = view?.stats;

  const scenesList = useMemo(() => SCENES, []);

  return (
    <div className="hx">
      <div className="hx__terrain" onPointerMove={onPointerMove} onPointerDown={onPointerDown}>
        <TerrainCanvas
          onReady={onReady}
          view={view}
          bake={bake}
          rung={rung}
          parentId={parentId}
          hover={hover}
          selection={selection}
          constellation={constellation}
          edgePolicy={policy}
          dimmed={dimmed}
        />
      </div>

      <div className="hx__panel">
        <div className="hx__title">terrain harness</div>

        <div className="hx__group">
          {(['continent', 'island', 'asset', 'passage'] as Rung[]).map((r) => (
            <button
              key={r}
              className="hx__btn"
              data-on={rung === r ? '1' : '0'}
              onClick={() => {
                void (async () => {
                  if (r === 'continent' || r === 'island') await load(r, null);
                  else if (r === 'asset') await load('asset', await firstChild('island', 'asset', null));
                  else {
                    const island = await firstChild('island', 'asset', null);
                    await load('passage', island === null ? null : await firstChild('asset', 'passage', island));
                  }
                })();
              }}
            >
              {r}
            </button>
          ))}
        </div>

        <div className="hx__group">
          {(['trade-route-skeleton', 'hover-neighborhood', 'query-constellation'] as DrawnReason[]).map((p) => (
            <button
              key={p}
              className="hx__btn"
              data-on={policy === p ? '1' : '0'}
              onClick={() => setPolicy(policy === p ? null : p)}
            >
              {p.split('-')[0]}
            </button>
          ))}
        </div>

        <div className="hx__group">
          <button className="hx__btn" data-on={dimmed ? '1' : '0'} onClick={() => setDimmed(!dimmed)}>
            dim
          </button>
          <button
            className="hx__btn"
            data-on={constellation ? '1' : '0'}
            onClick={() => {
              void window.__atlas?.scene(constellation ? 'home' : 'constellation');
            }}
          >
            constellation
          </button>
          <button
            className="hx__btn"
            data-on={stress > 0 ? '1' : '0'}
            onClick={() => setStress(stress > 0 ? 0 : 100_000)}
          >
            100k
          </button>
          <button className="hx__btn" onClick={() => void benchmark()}>
            bench
          </button>
        </div>

        <div className="hx__divider" />

        <div className="hx__row">
          <span>fps</span>
          <Mono value={stats.fps} digits={1} />
        </div>
        <div className="hx__row">
          <span>frame</span>
          <Mono value={stats.frameMs} digits={2} unit="ms" />
        </div>
        <div className="hx__row">
          <span>points</span>
          <Mono value={stats.points} warn={stress > 0} />
        </div>
        <div className="hx__row">
          <span>edge instances</span>
          <Mono value={stats.edges} />
        </div>
        <div className="hx__row">
          <span>draw calls</span>
          <Mono value={stats.drawCalls} />
        </div>
        <div className="hx__row">
          <span>labels</span>
          <Mono value={stats.labels} />
        </div>

        <div className="hx__divider" />

        <div className="hx__row">
          <span>bake nodes</span>
          <Mono value={nodeCount} />
        </div>
        <div className="hx__row">
          <span>edges drawn</span>
          <Mono value={`${edgeStats?.edges_drawn ?? 0} / ${edgeStats?.edge_count ?? 0}`} />
        </div>
        <div className="hx__row">
          <span>corpus + bake</span>
          <Mono value={buildMs} digits={0} unit="ms" />
        </div>

        <div className="hx__note">
          drawn_reason: {edgeStats?.drawn_reason ?? '—'}
          <br />
          corpus_provenance: {view?.corpus_provenance ?? '—'}
          {stress > 0 ? (
            <>
              <br />
              STRESS ON — positions replicated from the real bake to {stress.toLocaleString('en-US')} instances.
              Not a 100k corpus.
            </>
          ) : null}
          {busy ? (
            <>
              <br />
              loading…
            </>
          ) : null}
          <br />
          scenes: {scenesList.length}
        </div>
      </div>
    </div>
  );
}

declare global {
  interface Window {
    __atlas?: {
      scene: (n: string) => Promise<void> | void;
      settled?: () => Promise<void> | void;
      scenes?: string[];
      perf?: () => unknown;
      audit?: () => unknown;
    };
  }
}

const el = document.getElementById('harness');
if (el) createRoot(el).render(<Harness />);
