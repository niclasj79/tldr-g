/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — COMMAND SEARCH
 * =============================================================================
 *
 * `/` is the entry point into a large graph. Thirty-three islands are legible;
 * the bake's 4,406 positions are not, and no amount of panning finds a name you
 * already know. The index this surface builds over them holds 3,885 searchable
 * things — the footer prints that count, and it is the figure any prose about
 * "what search covers" has to use, because it is the one the reader can see.
 *
 * FOUR GROUPS, IN THIS ORDER, AND THE ORDER IS THE ARGUMENT:
 *
 *   Staged questions   the things this corpus can actually answer, with the
 *                      by-construction answer behind them. Offered FIRST because
 *                      the product's thesis is a rendered answer, not a lookup.
 *   On the map         every label and alias in the bake. Selecting one changes
 *                      the rung if it has to, selects the node, and FLIES the
 *                      camera to it — the map moves, the user is not teleported.
 *   Commands           the keyboard map, as a list. Same table the help overlay
 *                      reads, dispatched through the same `handleKey`, so a row
 *                      here can never do something the glyph beside it does not.
 *   Rungs              the four altitudes.
 *
 * IT NEVER RANKS BY ANYTHING BUT THE QUERY. No popularity, no history, no
 * learned weighting: the same keystrokes always produce the same list.
 *
 * -----------------------------------------------------------------------------
 * IT USED TO HAVE ONE DOOR, AND THE DOOR WAS A KEYSTROKE
 * -----------------------------------------------------------------------------
 * Everything above was true and almost nobody reached it. The only production
 * affordance that opened this surface was `/`, plus one accident — Enter on an
 * empty command bar. There was no visible reference to it anywhere in the
 * mounted tree: scanning every `button` and `[role=button]` for text matching
 * /search/ returned nothing. (An earlier note here blamed a `<KeyHint>` chip in
 * `StagedPanel` for being the only mention. `StagedPanel` is mounted by nothing
 * — `InspectorRail` mounts `StagedQuestions`, which has no search reference at
 * all — so the real state was one step worse than the one that was written down.)
 *
 * `openCommandSearch()` below is the fix's other end. The composer carries a real
 * labelled control and an inline suggestion listbox (see `CommandBar.tsx` for why
 * the focus behaviour is a combobox and NOT this dialog — a modal that opens on
 * focus takes the caret away from the user who just clicked into the field), and
 * the RESULT header carries the same control once the composer is gone, because
 * the composer is only mounted before a render or while editing one. Every route
 * comes through this one function, and it carries the text the user had already
 * typed rather than making them type it twice.
 *
 * -----------------------------------------------------------------------------
 * THE QUESTION ROWS SAY `Verified sample answer`, NOT `By construction`
 * -----------------------------------------------------------------------------
 * This is a FIRST-USE SURFACE: for a reader who found the palette from the
 * composer it is the first list of anything they have seen, and `By construction`
 * is four words that have to be decoded before the row can be read. The plain
 * half of `COPY.vocabulary.byConstruction` leads and the technical term is one
 * hover away in `dual()`. The receipt and the answer's gold row are expert
 * surfaces and keep the technical term unchanged.
 * ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { COPY, dual, plain, rungCopy } from '@/copy';
import { RUNGS, RUNG_GLYPH } from '@/engine';
import type { Rung, StagedQuery } from '@/engine';
import { KEYMAP, useAtlas, useAtlasStore, type KeyBinding } from '@/state';
import { Chip, Glyph, KeyHint, Num, ScrimOverlay, SectionLabel } from '@/ui/primitives';

import { fuzzyBest, markRuns } from '@/interaction/fuzzy';
import { buildSearchIndex, peekSearchIndex, type IndexItem, type SearchIndex } from '@/interaction/search-index';
import { readTuning } from '@/interaction/tuning';
import { getTerrain } from '@/graph';
import { stopMomentum } from '@/interaction/InteractionSurface';

import '@/interaction/interaction.css';
import '@/interaction/search.css';

