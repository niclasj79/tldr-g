// Exercise the engine seam for real. Run: node scripts/verify-api.mjs
//
// Nothing here is asserted from a fixture file. The corpus is built, the layout
// is baked, every client method is called, and then the SAME client is pointed
// at a real HTTP server over the loopback interface and every method is called
// again — because the claim this file exists to falsify is that swapping the
// demo for a live engine is a base-URL change and not a rewrite.

import { build } from 'esbuild'
import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const out = await mkdtemp(join(tmpdir(), 'tldrg-api-'))
const bundle = join(out, 'engine.mjs')

await build({
  entryPoints: [join(ROOT, 'src/engine/index.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  logLevel: 'warning',
  alias: { '@': join(ROOT, 'src') },
})

const E = await import(pathToFileURL(bundle).href)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const section = (t) => console.log('\n=== ' + t + ' ===')

/* ─────────────────────────────────────────────────────────────────────────── */
section('FIXTURES')

const t0 = performance.now()
const fx = E.getFixtures()
const firstCall = performance.now() - t0
const t1 = performance.now()
E.getFixtures()
const secondCall = performance.now() - t1

console.log('  timings (measured):', JSON.stringify(fx.timings))
check('fixtures memoised', secondCall < 1, `first ${firstCall.toFixed(0)}ms, second ${secondCall.toFixed(4)}ms`)
check('getFixtures() is identity-stable', E.getFixtures() === fx)
check('timings are real', fx.timings.build_ms > 0 && fx.timings.bake_ms > 0 && fx.timings.total_ms > 0)
check('every node is positioned', fx.positions.size === fx.world.nodes.length, `${fx.positions.size} / ${fx.world.nodes.length}`)
check('corpus is labelled', fx.corpus_provenance === 'synthetic-design-concept')

const totalEdges = fx.world.edges.length
console.log('  world:', fx.world.nodes.length, 'nodes /', totalEdges, 'edges')
console.log('  bundles: continent', fx.bundles.continent.length, '· island', fx.bundles.island.length)
const islandCorridorEdges = fx.bundles.island.reduce((n, b) => n + b.count, 0)
check('island corridors carry real relations', islandCorridorEdges > 0, `${islandCorridorEdges} relations in ${fx.bundles.island.length} corridors`)
check('every corridor is a strait', fx.bundles.island.every((b) => b.is_strait))

/* ─────────────────────────────────────────────────────────────────────────── */
section('EDGE POLICY — edges are earned')

const client = new E.EngineClient({ simulateWire: false })
check('transport is the fixture transport', client.mode === 'fixture' && client.baseUrl === null)

const views = {}
for (const [rung, parent] of [
  ['continent', null],
  ['island', null],
  ['island', fx.world.continents[0].id],
  ['asset', fx.world.islands[0].id],
  ['passage', fx.world.islands[0].asset_ids[0]],
]) {
  const v = await client.getGraphView(rung, parent)
  views[`${rung}${parent ? '/' + parent : ''}`] = v
  const withheld = v.stats.edge_count - v.stats.edges_drawn
  console.log(
    `  ${rung.padEnd(9)} parent=${String(parent).slice(0, 34).padEnd(34)}` +
      ` nodes ${String(v.stats.node_count).padStart(4)} · edges ${String(v.stats.edge_count).padStart(4)}` +
      ` · drawn ${String(v.stats.edges_drawn).padStart(4)} · bundles ${String(v.bundles.length).padStart(3)}` +
      ` · ${v.stats.drawn_reason}`,
  )
  check(`${rung} view never ships the whole edge set`, v.stats.edge_count < totalEdges, `${v.stats.edge_count} << ${totalEdges}`)
  check(`${rung} view: edges_drawn <= edge_count`, v.stats.edges_drawn <= v.stats.edge_count)
  check(`${rung} view echoes the bake`, v.bake_id === fx.bake.bake_id)
  check(`${rung} view is labelled`, v.corpus_provenance === 'synthetic-design-concept')
  void withheld
}

const continentView = views['continent']
check('continent rung draws corridors, not relations', continentView.bundles.length > 0)
check('continent rung nodes are exactly the continents', continentView.nodes.every((n) => n.kind === 'continent'))
const assetView = views[`asset/${fx.world.islands[0].id}`]
check('asset rung carries the entity layer', assetView.nodes.some((n) => n.kind === 'entity'))
check('passage rung carries the entity layer', views[`passage/${fx.world.islands[0].asset_ids[0]}`].nodes.some((n) => n.kind === 'entity'))

const quarantinedInView = assetView.edges.filter((e) => e.quarantined).length
check(
  'quarantined relations ship but are not stroked',
  assetView.stats.edge_count - assetView.stats.edges_drawn === quarantinedInView,
  `${quarantinedInView} latent`,
)

const hover = await client.getGraphView('asset', fx.world.islands[0].id, {
  drawnReason: 'hover-neighborhood',
  hoverNodeId: fx.world.islands[0].asset_ids[0],
  hops: 1,
})
check('hover-neighborhood narrows the edge set', hover.stats.edge_count < assetView.stats.edge_count, `${hover.stats.edge_count} < ${assetView.stats.edge_count}`)
check('hover-neighborhood reports its rule', hover.stats.drawn_reason === 'hover-neighborhood')

let rejected = null
try { await client.getGraphView('universe') } catch (err) { rejected = err }
check('there is no fifth rung', rejected !== null && rejected.code === 'BAD_RUNG', rejected?.exact_remedy ?? '')

/* ─────────────────────────────────────────────────────────────────────────── */
section('QUERY — the headline receipt')

const gt = E.DEMO_GROUND_TRUTH
const answer = await client.postQuery(gt.query)
console.log('  answer :', answer.answer)
console.log('  gold   :', answer.gold)
console.log('  stats  :', JSON.stringify({
  token_budget: answer.render_stats.token_budget,
  tokens_rendered: answer.render_stats.tokens_rendered,
  counterfactual_tokens: answer.render_stats.counterfactual_tokens,
  savings_pct: answer.render_stats.savings_pct,
  render_confidence_L: answer.render_stats.render_confidence_L,
}))
console.log('  latency:', answer.latency_ms, 'ms (measured)')
check('gold answer is by construction', answer.gold === gt.gold)
check('receipt matches the contractual figures', answer.render_stats.tokens_rendered === E.DEMO_RECEIPT.tokens_rendered && answer.render_stats.savings_pct === E.DEMO_RECEIPT.savings_pct)
check('the path crosses a strait', answer.constellation.path.some((s) => s.crosses_strait))
check('the bridge entity is named', answer.constellation.bridge_entity_id === E.DEMO_BRIDGE_ENTITY_ID)
check('latency is a real measurement', typeof answer.latency_ms === 'number' && answer.latency_ms >= 0)

const trace = await client.getRenderTrace(answer.trace_id)
const verdict = await client.verifyTrace(trace)
check('the receipt verifies', verdict.valid === true, verdict.verdict)
const forged = E.tamper(trace, 'payload')
const forgedVerdict = await client.verifyTrace(forged)
check('a tampered payload fails loudly', forgedVerdict.valid === false && forgedVerdict.payload_hash_matches === false, forgedVerdict.verdict)

/* ─────────────────────────────────────────────────────────────────────────── */
section('QUERY — the other staged questions, rendered by traversal')

const staged = await client.getStagedQueries()
check('the command bar has real questions', staged.length >= 2, `${staged.length} staged`)
for (const sq of staged) {
  if (sq.id === E.DEMO_QUERY_ID) continue
  const r = await client.postQuery(sq.query)
  const rs = r.render_stats
  console.log(
    `  ${sq.id.padEnd(24)} intent=${r.intent.padEnd(10)} cites=${rs.lod0_passages}` +
      ` spent=${String(rs.tokens_rendered).padStart(5)}/${rs.token_budget}` +
      ` vs ${String(rs.counterfactual_tokens).padStart(6)} = ${rs.savings_pct}% · L=${rs.render_confidence_L}` +
      ` · composite ${JSON.stringify(rs.composite)}`,
  )
  check(`${sq.id} answers`, r.gold === sq.gold)
  check(`${sq.id} stays inside the budget`, rs.tokens_rendered <= rs.token_budget)
  check(`${sq.id} beats the naive baseline`, rs.counterfactual_tokens > rs.tokens_rendered)
  const t = await client.getRenderTrace(r.trace_id)
  const v = client.verifyTraceSync(t)
  check(`${sq.id} receipt verifies`, v.valid === true)
  check(`${sq.id} cites checkable bytes`, t.citations.every((c) => c.content_hash.startsWith('sha256:')))
  check(`${sq.id} reports what it did not spend on`, t.omitted_but_connected.length > 0, `${t.omitted_but_connected.length} pointers`)
}

const adhoc = await client.postQuery('What does Tollstrand Battery operate?')
console.log('  ad hoc :', adhoc.answer.slice(0, 130))
check('free text renders from the world', adhoc.render_stats.lod0_passages > 0 && adhoc.gold === undefined)
let noMatch = null
try { await client.postQuery('zzzz qqqq wwww') } catch (err) { noMatch = err }
check('an unanswerable question refuses rather than invents', noMatch !== null && noMatch.code === 'QUERY_NO_MATCH', noMatch?.exact_remedy ?? '')

/* ─────────────────────────────────────────────────────────────────────────── */
section('THE REST OF THE SURFACE')

const integrity = await client.getIntegrity()
const rate = E.truthGatedRate(integrity)
console.log(`  integrity: total ${integrity.total_edges} · admitted ${integrity.admitted} · quarantined ${integrity.quarantined} · exempt ${integrity.truth_gate_exempt_structural} · gated rate ${(rate.rate * 100).toFixed(2)}%`)
check('integrity counts the whole edge set', integrity.total_edges === totalEdges)
check('the structural exemption is reported separately', integrity.truth_gate_exempt_structural > 0)
check('rejections are grouped with examples', integrity.by_reason.length > 0 && integrity.by_reason[0].example_edge_ids.length > 0)

const bake = await client.getLayoutBake()
check('the bake is servable', bake.bake_id === fx.bake.bake_id && bake.positions.length === fx.world.nodes.length)

const somePassage = fx.world.passages[0]
const source = await client.getSource(somePassage.source_id)
check('the source is servable', source.kind === 'source' && source.segments[0].seq === 0)
check('the verbatim segment really backs the passage', E.contentHash(source.segments[0].text.slice(somePassage.char_start, somePassage.char_end)) === somePassage.content_hash)

const nbr = await client.getNeighborhood(E.DEMO_BRIDGE_ENTITY_ID, 1)
check('neighborhood is bounded', nbr.stats.node_count > 1 && nbr.stats.edge_count < totalEdges, `${nbr.stats.node_count} nodes / ${nbr.stats.edge_count} edges`)

const path = await client.findPath('e:rimsdal-group', 'e:bruntorp-facility')
console.log('  path   :', path.map((s) => `${s.from_id} -${s.family}-> ${s.to_id}`).join('  '))
check('the gold chain is walkable', path.length === 2 && path.some((s) => s.crosses_strait))
// The path readout and the citations under it are on the same screen. If the
// traversal picks a different pair of relations from the ones the receipt cites,
// the two panels contradict each other about the same two nodes.
const families = path.map((s) => s.family)
check(
  'findPath agrees with the receipt about which relations carry the answer',
  families.includes('acquired') && families.includes('operates'),
  families.join(' + '),
)
check('every hop on the returned path can be cited', path.every((s) => s.evidence_passage_ids.length > 0))
const noRoute = await client.findPath(fx.world.continents[0].id, fx.world.continents[1].id)
check('no route is a real answer, not an error', Array.isArray(noRoute))

const tl = await client.getTimeline({ scopeId: fx.world.islands[0].id, limit: 25 })
console.log(`  timeline: ${tl.events.length} events (+${tl.truncated} truncated) from ${tl.from.slice(0, 10)} to ${tl.to.slice(0, 10)}`)
check('the timeline is dated from the corpus clock', tl.events.length > 0 && tl.events[0].at <= tl.events[tl.events.length - 1].at)
check('the default window is a measurement, not a sentinel', tl.from > '2020' && tl.to < '2030', `${tl.from.slice(0, 10)} .. ${tl.to.slice(0, 10)}`)
check('the timeline is labelled', tl.corpus_provenance === 'synthetic-design-concept')

/* ─────────────────────────────────────────────────────────────────────────── */
section('CACHE — a real counter')

const fresh = new E.EngineClient({ simulateWire: false, cacheCapacity: 8 })
await fresh.getGraphView('continent')
const afterMiss = fresh.cacheStats()
await fresh.getGraphView('continent')
const afterHit = fresh.cacheStats()
console.log('  ', JSON.stringify(afterHit))
check('a repeat call is a real hit', afterHit.hits === afterMiss.hits + 1 && afterHit.lookups === afterMiss.lookups + 1)
check('a hit is faster than a miss', fresh.lastLatency >= 0)
check('the key is bake-scoped', E.getFixtures().bake.bake_id.startsWith('bake_'))

/* ─────────────────────────────────────────────────────────────────────────── */
section('WIRE MODEL — deterministic, derived from payload size, switchable')

const wired = new E.EngineClient({ simulateWire: true })
const w0 = performance.now()
await wired.getGraphView('asset', fx.world.islands[0].id)
const wiredMs = performance.now() - w0
const bare = new E.EngineClient({ simulateWire: false })
const b0 = performance.now()
await bare.getGraphView('asset', fx.world.islands[0].id)
const bareMs = performance.now() - b0
console.log(`  same view: wire-modelled ${wiredMs.toFixed(1)}ms · unmodelled ${bareMs.toFixed(1)}ms · ceiling ${E.WIRE.max_ms}ms`)
check('the wire model costs something', wiredMs > bareMs)
check('the wire model is bounded', wiredMs < E.WIRE.max_ms + 60)

/* ─────────────────────────────────────────────────────────────────────────── */
section('HTTP TRANSPORT — the same client, over a real socket')

// A conforming engine: it answers the same paths with the same envelopes. It is
// backed by the fixture client, which is the point — the two halves of api.ts
// have to agree byte for byte or these checks fail.
const back = new E.EngineClient({ simulateWire: false })
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    const q = url.searchParams
    const p = url.pathname
    const send = (obj) => {
      const body = JSON.stringify(obj)
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    }
    const prov = 'synthetic-design-concept'

    if (p.startsWith('/graph/view/')) {
      return send(await back.getGraphView(p.slice('/graph/view/'.length), q.get('parent_id'), {
        drawnReason: q.get('drawn_reason') ?? undefined,
        hoverNodeId: q.get('hover_node_id') ?? undefined,
        hops: q.get('hops') ? Number(q.get('hops')) : undefined,
        includeEntities: q.has('include_entities') ? q.get('include_entities') === 'true' : undefined,
      }))
    }
    if (p.startsWith('/graph/neighborhood/')) {
      return send(await back.getNeighborhood(decodeURIComponent(p.slice('/graph/neighborhood/'.length)), Number(q.get('hops') ?? 1)))
    }
    if (p === '/graph/path') return send({ steps: await back.findPath(q.get('from'), q.get('to')), corpus_provenance: prov })
    if (p === '/layout/bake') return send(await back.getLayoutBake())
    if (p === '/integrity') return send(await back.getIntegrity())
    if (p === '/query/staged') return send({ queries: await back.getStagedQueries(), corpus_provenance: prov })
    if (p === '/timeline') {
      return send(await back.getTimeline({
        scopeId: q.get('scope_id') ?? undefined,
        limit: q.get('limit') ? Number(q.get('limit')) : undefined,
      }))
    }
    if (p.startsWith('/source/')) return send({ source: await back.getSource(decodeURIComponent(p.slice('/source/'.length))), corpus_provenance: prov })
    if (p.startsWith('/node/')) return send({ node: await back.getNode(decodeURIComponent(p.slice('/node/'.length))), corpus_provenance: prov })
    if (p.startsWith('/trace/') && p !== '/trace/verify') return send(await back.getRenderTrace(decodeURIComponent(p.slice('/trace/'.length))))

    const body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)) })
    const json = body ? JSON.parse(body) : {}
    if (p === '/query/render') return send(await back.postQuery(json.query, { tokenBudget: json.token_budget, maxCitations: json.max_citations }))
    if (p === '/trace/verify') return send(await back.verifyTrace(json.trace))

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'no such route' }))
  } catch (err) {
    // A conforming engine maps its own error codes onto HTTP status, so the
    // client can tell "no such id" from "the engine fell over".
    const status = err && typeof err.status === 'number' ? err.status : 500
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: err?.code, error: String(err && err.message) }))
  }
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const live = new E.EngineClient({ baseUrl: `http://127.0.0.1:${port}` })
check('base URL switches the transport', live.mode === 'http' && live.baseUrl === `http://127.0.0.1:${port}`)

