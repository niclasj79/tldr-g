/**
 * =============================================================================
 * THE TRUST HARNESS
 * =============================================================================
 *
 * `/trust-harness.html` — all five trust surfaces side by side, at rail width,
 * against the REAL engine.
 *
 * Nothing on this page is a fixture of a fixture. It calls `engine.postQuery()`
 * with the corpus's own staged bridge question, fetches the signed trace with
 * `engine.getRenderTrace()`, verifies it with the same `verifyTraceSync()` the
 * product calls, and reads `engine.getIntegrity()` for the truth gate's report
 * card. The tamper buttons call the real `tamper()`. The hashes are hashes.
 *
 * It exists because a trust panel is exactly the kind of component that looks
 * finished in code and turns out, on screen, to have a 12-character hash showing
 * five real characters, or a diff nobody can read, or a VALID badge that is
 * green before anything has been checked. Those are all findings from looking,
 * and none of them is visible from the file.
 *
 * -----------------------------------------------------------------------------
 * THE PING RECORDER IS LABELLED AS A RECORDER
 * -----------------------------------------------------------------------------
 * There is no terrain on this page, so `firePings` would honestly report that
 * nothing was drawn. To exercise the in-flight state anyway, the harness
 * installs a RECORDER through `setTracePing()`: it logs the two node ids and the
 * stagger, waits the real interval, and resolves. The masthead says it is a
 * recorder and prints what it recorded. It is a stand-in for a renderer and it
 * says so — which is the difference between a test double and a lie.
 *
 * The same page installs a MAP PROBE through `setMapProbe()`, for the same
 * reason and with one extra consequence: with an override in place the seam
 * never reaches for `@/graph` at all, so the trust harness still loads without a
 * WebGL context and without three.js. Tamper the trace here and the repudiation
 * layer really draws — over a stated stand-in frame, on the real node ids.
 * =============================================================================
 */

import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { COPY } from '@/copy';
import {
  engine,
  tamper,
  verifyTrace,
  DEMO_GROUND_TRUTH,
  type Citation,
  type GraphNode,
  type IntegrityResponse,
  type QueryRenderResponse,
  type RenderTraceV1,
  type TamperKind,
  type VerifyResult,
} from '@/engine';
import { readTokens } from '@/styles/tokens';
import { Btn, Num, Panel } from '@/ui/primitives';

import {
  CitationList,
  InspectorBody,
  Note,
  PassageDrilldown,
  ProvenanceChip,
  QuarantinePanel,
  ReceiptPanel,
  VerificationPanel,
  setMapProbe,
  setTracePing,
} from '@/ui/provenance';

import '@/styles/base.css';
import '@/styles/primitives.css';
import './harness.css';

/* =============================================================================
 * 1. THE PING RECORDER
 * ========================================================================== */

interface PingRecord {
  from_id: string;
  to_id: string;
  delay_ms: number;
}

const RECORDED: PingRecord[] = [];
let onRecord: (() => void) | null = null;

setTracePing(async (from_id, to_id, delayMs = 0) => {
  RECORDED.push({ from_id, to_id, delay_ms: delayMs });
  onRecord?.();
  const dwell = delayMs + readTokens().ms.ui;
  await new Promise<void>((resolve) => window.setTimeout(resolve, dwell));
});

/* -----------------------------------------------------------------------------
 * THE MAP PROBE STAND-IN
 * -----------------------------------------------------------------------------
 * A declared frame in the middle of the page and a linear projection into it.
 * It is not pretending to be the terrain: it exists so that "the repudiation
 * layer draws a mark for every node of the answer path, and none for a node it
 * has no position for" is something the DOM can be asked, rather than something
 * a screenshot has to be squinted at. `onFrame` never fires — nothing here
 * animates — so the layer's single initial projection is the whole behaviour.
 * -------------------------------------------------------------------------- */
setMapProbe({
  project(world) {
    if (world.length === 0) return null;
    const frame = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const xs = world.map((p) => p.x);
    const ys = world.map((p) => p.y);
    const spanX = Math.max(1e-6, Math.max(...xs) - Math.min(...xs));
    const spanY = Math.max(1e-6, Math.max(...ys) - Math.min(...ys));
    return {
      frame,
      points: world.map((p) => ({
        id: p.id,
        x: frame.width * (0.25 + (0.5 * (p.x - Math.min(...xs))) / spanX),
        y: frame.height * (0.75 - (0.5 * (p.y - Math.min(...ys))) / spanY),
      })),
    };
  },
  onFrame() {
    return () => undefined;
  },
});

