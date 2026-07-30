/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE σ-CLASS FILTER CHIPS
 * =============================================================================
 *
 * Chips, never a dropdown. A dropdown hides its own state: you cannot tell from
 * across the room whether four classes are off, and a filter you have forgotten
 * about is the fastest way to read a map wrong.
 *
 * EVERY COUNT ON THIS BAR IS COUNTED, HERE, FROM `view.edges`. There is no
 * cached total and no estimate. `structural` genuinely is the largest class in
 * this corpus, and it says so.
 *
 * AND THEY SAY WHAT THEY REMOVED. A filter bar that only shows what it kept is
 * a filter bar you can be lied to by. The withheld line is the number of
 * relations that are in the payload and are not being stroked BECAUSE OF THESE
 * CONTROLS — separate from the ones the edge policy withheld, which is a
 * different decision made by a different part of the engine.
 *
 * -----------------------------------------------------------------------------
 * ONE THING THIS BAR WILL NOT DO
 * -----------------------------------------------------------------------------
 * It will not let you turn every class off. Downstream, an EMPTY σ list means
 * "no filter" rather than "hide everything" — so a "None" control would turn
 * every relation back on while claiming to have turned them all off. Rather than
 * ship a control that lies, the last active class is inert. The asymmetry is
 * noted for the modules that own that semantics.
 * ========================================================================== */

import { useMemo } from 'react';

import { COPY, sigmaCopy } from '@/copy';
import { SIGMA_CLASSES } from '@/engine';
import type { SigmaClass } from '@/engine';
import { useAtlas, useAtlasStore } from '@/state';
import { Btn, Chip, Num } from '@/ui/primitives';

import '@/interaction/interaction.css';

export interface SigmaFiltersProps {
  className?: string;
}

export function SigmaFilters({ className }: SigmaFiltersProps): JSX.Element | null {
  const { view, sigma, showQuarantined } = useAtlasStore((s) => ({
    view: s.view,
    sigma: s.filters.sigma,
    showQuarantined: s.filters.showQuarantined,
  }));

  const counts = useMemo(() => {
    const bySigma = new Map<SigmaClass, number>();
    let quarantined = 0;
    for (const edge of view?.edges ?? []) {
      bySigma.set(edge.sigma, (bySigma.get(edge.sigma) ?? 0) + 1);
      if (edge.quarantined) quarantined += 1;
    }
    return { bySigma, quarantined, total: view?.edges.length ?? 0 };
  }, [view]);

  // An empty list means "no filter" downstream, so treat it as all six here.
  const active = useMemo(
    () => new Set<SigmaClass>(sigma.length === 0 ? SIGMA_CLASSES : sigma),
    [sigma],
  );

  const withheld = useMemo(() => {
    let n = 0;
    for (const edge of view?.edges ?? []) {
      if (!active.has(edge.sigma)) n += 1;
      else if (edge.quarantined && !showQuarantined) n += 1;
    }
    return n;
  }, [view, active, showQuarantined]);

  if (view === null) return null;

  const toggle = (cls: SigmaClass): void => {
    const store = useAtlas.getState();
    const next = new Set(active);
    if (next.has(cls)) {
      if (next.size === 1) return; // see the header note
      next.delete(cls);
    } else {
      next.add(cls);
    }
    store.setSigmaFilter(SIGMA_CLASSES.filter((c) => next.has(c)));
  };

  return (
    <div className={className ? `ix-filters ${className}` : 'ix-filters'}>
      <span className="caps ink-faint ix-filters__label" title={COPY.analyst.sigmaFilter.note}>
        {COPY.analyst.sigmaFilter.title}
      </span>

      {SIGMA_CLASSES.map((cls) => {
        const copy = sigmaCopy(cls);
        const on = active.has(cls);
        const lastOne = on && active.size === 1;
        return (
          <Chip
            key={cls}
            active={on}
            tone={on ? 'render' : 'dim'}
            count={counts.bySigma.get(cls) ?? 0}
            onClick={lastOne ? undefined : () => toggle(cls)}
            title={`${copy.short} ${cls === 'structural' ? COPY.sigma.exemptLabel : COPY.sigma.gatedLabel}`}
          >
            {copy.label}
          </Chip>
        );
      })}

      <Chip
        active={showQuarantined}
        tone={showQuarantined ? 'alarm' : 'dim'}
        count={counts.quarantined}
        onClick={() => useAtlas.getState().toggleQuarantined()}
        title={showQuarantined ? COPY.quarantine.hide.title : COPY.quarantine.show.title}
      >
        {COPY.quarantine.countLabel}
      </Chip>

      <span className="ix-filters__withheld" title={COPY.analyst.readouts.withheld.tip}>
        <span className="caps ink-faint">{COPY.analyst.readouts.withheld.label}</span>
        <Num value={withheld} format="int" tone={withheld > 0 ? 'warn' : 'faint'} />
        <span className="ink-faint">{COPY.common.ofLabel}</span>
        <Num value={counts.total} format="int" tone="faint" />
      </span>

      {active.size === SIGMA_CLASSES.length ? null : (
        <Btn
          variant="ghost"
          size="sm"
          onClick={() => useAtlas.getState().setSigmaFilter([...SIGMA_CLASSES])}
          title={COPY.analyst.sigmaFilter.all.title}
        >
          {COPY.analyst.sigmaFilter.all.label}
        </Btn>
      )}
    </div>
  );
}
