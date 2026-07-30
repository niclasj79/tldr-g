// Measure the generated corpus. Run: node scripts/corpus-report.mjs [--scale N]
//
// The counts printed here are MEASURED off the built world, never asserted
// alongside it. Anything this script prints has been through validateWorld().

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const out = await mkdtemp(join(tmpdir(), 'tldrg-corpus-'))
const bundle = join(out, 'world.mjs')
const outExtension = { '.js': '.mjs' }

await build({
  entryPoints: [join(ROOT, 'src/engine/corpus/world.ts'), join(ROOT, 'src/engine/corpus/relations.ts')],
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  logLevel: 'warning',
  outExtension,
  alias: { '@': join(ROOT, 'src') },
})

const mod = await import(pathToFileURL(bundle).href)
const rel = await import(pathToFileURL(join(out, 'relations.mjs')).href)

const scaleArg = process.argv.indexOf('--scale')
const scaleTo = scaleArg >= 0 ? Number(process.argv[scaleArg + 1]) : 0

const t0 = process.hrtime.bigint()
const w = mod.buildWorld()
const t1 = process.hrtime.bigint()

const ms = Number(t1 - t0) / 1e6
const s = w.stats

const j = (o) => JSON.stringify(o)
console.log('=== DETERMINISM ===')
const w2 = mod.buildWorld()
const sig = (x) =>
  [x.nodes.length, x.edges.length, x.sources.map((v) => v.content_hash).join('|'), x.passages.map((v) => v.content_hash).join('|')].join('#')
const a = sig(w)
const b = sig(w2)
console.log('two runs byte-identical:', a === b)
const differentSeed = mod.buildWorld(0x1234abc)
console.log('different seed differs :', sig(differentSeed) !== a)

console.log('\n=== TIMING ===')
console.log('buildWorld ms          :', ms.toFixed(0))

console.log('\n=== NODES ===')
console.log('total                  :', s.nodes_total)
console.log('by kind                :', j(s.nodes_by_kind))
console.log('assets+passages        :', s.nodes_by_kind.asset + s.nodes_by_kind.passage)
console.log('communities            :', s.communities)
console.log('tokens (est) total     :', s.tokens_total)
console.log('source characters      :', s.source_characters)

console.log('\n=== EDGES ===')
console.log('total                  :', s.edges_total)
console.log('by sigma               :', j(s.edges_by_sigma))
console.log('semantic / structural  :', s.edges_semantic, '/', s.edges_structural)
console.log('distinct families used :', s.distinct_families_used, 'of 91')
console.log('crosses_strait         :', s.strait_edges)

console.log('\n=== TRUTH GATE ===')
console.log('quarantined            :', s.quarantined)
console.log('quarantine rate        :', (s.quarantine_rate * 100).toFixed(2) + '% of truth-gated edges')
console.log('by reason              :', j(s.quarantine_by_reason))
console.log('structural quarantined :', w.edges.filter((e) => e.sigma === 'structural' && e.quarantined).length)

console.log('\n=== ENTITY LAYER ===')
console.log('entities               :', s.nodes_by_kind.entity)
console.log('bridge entities        :', s.bridge_entities, '(' + (s.bridge_entity_rate * 100).toFixed(1) + '%)')
console.log('max island span        :', Math.max(...w.entities.map((e) => e.island_ids.length)))
console.log('entities w/ 0 mentions :', w.entities.filter((e) => e.mentions.length === 0).length)

console.log('\n=== RESOLUTION DISCLOSURE ===')
console.log('resolved passages      :', s.resolved_passages, '(' + (s.resolution_rate * 100).toFixed(1) + '%)')
const byRes = {}
for (const p of w.passages) byRes[p.resolution] = (byRes[p.resolution] ?? 0) + 1
console.log('by resolution          :', j(byRes))

console.log('\n=== SPAN / HASH SPOT CHECK ===')
let spanOk = 0
let hashOk = 0
for (let i = 0; i < w.passages.length; i += 37) {
  const p = w.passages[i]
  const span = mod.verbatimSpan(w, p.id)
  if (span !== null && span.length === p.char_end - p.char_start) spanOk++
  if (mod.verifyPassageHash(w, p.id)) hashOk++
}
const sampled = Math.ceil(w.passages.length / 37)
console.log('sampled spans          :', sampled, '| offsets slice cleanly:', spanOk, '| hashes verify:', hashOk)

