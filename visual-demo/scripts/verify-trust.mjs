// Empirically verify the trust half. Run: node scripts/verify-trust.mjs
//
// Nothing in here is asserted alongside the thing it checks. The script bundles
// the real modules, rebuilds the real corpus, signs a real trace, tampers with
// real bytes, and prints what actually came out. If a number in the receipt has
// drifted, or a citation no longer hashes to the corpus's own bytes, this exits
// non-zero and says which one.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const out = await mkdtemp(join(tmpdir(), 'tldrg-trust-'))

await build({
  entryPoints: [
    join(ROOT, 'src/engine/trust/sign.ts'),
    join(ROOT, 'src/engine/trust/trace.ts'),
    join(ROOT, 'src/engine/trust/integrity.ts'),
    join(ROOT, 'src/engine/corpus/world.ts'),
  ],
  outdir: out,
  outbase: join(ROOT, 'src'),
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  logLevel: 'warning',
  outExtension: { '.js': '.mjs' },
  alias: { '@': join(ROOT, 'src') },
})

const load = (p) => import(pathToFileURL(join(out, p)).href)
const sign = await load('engine/trust/sign.mjs')
const trace = await load('engine/trust/trace.mjs')
const integrity = await load('engine/trust/integrity.mjs')
const corpus = await load('engine/corpus/world.mjs')

let failures = 0
const ok = (label, pass, detail = '') => {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
}
const eq = (label, actual, expected) =>
  ok(label, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)

/* ═══ 1. CANONICALIZATION ═════════════════════════════════════════════════ */
console.log('\n=== 1. CANONICALIZATION ===')
const c = sign.canonicalize
eq('key order does not matter', c({ b: 1, a: 2 }), c({ a: 2, b: 1 }))
eq('nested key order does not matter', c({ x: { z: 1, y: [1, { b: 2, a: 3 }] } }), c({ x: { y: [1, { a: 3, b: 2 }], z: 1 } }))
ok('array order DOES matter', c([1, 2]) !== c([2, 1]))
eq('undefined property == absent property', c({ a: 1, b: undefined }), c({ a: 1 }))
ok('null is NOT undefined', c({ a: 1, b: null }) !== c({ a: 1 }))
eq('undefined inside an array is null', c([undefined]), '[null]')
eq('no insignificant whitespace', c({ a: [1, 2], b: 'x' }), '{"a":[1,2],"b":"x"}')
eq('negative zero normalises', c(-0), '0')
eq('integers are plain', c(5040), '5040')
eq('floats round-trip shortest', c(0.1 + 0.2), '0.30000000000000004')
eq('Date uses toJSON', c(new Date(0)), '"1970-01-01T00:00:00.000Z"')
ok('NaN throws', (() => { try { c(NaN); return false } catch { return true } })())
ok('Infinity throws', (() => { try { c(Infinity); return false } catch { return true } })())
ok('bigint throws', (() => { try { c(1n); return false } catch { return true } })())
ok('Map throws', (() => { try { c(new Map()); return false } catch { return true } })())
ok('cycles throw', (() => { const o = {}; o.self = o; try { c(o); return false } catch { return true } })())
ok('different payloads differ', c({ a: 1 }) !== c({ a: 2 }))
eq('JSON round-trip is stable', c(JSON.parse(JSON.stringify({ b: [1, { d: 4, c: 3 }], a: 'x' }))), c({ a: 'x', b: [1, { c: 3, d: 4 }] }))

/* ═══ 2. KEYPAIR + SIGN/VERIFY ROUND TRIP ═════════════════════════════════ */
console.log('\n=== 2. SIGN -> VERIFY ===')
const kp = sign.getDemoKeypair()
console.log('did      :', kp.did)
console.log('key_id   :', kp.key_id)
console.log('pubkey   :', Buffer.from(kp.pub).toString('hex'))
ok('private key is 32 bytes', kp.priv.length === 32)
ok('public key is 32 bytes', kp.pub.length === 32)
ok('keypair is stable across calls', Buffer.from(sign.getDemoKeypair().pub).toString('hex') === Buffer.from(kp.pub).toString('hex'))

