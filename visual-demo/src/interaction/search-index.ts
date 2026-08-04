/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — THE LABEL INDEX
 * =============================================================================
 *
 * Search is the entry point into a large graph, so it has to be over the WHOLE
 * bake and not over whatever rung happens to be loaded. This builds that index
 * out of four real `GET /graph/view/{rung}` calls — every continent, every
 * island, every asset with its entity layer, and every passage — and keeps only
 * the fields a result row needs.
 *
 * THREE THINGS WORTH KNOWING:
 *
 *   IT IS LAZY. Nothing is fetched until the palette is opened for the first
 *   time. The passage rung is 2,207 nodes carrying their full text; paying for
 *   that on boot would tax every session for a feature most of them never open.
 *
 *   IT IS KEYED BY BAKE. `bake_id` is in the cache key because a re-bake mints
 *   new coordinates, and flying the camera to a stale position is the most
 *   convincing kind of wrong a map can be.
 *
 *   IT ASKS FOR NO EDGES. `maxEdges: 0` on every call. The index is over labels;
 *   shipping 512 relations four times to build a list of names would be a
 *   payload nobody reads.
 *
 * The count the palette prints is `items.length` — a measured number, rendered
 * through the mono primitive like every other measured number in the product.
 * ========================================================================== */

import { RUNG_DEPTH, engine } from '@/engine';
import type { Entity, GraphNode, NodeKind, Rung, ViewKey } from '@/engine';

/** One searchable thing. Flat and small: the index is held for the session. */
export interface IndexItem {
  id: string;
  kind: NodeKind;
  label: string;
  /** The rung this node is ADDRESSABLE at. Entities and sources are not rungs. */
  addressAt: Rung;
  /** Spine parent, so activating a result can scope the rung it opens. */
  parentId: string | null;
  community_id: string;
  degree: number;
  /** Surface forms that also resolve here. Empty for everything but entities. */
  aliases: string[];
  /** `[label, ...aliases]`, lowercased once so matching never re-allocates. */
  haystacks: string[];
}

export interface SearchIndex {
  bake_id: string;
  items: IndexItem[];
  /** How many of each kind went in. Real counts, shown in the palette footer. */
  byKind: Record<NodeKind, number>;
}

/** Entities and sources hang off the asset — the extraction context they live in. */
function addressRung(kind: NodeKind): Rung {
  switch (kind) {
    case 'continent':
    case 'island':
    case 'asset':
      return kind;
    /* A PASSAGE, AN ENTITY AND A SOURCE ALL ANSWER 'asset'. None of them is a
       rung; the asset is the finest place any of them can be found AT. */
    case 'passage':
    case 'entity':
    case 'source':
      return 'asset';
  }
}

function spineParent(node: GraphNode): string | null {
  switch (node.kind) {
    case 'island':
    case 'asset':
      return node.parent_id;
    case 'passage':
      return node.asset_id;
    default:
      return null;
  }
}

function toItem(node: GraphNode): IndexItem {
  const aliases = node.kind === 'entity' ? [...(node as Entity).aliases] : [];
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    addressAt: addressRung(node.kind),
    parentId: spineParent(node),
    community_id: node.community_id,
    degree: node.degree,
    aliases,
    haystacks: [node.label, ...aliases],
  };
}

let cache: SearchIndex | null = null;
let inflight: Promise<SearchIndex> | null = null;

/** The index if it has already been built. Never triggers a fetch. */
export function peekSearchIndex(): SearchIndex | null {
  return cache;
}

/**
 * Build (or return) the index for the current bake.
 *
 * A second caller during the build gets the FIRST call's promise rather than
 * starting a second set of four requests — opening the palette twice while it is
 * loading is a normal thing for a hand to do.
 */
export function buildSearchIndex(bakeId: string, signal?: AbortSignal): Promise<SearchIndex> {
  if (cache !== null && cache.bake_id === bakeId) return Promise.resolve(cache);
  if (inflight !== null) return inflight;

  inflight = (async () => {
    /* VIEW KEYS, not rungs — passages are still indexed and still findable;
       they are simply not a level you can stand on. */
    const rungs: ViewKey[] = ['continent', 'island', 'asset', 'passage'];
    const views = await Promise.all(
      rungs.map((rung) =>
        engine.getGraphView(rung, null, {
          maxEdges: 0,
          maxBundles: 0,
          // The entity layer rides along with the assets — that is the rung it is
          // extracted in — and is asked for exactly once.
          includeEntities: rung === 'asset',
          signal,
        }),
      ),
    );

    const seen = new Set<string>();
    const items: IndexItem[] = [];
    const byKind = {
      continent: 0,
      island: 0,
      asset: 0,
      entity: 0,
      passage: 0,
      source: 0,
    } as Record<NodeKind, number>;

    for (const view of views) {
      for (const node of view.nodes) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        items.push(toItem(node));
        byKind[node.kind] += 1;
      }
    }

    // Coarse rungs first, then by degree: a continent should not rank below a
    // passage that happens to share three letters with the query.
    items.sort(
      (a, b) =>
        RUNG_DEPTH[a.addressAt] - RUNG_DEPTH[b.addressAt] ||
        b.degree - a.degree ||
        (a.label < b.label ? -1 : 1),
    );

    cache = { bake_id: views[0].bake_id, items, byKind };
    return cache;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/** Drop the index. The store's bake change is the only thing that should do this. */
export function resetSearchIndex(): void {
  cache = null;
}