/* =============================================================================
 * 2. REAL ENGINE OUTPUT, MEASURED
 * ========================================================================== */

interface Bundle {
  active: QueryRenderResponse;
  trace: RenderTraceV1;
  verify: VerifyResult;
  integrity: IntegrityResponse;
  entity: GraphNode;
  /** The one coref-resolved citation in the demo slice — the diff's whole point. */
  resolved: Citation | null;
  /** Wall clock for the whole load, measured here, on this machine, just now. */
  load_ms: number;
}

async function load(): Promise<Bundle> {
  const t0 = performance.now();
  await engine.warm();
  const active = await engine.postQuery(DEMO_GROUND_TRUTH.query);
  const trace = await engine.getRenderTrace(active.trace_id);
  const verify = engine.verifyTraceSync(trace);
  const integrity = await engine.getIntegrity();
  const entity = await engine.getNode(
    active.constellation.bridge_entity_id ?? trace.admitted[0].node_id,
  );
  const resolved = trace.citations.find((c) => c.resolution !== 'verbatim') ?? null;
  return { active, trace, verify, integrity, entity, resolved, load_ms: performance.now() - t0 };
}

/* =============================================================================
 * 3. THE SHEET
 * ========================================================================== */

type SceneName =
  | 'home'
  | 'receipt'
  | 'verify-valid'
  | 'verify-invalid'
  | 'tamper-signature'
  | 'tamper-did'
  | 'passage-drilldown'
  | 'quarantine'
  | 'citation-ping';

const SCENES: SceneName[] = [
  'home',
  'receipt',
  'verify-valid',
  'verify-invalid',
  'tamper-signature',
  'tamper-did',
  'passage-drilldown',
  'quarantine',
  'citation-ping',
];