console.log('\n=== GROUND TRUTH ===')
const byLabel = new Map(w.entities.map((e) => [e.label, e]))
const kv = byLabel.get('Tollstrand Battery')
const tf = byLabel.get('Bruntorp Facility')
const nb = byLabel.get('Rimsdal Group')
console.log('Tollstrand Battery      :', kv.id, '| is_bridge', kv.is_bridge, '| islands', j(kv.island_ids), '| mentions', kv.mentions.length)
console.log('Bruntorp Facility        :', tf.id, '| islands', j(tf.island_ids), '| mentions', tf.mentions.length)
console.log('Rimsdal Group       :', nb.id, '| islands', j(nb.island_ids), '| mentions', nb.mentions.length)
const opE = w.edges.find((e) => e.from_id === kv.id && e.to_id === tf.id && e.family === 'operates')
const acE = w.edges.find((e) => e.from_id === nb.id && e.to_id === kv.id && e.family === 'acquired')
console.log('operates edge          :', opE.id, '| sigma', opE.sigma, '| quarantined', opE.quarantined, '| strait', opE.crosses_strait, '| evidence', opE.evidence_passage_ids.length)
console.log('acquired edge          :', acE.id, '| sigma', acE.sigma, '| quarantined', acE.quarantined, '| strait', acE.crosses_strait, '| evidence', acE.evidence_passage_ids.length)

console.log('\n--- a verbatim span carrying the first hop ---')
const ev = opE.evidence_passage_ids[0]
console.log(mod.verbatimSpan(w, ev).slice(0, 460))

console.log('\n--- a resolved passage, with its recoverable verbatim ---')
const resolved = w.passages.find((p) => p.resolution === 'coref_resolved')
if (resolved) {
  console.log('resolution :', resolved.resolution)
  console.log('rendered   :', resolved.text.slice(-190))
  console.log('verbatim   :', mod.verbatimSpan(w, resolved.id).slice(-190))
}

console.log('\n=== STAGED QUERIES ===')
for (const q of w.staged_queries) {
  console.log(`- ${q.id} [${q.intent}] gold="${q.gold}" nodes=${q.gold_node_ids.length} edges=${q.gold_edge_ids.length}`)
  console.log(`    ${q.query}`)
}

console.log('\n=== FAMILY COVERAGE ===')
const used = new Set(w.edges.map((e) => e.family))
console.log('families with >=1 edge :', used.size)
const missing = rel.RELATION_FAMILIES.filter((d) => !used.has(d.family)).map((d) => d.family)
console.log('never instantiated     :', missing.length ? j(missing) : 'none')
const topFamilies = [...w.edges.reduce((m, e) => m.set(e.family, (m.get(e.family) ?? 0) + 1), new Map())]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)
console.log('most used              :', j(Object.fromEntries(topFamilies)))

console.log('\n=== A FULL SOURCE, HEAD ===')
const demoAsset = w.assets.find((a) => a.parent_id === 'i:storage.tollstrand-cluster' && a.passage_ids.length >= 4)
const demoSrc = w.node_by_id.get(demoAsset.source_id)
console.log('locator:', demoSrc.locator, '| media:', demoSrc.media_type, '| hash:', demoSrc.content_hash)
console.log(demoSrc.segments[0].text.slice(0, 1500))

if (scaleTo > 0) {
  console.log('\n=== SCALE PAD ===')
  const t2 = process.hrtime.bigint()
  const big = mod.buildSynthetic(scaleTo)
  const t3 = process.hrtime.bigint()
  console.log('requested              :', scaleTo)
  console.log('produced nodes         :', big.stats.nodes_total)
  console.log('produced edges         :', big.stats.edges_total)
  console.log('by kind                :', j(big.stats.nodes_by_kind))
  console.log('ms                     :', (Number(t3 - t2) / 1e6).toFixed(0))
}

await rm(out, { recursive: true, force: true })