const signed = trace.buildDemoRenderTrace()
console.log('trace_id :', signed.trace_id)
console.log('payload  :', signed.payload_hash)
console.log('sig      :', signed.signature.sig)
console.log('alg      :', signed.signature.alg, '| provenance:', signed.corpus_provenance)

const v0 = sign.verifyTrace(signed, '2026-07-27T00:00:00.000Z')
eq('valid', v0.valid, true)
eq('payload_hash_matches', v0.payload_hash_matches, true)
eq('signature_valid', v0.signature_valid, true)
eq('verdict', v0.verdict, sign.VERDICT.VALID)

// The verdicts are asserted against the CONSTANT, not against literals — a literal
// here is how the strings drifted into being byte-identical with the real verifier's
// output in the first place. This guard pins the property that actually matters: every
// verdict this demo can emit is scope-prefixed, so a screenshot of it can never be
// mistaken for a genuine tp-vrg-verify result.
for (const [name, text] of Object.entries(sign.VERDICT)) {
  ok(`verdict ${name} is demo-scoped`, String(text).startsWith('demo:'), String(text))
}
eq('verify reports the did it checked', v0.did, kp.did)

const unsigned = trace.buildRenderTrace(trace.demoRenderTraceInput())
eq('an unsigned trace does not verify', sign.verifyTrace(unsigned).valid, false)
eq('...and its payload hash is still correct', sign.verifyTrace(unsigned).payload_hash_matches, true)
eq('...so the verdict blames the signature', sign.verifyTrace(unsigned).verdict, sign.VERDICT.SIGNATURE_MUTATED)
eq('signing is deterministic', trace.buildDemoRenderTrace().signature.sig, signed.signature.sig)
eq('the payload hash is deterministic', trace.buildDemoRenderTrace().payload_hash, signed.payload_hash)
eq('a JSON round-trip still verifies', sign.verifyTrace(JSON.parse(JSON.stringify(signed))).valid, true)

/* ═══ 3. TAMPER ═══════════════════════════════════════════════════════════ */
console.log('\n=== 3. TAMPER ===')
const tPayload = sign.tamper(signed, 'payload')
const vPayload = sign.verifyTrace(tPayload, '2026-07-27T00:00:00.000Z')
console.log('quote before:', signed.citations[0].quote.slice(0, 96) + '...')
console.log('quote after :', tPayload.citations[0].quote.slice(0, 96) + '...')
ok('tamper("payload") changed real bytes', tPayload.citations[0].quote !== signed.citations[0].quote)
ok('the original trace was not mutated', sign.verifyTrace(signed).valid === true)
eq('payload tamper -> valid', vPayload.valid, false)
eq('payload tamper -> payload_hash_matches', vPayload.payload_hash_matches, false)
eq('payload tamper -> signature_valid', vPayload.signature_valid, true)
eq('payload tamper -> verdict', vPayload.verdict, sign.VERDICT.PAYLOAD_MUTATED)

const tSig = sign.tamper(signed, 'signature')
const vSig = sign.verifyTrace(tSig, '2026-07-27T00:00:00.000Z')
console.log('sig before  :', signed.signature.sig.slice(-24))
console.log('sig after   :', tSig.signature.sig.slice(-24))
ok('tamper("signature") changed real bytes', tSig.signature.sig !== signed.signature.sig)
eq('signature tamper -> valid', vSig.valid, false)
eq('signature tamper -> payload_hash_matches', vSig.payload_hash_matches, true)
eq('signature tamper -> signature_valid', vSig.signature_valid, false)
eq('signature tamper -> verdict', vSig.verdict, sign.VERDICT.SIGNATURE_MUTATED)

const tDid = sign.tamper(signed, 'did')
const vDid = sign.verifyTrace(tDid, '2026-07-27T00:00:00.000Z')
console.log('did after   :', tDid.signature.did)
eq('did tamper -> valid', vDid.valid, false)
eq('did tamper -> payload_hash_matches', vDid.payload_hash_matches, true)
eq('did tamper -> signature_valid', vDid.signature_valid, false)
eq('did tamper -> verdict', vDid.verdict, sign.VERDICT.DID_MUTATED ?? sign.VERDICT.SIGNATURE_MUTATED)
eq('did tamper -> the verdict names the DID checked', vDid.did, 'did:web:not-tldr-g.example')

