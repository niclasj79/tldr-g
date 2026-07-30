/**
 * =============================================================================
 * THE SPECIMEN SHEET
 * =============================================================================
 *
 * A separate Vite entry (`/styles-harness.html`) that renders every primitive in
 * every tone and every density, the five-state resolution ramp as DOM, the type
 * scale, and the three lights side by side.
 *
 * It exists so that the visual system is FALSIFIABLE. A component library you
 * can only see by driving the product into the right state is a component
 * library nobody checks.
 *
 * EVERY NUMBER ON THIS SHEET IS REAL. The token counts, the savings, the render
 * confidence, the payload hash and the Ed25519 signature are all read out of the
 * engine's own demo receipt at load time — `buildDemoRenderTrace()` /
 * `buildDemoRenderStats()`, the same functions the product calls — and the two
 * latency figures are measured on this machine, in this page, right now. A
 * specimen sheet full of lorem-ipsum digits would be exactly the interface lie
 * this product is built to refuse.
 *
 * The corpus behind those figures is synthetic, and the sheet says so in its
 * masthead, in the engine's own words.
 * =============================================================================
 */

import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  buildDemoRenderStats,
  buildDemoRenderTrace,
  verifyTrace,
  DEMO_GROUND_TRUTH,
  LOD_STATES,
  RELATION_FAMILIES,
  RUNGS,
  SIGMA_CLASSES,
  type DensityMode,
  type LodState,
  type SigmaClass,
} from '@/engine';
import { invalidateTokens, readTokens } from '@/styles/tokens';

import {
  Btn,
  Chip,
  Disclosure,
  Divider,
  Glyph,
  Hash,
  KeyHint,
  LodChip,
  Meter,
  Num,
  Panel,
  Row,
  ScrimOverlay,
  SectionLabel,
  Sparkline,
  StateDot,
  Tip,
  type Tone,
} from '@/ui/primitives';

import '@/styles/base.css';
import '@/styles/primitives.css';
import './harness.css';

/* ---------------------------------------------------------------------------
 * Real engine readings, taken once, timed.
 * ------------------------------------------------------------------------- */

const t0 = performance.now();
const TRACE = buildDemoRenderTrace();
const SIGN_MS = performance.now() - t0;

const t1 = performance.now();
const STATS = buildDemoRenderStats(TRACE);
const DERIVE_MS = performance.now() - t1;

const VERIFY = verifyTrace(TRACE);

/** counterfactual / rendered — the multiple the render budget actually bought. */
const RATIO = STATS.counterfactual_tokens / STATS.tokens_rendered;
/** Mean token cost of an admitted citation. Derived from the two figures above. */
const TOKENS_PER_CITATION = STATS.tokens_rendered / TRACE.citations.length;

const ADMITTED_COSTS = TRACE.admitted.map((a) => a.tokens);
/** The most expensive admission. The denominator the tone matrix reads against. */
const COST_MAX = Math.max(...ADMITTED_COSTS);

/**
 * Relation families per sigma-class, COUNTED from the vocabulary rather than
 * transcribed from its documentation. A chip that says `factual 34` because
 * somebody typed 34 is the same defect as a fake progress bar, just quieter.
 */
const FAMILIES_BY_SIGMA: Array<{ sigma: SigmaClass; count: number }> = SIGMA_CLASSES.map((s) => ({
  sigma: s,
  count: RELATION_FAMILIES.filter((f) => f.sigma === s).length,
}));

const TONES: Tone[] = [
  'neutral',
  'dim',
  'faint',
  'render',
  'evidence',
  'curiosity',
  'ok',
  'warn',
  'alarm',
];

const DENSITIES: DensityMode[] = ['comfortable', 'compact', 'touch'];

/* ---------------------------------------------------------------------------
 * Sections
 * ------------------------------------------------------------------------- */

