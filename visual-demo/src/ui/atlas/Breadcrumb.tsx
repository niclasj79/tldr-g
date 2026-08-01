/**
 * =============================================================================
 * BREADCRUMB — the rung stack, a depth gauge, and the level selector
 * =============================================================================
 *
 * This is a navigation control and an INSTRUMENT READING at the same time, and
 * the second job is the one people forget.
 *
 * As navigation it is obvious: World › Continent › Island › and the level you
 * are standing on, every step clickable, every step returning you to the view
 * that CONTAINS that step rather than to the step itself.
 *
 * As a gauge it says how deep you are and how much further down there is.
 *
 * -----------------------------------------------------------------------------
 * IT WAS WITHDRAWN AT THE WIDTHS WHERE IT WAS NEEDED MOST
 * -----------------------------------------------------------------------------
 * `shell.css` carried `@media (max-width: 1500px) { .topbar__crumbs { display:
 * none } }`. The only surface in the product that says where on the spine you
 * are standing was deleted below 1500px — the exact viewport range where a
 * reader has the least context on screen and the most need of it — and the only
 * remaining way up the spine was a keyboard shortcut nobody had been shown.
 *
 * So this component now renders TWO forms and the media query chooses between
 * them instead of choosing between one form and nothing:
 *
 *   .rb-full     the whole route. World › … › here, plus the latent levels.
 *   .rb-compact  the three facts a lost reader actually needs — which LEVEL
 *                they are reading, what they are INSIDE, and the way up.
 *
 * Exactly one of the two is displayed at any width and the nav itself is never
 * `display: none`. Everything the compact form drops stays reachable, because
 * the LEVEL SELECTOR is outside both and renders at every width.
 *
 * -----------------------------------------------------------------------------
 * THE LATENT LEVELS BECAME A CONTROL
 * -----------------------------------------------------------------------------
 * The levels below you used to be drawn as `aria-hidden` outline glyphs: a
 * depth gauge you could read and could not operate, which vanished entirely at
 * the passage rung because there is nothing below it. They are now the four
 * stops of a real radio group — still drawn at latent weight when they are
 * below you, still present as topology, and now pressable. A gauge that is also
 * the control for the thing it gauges is one object instead of two.
 *
 * RADIO, NOT FOUR BUTTONS. You are on exactly one level the way you are in
 * exactly one lens; four independent `<button>`s told a screen reader — and
 * everyone else — that these were four things you may press rather than one
 * thing with four positions.
 *
 * -----------------------------------------------------------------------------
 * A LEVEL JUMP KEEPS WHAT YOU ARE HOLDING
 * -----------------------------------------------------------------------------
 * Pressing `Assets` from inside one island used to throw the island away and
 * draw all 521 assets in the corpus — a control that answers "show me the
 * documents" by discarding the only reason you were looking at documents. See
 * `scopeForLevel()`: the stop descends into the selection, else the breadcrumb
 * scope, else the answer's own place, and shows the whole level only when there
 * is genuinely nothing to keep.
 *
 * THE GLYPH FLIP is beat four of the descent. It is keyed on `rung`, so it fires
 * exactly when the ontology changes and at no other time. There is no flip on a
 * hover, on a selection, or on a re-render — an animation here would be claiming
 * a state transition that did not happen.
 *
 * Every string comes from `@/copy`. Every number goes through `<Num>`.
 * =============================================================================
 */

import { useCallback, useRef, type KeyboardEvent } from 'react';

import { RUNGS, RUNG_DEPTH } from '@/engine';
import type { GraphNode, QueryRenderResponse, Rung } from '@/engine';
import { COPY, dual, plain, rungCopy } from '@/copy';
import { useAtlasStore } from '@/state';
import type { RungStackEntry } from '@/state';
import { Btn, Glyph, KeyHint, Num, Tip, cx } from '@/ui/primitives';

import { ascend, goToRung } from './descent';

/* =============================================================================
 * THE SCOPE A LEVEL JUMP SHOULD KEEP
 * ========================================================================== */