type Row =
  | { group: 'questions'; key: string; query: StagedQuery; score: number }
  | { group: 'nodes'; key: string; item: IndexItem; hits: number[]; score: number }
  | { group: 'commands'; key: string; binding: KeyBinding; score: number }
  | { group: 'rungs'; key: string; rung: Rung; score: number };

const GROUP_ORDER = ['questions', 'nodes', 'commands', 'rungs'] as const;

/** Wait for React to flush its effects — the terrain's own auto-frame runs there. */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/* -----------------------------------------------------------------------------
 * THE DOOR
 * -----------------------------------------------------------------------------
 * `ui.search` is a boolean in the store and `toggle()` flips it, which is the
 * right shape for a keyboard binding and the wrong one for a button: a control
 * labelled "Search" that CLOSES search when the surface is already open is a
 * control that lies about what it does. So this opens, and only opens.
 *
 * The seed is a one-shot handoff and it is module state rather than store state
 * on purpose — carried text is a property of one open, not of the application,
 * and putting it in the store would mean a field that has to be cleared by
 * whoever remembers to. It is read and cleared by the open effect below, so a
 * later `/` cannot inherit text somebody typed into the composer ten minutes
 * ago.
 * -------------------------------------------------------------------------- */
let pendingSeed = '';

/** Open command search, carrying `seed` into its field. Never closes it. */
export function openCommandSearch(seed = ''): void {
  const store = useAtlas.getState();
  // The seed is only armed when an open will actually follow. Setting it on a
  // call that opens nothing would leave it loaded for whoever opened next —
  // text typed into the composer arriving in a palette somebody reached with
  // `/` minutes later.
  if (store.ui.search) return;
  pendingSeed = seed;
  store.toggle('search');
}