function ThreeLights(): JSX.Element {
  const lights: Array<{ tone: Tone; name: string; job: string }> = [
    {
      tone: 'render',
      name: '--render',
      job: "the engine's ATTENTION. Selection, active edges, focus, the constellation. If the engine is not attending to it, it is not this colour.",
    },
    {
      tone: 'evidence',
      name: '--evidence',
      job: 'OLD LIGHT from the sources. Citations, provenance traces, receipts, signatures, hashes — authority that predates this session.',
    },
    {
      tone: 'curiosity',
      name: '--curiosity',
      job: 'the QUESTION light. Knowledge gaps, suggested questions, omitted-but-connected. The only light that points outward.',
    },
  ];

  return (
    <Panel title="the three lights">
      <div className="spec-stack" style={{ gap: 'var(--gap-section)' }}>
        {lights.map((l) => (
          <div key={l.name} className={`light tone-${l.tone}`}>
            <span className="light-bar" />
            <span className="light-name">{l.name}</span>
            <span className="light-job">{l.job}</span>
          </div>
        ))}
        <Divider />
        <div className="light tone-alarm">
          <span className="light-bar" />
          <span className="light-name">--alarm</span>
          <span className="light-job">
            FAIL-LOUD ONLY. Never decorative, never a hover state, never an accent. If this is on
            screen, something is actually wrong and the UI must name it and remedy it.
          </span>
        </div>
      </div>
    </Panel>
  );
}

function TypeScale(): JSX.Element {
  const scale: Array<{ px: number; cls: string; use: string }> = [
    { px: 28, cls: 't-28', use: 'the one hero figure per view' },
    { px: 20, cls: 't-20', use: 'section headers · tracking tightens here' },
    { px: 16, cls: 't-16', use: 'panel titles, the answer line' },
    { px: 14, cls: 't-14', use: 'body, panel content' },
    { px: 12.5, cls: 't-12-5', use: 'the workhorse: rows, readouts' },
    { px: 11, cls: 't-11', use: 'micro-labels, units, ticks' },
  ];
  return (
    <Panel title="type scale · Inter 400/500/650">
      <div className="spec-stack" style={{ gap: 'var(--gap-row)' }}>
        {scale.map((s) => (
          <div key={s.px} className="spec-stack">
            <div className="spec-wrap" style={{ alignItems: 'baseline' }}>
              <span className={`${s.cls} w-500`}>Shortest sufficient view</span>
              <Num value={s.px} format={Number.isInteger(s.px) ? 'int' : 'float1'} unit="px" tone="faint" />
            </div>
            <span className="spec-note">{s.use}</span>
          </div>
        ))}
        <Divider />
        <div className="spec-wrap">
          <span className="t-12-5 w-400 ink-dim">400 regular</span>
          <span className="t-12-5 w-500">500 medium</span>
          <span className="t-12-5 w-650">650 semibold</span>
        </div>
        <span className="spec-note">Three weights, no italics. Tracking tightens from 20px up.</span>

        <Divider />
        <SectionLabel>JetBrains Mono 400/500 · the numeric rail</SectionLabel>
        <div className="spec-stack">
          <span className="mono t-14 w-400 ink-dim">0123456789 · sha256 · did:web</span>
          <span className="mono t-14 w-500">0123456789 · 21 044 · 76.1 % · 4.18×</span>
        </div>
        <span className="spec-note">
          Tabular figures: every digit occupies one advance, so a column of readouts stays a column
          and an updating number never shoves the row it lives in.
        </span>
      </div>
    </Panel>
  );
}

function ResolutionRamp(): JSX.Element {
  const tokens = readTokens();
  const note: Record<LodState, string> = {
    'lod-0': 'verbatim · fovea',
    'lod-1': 'summary · penumbra',
    'lod-2': 'label · periphery',
    ghost: 'present, not spent on',
    latent: 'outline only — the terrain never has holes',
  };
  return (
    <Panel title="resolution ramp" glyph="passage" tone="render">
      <div className="spec-wrap" style={{ gap: 'var(--gap-section)' }}>
        {LOD_STATES.map((s) => (
          <LodChip key={s} state={s} />
        ))}
      </div>
      <Divider />
      <div>
        {LOD_STATES.map((s) => (
          <Row
            key={s}
            label={<span className="spec-key">{s}</span>}
            value={
              <span className="spec-wrap" style={{ justifyContent: 'flex-end' }}>
                <span className="spec-note">{note[s]}</span>
                <Num value={tokens.lod[s].opacity * 100} format="pct1" tone="dim" />
              </span>
            }
          />
        ))}
      </div>
      <span className="spec-note">
        Opacities read live from <span className="mono">--lod-*-opacity</span>. The lod-0 chip
        carries the only glow in the product: 6px, capped by the token, earned by being the fovea.
      </span>
    </Panel>
  );
}

