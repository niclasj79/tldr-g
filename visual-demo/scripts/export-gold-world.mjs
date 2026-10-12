// Export the demo's synthetic world for EXP-126 (the film's beat on the real TLDR-G engine).
// Run: node scripts/export-gold-world.mjs <out-dir>
//
// Writes one plain-text file per source (its verbatim segment, seq 0) for the real engine to ingest,
// and gold.json: the world's own graph (passages with character spans, entities with aliases and
// mentions, typed edges with their evidence passages, the staged queries and the ground-truth chain).
// The world is seeded and byte-reproducible (validateWorld() runs inside buildWorld), so the export is
// regenerated, never committed. Everything here is synthetic: CORPUS_PROVENANCE says so on every record.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = resolve(process.argv[2] || 'build/gold-world')

const tmp = await mkdtemp(join(tmpdir(), 'tldrg-export-'))
await build({
  entryPoints: [join(ROOT, 'src/engine/corpus/world.ts')],
  outdir: tmp, bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  logLevel: 'warning', outExtension: { '.js': '.mjs' }, alias: { '@': join(ROOT, 'src') },
})
const mod = await import(pathToFileURL(join(tmp, 'world.mjs')).href)
const w = mod.buildWorld()
mod.validateWorld(w, { deep: true })

const safe = (id) => id.replace(/[^A-Za-z0-9._-]/g, '_')
await mkdir(join(OUT, 'docs'), { recursive: true })
const sources = []
for (const s of w.sources) {
  const seg = s.segments.find((g) => g.seq === 0)
  if (!seg || !seg.text) throw new Error(`source ${s.id} has no verbatim segment`)
  const file = `${safe(s.id)}.txt`
  await writeFile(join(OUT, 'docs', file), seg.text, 'utf8')
  sources.push({ id: s.id, file, locator: s.locator, asset_ids: s.asset_ids, chars: seg.text.length })
}
const island_of = (id) => w.island_of.get(id) ?? null
const gold = {
  seed: w.seed,
  corpus_provenance: w.corpus_provenance,
  stats: w.stats,
  ground_truth: w.ground_truth,
  staged_queries: w.staged_queries,
  sources,
  assets: w.assets.map((a) => ({ id: a.id, label: a.label, island_id: a.parent_id, source_id: a.source_id, passage_ids: a.passage_ids })),
  passages: w.passages.map((p) => ({
    id: p.id, asset_id: p.asset_id, source_id: p.source_id, seq: p.seq, char_start: p.char_start, char_end: p.char_end,
    verbatim: mod.verbatimSpan(w, p.id), text: p.text, entity_ids: p.entity_ids, island_id: island_of(p.id),
  })),
  entities: w.entities.map((e) => ({
    id: e.id, label: e.label, aliases: e.aliases, entity_type: e.entity_type, mentions: e.mentions,
    asset_ids: e.asset_ids, island_ids: e.island_ids, is_bridge: e.is_bridge,
  })),
  edges: w.edges.filter((e) => e.sigma !== 'structural').map((e) => ({
    id: e.id, from_id: e.from_id, to_id: e.to_id, family: e.family, sigma: e.sigma,
    evidence_passage_ids: e.evidence_passage_ids, quarantined: e.quarantined, crosses_strait: e.crosses_strait,
  })),
}
await writeFile(join(OUT, 'gold.json'), JSON.stringify(gold), 'utf8')
await rm(tmp, { recursive: true, force: true })
console.log(`exported ${sources.length} sources, ${gold.passages.length} passages, ${gold.entities.length} entities, ` +
  `${gold.edges.length} semantic edges (${gold.edges.filter((e) => e.quarantined).length} quarantined), ` +
  `${gold.staged_queries.length} staged queries -> ${OUT}`)