export function CommandPalette(): JSX.Element | null {
  const { open, bakeId, staged } = useAtlasStore((s) => ({
    open: s.ui.search,
    bakeId: s.bake?.bake_id ?? null,
    staged: s.stagedQueries,
  }));

  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [index, setIndex] = useState<SearchIndex | null>(peekSearchIndex());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  /* The index is built on the FIRST open and never on boot: the passage rung is
     2,207 nodes carrying their full text, and most sessions never search. */
  useEffect(() => {
    if (!open || bakeId === null) return;
    if (index !== null && index.bake_id === bakeId) return;
    const controller = new AbortController();
    buildSearchIndex(bakeId, controller.signal)
      .then(setIndex)
      .catch(() => {
        /* An index that could not be built leaves the node group absent, which is
           the truth. It does not become an empty group pretending to have looked. */
      });
    return () => controller.abort();
  }, [open, bakeId, index]);

  useEffect(() => {
    if (!open) return;
    // The seed is consumed here and cleared, so it can never leak into a later
    // open. An unseeded open is the empty string, which is what it always was.
    setText(pendingSeed);
    pendingSeed = '';
    setActive(0);
    // Focus after the portal has mounted, or the caret lands nowhere.
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el === null) return;
      el.focus();
      // Caret at the end of the carried text, not selecting it: the user is
      // continuing a query they started in the composer, not replacing it.
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    const q = text.trim();
    const cap = Math.max(1, Math.floor(readTuning().searchMax));
    const out: Row[] = [];

    for (const query of staged) {
      const m = q.length === 0 ? { score: 0, indices: [] } : fuzzyBest(q, [query.query, query.gold, query.why]);
      if (m === null) continue;
      out.push({ group: 'questions', key: query.id, query, score: m.score });
    }

    if (q.length > 0 && index !== null) {
      const hits: Row[] = [];
      for (const item of index.items) {
        const m = fuzzyBest(q, item.haystacks);
        if (m === null) continue;
        hits.push({ group: 'nodes', key: item.id, item, hits: m.indices, score: m.score });
      }
      hits.sort((a, b) => b.score - a.score);
      out.push(...hits.slice(0, cap));
    }

    for (const binding of KEYMAP) {
      if (binding.rung !== null) continue; // the rung jumps get their own group
      /* THE PALETTE DOES NOT LIST THE COMMAND THAT OPENS THE PALETTE.
         `search` dispatches through the same `handleKey` as everything else, so
         picking it here closed this surface and immediately reopened it — a row
         whose entire effect is to return you to where you already are. It is not
         a reachable action from inside; it is a dead affordance. */
      if (binding.id === 'search') continue;
      const label = COPY.keyboard.actions[binding.id];
      const m = q.length === 0 ? { score: 0, indices: [] } : fuzzyBest(q, [label]);
      if (m === null) continue;
      out.push({ group: 'commands', key: `k:${binding.id}`, binding, score: m.score });
    }

    for (const rung of RUNGS) {
      const copy = rungCopy(rung);
      const m = q.length === 0 ? { score: 0, indices: [] } : fuzzyBest(q, [copy.label, copy.plural, copy.short]);
      if (m === null) continue;
      out.push({ group: 'rungs', key: `r:${rung}`, rung, score: m.score });
    }

    // Group order is fixed; rank inside a group.
    return out.sort(
      (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || b.score - a.score,
    );
  }, [text, staged, index]);

  const close = useCallback(() => {
    useAtlas.getState().toggle('search');
  }, []);

  const activate = useCallback(
    async (row: Row) => {
      const store = useAtlas.getState();
      close();

      if (row.group === 'questions') {
        store.stageQuery(row.query.query);
        await store.runQuery(row.query.query);
        return;
      }
      if (row.group === 'commands') {
        store.handleKey({ key: row.binding.codes[0] });
        return;
      }
      if (row.group === 'rungs') {
        await store.goToRung(row.rung, null);
        return;
      }

      /* A node. Change the rung if the node is not addressable where we stand,
         then select it and FLY. The two rAFs let the shell's `setScene` run its
         own auto-frame first; `moveTo` retargets from wherever the camera is by
         then, so the two motions read as one flight rather than as a fight. */
      const item = row.item;
      // A fling still travelling would cancel the flight frame by frame.
      stopMomentum();
      if (item.kind === 'passage') {
        await store.openPassage(item.id);
      } else if (item.kind === 'asset') {
        await store.goToRung('asset', item.parentId);
      } else if (item.kind === 'entity' || item.kind === 'source') {
        await store.goToRung('asset', null);
      } else {
        await store.goToRung(item.addressAt, null);
      }
      store.selectNode(item.id, false);
      await afterPaint();
      await getTerrain()?.camera.fitTo([item.id], 120);
    },
    [close],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
        e.preventDefault();
        setActive((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length));
        return;
      }
      if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
        e.preventDefault();
        setActive((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const row = rows[active];
        if (row !== undefined) void activate(row);
      }
    },
    [activate, active, close, rows],
  );

  // Keep the active row in view without animating anything.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, rows]);

  if (!open) return null;

  let lastGroup: Row['group'] | null = null;

  return (
    <ScrimOverlay className="ix-palette__scrim" onDismiss={close}>
      <div className="ix-palette" role="dialog" aria-modal="true" aria-label={COPY.search.title}>
        <div className="ix-palette__field">
          {/* THE SURFACE'S OWN NAME, and it names a panel — so it is --ink-dim
              (5.61:1 at its worst ground) and not --ink-faint, which measures
              3.01:1 and is declared decoration-only. */}
          <span className="ix-palette__slash caps ink-dim">{COPY.search.title}</span>
          <input
            ref={inputRef}
            className="ix-palette__input"
            type="text"
            value={text}
            spellCheck={false}
            autoComplete="off"
            placeholder={COPY.search.placeholder}
            aria-label={COPY.search.placeholder}
            onChange={(e) => {
              setText(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>

        <div className="ix-palette__list u-scroll" ref={listRef}>
          {rows.length === 0 ? <p className="ix-palette__empty">{COPY.search.empty}</p> : null}
          {rows.map((row, i) => {
            const header = row.group === lastGroup ? null : (
              <SectionLabel key={`h:${row.group}`} className="ix-palette__group">
                {COPY.search.groups[row.group]}
              </SectionLabel>
            );
            lastGroup = row.group;
            return (
              <div key={row.key} className="ix-palette__slot">
                {header}
                <button
                  type="button"
                  className="ix-palette__row"
                  data-active={i === active ? 'true' : undefined}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void activate(row)}
                >
                  <RowBody row={row} />
                </button>
              </div>
            );
          })}
        </div>

        {/* THE FOOTER IS THE ONLY PLACE THE ENTER/ESC CONTRACT IS STATED, and a
            count is a measurement. Both were on the decoration step: the hint at
            3.01:1, and the index count on the faint tone of the mono primitive —
            which `check-discipline.mjs` rule 12 fails outright, because there is
            no such thing as a decorative measured number. It was one of three
            live violations in the tree. */}
        <div className="ix-palette__ft">
          <span className="ink-dim">{COPY.search.hint}</span>
          {index === null ? null : (
            <span className="ix-palette__count">
              <Num value={index.items.length} format="int" tone="dim" />
              <span className="ink-dim">{COPY.search.groups.nodes.toLowerCase()}</span>
            </span>
          )}
        </div>
      </div>
    </ScrimOverlay>
  );
}

/* -----------------------------------------------------------------------------
 * ONE ROW
 * -------------------------------------------------------------------------- */

function RowBody({ row }: { row: Row }): JSX.Element {
  if (row.group === 'questions') {
    return (
      <>
        <span className="ix-palette__glyph" aria-hidden="true">
          ?
        </span>
        <span className="ix-palette__main">
          <span className="ix-palette__title">{row.query.query}</span>
          <span className="ix-palette__sub">{row.query.why}</span>
        </span>
        {/* PLAIN NAME LEADS ON A FIRST-USE SURFACE. The technical term is the
            second half of the tip and is unchanged in the receipt. */}
        <Chip tone="evidence" title={`${dual('byConstruction')} — ${COPY.answer.goldTip}`}>
          {plain('byConstruction')}
        </Chip>
      </>
    );
  }

  if (row.group === 'commands') {
    return (
      <>
        <span className="ix-palette__glyph" aria-hidden="true">
          ·
        </span>
        <span className="ix-palette__main">
          <span className="ix-palette__title">{COPY.keyboard.actions[row.binding.id]}</span>
        </span>
        <KeyHint keys={row.binding.keys} />
      </>
    );
  }

  if (row.group === 'rungs') {
    const copy = rungCopy(row.rung);
    return (
      <>
        <Glyph rung={row.rung} tone="dim" />
        <span className="ix-palette__main">
          <span className="ix-palette__title">{copy.plural}</span>
          <span className="ix-palette__sub">{copy.short}</span>
        </span>
        <KeyHint keys={[String(RUNGS.indexOf(row.rung) + 1)]} />
      </>
    );
  }

  const item = row.item;
  const runs = markRuns(item.label, row.hits);
  return (
    <>
      <span className="ix-palette__glyph" aria-hidden="true">
        {RUNG_GLYPH[item.addressAt]}
      </span>
      <span className="ix-palette__main">
        <span className="ix-palette__title">
          {runs.map((r, i) =>
            r.hit ? (
              <mark key={i} className="ix-palette__hit">
                {r.text}
              </mark>
            ) : (
              <span key={i}>{r.text}</span>
            ),
          )}
        </span>
        {item.aliases.length === 0 ? null : (
          <span className="ix-palette__sub">{item.aliases.join(' · ')}</span>
        )}
      </span>
      <Chip tone="dim" title={COPY.rungs.levels[item.addressAt].short}>
        {COPY.rungs.kinds[item.kind]}
      </Chip>
      {/* A degree is a measurement, so it is never on the decoration step. */}
      <Num value={item.degree} format="int" tone="dim" title={COPY.inspector.rows.degree.tip} />
    </>
  );
}
