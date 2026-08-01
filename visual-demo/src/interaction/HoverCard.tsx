/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE HOVER CARD
 * =============================================================================
 *
 * A calm, anchored readout of the node under the pointer. It is NOT the
 * Inspector: the Inspector is a held panel with seventeen rows and a history;
 * this is what the terrain can tell you in the time it takes to point at
 * something, and it should never grow past that.
 *
 * EVERY FIGURE ON IT IS SOURCED.
 *   label / community / degree / centrality  — fields of the `GraphNode` payload
 *   resolution                                — the store's own admitted tier
 *   σ-class mix                               — counted from the neighbourhood
 *                                               response's real `edges` array
 * There is no "relevance", no "score", no invented strength bar. If the
 * neighbourhood has not landed the card simply has fewer rows.
 *
 * POSITIONING IS IMPERATIVE AND DOCKED. `placeHoverCard()` is called from the
 * pointermove handler and writes a transform straight onto the element without
 * React reconciling anything — but it docks the card to a stable margin slot
 * rather than trailing the cursor, so it never covers the cluster you are about
 * to explore. See the note above `EXCLUSION_RADIUS`. It portals to
 * `document.body` because a `backdrop-filter` ancestor becomes a containing block
 * for fixed descendants — the same trap the primitives hit and fixed.
 * ========================================================================== */

import { forwardRef } from 'react';
import { createPortal } from 'react-dom';

import { COPY, lodCopy, sigmaCopy } from '@/copy';
import type { Asset, Entity, GraphNode, LodState, Passage, Rung } from '@/engine';
import { Chip, Glyph, LodChip, Num, Row } from '@/ui/primitives';

import type { HoverNeighborhood } from '@/interaction/useHoverNeighborhood';

export interface HoverCardProps {
  node: GraphNode;
  /** The tier the store admitted this node at. Never guessed. */
  lod: LodState | undefined;
  /** `null` until the debounced request lands, or when it was aborted. */
  neighborhood: HoverNeighborhood | null;
}

/**
 * THE CARD DOES NOT FOLLOW THE POINTER, AND THAT IS THE POINT.
 *
 * A cursor-anchored card covers the neighbourhood you are reaching toward next.
 * On a terrain the whole job is scanning a cluster — pointing at a node, reading
 * it, then moving to its neighbour — and a card that rides the pointer sits
 * exactly on top of the next thing you wanted to look at. It also drags the eye
 * around the screen at pointer rate, which is the opposite of calm.
 *
 * So the card DOCKS. It takes one of a few stable slots at the margins of the
 * terrain, outside the region you are working in, and it stays there while you
 * scan. It only relocates when the pointer actually enters the slot it is
 * occupying — and then it moves once, decisively, rather than continuously.
 *
 * The exclusion radius stands in for "the cluster I am exploring". It is
 * deliberately generous: a lit hover-neighbourhood spans well beyond the node
 * itself, and the card must clear the whole of it, not just the cursor.
 */
const EXCLUSION_RADIUS = 260;

/** Breathing room between the card and the terrain's edges. */
const INSET = 12;

/**
 * Candidate docks, in preference order.
 *
 * Top-right is deliberately absent: the world-map strip lives there from island
 * depth down, and two floating objects in one corner is how a calm instrument
 * turns into a cluttered one. Bottom-right is last because the rung legend sits
 * there.
 */
const SLOTS = ['bottom-left', 'top-left', 'bottom-right'] as const;
type Slot = (typeof SLOTS)[number];

/** The slot currently in use. Held across calls so the card stays put while scanning. */
let activeSlot: Slot = 'bottom-left';

function slotRect(slot: Slot, area: DOMRect, w: number, h: number) {
  const left = area.left + INSET;
  const right = area.right - INSET - w;
  const top = area.top + INSET;
  const bottom = area.bottom - INSET - h;
  switch (slot) {
    case 'top-left':
      return { x: left, y: top };
    case 'bottom-right':
      return { x: right, y: bottom };
    case 'bottom-left':
    default:
      return { x: left, y: bottom };
  }
}