function NumFormats(): JSX.Element {
  return (
    <Panel title="num · seven formats" tone="render">
      <div>
        <Row label={<span className="spec-key">int</span>} value={<Num value={TRACE.citations.length} format="int" unit="cit" />} />
        <Row label={<span className="spec-key">tokens</span>} value={<Num value={STATS.counterfactual_tokens} format="tokens" unit="tok" />} />
        <Row label={<span className="spec-key">ms</span>} value={<Num value={SIGN_MS} format="ms" />} />
        <Row label={<span className="spec-key">pct1</span>} value={<Num value={STATS.savings_pct} format="pct1" tone="render" />} />
        <Row label={<span className="spec-key">float1</span>} value={<Num value={TOKENS_PER_CITATION} format="float1" unit="tok/cit" />} />
        <Row label={<span className="spec-key">float2</span>} value={<Num value={STATS.render_confidence_L} format="float2" unit="L" />} />
        <Row label={<span className="spec-key">ratio</span>} value={<Num value={RATIO} format="ratio" tone="evidence" />} />
        <Row label={<span className="spec-key">non-finite</span>} value={<Num value={Number.NaN} format="float2" />} />
      </div>
      <span className="spec-note">
        Thousands are separated by a hairline gap, not a comma. A value the engine did not supply is
        an em dash — never a zero, never a placeholder that looks like a reading.
      </span>
    </Panel>
  );
}

function Receipt(): JSX.Element {
  const [run, setRun] = useState(0);
  return (
    <Panel
      title="render budget"
      glyph="asset"
      tone="render"
      actions={
        <Btn variant="ghost" size="sm" onClick={() => setRun((n) => n + 1)}>
          recount
        </Btn>
      }
    >
      <div className="spec-wrap" style={{ alignItems: 'baseline' }}>
        <Num
          key={run}
          className="t-28"
          value={STATS.tokens_rendered}
          countFrom={STATS.counterfactual_tokens}
          format="tokens"
          unit="tok"
          tone="render"
        />
        <span className="spec-note">rendered, down from the naive counterfactual</span>
      </div>

      <Meter value={STATS.tokens_rendered} max={STATS.token_budget} label="token budget" tone="render" />
      <Meter
        value={STATS.render_confidence_L}
        max={1}
        label="render confidence L"
        tone="render"
        readout={<Num value={STATS.render_confidence_L} format="float2" tone="dim" />}
      />

      <Divider />
      <SectionLabel>composite</SectionLabel>
      <Meter value={STATS.composite.semantic} max={1} label="semantic" tone="faint" />
      <Meter value={STATS.composite.topology} max={1} label="topology" tone="faint" />
      <Meter value={STATS.composite.temporal} max={1} label="temporal" tone="faint" />
      <Meter value={STATS.composite.authorial} max={1} label="authorial" tone="faint" />

      <Divider />
      <div>
        <Row label="counterfactual" value={<Num value={STATS.counterfactual_tokens} format="tokens" unit="tok" tone="dim" />} />
        <Row label="saved" value={<Num value={STATS.savings_pct} format="pct1" tone="render" />} />
        <Row label="lod-0 passages" value={<Num value={STATS.lod0_passages} format="int" tone="dim" />} />
        <Row label="lod-1 context nodes" value={<Num value={STATS.lod1_context_nodes} format="int" tone="dim" />} />
        <Row label="lod-2 pointer nodes" value={<Num value={STATS.lod2_pointer_nodes} format="int" tone="dim" />} />
        <Row
          label="cache"
          value={
            <span className="spec-wrap">
              <Num value={STATS.cache_hits} format="int" tone="dim" />
              <span className="spec-note">/</span>
              <Num value={STATS.cache_lookups} format="int" tone="faint" />
            </span>
          }
        />
      </div>

      <Divider />
      <div className="spec-wrap">
        <Sparkline points={ADMITTED_COSTS} tone="render" width={104} label="token cost per admitted node" />
        <span className="spec-note">token cost per admitted node, in admission order</span>
      </div>
    </Panel>
  );
}