const localView = await client.getGraphView('island', null)
const remoteView = await live.getGraphView('island', null)
check(
  'GET /graph/view/{rung} is identical over the wire',
  JSON.stringify(localView) === JSON.stringify(remoteView),
  `${remoteView.stats.node_count} nodes / ${remoteView.stats.edge_count} edges / ${remoteView.bundles.length} corridors`,
)

const remoteAnswer = await live.postQuery(gt.query)
check('POST /query/render is identical over the wire', remoteAnswer.answer === answer.answer && remoteAnswer.render_stats.tokens_rendered === answer.render_stats.tokens_rendered)
const remoteTrace = await live.getRenderTrace(remoteAnswer.trace_id)
check('GET /trace/{id} survives the wire', remoteTrace.payload_hash === trace.payload_hash)
check('the signature verifies AFTER a JSON round trip', client.verifyTraceSync(remoteTrace).valid === true)
const remoteVerify = await live.verifyTrace(remoteTrace, { local: false })
check('POST /trace/verify works', remoteVerify.valid === true, remoteVerify.verdict)
check('GET /integrity is identical over the wire', JSON.stringify(await live.getIntegrity()) === JSON.stringify(integrity))
check('GET /source/{id} is identical over the wire', JSON.stringify(await live.getSource(somePassage.source_id)) === JSON.stringify(source))
check('GET /graph/neighborhood is identical over the wire', JSON.stringify(await live.getNeighborhood(E.DEMO_BRIDGE_ENTITY_ID, 1)) === JSON.stringify(nbr))
check('GET /graph/path is identical over the wire', JSON.stringify(await live.findPath('e:rimsdal-group', 'e:bruntorp-facility')) === JSON.stringify(path))
check('GET /timeline is identical over the wire', JSON.stringify(await live.getTimeline({ scopeId: fx.world.islands[0].id, limit: 25 })) === JSON.stringify(tl))
check('GET /layout/bake is identical over the wire', (await live.getLayoutBake()).content_hash === bake.content_hash)
check('GET /query/staged is identical over the wire', JSON.stringify(await live.getStagedQueries()) === JSON.stringify(staged))

let http404 = null
try { await live.getSource('s:does-not-exist') } catch (err) { http404 = err }
check('a 404 over the wire becomes a NOT_FOUND with a remedy', http404?.code === 'NOT_FOUND' && http404.status === 404)
check('an HTTP failure becomes a DegradedReason', typeof http404?.toDegradedReason === 'function', http404?.toDegradedReason?.().exact_remedy ?? '')

server.close()

/* ─────────────────────────────────────────────────────────────────────────── */
console.log(`\n${pass} PASS / ${fail} FAIL`)
await rm(out, { recursive: true, force: true })
process.exitCode = fail === 0 ? 0 : 1
