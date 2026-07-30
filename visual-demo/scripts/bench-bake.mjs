// Empirical verification of src/engine/layout/bake.ts.
//
// Everything this script prints is MEASURED, not expected. It builds synthetic
// worlds that obey the TLDR-G grain (continent > island > asset > passage, plus a
// cross-cutting entity layer with real bridge entities), bakes them, and reports:
//
//   1. bake wall-clock at 6K and 100K nodes
//   2. determinism: same world, shuffled input arrays, byte-identical positions?
//   3. memory shape at 100K
//   4. re-bake drift with +10% nodes added and 3% removed
//   5. cluster separation: intra- vs inter-community distance, neighbour purity
//   6. the demo's bridge entity actually landing in the strait
//   7. spatial-index query cost at 100K (it must not linear-scan)
//
// Usage: node --expose-gc scripts/bench-bake.mjs

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as esbuild from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ── build the module under test ─────────────────────────────────────────── */
const outDir = await mkdtemp(join(tmpdir(), 'tldrg-bake-'))
const outFile = join(outDir, 'bake.mjs')
await esbuild.build({
  entryPoints: [join(ROOT, 'src/engine/layout/bake.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: outFile,
  alias: { '@': join(ROOT, 'src') },
  logLevel: 'error',
})
const bake = await import('file://' + outFile.replace(/\\/g, '/'))

/* ── seeded PRNG so the corpus itself is reproducible ────────────────────── */
function splitmix32(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x9e3779b9) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad)
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97)
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296
  }
}

const NOW = '2026-07-27T09:00:00.000Z'

function edge(id, from, to, family, sigma, inverse, weight, crosses) {
  return {
    id,
    from_id: from,
    to_id: to,
    family,
    sigma,
    inverse_family: inverse,
    weight,
    confidence: 0.9,
    evidence_passage_ids: [],
    quarantined: false,
    quarantine_reason: null,
    created_at: NOW,
    crosses_strait: Boolean(crosses),
  }
}

/**
 * A synthetic world with the real shape: 4 continents, 5 islands each (20
 * communities), assets of 6 passages, an entity layer at ~8% of nodes, and a
 * deliberate population of cross-island bridge entities.
 */