function Provenance(): JSX.Element {
  return (
    <Panel title="provenance" glyph="continent" tone="evidence">
      <div className="spec-stack">
        <Hash value={TRACE.payload_hash} label="payload" />
        <Hash value={TRACE.signature.sig} label="sig" chars={16} />
      </div>
      <Divider />
      <div>
        <Row label="alg" value={TRACE.signature.alg} mono tone="evidence" />
        <Row label="did" value={TRACE.signature.did} mono tone="evidence" />
        <Row label="key" value={TRACE.signature.key_id.split('#')[1]} mono tone="evidence" />
        <Row label="citations" value={<Num value={TRACE.citations.length} format="int" tone="evidence" />} />
        <Row label="admitted" value={<Num value={TRACE.admitted.length} format="int" tone="evidence" />} />
        <Row
          label="omitted but connected"
          value={<Num value={TRACE.omitted_but_connected.length} format="int" tone="curiosity" />}
        />
      </div>
      <Divider />
      <div className="spec-stack">
        <StateDot state={VERIFY.payload_hash_matches ? 'on' : 'fail'} tone="ok" label="payload hash matches" />
        <StateDot state={VERIFY.signature_valid ? 'on' : 'fail'} tone="ok" label="signature valid" />
        <span className="spec-note mono">{VERIFY.verdict}</span>
      </div>
      <span className="spec-note">
        Click-to-copy; the full value is in the title. The scheme is set back so the budget is spent
        on digest characters, and truncation keeps the LEADING ones.
      </span>
    </Panel>
  );
}

function Controls(): JSX.Element {
  const [scrim, setScrim] = useState(false);
  return (
    <Panel title="controls">
      <SectionLabel>btn</SectionLabel>
      <div className="spec-wrap">
        <Btn variant="primary">run query</Btn>
        <Btn variant="quiet">explain path</Btn>
        <Btn variant="ghost">dismiss</Btn>
      </div>
      <div className="spec-wrap">
        <Btn variant="primary" size="sm">
          verify
        </Btn>
        <Btn variant="quiet" size="sm">
          save view
        </Btn>
        <Btn variant="ghost" size="sm" disabled>
          disabled
        </Btn>
        <Btn variant="primary" size="sm" tone="alarm">
          re-run the bake
        </Btn>
      </div>

      <Divider />
      <SectionLabel>chip</SectionLabel>
      <div className="spec-wrap">
        {FAMILIES_BY_SIGMA.map((f) => (
          <Chip
            key={f.sigma}
            active={f.sigma === 'factual' || f.sigma === 'causal'}
            tone={f.sigma === 'authorial' ? 'evidence' : f.sigma === 'structural' ? 'curiosity' : 'render'}
            count={f.count}
            onClick={() => undefined}
          >
            {f.sigma}
          </Chip>
        ))}
      </div>
      <span className="spec-note">Counts are read from the relation vocabulary at load time.</span>

      <Divider />
      <SectionLabel>keyhint</SectionLabel>
      <div className="spec-wrap">
        <KeyHint keys={['/']} />
        <KeyHint keys={['A']} />
        <KeyHint keys={['I']} />
        <KeyHint keys={['P']} />
        <KeyHint keys={['T']} />
        <KeyHint keys={['Esc']} />
        <KeyHint keys={['⇧', 'G']} />
      </div>

      <Divider />
      <SectionLabel>glyph · statedot · tip</SectionLabel>
      <div className="spec-wrap">
        {RUNGS.map((r) => (
          <span key={r} className="spec-wrap" style={{ gap: 'var(--gap-tight)' }}>
            <Glyph rung={r} />
            <span className="spec-note">{r}</span>
          </span>
        ))}
      </div>
      <div className="spec-wrap">
        <StateDot state="on" label="engine ready" />
        <StateDot state="pending" label="bake settling" />
        <StateDot state="off" label="llm-augmented off" />
        <StateDot state="fail" label="signature invalid" />
      </div>
      <div className="spec-wrap">
        <Tip content="A bridge entity is mentioned in assets on two different islands. The path through it is what crosses the strait.">
          <Chip tone="curiosity">bridge entity</Chip>
        </Tip>
        <Btn variant="quiet" size="sm" onClick={() => setScrim(true)}>
          scrim overlay
        </Btn>
      </div>

      <Divider />
      <SectionLabel>disclosure</SectionLabel>
      <Disclosure summary="why this edge was admitted" open>
        <span className="spec-prose">
          Two hops, both evidenced: <span className="mono">operates</span> (factual) then{' '}
          <span className="mono">acquired</span> (episodic). The second hop crosses a strait.
        </span>
      </Disclosure>
      <Disclosure summary="omitted but connected">
        <span className="spec-prose">
          Reached only through a quarantined edge. Present in the terrain as{' '}
          <span className="mono">latent</span> topology.
        </span>
      </Disclosure>

      {scrim ? (
        <ScrimOverlay onDismiss={() => setScrim(false)}>
          <Panel title="scrim overlay" glyph="island" tone="render">
            <span className="spec-prose" style={{ maxWidth: 'calc(var(--s-12) * 8)' }}>
              The ground is <span className="mono">--scrim</span>, a 70% void wash — never pure
              black. The terrain stays faintly visible underneath, because the user has not left the
              map; the map is being spoken over.
            </span>
            <div className="spec-wrap">
              <Btn variant="primary" onClick={() => setScrim(false)}>
                dismiss
              </Btn>
              <KeyHint keys={['Esc']} />
            </div>
          </Panel>
        </ScrimOverlay>
      ) : null}
    </Panel>
  );
}