/**
 * The node a jump to `target` should be scoped INSIDE, or `null` for the whole
 * level.
 *
 * The engine's contract is exact: the scope of a view at level N is a node at
 * level N-1, because that is what `parent_id` means. So every candidate below
 * is resolved to a body of the PARENT level before it is offered, and a
 * candidate that cannot be resolved is skipped rather than coerced — passing an
 * island as the scope of a passage view would be a plausible-looking request
 * for a view that does not exist.
 *
 * The order is what the reader is most likely to mean, most specific first:
 *
 *   1. WHAT THEY ARE HOLDING. A selection is the strongest statement of intent
 *      on the screen. If it is a body of the parent level, that is the scope.
 *   2. WHERE THEY ARE STANDING. The breadcrumb entry at the parent's depth —
 *      the old behaviour, and still right when nothing is held.
 *   3. WHAT THE ANSWER IS ABOUT. A bridge entity is not on the spine, but it
 *      carries `island_ids`, so at the island level it names its own place. The
 *      answer path's first node is the fallback for a non-bridge answer.
 *
 * Only when all three miss does the jump show the whole level, which is a real
 * and useful view — every island in the world is where the straits read.
 */
export interface ScopeContext {
  stack: readonly RungStackEntry[];
  focus: string | null;
  view: { nodes: readonly GraphNode[] } | null;
  /** The current answer's subgraph, when there is one. */
  constellation: QueryRenderResponse['constellation'] | null;
}

export function scopeForLevel(target: Rung, s: ScopeContext): string | null {
  const depth = RUNG_DEPTH[target];
  if (depth === 0) return null; // the world is a set of continents; nothing contains them
  const parentRung = RUNGS[depth - 1];

  const nodeOf = (id: string): GraphNode | null =>
    s.view?.nodes.find((n) => n.id === id) ?? null;

  /** A candidate id resolved to a body of `parentRung`, or null if it cannot be. */
  const asScope = (id: string | null): string | null => {
    if (id === null) return null;
    // The breadcrumb already knows the rung of every ancestor without a fetch.
    const onRoute = s.stack.find((e) => e.id === id);
    if (onRoute !== undefined) return onRoute.rung === parentRung ? onRoute.id : null;

    const node = nodeOf(id);
    if (node === null) return null;
    if (node.kind === parentRung) return node.id;
    // AN ENTITY IS NOT ON THE SPINE, and this is the one place that matters: a
    // bridge entity's whole point is that it is mentioned on more than one
    // island, so at the island level it can name where it lives. It cannot name
    // a continent or an asset, and it does not pretend to.
    if (node.kind === 'entity' && parentRung === 'island') return node.island_ids[0] ?? null;
    return null;
  };

  const held = asScope(s.focus);
  if (held !== null) return held;

  // The breadcrumb is continent-first and one entry per level, so the entry at
  // the parent's depth IS the parent — but the rung is checked rather than
  // assumed from the index. An off-by-one here would not throw: it would hand
  // the engine a legal id for the wrong level and get back a view of something
  // else, which is the plausible-looking wrong answer this codebase treats as
  // the expensive class of bug.
  const standing = s.stack[depth - 1];
  if (standing !== undefined && standing.rung === parentRung) return standing.id;

  if (s.constellation !== null) {
    const bridge = asScope(s.constellation.bridge_entity_id);
    if (bridge !== null) return bridge;
    const firstHop = asScope(s.constellation.path[0]?.from_id ?? null);
    if (firstHop !== null) return firstHop;
  }

  return null;
}

/* =============================================================================
 * THE LEVEL SELECTOR — one implementation, two renderings
 * -----------------------------------------------------------------------------
 * The top bar needs a horizontal strip of four glyphs and Atlas Mode needs a
 * vertical column of four named stops with the noun for what each one contains.
 * They are the same control, so they are the same component: two renderings of
 * one radio group, one scope rule, one keyboard model. Two implementations would
 * be two chances for the stops to disagree about which level is current.
 * ========================================================================== */