function makeWorld(targetNodes, seed = 1) {
  const rnd = splitmix32(seed)
  const CONTINENTS = 4
  const ISLANDS_PER = 5
  const PASSAGES_PER_ASSET = 6
  const islands = CONTINENTS * ISLANDS_PER
  const assetsPerIsland = Math.max(2, Math.round((targetNodes * 0.92) / (islands * (PASSAGES_PER_ASSET + 1))))

  const nodes = []
  const edges = []
  let eid = 0

  const islandIds = []
  const assetsByIsland = new Map()
  const passagesByIsland = new Map()

  for (let c = 0; c < CONTINENTS; c++) {
    const cid = `cont-${c}`
    const myIslands = []
    for (let i = 0; i < ISLANDS_PER; i++) {
      const iid = `isl-${c}-${i}`
      myIslands.push(iid)
      islandIds.push(iid)
      const myAssets = []
      const myPassages = []
      for (let a = 0; a < assetsPerIsland; a++) {
        const aid = `ast-${c}-${i}-${a}`
        myAssets.push(aid)
        const pids = []
        for (let p = 0; p < PASSAGES_PER_ASSET; p++) {
          const pid = `psg-${c}-${i}-${a}-${p}`
          pids.push(pid)
          myPassages.push(pid)
          nodes.push({
            id: pid,
            kind: 'passage',
            label: `passage ${p}`,
            community_id: iid,
            centrality: rnd() * 0.35,
            degree: 3,
            created_at: NOW,
            parent_id: aid,
            asset_id: aid,
            source_id: `src-${c}-${i}-${a}`,
            seq: p,
            char_start: p * 400,
            char_end: (p + 1) * 400,
            content_hash: '0'.repeat(64),
            text: '',
            resolution: 'verbatim',
            token_count: 90,
            entity_ids: [],
          })
          if (p > 0) {
            edges.push(edge(`e${eid++}`, pids[p - 1], pid, '_follows', 'structural', '_precedes', 0.95, false))
          }
          if (p > 1) {
            edges.push(edge(`e${eid++}`, pids[p - 2], pid, '_co_doc', 'structural', '_co_doc', 0.6, false))
          }
        }
        nodes.push({
          id: aid,
          kind: 'asset',
          label: `asset ${a}`,
          community_id: iid,
          centrality: 0.2 + rnd() * 0.4,
          degree: PASSAGES_PER_ASSET,
          created_at: NOW,
          parent_id: iid,
          continent_id: cid,
          boundary_kind: 'contract',
          boundary_declared_at: NOW,
          source_id: `src-${c}-${i}-${a}`,
          passage_ids: pids,
          entity_ids: [],
          token_count: PASSAGES_PER_ASSET * 90,
          summary: '',
        })
      }
      assetsByIsland.set(iid, myAssets)
      passagesByIsland.set(iid, myPassages)
      nodes.push({
        id: iid,
        kind: 'island',
        label: `island ${c}-${i}`,
        community_id: iid,
        centrality: 0.5 + rnd() * 0.3,
        degree: myAssets.length,
        created_at: NOW,
        parent_id: cid,
        asset_ids: myAssets,
        bridge_entity_ids: [],
        passage_count: myPassages.length,
        summary: '',
      })
    }
    nodes.push({
      id: cid,
      kind: 'continent',
      label: `continent ${c}`,
      community_id: myIslands[0],
      centrality: 0.9,
      degree: myIslands.length,
      created_at: NOW,
      parent_id: null,
      island_ids: myIslands,
      asset_count: myIslands.length * assetsPerIsland,
      passage_count: myIslands.length * assetsPerIsland * PASSAGES_PER_ASSET,
      summary: '',
    })
  }

  /* ── entity layer: ~8% of the world, 12% of them bridging two islands ──── */
  const entityCount = Math.max(8, Math.round(targetNodes * 0.08))
  const FAMILIES = [
    ['operates', 'factual', 'operated_by'],
    ['part_of', 'factual', 'has_part'],
    ['located_in', 'factual', 'location_of'],
    ['acquired', 'episodic', 'acquired_by'],
    ['supplies', 'factual', 'supplied_by'],
    ['causes', 'causal', 'caused_by'],
    ['authored_by', 'authorial', 'authored'],
    ['occurred_at', 'temporal', null],
  ]
  const entityIds = []
  for (let n = 0; n < entityCount; n++) {
    const isBridge = n % 8 === 0
    const homeIsland = islandIds[Math.floor(rnd() * islandIds.length)]
    const farIsland = islandIds[Math.floor(rnd() * islandIds.length)]
    const myIslands = isBridge && farIsland !== homeIsland ? [homeIsland, farIsland] : [homeIsland]
    const mentions = []
    const assetIds = []
    for (const iid of myIslands) {
      const pool = passagesByIsland.get(iid)
      const k = 2 + Math.floor(rnd() * 3)
      for (let j = 0; j < k; j++) {
        const pid = pool[Math.floor(rnd() * pool.length)]
        mentions.push(pid)
        assetIds.push(pid.split('-').slice(0, 4).join('-').replace('psg', 'ast'))
      }
    }
    const id = `ent-${n}`
    entityIds.push(id)
    nodes.push({
      id,
      kind: 'entity',
      label: `entity ${n}`,
      community_id: homeIsland,
      centrality: rnd() * 0.6,
      degree: mentions.length,
      created_at: NOW,
      parent_id: null,
      entity_type: 'organization',
      aliases: [],
      mentions,
      asset_ids: [...new Set(assetIds)],
      island_ids: [...new Set(myIslands)],
      is_bridge: [...new Set(myIslands)].length > 1,
      summary: '',
    })
  }
  for (let n = 0; n < entityIds.length; n++) {
    const relations = 1 + Math.floor(rnd() * 3)
    for (let k = 0; k < relations; k++) {
      const other = entityIds[Math.floor(rnd() * entityIds.length)]
      if (other === entityIds[n]) continue
      const [family, sigma, inv] = FAMILIES[Math.floor(rnd() * FAMILIES.length)]
      edges.push(edge(`e${eid++}`, entityIds[n], other, family, sigma, inv, 0.4 + rnd() * 0.5, false))
    }
  }

  return { nodes, edges, islandIds, assetsByIsland, passagesByIsland }
}