/** Does a card placed here collide with the region the pointer is working in? */
function blocked(x: number, y: number, w: number, h: number, px: number, py: number): boolean {
  const nearestX = Math.max(x, Math.min(px, x + w));
  const nearestY = Math.max(y, Math.min(py, y + h));
  const dx = px - nearestX;
  const dy = py - nearestY;
  return dx * dx + dy * dy < EXCLUSION_RADIUS * EXCLUSION_RADIUS;
}

/**
 * Dock the card clear of the pointer's working region.
 *
 * Called from a pointermove handler: one measurement, one style write, no
 * allocation, and in the common case no visible change at all because the
 * chosen slot is still valid.
 */
export function placeHoverCard(el: HTMLElement | null, clientX: number, clientY: number): void {
  if (el === null) return;
  const w = el.offsetWidth;
  const h = el.offsetHeight;

  // Dock inside the terrain, not the window: the card belongs to the map, and
  // the rail and HUD are not the map. Falls back to the viewport if the canvas
  // is not mounted yet.
  const canvas = document.querySelector('canvas');
  const area =
    canvas !== null
      ? canvas.getBoundingClientRect()
      : new DOMRect(0, 0, window.innerWidth, window.innerHeight);

  // Hysteresis: keep the slot we are in unless the pointer has actually reached
  // it. Re-picking every frame is what produces a card that twitches between
  // corners while you sweep across the middle of the map.
  const held = slotRect(activeSlot, area, w, h);
  if (!blocked(held.x, held.y, w, h, clientX, clientY)) {
    el.style.transform = `translate3d(${Math.round(held.x)}px, ${Math.round(held.y)}px, 0)`;
    return;
  }

  for (const slot of SLOTS) {
    const r = slotRect(slot, area, w, h);
    if (blocked(r.x, r.y, w, h, clientX, clientY)) continue;
    activeSlot = slot;
    el.style.transform = `translate3d(${Math.round(r.x)}px, ${Math.round(r.y)}px, 0)`;
    return;
  }

  // Every slot is compromised — a small viewport, or a pointer in the middle of
  // a short window. Take the slot furthest from the pointer rather than picking
  // arbitrarily, so the card is at least as far out of the way as it can be.
  let best: Slot = SLOTS[0];
  let bestD = -1;
  for (const slot of SLOTS) {
    const r = slotRect(slot, area, w, h);
    const dx = clientX - (r.x + w / 2);
    const dy = clientY - (r.y + h / 2);
    const d = dx * dx + dy * dy;
    if (d > bestD) {
      bestD = d;
      best = slot;
    }
  }
  activeSlot = best;
  const r = slotRect(best, area, w, h);
  el.style.transform = `translate3d(${Math.round(r.x)}px, ${Math.round(r.y)}px, 0)`;
}

function isSpineRung(kind: GraphNode['kind']): kind is Rung {
  return kind === 'continent' || kind === 'island' || kind === 'asset' || kind === 'passage';
}