function Sheet({ bundle }: { bundle: Bundle }): JSX.Element {
  const { active, integrity, entity, resolved } = bundle;

  /* The trace under inspection. `tamper()` returns a mutated COPY, so the
     pristine one is never lost and Restore is a real restore. */
  const [trace, setTrace] = useState<RenderTraceV1>(bundle.trace);
  const [verify, setVerify] = useState<VerifyResult | null>(bundle.verify);
  const [tampered, setTampered] = useState(false);
  const [stroking, setStroking] = useState(false);
  const [pings, setPings] = useState<PingRecord[]>([]);
  const [focus, setFocus] = useState<string>(
    resolved?.passage_id ?? bundle.trace.citations[0].passage_id,
  );

  useEffect(() => {
    onRecord = () => setPings([...RECORDED]);
    return () => {
      onRecord = null;
    };
  }, []);

  const doTamper = useCallback(
    (kind: TamperKind) => {
      const mutated = tamper(bundle.trace, kind);
      setTrace(mutated);
      setVerify(verifyTrace(mutated));
      setTampered(true);
    },
    [bundle.trace],
  );

  const doRestore = useCallback(() => {
    setTrace(bundle.trace);
    setVerify(verifyTrace(bundle.trace));
    setTampered(false);
  }, [bundle.trace]);

  /* ---- the scene hook, driving the real controls --------------------- */
  useEffect(() => {
    const host = window as unknown as {
      __atlas?: Record<string, unknown>;
    };
    const settle = (): Promise<void> =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    host.__atlas = {
      ...(host.__atlas ?? {}),
      scenes: SCENES,
      scene: async (name: SceneName): Promise<void> => {
        switch (name) {
          case 'verify-invalid':
            doTamper('payload');
            break;
          case 'tamper-signature':
            doTamper('signature');
            break;
          case 'tamper-did':
            doTamper('did');
            break;
          case 'citation-ping':
            doRestore();
            break;
          default:
            doRestore();
            break;
        }
        await settle();
        await settle();
      },
      settled: settle,
    };
  }, [doTamper, doRestore]);

  const citation = trace.citations.find((c) => c.passage_id === focus) ?? trace.citations[0];

  return (
    <div className="th">
      {/* ---- masthead ------------------------------------------------- */}
      <header className="th-hd">
        <span className="th-title">{COPY.product.name}</span>
        <ProvenanceChip />
        <span className="th-meta">
          <span className="th-k">load</span>
          <Num value={bundle.load_ms} format="ms" tone="dim" />
        </span>
        <span className="th-meta">
          <span className="th-k">{COPY.receipt.header.latency.label}</span>
          <Num value={active.latency_ms} format="ms" tone="dim" />
        </span>
        <span className="th-meta">
          <span className="th-k">ping recorder</span>
          <Num value={pings.length} format="int" tone="evidence" />
        </span>
        <span className="th-note">
          Stand-in for the renderer: `setTracePing` records the two node ids and the stagger, waits
          the real interval, and resolves. No terrain is attached to this page.
        </span>
        {pings.length === 0 ? null : (
          <span className="th-pings">
            {pings.slice(-4).map((p, i) => (
              <span className="th-ping" key={`${p.from_id}-${p.to_id}-${i}`}>
                {p.from_id} → {p.to_id}
                <Num value={p.delay_ms} format="ms" tone="faint" />
              </span>
            ))}
          </span>
        )}
      </header>

      {/* ---- five columns, at rail width ------------------------------ */}
      <div className="th-cols">
        <ReceiptPanel
          trace={trace}
          stats={active.render_stats}
          active={active}
          verify={verify}
          onOpenPassage={setFocus}
        />

        <VerificationPanel
          trace={trace}
          verify={verify}
          tampered={tampered}
          onVerify={() => setVerify(verifyTrace(trace))}
          onTamper={doTamper}
          onRestore={doRestore}
        />

        <QuarantinePanel
          integrity={integrity}
          showQuarantined={stroking}
          onToggleQuarantined={() => setStroking((v) => !v)}
          onShowExamples={() => 0}
        />

        <div className="th-col">
          <Panel title={COPY.inspector.title} tone="render" scroll>
            <InspectorBody node={entity} lod="lod-1" />
          </Panel>
          <Panel title={COPY.receipt.citations.title} tone="evidence" scroll>
            <CitationList
              citations={trace.citations.slice(0, 2)}
              path={active.constellation.path}
              bridgeEntityId={active.constellation.bridge_entity_id}
              onOpenPassage={setFocus}
            />
          </Panel>
        </div>

        <Panel
          title={COPY.rungs.levels.passage.label}
          tone="evidence"
          scroll
          actions={
            <>
              {/* One button per citation, numbered by POSITION in the receipt.
                  They were numbered by `seq` and two citations legitimately
                  share a seq — a picker with two buttons labelled `2` is a
                  picker you have to guess at. */}
              {trace.citations.map((c, i) => (
                <Btn
                  key={c.citation_id}
                  variant={c.passage_id === focus ? 'primary' : 'ghost'}
                  size="sm"
                  tone={c.resolution === 'verbatim' ? 'evidence' : 'render'}
                  onClick={() => setFocus(c.passage_id)}
                  title={`${c.passage_id} · ${c.resolution}`}
                >
                  <Num value={i + 1} format="int" tone="dim" />
                </Btn>
              ))}
            </>
          }
        >
          <Note>{COPY.trust.disclosure.note}</Note>
          <PassageDrilldown passageId={focus} citation={citation ?? null} />
        </Panel>
      </div>
    </div>
  );
}

/* =============================================================================
 * 4. BOOT
 * ========================================================================== */

function Root(): JSX.Element {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void load()
      .then((b) => {
        if (live) setBundle(b);
      })
      .catch((e: unknown) => {
        if (live) setFailed(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  if (failed !== null) {
    return (
      <div className="th th-fail">
        <span className="th-title">{COPY.degraded.banner}</span>
        <span className="th-note">{failed}</span>
      </div>
    );
  }
  if (bundle === null) {
    return (
      <div className="th">
        <span className="th-note">{COPY.common.notLoaded}</span>
      </div>
    );
  }
  return <Sheet bundle={bundle} />;
}

const host = document.getElementById('harness');
if (host !== null) {
  createRoot(host).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