// Every field of the payload is inside the signature, not just the quotes.
for (const [label, mutate] of [
  ['query', (t) => ({ ...t, query: t.query + ' ' })],
  ['model', (t) => ({ ...t, model: 'gpt-whatever' })],
  ['created_at', (t) => ({ ...t, created_at: '2020-01-01T00:00:00.000Z' })],
  ['an admission cost', (t) => ({ ...t, admitted: t.admitted.map((a, i) => (i === 9 ? { ...a, tokens: a.tokens + 1 } : a)) })],
  ['an omitted pointer', (t) => ({ ...t, omitted_but_connected: t.omitted_but_connected.slice(1) })],
  ['a content hash', (t) => ({ ...t, citations: t.citations.map((x, i) => (i === 2 ? { ...x, content_hash: x.content_hash.replace(/.$/, '0') } : x)) })],
  ['a resolution disclosure', (t) => ({ ...t, citations: t.citations.map((x, i) => (i === 2 ? { ...x, resolution: 'verbatim' } : x)) })],
]) {
  const r = sign.verifyTrace(mutate(signed))
  ok(`mutating ${label} breaks the payload hash`, r.payload_hash_matches === false && r.signature_valid === true)
}

/* ═══ 4. THE RECEIPT ══════════════════════════════════════════════════════ */
console.log('\n=== 4. DERIVED RECEIPT ===')
const stats = trace.buildDemoRenderStats(signed)
const R = trace.DEMO_RECEIPT
console.log('token_budget          :', stats.token_budget)
console.log('tokens_rendered       :', stats.tokens_rendered)
console.log('counterfactual_tokens :', stats.counterfactual_tokens)
console.log('savings_pct           :', stats.savings_pct)
console.log('lod0_passages         :', stats.lod0_passages)
console.log('lod1_context_nodes    :', stats.lod1_context_nodes)
console.log('lod2_pointer_nodes    :', stats.lod2_pointer_nodes)
console.log('render_confidence_L   :', stats.render_confidence_L)
console.log('composite             :', JSON.stringify(stats.composite))
console.log('cache                 :', stats.cache_hits + '/' + stats.cache_lookups)
console.log('families_used         :', stats.families_used.length, 'families,',
  stats.families_used.reduce((s, f) => s + f.count, 0), 'edges')
console.log('  top:', stats.families_used.slice(0, 6).map((f) => `${f.family}x${f.count}(${f.sigma})`).join(' '))
console.log('citations             :', signed.citations.length,
  '| verbatim', signed.citations.filter((x) => x.resolution === 'verbatim').length,
  '| distinct sources', new Set(signed.citations.map((x) => x.source_id)).size)
console.log('admitted              :', signed.admitted.length)
console.log('omitted_but_connected :', signed.omitted_but_connected.length,
  '|', JSON.stringify(signed.omitted_but_connected.reduce((m, p) => ({ ...m, [p.why_omitted]: (m[p.why_omitted] ?? 0) + 1 }), {})))

eq('token_budget', stats.token_budget, R.token_budget)
eq('tokens_rendered', stats.tokens_rendered, R.tokens_rendered)
eq('counterfactual_tokens', stats.counterfactual_tokens, R.counterfactual_tokens)
eq('savings_pct', stats.savings_pct, R.savings_pct)
eq('lod0_passages', stats.lod0_passages, R.lod0_passages)
eq('lod1_context_nodes', stats.lod1_context_nodes, R.lod1_context_nodes)
eq('lod2_pointer_nodes', stats.lod2_pointer_nodes, R.lod2_pointer_nodes)
eq('render_confidence_L', stats.render_confidence_L, R.render_confidence_L)

// The figures must be SUMS, not constants: recompute them a second way.
const sumAdmitted = signed.admitted.reduce((s, a) => s + a.tokens, 0)
eq('tokens_rendered is the sum of admitted[].tokens', sumAdmitted, stats.tokens_rendered)
const sumInventory = trace.DEMO_COUNTERFACTUAL_INVENTORY.reduce((s, a) => s + a.tokens, 0)
eq('counterfactual is the sum of the inventory', sumInventory, stats.counterfactual_tokens)
eq('savings recomputes', Math.round((1 - sumAdmitted / sumInventory) * 1000) / 10, stats.savings_pct)
eq('citation costs recompute from the quote bytes',
  signed.citations.reduce((s, x) => s + x.tokens, 0),
  signed.citations.reduce((s, x) => s + Math.max(1, Math.round(x.quote.length / 4)) + trace.CITATION_ENVELOPE_TOKENS, 0))