export interface LevelSelectorProps {
  /** `compact` is the top bar's glyph strip; `rail` is Atlas Mode's altimeter. */
  variant?: 'compact' | 'rail';
  className?: string;
  /** Called before the jump, so a guided tour can stand itself down first. */
  onJump?: () => void;
}

export function LevelSelector({
  variant = 'compact',
  className,
  onJump,
}: LevelSelectorProps): JSX.Element {
  /* EVERYTHING THE SCOPE RULE READS, AND NOTHING ELSE. Not `s.query`: its
     identity changes on every keystroke in the command bar, and a level
     selector that reconciles while somebody types is the same class of waste as
     a panel that repaints on hover. `s.query.active?.constellation` is stable
     between renders. */
  const { rung, stack, focus, view, constellation } = useAtlasStore((s) => ({
    rung: s.rung,
    stack: s.stack,
    focus: s.focus,
    view: s.view,
    constellation: s.query.active?.constellation ?? null,
  }));
  const depth = RUNG_DEPTH[rung];
  const stops = useRef<(HTMLButtonElement | null)[]>([]);
  const context: ScopeContext = { stack, focus, view, constellation };

  /* THE MEMO DEPENDS ON THE FIELDS, NOT ON THE OBJECT THAT HOLDS THEM.
     `context` is an object LITERAL, rebuilt on every render, so as a dependency
     it never compared equal and the `useCallback` returned a new function every
     time — a memo that never memoizes, which is the same dead affordance as a
     parameter that is never varied. The four fields it is built from ARE
     shallow-compared by the store selector, so depending on them directly makes
     the memo real and keeps the closure exactly as fresh as it was. */
  const jump = useCallback(
    (target: Rung) => {
      onJump?.();
      void goToRung(target, scopeForLevel(target, { stack, focus, view, constellation }));
    },
    [onJump, stack, focus, view, constellation],
  );

  /* ROVING TABINDEX AND ARROW KEYS, because that is what a radio group IS.
     A group of radios is ONE tab stop and the arrows move within it — four tab
     stops would make the selector cost four presses to walk past, which is the
     cost the keyboard map's own 1–4 shortcuts exist to avoid paying. Neither
     arrow key is in `KEYMAP`, so nothing here shadows a product shortcut. */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const next = (depth + step + RUNGS.length) % RUNGS.length;
      stops.current[next]?.focus();
      jump(RUNGS[next]);
    },
    [depth, jump],
  );

  return (
    <div
      className={cx('rb-levels', `rb-levels--${variant}`, className)}
      role="radiogroup"
      aria-label={dual('lod')}
      title={COPY.navigation.levels.tip}
    >
      {RUNGS.map((r, i) => {
        const here = r === rung;
        const level = rungCopy(r);
        const state = here ? 'here' : RUNG_DEPTH[r] < depth ? 'above' : 'below';
        // WHAT THIS PRESS WILL COST, WORKED OUT NOW RATHER THAN PROMISED.
        // Three different sentences, because there are three different
        // outcomes: the top of the spine has nothing to be inside of, a stop
        // with a resolvable scope keeps it, and a stop with none genuinely
        // shows the whole level and says so instead of implying otherwise.
        const consequence =
          RUNG_DEPTH[r] === 0
            ? COPY.navigation.levels.root
            : scopeForLevel(r, context) === null
              ? COPY.navigation.levels.whole
              : COPY.navigation.levels.scoped;
        return (
          <button
            key={r}
            ref={(el) => {
              stops.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={here}
            tabIndex={here ? 0 : -1}
            className={cx('rb-level', `is-${state}`)}
            onClick={() => jump(r)}
            onKeyDown={onKeyDown}
            // THE STOP SAYS WHAT IT WILL KEEP. `Assets` under a control that
            // used to discard the island you were inside is a label that names
            // the destination and hides the cost; this names both.
            //
            // AND THIS TITLE WAS BEING EATEN BY ITS OWN CHILD. `<Glyph>` puts
            // `title={rung}` on its span unconditionally, and in the compact
            // rendering the glyph is the button's entire content — so the
            // tooltip that actually appeared was the raw engine token `island`
            // / `asset`, never this sentence, at exactly the widths the compact
            // form exists to serve. The mark is taken out of hit-testing in
            // atlas.css (`.rb-level .rb-level-glyph { pointer-events: none }`)
            // so the pointer lands on the button and reads this.
            title={`${level.plural} — ${consequence}`}
            aria-label={level.plural}
          >
            <Glyph rung={r} tone={here ? 'render' : 'dim'} className="rb-level-glyph" />
            {variant === 'rail' ? (
              <>
                <span className="rb-level-name">{level.plural}</span>
                {/* Not on the stop you are standing on: the caption below
                    already says what is here, and the two together elided each
                    other into `Passag… mentio… YOU ARE HERE`. */}
                {here ? (
                  <span className="rb-level-here caps">{COPY.atlas.here}</span>
                ) : (
                  <span className="rb-level-holds caps">{level.contains}</span>
                )}
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* =============================================================================
 * THE BREADCRUMB
 * ========================================================================== */

export interface BreadcrumbProps {
  className?: string;
  /** Hide the ascend control when the shell already carries one. */
  showAscend?: boolean;
}

export function Breadcrumb({ className, showAscend = true }: BreadcrumbProps): JSX.Element {
  const { rung, stack, bodies } = useAtlasStore((s) => ({
    rung: s.rung,
    stack: s.stack,
    // The bodies OF THIS RUNG. `node_count` also carries the cross-cutting
    // entity layer, and calling that "assets" would be a small lie in a place
    // people read quickly.
    bodies: s.view === null ? 0 : s.view.nodes.filter((n) => n.kind === s.rung).length,
  }));

  const depth = RUNG_DEPTH[rung];
  const here = rungCopy(rung);
  const scope = stack.length === 0 ? null : stack[stack.length - 1];

  /* THE ROUTE COMPRESSES; THE SUBJECT DOES NOT.
     -----------------------------------------------------------------------
     At the passage rung the scope crumb is a whole document title — `Operations
     and maintenance agreement — Tollstrand Battery (KVA-0080)`, 439px of it —
     and it is the ONLY place on screen that names the thing the terrain is
     drawing as a bounded page. It was being clipped to `Operations and
     maintenance agreem…`, which names nothing.

     The bar cannot carry that title AND three ancestor names AND the question;
     giving the title its measure out of the command bar just moved the
     truncation onto the user's own sentence. So the deepest rung spends the
     width the other way round: the ROUTE gives up its words and keeps its
     glyphs — still clickable, still labelled on hover and to a screen reader —
     and the SUBJECT keeps its words. Two rungs of context abbreviate to two
     characters; one document keeps its name.

     Only at the deepest rung, because only there is there any pressure: at the
     asset rung the same bar carries every name it has with room to spare, and
     compressing a route nobody is squeezing would be a rule applied for its own
     sake. */
  const deep = stack.length >= RUNGS.length - 1;

  return (
    <nav className={cx('rb', className)} aria-label={COPY.topbar.breadcrumb.label}>
      {/* ---- THE FULL ROUTE. Shown when there is width for it. ------------ */}
      <span className="rb-full">
        <Tip content={COPY.topbar.breadcrumb.rootTip}>
          <button
            type="button"
            className="rb-crumb rb-root"
            onClick={() => void goToRung('continent', null)}
            title={COPY.topbar.breadcrumb.rootTip}
          >
            {COPY.topbar.breadcrumb.root}
          </button>
        </Tip>

        {stack.map((entry, i) => {
          const isScope = i === stack.length - 1;
          return (
            <span className="rb-step" key={entry.id}>
              <span className="rb-sep" aria-hidden="true">
                ›
              </span>
              <button
                type="button"
                className={cx('rb-crumb', isScope && 'rb-crumb--scope')}
                // Return to the view that CONTAINS this step, scoped to its own
                // parent. Clicking "Island" shows the islands of that continent, not
                // the inside of that island — the crumb names a place you were, and
                // going back to it means standing where you stood.
                onClick={() => void goToRung(entry.rung, i === 0 ? null : stack[i - 1].id)}
                // The step's OWN name, not the rung's generic description. A route
                // that has given up its words has to be able to give them back on
                // hover, and `Island` under a glyph that is already an island glyph
                // told nobody anything they could not already see.
                title={entry.label}
                aria-label={entry.label}
              >
                <Glyph rung={entry.rung} tone="dim" />
                {isScope || !deep ? <span className="rb-label">{entry.label}</span> : null}
              </button>
            </span>
          );
        })}

        <span className="rb-step">
          <span className="rb-sep" aria-hidden="true">
            ›
          </span>
          {/* Beat four. Keyed on the rung so the flip depicts the ontology change
              and nothing else. */}
          <span className="rb-here" key={rung}>
            <Glyph rung={rung} tone="render" className="rb-flip" />
            <span className="rb-label rb-current">{here.plural}</span>
            <Num value={bodies} format="int" tone="dim" className="rb-count" />
          </span>
        </span>
      </span>

      {/* ---- THE COMPACT FORM. Shown when there is not. -------------------- *
       * Three facts, no route: the LEVEL, the thing you are INSIDE, and the
       * count of what is at this level. The way up is the shared control below,
       * which renders at both widths — so the narrow form is missing the
       * ancestors' names and nothing else, and those are one press away in the
       * selector beside it. */}
      {/* NOT WRAPPED IN <Tip>. The tooltip primitive renders an anchor span
          around its child, and an anchor that survives its child's
          `display: none` is a hover target with nothing in it at every width
          where the compact form is not the one on screen. The explanation goes
          on the element itself. */}
      <span
        className="rb-compact"
        role="group"
        aria-label={COPY.navigation.breadcrumb.compact.label}
        title={COPY.navigation.breadcrumb.compact.tip}
      >
        <span className="rb-compact-level" key={rung}>
          <Glyph rung={rung} tone="render" className="rb-flip" />
          <span className="rb-current">{here.plural}</span>
          <Num value={bodies} format="int" tone="dim" className="rb-count" />
        </span>
        <span className="rb-compact-scope">
          <span className="rb-compact-in caps">{COPY.navigation.breadcrumb.inside.label}</span>
          {/* The innermost scope, or the honest name for having none. The store
              never authors prose, so the unscoped case is named here rather
              than invented as a node label. */}
          {scope === null ? (
            <span className="rb-label ink-dim">{COPY.navigation.breadcrumb.unscoped}</span>
          ) : (
            <button
              type="button"
              className="rb-crumb rb-crumb--scope"
              onClick={() =>
                void goToRung(scope.rung, stack.length < 2 ? null : stack[stack.length - 2].id)
              }
              title={scope.label}
              aria-label={scope.label}
            >
              <Glyph rung={scope.rung} tone="dim" />
              <span className="rb-label">{scope.label}</span>
            </button>
          )}
        </span>
      </span>

      {/* ---- THE LEVEL SELECTOR. Every width, both forms. ------------------ *
       * This is what makes the compact form a narrowing rather than a removal:
       * the ancestors' names are gone, the ability to move between levels is
       * not. It replaced the `aria-hidden` outline glyphs that used to sit here
       * — a gauge nobody could operate, which disappeared entirely at the one
       * level where there is nothing below you.
       *
       * NO EXTRA CLASS. It carried `className="rb-strip"`, which had no rule in
       * atlas.css, shell.css, primitives.css or base.css and painted nothing. It
       * read as the hook that separates the top bar's instance from other
       * compact instances; there is no other compact instance, and
       * `.rb-levels--compact` carries the whole treatment. A class that looks
       * load-bearing and is not gets styled by the next edit on that belief. */}
      <LevelSelector variant="compact" />

      {showAscend && depth > 0 ? (
        <span className="rb-up">
          <Btn
            variant="ghost"
            size="sm"
            tone="dim"
            onClick={() => void ascend()}
            title={`${COPY.topbar.breadcrumb.ascend.title} — ${plain('lod')}`}
          >
            {COPY.topbar.breadcrumb.ascend.label}
          </Btn>
          <KeyHint keys={['⌫']} />
        </span>
      ) : null}
    </nav>
  );
}
