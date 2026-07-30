/**
 * =============================================================================
 * BREADCRUMB — the rung stack, and a depth gauge
 * =============================================================================
 *
 * This is a navigation control and an INSTRUMENT READING at the same time, and
 * the second job is the one people forget.
 *
 * As navigation it is obvious: World › Continent › Island › and the rung you are
 * standing on, every step clickable, every step returning you to the view that
 * CONTAINS that step rather than to the step itself.
 *
 * As a gauge it says how deep you are and how much further down there is. The
 * rungs you have not descended are drawn to the right of the current one at
 * `latent` weight — outline only, no label, present as topology. That is the
 * same promise the terrain makes: the spine never has holes, and the part of it
 * you are not standing on is still visibly there.
 *
 * THE GLYPH FLIP is beat four of the descent. It is keyed on `rung`, so it fires
 * exactly when the ontology changes and at no other time. There is no flip on a
 * hover, on a selection, or on a re-render — an animation here would be claiming
 * a state transition that did not happen.
 *
 * Every string comes from `@/copy`. Every number goes through `<Num>`.
 * =============================================================================
 */

import { RUNGS, RUNG_DEPTH } from '@/engine';
import { COPY, rungCopy } from '@/copy';
import { useAtlasStore } from '@/state';
import { Btn, Glyph, KeyHint, Num, Tip, cx } from '@/ui/primitives';

import { ascend, goToRung } from './descent';

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
  const below = RUNGS.slice(depth + 1);
  const here = rungCopy(rung);

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
        const scope = i === stack.length - 1;
        return (
          <span className="rb-step" key={entry.id}>
            <span className="rb-sep" aria-hidden="true">
              ›
            </span>
            <button
              type="button"
              className={cx('rb-crumb', scope && 'rb-crumb--scope')}
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
              {scope || !deep ? <span className="rb-label">{entry.label}</span> : null}
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

      {below.length > 0 ? (
        <span className="rb-below" aria-hidden="true" title={COPY.rungs.note}>
          {below.map((r) => (
            <Glyph key={r} rung={r} tone="faint" className="rb-latent" />
          ))}
        </span>
      ) : null}

      {showAscend && depth > 0 ? (
        <span className="rb-up">
          <Btn
            variant="ghost"
            size="sm"
            tone="dim"
            onClick={() => void ascend()}
            title={COPY.topbar.breadcrumb.ascend.title}
          >
            {COPY.topbar.breadcrumb.ascend.label}
          </Btn>
          <KeyHint keys={['⌫']} />
        </span>
      ) : null}
    </nav>
  );
}