const wsum = Object.values(trace.CONFIDENCE_WEIGHTS).reduce((a, b) => a + b, 0)
eq('confidence weights sum to 1', Math.round(wsum * 1e9) / 1e9, 1)
const cw = trace.CONFIDENCE_WEIGHTS
const co = stats.composite
eq('L recomputes from the reported composite',
  Math.round((cw.semantic * co.semantic + cw.topology * co.topology + cw.temporal * co.temporal + cw.authorial * co.authorial) * 100) / 100,
  stats.render_confidence_L)

// The assertion must actually bite.
ok('assertDemoReceipt throws on drift', (() => {
  try { trace.assertDemoReceipt({ ...stats, tokens_rendered: stats.tokens_rendered + 1 }); return false } catch { return true }
})())

/* ═══ 5. THE SLICE IS REAL ════════════════════════════════════════════════ */
console.log('\n=== 5. THE DEMO SLICE AGAINST THE REAL CORPUS ===')
const w = corpus.buildWorld()
const nodeById = w.node_by_id
const edgeById = w.edge_by_id
const passageById = new Map(w.passages.map((p) => [p.id, p]))
const assetById = new Map(w.assets.map((a) => [a.id, a]))

let citeOk = 0
for (const cit of signed.citations) {
  const p = passageById.get(cit.passage_id)
  if (!p) { ok(`citation ${cit.passage_id} exists in the corpus`, false); continue }
  const hashOk = p.content_hash === cit.content_hash
  const quoteOk = p.text === cit.quote
  const resOk = p.resolution === cit.resolution
  const spanOk = corpus.verifyPassageHash(w, cit.passage_id)
  const chainOk = nodeById.get(p.source_id) !== undefined && p.asset_id === cit.asset_id
  if (hashOk && quoteOk && resOk && spanOk && chainOk) citeOk++
  else ok(`citation ${cit.passage_id} matches the corpus`, false,
    `hash=${hashOk} quote=${quoteOk} resolution=${resOk} sourceSpan=${spanOk} chain=${chainOk}`)
}
eq('all 5 citations are real corpus passages whose hash verifies over source bytes', citeOk, 5)

let invOk = 0
for (const a of trace.DEMO_COUNTERFACTUAL_INVENTORY) {
  const asset = assetById.get(a.asset_id)
  if (!asset) continue
  const real = asset.passage_ids.reduce((s, pid) => s + (passageById.get(pid)?.token_count ?? 0), 0)
  if (real === a.tokens && asset.passage_ids.length === a.passages && asset.parent_id === a.island_id) invOk++
  else ok(`inventory ${a.asset_id}`, false, `tokens ${a.tokens} vs ${real}, passages ${a.passages} vs ${asset.passage_ids.length}`)
}
eq('all 32 counterfactual assets carry the corpus\'s own token counts', invOk, trace.DEMO_COUNTERFACTUAL_INVENTORY.length)

let edgeOk = 0
for (const e of trace.DEMO_CONSTELLATION_EDGE_SET) {
  const real = edgeById.get(e.edge_id)
  if (real && real.family === e.family && real.quarantined === e.quarantined &&
      real.from_id === e.from_id && real.to_id === e.to_id && real.crosses_strait === e.crosses_strait) edgeOk++
  else ok(`edge ${e.edge_id}`, false, JSON.stringify({ want: e, got: real && { f: real.family, q: real.quarantined } }))
}
eq('all 45 constellation edges are real corpus edges', edgeOk, trace.DEMO_CONSTELLATION_EDGE_SET.length)

let admitOk = 0
for (const a of signed.admitted) {
  if (nodeById.has(a.node_id)) admitOk++
  else ok(`admitted node ${a.node_id} exists`, false)
}
eq('every admitted node exists in the corpus', admitOk, signed.admitted.length)