function ToneMatrix(): JSX.Element {
  return (
    <Panel title="tone matrix">
      <div className="tone-matrix">
        {TONES.map((t, i) => (
          <ToneRow key={t} tone={t} value={ADMITTED_COSTS[i]} max={COST_MAX} />
        ))}
      </div>
      <span className="spec-note">
        Nine tones, one channel. The bars are the first nine admitted nodes&rsquo; token costs
        against the most expensive one — a specimen sheet does not get to invent numbers either.
      </span>
    </Panel>
  );
}

function ToneRow({ tone, value, max }: { tone: Tone; value: number; max: number }): JSX.Element {
  return (
    <>
      <span className="tone-name">{tone}</span>
      <Chip tone={tone} active>
        active
      </Chip>
      <Meter value={value} max={max} tone={tone} />
      <Num value={(value / max) * 100} format="pct1" tone={tone} />
    </>
  );
}

function Surfaces(): JSX.Element {
  return (
    <Panel title="surfaces · elevation · focus">
      <span className="spec-prose">
        Elevation is a 1px <span className="mono">--line</span> border plus{' '}
        <span className="mono">--edge-light</span>, inset on the top edge only. Nothing is above this
        UI, so nothing could cast a shadow.
      </span>
      <Panel title="nested glass" tone="evidence">
        <div>
          <Row label="panel-bg" value="rgb(surface / .72)" mono tone="dim" />
          <Row label="panel-blur" value="12px" mono tone="dim" />
        </div>
      </Panel>

      <Divider />
      <SectionLabel>focus ring</SectionLabel>
      <div className="spec-wrap">
        <span className="btn btn-quiet tone-render spec-focus">static specimen</span>
        <Btn variant="quiet">press Tab to compare</Btn>
      </div>
      <span className="spec-note">
        1px <span className="mono">--render</span>, 2px offset, on every focusable thing. It is
        never removed — the attention light is what keyboard focus means everywhere else too.
      </span>

      <Divider />
      <SectionLabel>scrollbars</SectionLabel>
      <span className="spec-note">
        6px thumb in <span className="mono">--line</span>, transparent track, no arrows. Panels
        scroll internally and the page never scrolls — see the scrolling-body specimen.
      </span>
    </Panel>
  );
}

function PanelVariants(): JSX.Element {
  return (
    <Panel title="panel variants">
      <div className="spec-panels">
        <Panel>
          <span className="spec-note">no header. A body on glass, nothing else.</span>
        </Panel>
        <Panel title="titled">
          <span className="spec-note">11px uppercase --ink-faint, hairline under.</span>
        </Panel>
        <Panel title="glyph + actions" glyph="island" tone="render" actions={<KeyHint keys={['I']} />}>
          <span className="spec-note">the rung glyph takes the panel tone.</span>
        </Panel>
        <Panel title="scrolling body" scroll className="spec-panel-scroll">
          {TRACE.citations.map((c) => (
            <Row
              key={c.citation_id}
              label={<span className="mono">{c.passage_id}</span>}
              value={<Num value={c.tokens} format="int" unit="tok" tone="evidence" />}
            />
          ))}
        </Panel>
      </div>
    </Panel>
  );
}

function RowSpecimen(): JSX.Element {
  return (
    <Panel title="row · section label · divider" glyph="asset" tone="evidence">
      <SectionLabel>trace header</SectionLabel>
      <div>
        <Row label="version" value={TRACE.version} mono tone="dim" />
        <Row label="trace id" value={TRACE.trace_id} mono tone="evidence" />
        <Row label="query id" value={TRACE.query_id} mono tone="evidence" />
        <Row label="model" value={TRACE.model} mono tone="dim" />
        <Row label="created" value={TRACE.created_at} mono tone="dim" />
      </div>
      <Divider />
      <SectionLabel>first citation</SectionLabel>
      <div>
        <Row label="passage" value={TRACE.citations[0].passage_id} mono tone="dim" />
        <Row label="resolution" value={TRACE.citations[0].resolution} mono tone="ok" />
        <Row label="seq" value={<Num value={TRACE.citations[0].seq} format="int" tone="dim" />} />
        <Row label="cost" value={<Num value={TRACE.citations[0].tokens} format="int" unit="tok" tone="evidence" />} />
        <Row label="why admitted" value={TRACE.citations[0].why_admitted} mono tone="render" />
      </div>
      <span className="spec-note">
        `mono` puts a machine STRING on the mono rail. A measured NUMBER does not take `mono` — it
        takes a &lt;Num&gt;, which brings tabular figures and a receding unit with it.
      </span>
    </Panel>
  );
}