/**
 * Plant the contract's DEMO_GROUND_TRUTH chain into a world, on two named
 * islands, so the bridge-entity-in-the-strait claim can be measured rather than
 * asserted.
 */
function plantGroundTruth(world) {
  const islandA = world.islandIds[2]
  const islandB = world.islandIds[13]
  const passA = world.passagesByIsland.get(islandA).slice(0, 4)
  const passB = world.passagesByIsland.get(islandB).slice(0, 4)
  const assetsOf = (pids) => [...new Set(pids.map((p) => p.split('-').slice(0, 4).join('-').replace('psg', 'ast')))]

  const mk = (id, label, mentions, islands, isBridge, community) => ({
    id,
    kind: 'entity',
    label,
    community_id: community,
    centrality: 0.85,
    degree: mentions.length,
    created_at: NOW,
    parent_id: null,
    entity_type: 'organization',
    aliases: [],
    mentions,
    asset_ids: assetsOf(mentions),
    island_ids: islands,
    is_bridge: isBridge,
    summary: '',
  })

  world.nodes.push(mk('ent-bruntorp', 'Bruntorp Facility', passA.slice(0, 2), [islandA], false, islandA))
  world.nodes.push(mk('ent-rimsdal', 'Rimsdal Group', passB.slice(0, 2), [islandB], false, islandB))
  world.nodes.push(
    mk('ent-tollstrand', 'Tollstrand Battery', [...passA.slice(2), ...passB.slice(2)], [islandA, islandB], true, islandA),
  )
  world.edges.push(edge('e-gt-1', 'ent-tollstrand', 'ent-bruntorp', 'operates', 'factual', 'operated_by', 0.95, true))
  world.edges.push(edge('e-gt-2', 'ent-rimsdal', 'ent-tollstrand', 'acquired', 'episodic', 'acquired_by', 0.95, true))
  return { islandA, islandB }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */
function shuffled(arr, seed) {
  const rnd = splitmix32(seed)
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = out[i]
    out[i] = out[j]
    out[j] = t
  }
  return out
}