let ptrOk = 0
for (const p of signed.omitted_but_connected) {
  const n = nodeById.get(p.node_id)
  if (n && n.kind === p.kind) ptrOk++
  else ok(`pointer ${p.node_id}`, false, `kind ${p.kind} vs ${n && n.kind}`)
}
eq('every omitted pointer is a real node of the kind it claims', ptrOk, signed.omitted_but_connected.length)

// The entity counts the cost model is applied to are the corpus's own.
const entityRows = signed.admitted.filter((a) => a.kind === 'entity')
let costOk = 0
for (const row of entityRows) {
  const ent = nodeById.get(row.node_id)
  const expected = row.lod === 'lod-1'
    ? trace.summaryCost(ent.mentions.length, ent.asset_ids.length)
    : trace.pointerCost(ent.mentions.length, ent.asset_ids.length)
  if (expected === row.tokens) costOk++
  else ok(`cost model for ${row.node_id}`, false, `${row.tokens} vs ${expected}`)
}
eq('every admitted entity is costed from its real mention/asset counts', costOk, entityRows.length)

// The ground truth the receipt is about must literally exist in the graph.
const gt = corpus.DEFAULT_SEED !== undefined ? w.ground_truth : null
const path = trace.DEMO_PATH
let pathOk = 0
for (const step of path) {
  const e = edgeById.get(step.edge_id)
  if (e && e.from_id === step.from_id && e.to_id === step.to_id && e.family === step.family &&
      e.sigma === step.sigma && e.crosses_strait === step.crosses_strait && !e.quarantined) pathOk++
  else ok(`path step ${step.index}`, false, JSON.stringify(step))
}
eq('both hops of the gold chain are real, admitted edges', pathOk, 2)
eq('hop 1 crosses a strait', path[1].crosses_strait, true)
const bridge = nodeById.get(trace.DEMO_BRIDGE_ENTITY_ID)
eq('the bridge entity spans two islands', bridge.island_ids.length, 2)
eq('...and is flagged as a bridge', bridge.is_bridge, true)
eq('gold answer matches the ground truth', gt.gold, 'Rimsdal Group')

/* ═══ 6. INTEGRITY ════════════════════════════════════════════════════════ */
console.log('\n=== 6. INTEGRITY OVER THE REAL WORLD ===')
const report = integrity.computeIntegrity(w)
const gated = integrity.truthGatedRate(report)
console.log('total_edges                  :', report.total_edges)
console.log('admitted                     :', report.admitted)
console.log('quarantined                  :', report.quarantined)
console.log('truth_gate_exempt_structural :', report.truth_gate_exempt_structural)
console.log('truth-gated denominator      :', gated.gated, '| quarantine rate', (gated.rate * 100).toFixed(2) + '%')
console.log('by_reason:')
for (const r of report.by_reason) console.log(`  ${String(r.count).padStart(4)}  ${r.reason}  e.g. ${r.example_edge_ids.join(' ')}`)
eq('admitted + quarantined == total', report.admitted + report.quarantined, report.total_edges)
eq('by_reason sums to quarantined', report.by_reason.reduce((s, r) => s + r.count, 0), report.quarantined)
eq('counts match the corpus\'s own stats', report.total_edges, w.stats.edges_total)
eq('quarantined matches the corpus\'s own stats', report.quarantined, w.stats.quarantined)
eq('structural exemption matches the corpus\'s own stats', report.truth_gate_exempt_structural, w.stats.edges_structural)
ok('by_reason is sorted most-common first', report.by_reason.every((r, i, xs) => i === 0 || xs[i - 1].count >= r.count))
ok('every reason carries example edge ids', report.by_reason.every((r) => r.example_edge_ids.length > 0))
ok('no structural edge was quarantined', w.edges.every((e) => !(e.sigma === 'structural' && e.quarantined)))
eq('provenance is labelled', report.corpus_provenance, 'synthetic-design-concept')

/* ═══ REPORT ══════════════════════════════════════════════════════════════ */
console.log('\n=== RESULT ===')
if (failures === 0) console.log('trust: clean — signature, receipt arithmetic and integrity all verified empirically')
else { console.log(`trust: ${failures} failure(s)`); process.exitCode = 1 }

await rm(out, { recursive: true, force: true })