export const HoverCard = forwardRef<HTMLDivElement, HoverCardProps>(function HoverCard(
  { node, lod, neighborhood },
  ref,
) {
  const kindWord = COPY.rungs.kinds[node.kind];
  const mix = neighborhood !== null && neighborhood.nodeId === node.id ? neighborhood : null;

  const card = (
    /* `aria-hidden` IS CORRECT, AND IT IS ONLY CORRECT NOW.
       The review flagged this element for a good reason: it was the richest
       per-node summary the product produced and it was withheld from assistive
       technology, at a moment when nothing else in the tree offered a structured
       reading of a node at all. That is no longer the state of the tree —
       `<TerrainOutline/>` gives every node an operable row carrying its kind, its
       degree, the relation joining it to the cursor and the actions available on
       it, and it is driven by the same store this card reads.

       So the argument for hiding it is now the ordinary one and it holds: this
       card is POINTER-DRIVEN. It is positioned by a `pointermove` handler that
       writes a transform straight onto the element, it appears and vanishes at
       pointer rate, and its content is the hover target — which is exactly the
       one piece of state the announcer refuses to speak, because a pointer
       crossing 4,406 nodes would produce 4,406 utterances. Exposing a live
       tooltip that changes sixty times a second would not add a reading; it would
       drown the one the outline provides.

       The rule this encodes: hide a surface from assistive technology only when
       an equivalent one is exposed. Before the outline existed, this attribute
       was a hole. */
    <div className="ix-card" ref={ref} role="tooltip" aria-hidden="true">
      <div className="ix-card__hd">
        {isSpineRung(node.kind) ? (
          <Glyph rung={node.kind} tone="dim" />
        ) : (
          <span className="ix-card__kindmark caps ink-faint">{kindWord}</span>
        )}
        <span className="ix-card__label">{node.label}</span>
      </div>

      <div className="ix-card__badges">
        <Chip tone="dim" title={COPY.rungs.kinds[node.kind]}>
          {kindWord}
        </Chip>
        {lod === undefined ? null : <LodChip state={lod} label={lodCopy(lod).label} />}
        {node.kind === 'entity' && (node as Entity).is_bridge ? (
          <Chip tone="curiosity" active title={COPY.inspector.bridgeTip}>
            {COPY.inspector.bridgeBadge}
          </Chip>
        ) : null}
      </div>

      <div className="ix-card__rows">
        <Row
          label={COPY.inspector.rows.community.label}
          // Truncated to fit the card; the full id stays recoverable on hover.
          value={<span title={node.community_id}>{node.community_id}</span>}
          mono
          tone="dim"
          title={COPY.inspector.rows.community.tip}
        />
        <Row
          label={COPY.inspector.rows.degree.label}
          value={<Num value={node.degree} format="int" />}
          title={COPY.inspector.rows.degree.tip}
        />
        <Row
          label={COPY.inspector.rows.centrality.label}
          value={<Num value={node.centrality} format="float2" />}
          title={COPY.inspector.rows.centrality.tip}
        />
        {node.kind === 'entity' ? (
          <Row
            label={COPY.inspector.rows.mentions.label}
            value={<Num value={(node as Entity).mentions.length} format="int" />}
            title={COPY.inspector.rows.mentions.tip}
          />
        ) : null}
        {node.kind === 'asset' ? (
          <Row
            label={COPY.inspector.rows.tokens.label}
            value={<Num value={(node as Asset).token_count} format="tokens" />}
            title={COPY.inspector.rows.tokens.tip}
          />
        ) : null}
        {node.kind === 'passage' ? (
          <Row
            label={COPY.inspector.rows.seq.label}
            value={<Num value={(node as Passage).seq} format="int" />}
            title={COPY.inspector.rows.seq.tip}
          />
        ) : null}
      </div>

      {mix === null ? null : (
        <div className="ix-card__mix">
          <div className="ix-card__mixhd">
            <span className="caps ink-faint">{COPY.sigma.title}</span>
            <span className="ix-card__hops">
              {/* --ink-dim, NOT --ink-faint. The hop count is the one figure on
                  this card that says how far the lit neighbourhood actually
                  reaches, and the faint step is decoration only. */}
              <Num value={mix.hops} format="int" unit={COPY.common.units.hops} tone="dim" />
            </span>
          </div>
          <div className="ix-card__chips">
            {mix.sigmaMix.map((row) => (
              <Chip
                key={row.sigma}
                tone="dim"
                count={row.count}
                title={sigmaCopy(row.sigma).short}
              >
                {sigmaCopy(row.sigma).label}
              </Chip>
            ))}
          </div>
          <Row
            label={COPY.analyst.readouts.edges.label}
            value={<Num value={mix.view.stats.edge_count} format="int" />}
            title={COPY.analyst.readouts.edges.tip}
          />
          {mix.quarantined === 0 ? null : (
            <Row
              label={COPY.quarantine.countLabel}
              value={<Num value={mix.quarantined} format="int" tone="alarm" />}
              title={COPY.quarantine.never}
            />
          )}
        </div>
      )}

      <div className="ix-card__ft">{COPY.hud.hoverHint}</div>
    </div>
  );

  return createPortal(card, document.body);
});