function positionFingerprint(bakeResult) {
  // Bit-exact: hash the raw float bits, not a rounded string.
  const sorted = bakeResult.positions.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const buf = new Float64Array(sorted.length * 3)
  for (let i = 0; i < sorted.length; i++) {
    buf[i * 3] = sorted[i].x
    buf[i * 3 + 1] = sorted[i].y
    buf[i * 3 + 2] = sorted[i].r
  }
  const bytes = new Uint8Array(buf.buffer)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < bytes.length; i++) {
    h1 = (h1 ^ bytes[i]) >>> 0
    h1 = Math.imul(h1, 16777619) >>> 0
    h2 = (h2 + bytes[i]) >>> 0
    h2 = Math.imul(h2, 2246822519) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function fmt(ms) {
  return `${ms.toFixed(1)} ms`
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

const line = (label, value) => console.log(`  ${label.padEnd(46, '.')} ${value}`)

/* ═════════════════════════════════════════════════════════════════════════ */
console.log('\nTLDR-G VISUAL DEMO — bake benchmark (measured, node ' + process.version + ')')
console.log('='.repeat(78))

/* ── 1. 6K ───────────────────────────────────────────────────────────────── */
const w6 = makeWorld(6000, 11)
const gt = plantGroundTruth(w6)
const world6 = { nodes: w6.nodes, edges: w6.edges }
console.log(`\n[1] 6K WORLD  nodes=${world6.nodes.length}  edges=${world6.edges.length}`)

const opts = { now: NOW }
bake.bakeLayout(world6, opts) // warm the JIT
const t6 = []
let bake6
for (let i = 0; i < 7; i++) {
  const t0 = performance.now()
  bake6 = bake.bakeLayout(world6, opts)
  t6.push(performance.now() - t0)
}
line('bake time (median of 7)', fmt(median(t6)))
line('bake time (best / worst)', `${fmt(Math.min(...t6))} / ${fmt(Math.max(...t6))}`)
line('budget', '400 ms')
line('verdict', median(t6) < 400 ? 'PASS' : 'FAIL')
line('content_hash', bake6.content_hash.slice(0, 24) + '…')
line('bake_id', bake6.bake_id)
line('bounds', `x[${bake6.bounds.min_x.toFixed(1)}, ${bake6.bounds.max_x.toFixed(1)}] y[${bake6.bounds.min_y.toFixed(1)}, ${bake6.bounds.max_y.toFixed(1)}]`)

/* ── 2. determinism ──────────────────────────────────────────────────────── */
console.log('\n[2] DETERMINISM')
const fpA = positionFingerprint(bake6)
const fpB = positionFingerprint(bake.bakeLayout(world6, opts))
const worldShuffled = { nodes: shuffled(world6.nodes, 7), edges: shuffled(world6.edges, 8) }
const bakeShuffled = bake.bakeLayout(worldShuffled, opts)
const fpC = positionFingerprint(bakeShuffled)
line('same world, re-baked', fpA === fpB ? `identical (${fpA})` : `DIFFERENT ${fpA} vs ${fpB}`)
line('same world, input arrays shuffled', fpA === fpC ? `identical (${fpC})` : `DIFFERENT ${fpA} vs ${fpC}`)
line('content_hash stable under shuffle', bake6.content_hash === bakeShuffled.content_hash ? 'yes' : 'NO')

/* ── 3. cluster separation ───────────────────────────────────────────────── */
function separation(bakeResult, world) {
  const comm = new Map()
  for (const n of world.nodes) comm.set(n.id, n.community_id)
  const pts = bakeResult.positions.filter((p) => p.kind === 'passage' || p.kind === 'asset')
  const rnd = splitmix32(99)
  let intra = 0
  let intraN = 0
  let inter = 0
  let interN = 0
  const SAMPLES = 300000
  for (let s = 0; s < SAMPLES; s++) {
    const a = pts[Math.floor(rnd() * pts.length)]
    const b = pts[Math.floor(rnd() * pts.length)]
    if (a === b) continue
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    if (comm.get(a.id) === comm.get(b.id)) {
      intra += d
      intraN++
    } else {
      inter += d
      interN++
    }
  }
  return { intra: intra / intraN, inter: inter / interN, intraN, interN }
}

function purity(bakeResult, world, radiusFrac) {
  const comm = new Map()
  for (const n of world.nodes) comm.set(n.id, n.community_id)
  const idx = bake.buildSpatialIndex(bakeResult.positions)
  const diag = Math.hypot(
    bakeResult.bounds.max_x - bakeResult.bounds.min_x,
    bakeResult.bounds.max_y - bakeResult.bounds.min_y,
  )
  const r = diag * radiusFrac
  const rnd = splitmix32(123)
  let same = 0
  let total = 0
  const out = []
  for (let s = 0; s < 3000; s++) {
    const p = bakeResult.positions[Math.floor(rnd() * bakeResult.positions.length)]
    bake.queryRadius(idx, p.x, p.y, r, out)
    for (const i of out) {
      if (idx.ids[i] === p.id) continue
      total++
      if (comm.get(idx.ids[i]) === comm.get(p.id)) same++
    }
  }
  return total === 0 ? 0 : same / total
}

console.log('\n[3] CLUSTER SEPARATION (6K, asset+passage nodes, 300k sampled pairs)')
const sep6 = separation(bake6, world6)
line('mean INTRA-community distance', sep6.intra.toFixed(2) + ' layout units')
line('mean INTER-community distance', sep6.inter.toFixed(2) + ' layout units')
line('separation ratio (inter / intra)', (sep6.inter / sep6.intra).toFixed(2) + '×')
line('neighbour purity within 2% of diagonal', (purity(bake6, world6, 0.02) * 100).toFixed(1) + '%')
line('neighbour purity within 5% of diagonal', (purity(bake6, world6, 0.05) * 100).toFixed(1) + '%')

/* ── 4. bridge entity in the strait ──────────────────────────────────────── */
console.log('\n[4] BRIDGE ENTITY GEOMETRY (DEMO_GROUND_TRUTH chain)')
{
  const pos = bake.positionsById(bake6)
  const A = pos.get(gt.islandA)
  const B = pos.get(gt.islandB)
  const K = pos.get('ent-tollstrand')
  const T = pos.get('ent-bruntorp')
  const N = pos.get('ent-rimsdal')
  const strait = Math.hypot(A.x - B.x, A.y - B.y)
  const midX = (A.x + B.x) / 2
  const midY = (A.y + B.y) / 2
  const dA = Math.hypot(K.x - A.x, K.y - A.y)
  const dB = Math.hypot(K.x - B.x, K.y - B.y)
  line('island A ↔ island B centre distance', strait.toFixed(1))
  line('Tollstrand Battery → island A', dA.toFixed(1))
  line('Tollstrand Battery → island B', dB.toFixed(1))
  line('offset from the exact midpoint', Math.hypot(K.x - midX, K.y - midY).toFixed(1) + ` (${((Math.hypot(K.x - midX, K.y - midY) / strait) * 100).toFixed(1)}% of the crossing)`)
  line('balance |dA-dB| / strait', (((Math.abs(dA - dB)) / strait) * 100).toFixed(1) + '%')
  line('Bruntorp Facility → island A', Math.hypot(T.x - A.x, T.y - A.y).toFixed(1))
  line('Rimsdal Group → island B', Math.hypot(N.x - B.x, N.y - B.y).toFixed(1))
}

/* ── 5. re-bake drift ────────────────────────────────────────────────────── */
console.log('\n[5] RE-BAKE STABILITY (+10% nodes added, 3% removed)')
{
  const rnd = splitmix32(4242)
  const leafKinds = new Set(['passage', 'entity'])
  const leaves = world6.nodes.filter((n) => leafKinds.has(n.kind) && !n.id.startsWith('ent-tollstrand'))
  const doomed = new Set()
  const removeTarget = Math.round(world6.nodes.length * 0.03)
  while (doomed.size < removeTarget) doomed.add(leaves[Math.floor(rnd() * leaves.length)].id)

  const kept = world6.nodes
    .filter((n) => !doomed.has(n.id))
    .map((n) => {
      const c = { ...n }
      if (c.passage_ids) c.passage_ids = c.passage_ids.filter((p) => !doomed.has(p))
      if (c.mentions) c.mentions = c.mentions.filter((p) => !doomed.has(p))
      return c
    })
  const keptEdges = world6.edges.filter((e) => !doomed.has(e.from_id) && !doomed.has(e.to_id))

  // Additions: whole new assets (with their passages) hung off existing islands.
  const addTarget = Math.round(world6.nodes.length * 0.1)
  const newNodes = []
  const newEdges = []
  let added = 0
  let a = 0
  const islandNodes = kept.filter((n) => n.kind === 'island')
  while (added < addTarget) {
    const isl = islandNodes[a % islandNodes.length]
    const aid = `ast-new-${a}`
    const pids = []
    for (let p = 0; p < 6 && added < addTarget; p++) {
      const pid = `psg-new-${a}-${p}`
      pids.push(pid)
      newNodes.push({
        id: pid, kind: 'passage', label: 'new', community_id: isl.community_id,
        centrality: rnd() * 0.3, degree: 2, created_at: NOW, parent_id: aid, asset_id: aid,
        source_id: 'src-new', seq: p, char_start: 0, char_end: 1, content_hash: '0'.repeat(64),
        text: '', resolution: 'verbatim', token_count: 80, entity_ids: [],
      })
      if (p > 0) newEdges.push(edge(`en${a}-${p}`, pids[p - 1], pid, '_follows', 'structural', '_precedes', 0.95, false))
      added++
    }
    newNodes.push({
      id: aid, kind: 'asset', label: 'new asset', community_id: isl.community_id,
      centrality: 0.3, degree: pids.length, created_at: NOW, parent_id: isl.id,
      continent_id: isl.parent_id, boundary_kind: 'contract', boundary_declared_at: NOW,
      source_id: 'src-new', passage_ids: pids, entity_ids: [], token_count: 480, summary: '',
    })
    isl.asset_ids = [...isl.asset_ids, aid]
    added++
    a++
  }

  const world6b = { nodes: [...kept, ...newNodes], edges: [...keptEdges, ...newEdges] }
  const t0 = performance.now()
  const rebaked = bake.rebakeAnchored(bake6, world6b, opts)
  const rebakeMs = performance.now() - t0
  const al = rebaked.anchor_alignment
  const anchors = new Set(bake6.positions.map((p) => p.id))
  const survived = rebaked.positions.filter((p) => anchors.has(p.id)).length

  line('nodes before / after', `${world6.nodes.length} / ${world6b.nodes.length}`)
  line('removed / added', `${doomed.size} / ${newNodes.length}`)
  line('surviving anchors', String(survived))
  line('rebake time', fmt(rebakeMs))
  line('rotation applied', `${((al.rotation * 180) / Math.PI).toFixed(2)}°`)
  line('uniform scale applied', al.scale.toFixed(4))
  line('translation applied', `[${al.translate[0].toFixed(1)}, ${al.translate[1].toFixed(1)}]`)
  line('mean_drift (layout units)', al.mean_drift.toFixed(2))
  line('mean_drift as % of world diagonal', bake.meanDriftPercent(al, rebaked.bounds).toFixed(2) + '%')

  // Counterfactual: what an UNANCHORED re-bake would have cost the user.
  const naive = bake.bakeLayout(world6b, opts)
  const naivePos = bake.positionsById(naive)
  let naiveDrift = 0
  let nCount = 0
  for (const p of bake6.positions) {
    const q = naivePos.get(p.id)
    if (!q) continue
    naiveDrift += Math.hypot(q.x - p.x, q.y - p.y)
    nCount++
  }
  naiveDrift /= nCount
  const diag = Math.hypot(naive.bounds.max_x - naive.bounds.min_x, naive.bounds.max_y - naive.bounds.min_y)
  line('UNANCHORED re-bake drift (counterfactual)', naiveDrift.toFixed(2) + ` (${((naiveDrift / diag) * 100).toFixed(2)}% of diagonal)`)
  line('improvement from anchoring', (naiveDrift / al.mean_drift).toFixed(1) + '× less movement')

  for (const mobility of [0, 0.2, 0.5, 1]) {
    const r2 = bake.rebakeAnchored(bake6, world6b, { ...opts, anchoredMobility: mobility })
    line(`  drift @ anchoredMobility=${mobility}`, r2.anchor_alignment.mean_drift.toFixed(2) + ` (${bake.meanDriftPercent(r2.anchor_alignment, r2.bounds).toFixed(2)}%)`)
  }

  // Idempotence: re-baking an UNCHANGED world against itself must not move it.
  const same = bake.rebakeAnchored(bake6, world6, opts)
  const same0 = bake.rebakeAnchored(bake6, world6, { ...opts, anchoredMobility: 0 })
  line('drift when the corpus did not change', same.anchor_alignment.mean_drift.toFixed(3) + ` (${bake.meanDriftPercent(same.anchor_alignment, same.bounds).toFixed(3)}%)`)
  line('  same, at anchoredMobility=0', same0.anchor_alignment.mean_drift.toFixed(3))
}

/* ── 6. 100K ─────────────────────────────────────────────────────────────── */
console.log('\n[6] 100K WORLD')
if (global.gc) global.gc()
const before = process.memoryUsage()
const w100 = makeWorld(100000, 5)
const world100 = { nodes: w100.nodes, edges: w100.edges }
const afterBuild = process.memoryUsage()
line('nodes / edges', `${world100.nodes.length} / ${world100.edges.length}`)

const t100 = []
let bake100
for (let i = 0; i < 3; i++) {
  const t0 = performance.now()
  bake100 = bake.bakeLayout(world100, opts)
  t100.push(performance.now() - t0)
}
if (global.gc) global.gc()
const afterBake = process.memoryUsage()
line('bake time (median of 3)', fmt(median(t100)))
line('bake time (best / worst)', `${fmt(Math.min(...t100))} / ${fmt(Math.max(...t100))}`)
line('positions emitted', String(bake100.positions.length))
line('heap: corpus construction', mb(afterBuild.heapUsed - before.heapUsed))
line('heap: after bake (retained)', mb(afterBake.heapUsed - afterBuild.heapUsed))
line('heap total / rss at peak', `${mb(afterBake.heapTotal)} / ${mb(afterBake.rss)}`)
{
  const n = world100.nodes.length
  const m = world100.edges.length
  const featureBytes = n * 16 * 4 * 2
  const posBytes = n * 4 * 4
  const adjBytes = (m + n * 4) * 2 * 8
  line('typed-array working set (computed)', `${mb(featureBytes + posBytes + adjBytes)} (features ${mb(featureBytes)}, adjacency ~${mb(adjBytes)})`)
}

console.log('\n[7] 100K CLUSTER SEPARATION + INDEX')
const sep100 = separation(bake100, world100)
line('mean INTRA-community distance', sep100.intra.toFixed(2))
line('mean INTER-community distance', sep100.inter.toFixed(2))
line('separation ratio (inter / intra)', (sep100.inter / sep100.intra).toFixed(2) + '×')
line('neighbour purity within 2% of diagonal', (purity(bake100, world100, 0.02) * 100).toFixed(1) + '%')

{
  const t0 = performance.now()
  const idx = bake.buildSpatialIndex(bake100.positions)
  const buildMs = performance.now() - t0
  line('spatial index build (100k)', fmt(buildMs))
  line('grid', `${idx.cols} × ${idx.rows} cells, ${(idx.count / (idx.cols * idx.rows)).toFixed(2)} nodes/cell`)
  {
    const rsorted = Float32Array.from(idx.rs).sort()
    const p = (q) => rsorted[Math.floor(q * (rsorted.length - 1))].toFixed(1)
    line('node radius p50 / p90 / p99 / max', `${p(0.5)} / ${p(0.9)} / ${p(0.99)} / ${p(1)}`)
    const per = []
    for (let L = 0; L < idx.hitLevels; L++) {
      const cells = idx.hitCols[L] * idx.hitRows[L]
      const entries = idx.hitItems[L].length
      if (entries) per.push(`L${L}:${entries}/${cells}c`)
    }
    line('hit levels (entries/cells)', per.join(' '))
    // measured candidates actually distance-tested per pick
    const rnd2 = splitmix32(77)
    let cand = 0
    const N2 = 20000
    for (let s = 0; s < N2; s++) {
      const q = bake100.positions[Math.floor(rnd2() * bake100.positions.length)]
      for (let L = 0; L < idx.hitLevels; L++) {
        const cs = idx.hitBase * 2 ** L
        const gx = Math.min(idx.hitCols[L] - 1, Math.max(0, Math.floor((q.x - idx.bounds.min_x) / cs)))
        const gy = Math.min(idx.hitRows[L] - 1, Math.max(0, Math.floor((q.y - idx.bounds.min_y) / cs)))
        const c = gy * idx.hitCols[L] + gx
        cand += idx.hitStart[L][c + 1] - idx.hitStart[L][c]
      }
    }
    line('candidates distance-tested per pick', (cand / N2).toFixed(1))
  }

  const rnd = splitmix32(31)
  const N = 200000
  const t1 = performance.now()
  let hits = 0
  for (let i = 0; i < N; i++) {
    const p = bake100.positions[Math.floor(rnd() * bake100.positions.length)]
    if (bake.pickAt(idx, p.x, p.y, 0) >= 0) hits++
  }
  const pickMs = performance.now() - t1
  line('pickAt × 200,000', `${fmt(pickMs)} → ${((pickMs / N) * 1000).toFixed(3)} µs/pick`)
  line('pick hit rate', ((hits / N) * 100).toFixed(1) + '%')

  const out = []
  const t2 = performance.now()
  let touched = 0
  for (let i = 0; i < 50000; i++) {
    const p = bake100.positions[Math.floor(rnd() * bake100.positions.length)]
    bake.queryRadius(idx, p.x, p.y, 8, out)
    touched += out.length
  }
  const qMs = performance.now() - t2
  line('queryRadius(r=8) × 50,000', `${fmt(qMs)} → ${((qMs / 50000) * 1000).toFixed(3)} µs/query, ${(touched / 50000).toFixed(1)} hits avg`)
  line('linear-scan equivalent would be', `${(100000).toLocaleString()} tests/query`)
}

/* ── 8. rung invariant + latent grid ─────────────────────────────────────── */
console.log('\n[8] SPINE INVARIANT + LATENT GRID')
{
  const pos = bake.positionsById(bake6)
  let worstAsset = 0
  let worstIsland = 0
  let worstCont = 0
  for (const n of world6.nodes) {
    const kids =
      n.kind === 'asset' ? n.passage_ids : n.kind === 'island' ? n.asset_ids : n.kind === 'continent' ? n.island_ids : null
    if (!kids || kids.length === 0) continue
    let cx = 0
    let cy = 0
    let k = 0
    for (const id of kids) {
      const p = pos.get(id)
      if (!p) continue
      cx += p.x
      cy += p.y
      k++
    }
    if (k === 0) continue
    const me = pos.get(n.id)
    const d = Math.hypot(me.x - cx / k, me.y - cy / k)
    if (n.kind === 'asset') worstAsset = Math.max(worstAsset, d)
    if (n.kind === 'island') worstIsland = Math.max(worstIsland, d)
    if (n.kind === 'continent') worstCont = Math.max(worstCont, d)
  }
  line('max |asset − centroid(passages)|', worstAsset.toExponential(2))
  line('max |island − centroid(assets)|', worstIsland.toExponential(2))
  line('max |continent − centroid(islands)|', worstCont.toExponential(2))

  const latent = bake.gridSnapForLatent(240, { extent: 1000 })
  const allLatent = latent.every((p) => p.lod_hint === 'latent')
  const latentB = bake.gridSnapForLatent(240, { extent: 1000 })
  line('gridSnapForLatent(240)', `${latent.length} positions, all lod_hint=latent: ${allLatent}`)
  line('latent grid deterministic', JSON.stringify(latent) === JSON.stringify(latentB) ? 'yes' : 'NO')
  line('boundsOf(latent grid)', `${bake.boundsOf(latent).min_x.toFixed(1)} … ${bake.boundsOf(latent).max_x.toFixed(1)}`)

  const rung = bake.bakeRung(world6, 'island', 'cont-1', bake6)
  line('bakeRung(island, cont-1)', `${rung.positions.length} positions`)
  const rung2 = bake.bakeRung(world6, 'continent', null, bake6)
  line('bakeRung(continent, null)', `${rung2.positions.length} positions`)
}

console.log('\n' + '='.repeat(78) + '\n')
await rm(outDir, { recursive: true, force: true })
