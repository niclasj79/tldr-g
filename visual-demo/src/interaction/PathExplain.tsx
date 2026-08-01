/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE PATH EXPLANATION VIEW
 * =============================================================================
 *
 * Pick two nodes; the engine walks the graph between them and the chain comes
 * back as typed hops. This is the screen the gold chain has to read cleanly on:
 *
 *     Rimsdal Group  —acquired→  Tollstrand Battery  —operates→  Bruntorp Facility
 *                       ^ episodic, 3 evidence passages, crosses a strait
 *
 * FOUR THINGS EVERY ROW STATES, BECAUSE A HOP WITHOUT THEM IS A CLAIM WITHOUT A
 * PROVENANCE:
 *   the relation FAMILY, in traversal orientation (the engine flips to the
 *     declared inverse when it walked the edge backwards, so every row reads
 *     left to right);
 *   the σ-CLASS, so you can see what KIND of claim carried the hop;
 *   the EVIDENCE COUNT — and if it is zero the row says the hop cannot be cited,
 *     in --alarm, rather than quietly showing a dash;
 *   whether it CROSSES A STRAIT, which is the only reason a two-island answer is
 *     possible at all.
 *
 * `GET /graph/path` returns `[]` when there is no route through ADMITTED
 * relations. That is a real result about the terrain and it is reported as one —
 * a path may well exist through claims the truth gate rejected, and those are
 * never traversed.
 *
 * When a chain comes back the terrain is driven to match it: the endpoints are
 * selected, the camera frames the whole chain, and the evidence light runs hop by
 * hop along it. Every one of those is depicting a state that actually exists.
 * ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { COPY, sigmaCopy } from '@/copy';
import { RUNG_GLYPH, byFamily, engine } from '@/engine';
import type { GraphNode, PathStep } from '@/engine';
import { getTerrain } from '@/graph';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Chip, Num, Panel } from '@/ui/primitives';

import { fuzzyBest } from '@/interaction/fuzzy';
import { stopMomentum } from '@/interaction/InteractionSurface';
import { buildSearchIndex, peekSearchIndex, type IndexItem } from '@/interaction/search-index';
import { readTuning } from '@/interaction/tuning';

import '@/interaction/interaction.css';

export interface PathExplainProps {
  className?: string;
}

/** Label cache. `getNode` is already cached by the client; this avoids the awaits. */
const labelCache = new Map<string, string>();

async function labelsFor(ids: readonly string[]): Promise<Map<string, string>> {
  const missing = ids.filter((id) => !labelCache.has(id));
  const fetched = await Promise.all(
    missing.map((id) => engine.getNode(id).catch((): GraphNode | null => null)),
  );
  fetched.forEach((node, i) => {
    labelCache.set(missing[i], node?.label ?? missing[i]);
  });
  const out = new Map<string, string>();
  for (const id of ids) out.set(id, labelCache.get(id) ?? id);
  return out;
}