function Timings(): JSX.Element {
  return (
    <Panel title="measured here, now" glyph="island" tone="evidence">
      <div>
        <Row label="build + sign trace" value={<Num value={SIGN_MS} format="ms" tone="evidence" />} />
        <Row label="derive render stats" value={<Num value={DERIVE_MS} format="ms" tone="evidence" />} />
        <Row label="admitted nodes" value={<Num value={TRACE.admitted.length} format="int" tone="dim" />} />
        <Row label="relation families used" value={<Num value={STATS.families_used.length} format="int" tone="dim" />} />
      </div>
      <Divider />
      <span className="spec-prose">{DEMO_GROUND_TRUTH.query}</span>
      <span className="spec-note">
        gold: <span className="mono">{DEMO_GROUND_TRUTH.gold}</span> · bridge entity:{' '}
        <span className="mono">{DEMO_GROUND_TRUTH.bridge_entity_label}</span>
      </span>
    </Panel>
  );
}

/* ---------------------------------------------------------------------------
 * The sheet
 * ------------------------------------------------------------------------- */

function Sheet(): JSX.Element {
  const [density, setDensity] = useState<DensityMode>('comfortable');

  useEffect(() => {
    document.documentElement.dataset.density = density;
    invalidateTokens();
  }, [density]);

  const set = useCallback((d: DensityMode) => setDensity(d), []);

  return (
    <div className="sheet">
      <header className="sheet-hd">
        <span className="sheet-mark">
          <Glyph rung="continent" tone="render" />
          <span className="sheet-name">TLDR-G VISUAL DEMO</span>
          <span className="sheet-sub">specimen sheet · ui primitives</span>
        </span>
        <span className="sheet-tagline">render, don&rsquo;t retrieve</span>
        <span className="sheet-hd-right">
          {DENSITIES.map((d) => (
            <Chip key={d} active={d === density} onClick={() => set(d)}>
              {d}
            </Chip>
          ))}
          <Divider vertical />
          <Chip tone="warn" active title="Every figure on this sheet comes from the synthetic demo corpus.">
            corpus_provenance: {TRACE.corpus_provenance}
          </Chip>
        </span>
      </header>

      {/* Columns are assigned by hand and balanced by eye. Twelve panels, four
          columns, nothing hidden off the edge of the viewport. */}
      <div className="sheet-field">
        <div className="sheet-col">
          <ThreeLights />
          <TypeScale />
          <ResolutionRamp />
        </div>
        <div className="sheet-col">
          <NumFormats />
          <Receipt />
          <Timings />
        </div>
        <div className="sheet-col">
          <Provenance />
          <Controls />
          <PanelVariants />
        </div>
        <div className="sheet-col">
          <ToneMatrix />
          <RowSpecimen />
          <Surfaces />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Boot + the scene hook the screenshot harness drives.
 * ------------------------------------------------------------------------- */

const el = document.getElementById('root');
if (el) createRoot(el).render(<StrictMode><Sheet /></StrictMode>);

interface HarnessHook {
  scenes: string[];
  scene: (n: string) => Promise<void>;
  settled: () => Promise<void>;
}

const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

(window as unknown as { __atlas?: HarnessHook }).__atlas = {
  // 'home' is the comfortable default; the other two drive the real density
  // switch on <html data-density>, which is the only thing density changes.
  scenes: ['home', 'compact', 'touch'],
  scene: async (n: string) => {
    const d: DensityMode = n === 'compact' ? 'compact' : n === 'touch' ? 'touch' : 'comfortable';
    const chip = Array.from(document.querySelectorAll<HTMLButtonElement>('.sheet-hd-right .chip')).find(
      (b) => b.textContent?.trim() === d,
    );
    chip?.click();
    await frame();
  },
  settled: frame,
};