export function PathExplain({ className }: PathExplainProps): JSX.Element {
  const { bakeId, selection } = useAtlasStore((s) => ({
    bakeId: s.bake?.bake_id ?? null,
    selection: s.selection,
  }));

  const [from, setFrom] = useState<IndexItem | null>(null);
  const [to, setTo] = useState<IndexItem | null>(null);
  const [steps, setSteps] = useState<PathStep[] | null>(null);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [running, setRunning] = useState(false);
  const [index, setIndex] = useState<IndexItem[]>(peekSearchIndex()?.items ?? []);

  useEffect(() => {
    if (bakeId === null) return;
    const controller = new AbortController();
    buildSearchIndex(bakeId, controller.signal)
      .then((ix) => setIndex(ix.items))
      .catch(() => {
        /* No index, no picker suggestions. The panel still works off the selection. */
      });
    return () => controller.abort();
  }, [bakeId]);

  const byId = useMemo(() => new Map(index.map((i) => [i.id, i])), [index]);

  /* The terrain IS the picker. Selecting two nodes on the map fills both ends,
     which is how most of these questions actually get asked. */
  useEffect(() => {
    if (selection.length < 2) return;
    const a = byId.get(selection[0]);
    const b = byId.get(selection[selection.length - 1]);
    if (a !== undefined) setFrom(a);
    if (b !== undefined && b.id !== a?.id) setTo(b);
  }, [selection, byId]);

  const run = useCallback(async () => {
    if (from === null || to === null) return;
    setRunning(true);
    try {
      const found = await engine.findPath(from.id, to.id);
      setSteps(found);
      const ids = new Set<string>([from.id, to.id]);
      for (const s of found) {
        ids.add(s.from_id);
        ids.add(s.to_id);
      }
      setLabels(await labelsFor([...ids]));
      if (found.length === 0) return;

      // Drive the terrain to match what the panel now claims.
      const store = useAtlas.getState();
      store.selectNode(found[0].from_id, false);
      for (const s of found) store.selectNode(s.to_id, true);

      const terrain = getTerrain();
      if (terrain === null) return;
      stopMomentum(); // leftover momentum cancels a flight frame by frame
      await terrain.camera.fitTo([...ids], 110);
      const tune = readTuning();
      for (const s of found) {
        // OLD LIGHT running the chain, hop by hop, in traversal order.
        await terrain.tracePing(s.from_id, s.to_id, tune.reducedMotion ? 0 : 60);
      }
    } catch {
      setSteps([]);
    } finally {
      setRunning(false);
    }
  }, [from, to]);

  const verdict = COPY.answer.explain.verdicts['no-admitted-route'];

  return (
    <Panel
      title={COPY.answer.path.title}
      className={className ? `ix-path ${className}` : 'ix-path'}
      scroll
      actions={
        <Btn
          variant="primary"
          size="sm"
          disabled={from === null || to === null || running}
          onClick={() => void run()}
          title={COPY.answer.explain.action.title}
        >
          {COPY.answer.explain.action.label}
        </Btn>
      }
    >
      <p className="ix-path__note" id="ix-path-note">
        {COPY.answer.path.note}
      </p>

      <div className="ix-path__ends">
        <NodePicker value={from} items={index} onPick={setFrom} />
        <span className="ix-path__arrow" aria-hidden="true">
          →
        </span>
        <NodePicker value={to} items={index} onPick={setTo} />
      </div>

      {steps === null ? null : steps.length === 0 ? (
        <div className="ix-path__verdict">
          <Chip tone="curiosity" active title={verdict.long}>
            {verdict.label}
          </Chip>
          <p className="ix-path__note">{verdict.short}</p>
        </div>
      ) : (
        <ol className="ix-path__hops">
          {steps.map((step) => (
            <Hop key={step.edge_id} step={step} labels={labels} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

/* -----------------------------------------------------------------------------
 * ONE HOP
 * -------------------------------------------------------------------------- */

function Hop({ step, labels }: { step: PathStep; labels: Map<string, string> }): JSX.Element {
  const family = byFamily[step.family];
  const sigma = sigmaCopy(step.sigma);
  const evidence = step.evidence_passage_ids.length;

  return (
    <li className="ix-hop">
      <span className="ix-hop__index">
        <span className="caps ink-faint">{COPY.answer.path.hop}</span>
        <Num value={step.index + 1} format="int" tone="dim" />
      </span>

      <span className="ix-hop__chain">
        <span className="ix-hop__node">{labels.get(step.from_id) ?? step.from_id}</span>
        <span className="ix-hop__rel" title={COPY.sigma.family.tip}>
          <span className="ink-faint">{COPY.answer.path.via}</span>
          <span className="ix-hop__family">{family.label}</span>
          <span className="ix-hop__arrow" aria-hidden="true">
            →
          </span>
        </span>
        <span className="ix-hop__node">{labels.get(step.to_id) ?? step.to_id}</span>
      </span>

      <span className="ix-hop__meta">
        <Chip tone="dim" title={sigma.short}>
          {sigma.label}
        </Chip>
        {evidence === 0 ? (
          <span className="ix-hop__noevidence" title={COPY.answer.path.noEvidence}>
            {COPY.answer.path.noEvidence}
          </span>
        ) : (
          <span className="ix-hop__evidence">
            <span className="caps ink-faint">{COPY.answer.path.evidence}</span>
            <Num value={evidence} format="int" tone="evidence" />
          </span>
        )}
        {step.crosses_strait ? (
          <Chip tone="curiosity" active title={COPY.answer.path.straitTip}>
            {COPY.answer.path.strait}
          </Chip>
        ) : null}
      </span>
    </li>
  );
}

/* -----------------------------------------------------------------------------
 * ONE ENDPOINT PICKER
 * -----------------------------------------------------------------------------
 * A search field over the same label index the command palette uses. It is
 * unlabelled on purpose: the deck has no `from` / `to` strings and this module
 * does not author prose, so the two ends are distinguished by order and by the
 * arrow between them. Reported as a copy gap rather than invented here.
 * -------------------------------------------------------------------------- */

function NodePicker({
  value,
  items,
  onPick,
}: {
  value: IndexItem | null;
  items: readonly IndexItem[];
  onPick: (item: IndexItem) => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const matches = useMemo(() => {
    const q = text.trim();
    if (q.length === 0) return [];
    const out: { item: IndexItem; score: number }[] = [];
    for (const item of items) {
      const m = fuzzyBest(q, item.haystacks);
      if (m === null) continue;
      out.push({ item, score: m.score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 8);
  }, [text, items]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  return (
    <div className="ix-picker" ref={boxRef}>
      <div className="ix-picker__field" title={value?.label}>
        <span className="ix-picker__glyph" aria-hidden="true">
          {value === null ? '·' : RUNG_GLYPH[value.addressAt]}
        </span>
        <input
          className="ix-picker__input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label={COPY.search.placeholder}
          aria-describedby="ix-path-note"
          placeholder={value?.label ?? COPY.inspector.emptyTitle}
          value={text}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
        />
      </div>
      {open && matches.length > 0 ? (
        <div className="ix-picker__list u-scroll">
          {matches.map(({ item }) => (
            <button
              key={item.id}
              type="button"
              className="ix-picker__row"
              onClick={() => {
                onPick(item);
                setText('');
                setOpen(false);
              }}
            >
              <span className="ix-picker__glyph" aria-hidden="true">
                {RUNG_GLYPH[item.addressAt]}
              </span>
              <span className="ix-picker__label">{item.label}</span>
              <span className="ink-faint">{COPY.rungs.kinds[item.kind]}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
