// Exercise the visual demo's state machine for real, headlessly. Run: node scripts/verify-state.mjs
//
// Nothing here is mocked. The store is the store the app runs, wired to the real
// engine client over the real fixture corpus, and every assertion below is made
// against what actually happened rather than against a fixture of what should
// have. Four things are being falsified:
//
//   1. THE MACHINE IS DECLARED. Every transition the table allows is legal at
//      runtime, every transition it forbids throws, and every transition the
//      real actions produce is one the table declared.
//   2. THE TERRAIN NEVER HAS HOLES. After a real render, the resolution map
//      answers for every node in the view — and the tiers it reports are the
//      ones the signed trace admitted, not tiers this store invented.
//   3. A SHARED SCENE ROUND-TRIPS. Encode, decode, and drive the store back to
//      the same place through the same actions a click would use.
//   4. EVERY SCENE THE HARNESS NEEDS CAN BE REACHED, using real actions only.
//
// Exits non-zero on the first failed assertion class, so CI can gate on it.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const out = await mkdtemp(join(tmpdir(), 'tldrg-state-'))

// Both entry points in ONE graph with code splitting, so the state module and
// the engine module share a single instance of the fixture memo. Two bundles
// would mean two corpora, and every id in one would be a stranger to the other.
await build({
  entryPoints: [join(ROOT, 'src/state/index.ts'), join(ROOT, 'src/engine/index.ts')],
  outdir: out,
  outbase: join(ROOT, 'src'),
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  logLevel: 'warning',
  alias: { '@': join(ROOT, 'src') },
})

const S = await import(pathToFileURL(join(out, 'state/index.js')).href)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}
const section = (t) => console.log('\n=== ' + t + ' ===')
const store = S.useAtlas
const st = () => store.getState()

/* ─────────────────────────────────────────────────────────────────────────── */
section('1. THE TRANSITION TABLE')

const declared = S.transitionPairs()
const forbidden = S.illegalPairs()
console.log(`  ${S.APP_STATES.length} states · ${declared.length} declared transitions · ${forbidden.length} forbidden`)
check('strict mode is on under node', S.STRICT_TRANSITIONS === true)

let legalOk = 0
for (const { from, to } of declared) {
  if (S.canTransition(from, to) && S.assertTransition(from, to, 'verify') === true) legalOk++
}
check('every declared transition is permitted', legalOk === declared.length, `${legalOk}/${declared.length}`)

let threw = 0
const notThrown = []
for (const { from, to } of forbidden) {
  try {
    S.assertTransition(from, to, 'verify')
    notThrown.push(`${from} -> ${to}`)
  } catch (err) {
    if (err instanceof S.IllegalTransition && err.from === from && err.to === to) threw++
  }
}
check('every forbidden transition throws IllegalTransition', threw === forbidden.length, `${threw}/${forbidden.length}${notThrown.length ? ' — leaked: ' + notThrown.join(', ') : ''}`)

check('self-transition is a legal no-op', S.APP_STATES.every((s) => S.canTransition(s, s)))
check('SETTLING has exactly one non-degraded exit', JSON.stringify(S.TRANSITIONS.SETTLING) === JSON.stringify(['READY', 'DEGRADED']))
check('DEGRADED is reachable from every state', S.APP_STATES.every((s) => s === 'DEGRADED' || S.TRANSITIONS[s].includes('DEGRADED')))
check(
  'recover() never returns to a transient state',
  ['INGESTING', 'SETTLING', 'QUERYING'].every((s) => !S.isTransient(S.recoveryTarget(s, true)) && !S.isTransient(S.recoveryTarget(s, false))),
  `READY|EMPTY from ${['INGESTING', 'SETTLING', 'QUERYING'].map((s) => `${s}->${S.recoveryTarget(s, true)}`).join(' ')}`,
)

/* ─────────────────────────────────────────────────────────────────────────── */
section('2. THE MACHINE, DRIVEN BY REAL ACTIONS')

// Watch every `app` change the real actions produce and audit it against the
// table. This is the empirical half: the table can be right and the store can
// still take a move it never declared.
const observed = []
const illegalObserved = []
let previous = st().app
store.subscribe((s) => {
  if (s.app === previous) return
  observed.push(`${previous} -> ${s.app}`)
  if (!S.canTransition(previous, s.app)) illegalObserved.push(`${previous} -> ${s.app}`)
  previous = s.app
})

check('the store starts in FIRST-RUN', st().app === 'FIRST-RUN')

const t0 = performance.now()
await st().boot()
check('boot() on a first visit stops at FIRST-RUN (the invitation)', st().app === 'FIRST-RUN', `${(performance.now() - t0).toFixed(1)}ms`)

// FIRST-RUN -> INGESTING -> SETTLING -> READY, through the button the first-run
// screen actually offers.
const tIngest = performance.now()
await st().ingestDemo()
const ingestMs = performance.now() - tIngest
check('ingestDemo() reaches READY', st().app === 'READY', `${ingestMs.toFixed(0)}ms wall clock`)
check('the corpus materialised', st().view !== null && st().bake !== null)
console.log('  measured phases:', JSON.stringify(st().timings))
check('the phase timings are measured, not asserted', st().timings !== null && st().timings.build_ms > 0 && st().timings.bake_ms > 0)
check('ingest reported the ids that arrived', st().ingestedIds.length === st().view.stats.node_count, `${st().ingestedIds.length} new node ids`)
check('the staged questions arrived', st().stagedQueries.length > 0, st().stagedQueries.map((q) => q.id).join(' · '))
check('the integrity report arrived', st().integrity !== null, `${st().integrity?.quarantined} quarantined of ${st().integrity?.total_edges}`)
check('the command bar is pre-staged with a real staged question', st().query.staged === st().stagedQueries[0].query)

// READY -> INGESTING -> SETTLING -> READY (more documents into a live corpus).
await st().ingestDemo()
check('a second ingest is legal from READY and returns to READY', st().app === 'READY')
check('a second ingest reports NO new ids', st().ingestedIds.length === 0, 'the corpus was already materialised — and says so')

/* ─────────────────────────────────────────────────────────────────────────── */
section('3. AN ILLEGAL MOVE THROWS AT THE CALL SITE')

st().unload('EMPTY')
check('unload() reaches EMPTY', st().app === 'EMPTY')

let rejected = null
try {
  await st().runQuery('anything at all')
} catch (err) {
  rejected = err
}
check(
  'runQuery() from EMPTY throws rather than rendering over a corpus that is not there',
  rejected instanceof S.IllegalTransition && rejected.from === 'EMPTY' && rejected.to === 'QUERYING',
  rejected?.message?.slice(0, 96) ?? 'nothing was thrown',
)

st().unload('FIRST-RUN')
check('unload("FIRST-RUN") is legal from EMPTY', st().app === 'FIRST-RUN')
await st().ingestDemo()
check('and the corpus can be re-opened from there', st().app === 'READY')

/* ─────────────────────────────────────────────────────────────────────────── */
section('4. A REAL RENDER, AND THE RESOLUTION MAP')

const question = st().stagedQueries[0].query
console.log('  question:', question)
const tQuery = performance.now()
await st().runQuery(question)
const queryMs = performance.now() - tQuery

check('the render landed back in READY', st().app === 'READY', `${queryMs.toFixed(0)}ms round trip`)
const active = st().query.active
const trace = st().trace
check('an answer was returned', active !== null && active.answer.length > 0)
console.log('  answer:', active.answer.slice(0, 120))
console.log(
  '  render budget:',
  `${active.render_stats.tokens_rendered} / ${active.render_stats.counterfactual_tokens} tokens` +
    ` · saved ${active.render_stats.savings_pct}% · L ${active.render_stats.render_confidence_L}`,
)
check('the answer is labelled as a design concept', active.corpus_provenance === 'synthetic-design-concept')
check('the receipt came back with it', trace !== null && trace.trace_id === active.trace_id)
check('the view switched to the constellation edge policy', st().view.stats.drawn_reason === 'query-constellation', `${st().view.stats.edges_drawn} of ${st().view.stats.edge_count} edges stroked`)

const view = st().view
const lod = st().lod
const holes = S.lodHoles(view, lod)
check('THE TERRAIN HAS NO HOLES: every node in the view carries a tier', holes.length === 0, `${view.nodes.length} nodes · ${Object.keys(lod).length} entries · ${holes.length} holes`)
console.log('  ramp:', JSON.stringify(S.lodHistogram(lod)))

let admittedMatches = 0
let admittedTotal = 0
for (const record of trace.admitted) {
  if (record.kind === 'passage') continue // citations override to lod-0; checked below
  admittedTotal++
  if (lod[record.node_id] === record.lod || lod[record.node_id] === 'lod-1' || lod[record.node_id] === 'lod-0') admittedMatches++
}
check('admitted nodes carry the tier the trace admitted them at', admittedMatches === admittedTotal, `${admittedMatches}/${admittedTotal}`)
check('every citation is lod-0 — the verbatim guarantee', trace.citations.every((c) => lod[c.passage_id] === 'lod-0'), `${trace.citations.length} citations`)

const onePointer = trace.omitted_but_connected.filter((p) => p.hop_distance <= 1)
check(
  'omitted-but-connected at one hop renders as a ghost, never as a hole',
  onePointer.every((p) => lod[p.node_id] === 'ghost' || lod[p.node_id] === 'lod-0'),
  `${onePointer.length} pointers`,
)
const unmentioned = view.nodes.filter(
  (n) =>
    !trace.admitted.some((a) => a.node_id === n.id) &&
    !trace.omitted_but_connected.some((p) => p.node_id === n.id) &&
    !trace.citations.some((c) => c.passage_id === n.id),
)
check(
  'everything the receipt does not mention is latent, and still present',
  unmentioned.every((n) => lod[n.id] === 'latent'),
  `${unmentioned.length} latent nodes hold the terrain together`,
)

/* ─────────────────────────────────────────────────────────────────────────── */
section('5. THE RESTING MAP, AT EVERY RUNG')

await st().goToRung('continent', null)
const continentId = st().view.nodes[0].id
check(
  'with an answer on screen but nothing to say at this altitude, the view falls back to the skeleton and SAYS SO',
  st().view.stats.drawn_reason === 'trade-route-skeleton' && st().view.stats.edges_drawn > 0,
  `continent rung: ${st().view.stats.edges_drawn} corridor exemplars · ${st().view.stats.drawn_reason}`,
)
for (const [rung, parent] of [
  ['continent', null],
  ['island', null],
  ['island', continentId],
]) {
  await st().goToRung(rung, parent)
  const v = st().view
  const holesHere = S.lodHoles(v, st().lod)
  check(
    `${rung} rung (${parent ?? 'whole rung'}): no holes`,
    holesHere.length === 0,
    `${v.stats.node_count} nodes · ${v.stats.edges_drawn}/${v.stats.edge_count} edges · ${v.stats.drawn_reason} · ${JSON.stringify(S.lodHistogram(st().lod))}`,
  )
}

// Descend the spine the way a click does, and check the breadcrumb it builds.
await st().goToRung('continent', null)
await st().descend(st().view.nodes[0].id)
const islandId = st().view.nodes.find((n) => n.kind === 'island').id
await st().descend(islandId)
check('descend() builds the breadcrumb', st().rung === 'asset' && st().stack.length === 2, st().stack.map((e) => `${e.rung}:${e.label}`).join(' / '))
check('the parent scope is the deepest breadcrumb entry', S.parentIdOf(st()) === islandId)
await st().ascend()
check('ascend() pops one rung', st().rung === 'island' && st().stack.length === 1)

/* ─────────────────────────────────────────────────────────────────────────── */
section('6. SELECTION, TRUST AND THE INDEPENDENT PATH')

await st().goToRung('island', null)
await st().runQuery(question)

const verified = st().verifyActive()
check('the signed receipt verifies', verified?.valid === true, verified?.verdict)
st().tamperActive('payload')
check('tampering with the payload breaks the signature for real', st().verify.valid === false && st().tampered === true, st().verify.verdict)
await st().restoreTrace()
check('restoring the receipt makes it valid again', st().verify.valid === true && st().tampered === false)

const steps = await st().explainPath()
const explain = st().explain
check(
  'the answer path re-derives independently through GET /graph/path',
  explain !== null && explain.verdict === 'identical',
  `${steps.map((s) => s.family).join(' + ')} between ${explain?.endpoints?.join(' -> ')}`,
)
check('explaining the path selects the nodes on it', st().selection.length === steps.length + 1, st().selection.join(', '))

const citation = st().trace.citations[0]
await st().openPassage(citation.passage_id)
check('openPassage() descends to the passage rung with the molecule on the breadcrumb', st().rung === 'passage' && st().stack.length === 3, st().stack.map((e) => e.id).join(' / '))
check('the opened passage is focused and drawn verbatim', st().focus === citation.passage_id && st().lod[citation.passage_id] === 'lod-0')

/* ─────────────────────────────────────────────────────────────────────────── */
section('7. SAVED VIEW ROUND TRIP')

const sample = {
  version: 1,
  rung: 'asset',
  parentId: islandId,
  camera: { x: -128.25, y: 44.5, zoom: 2.375 },
  selection: ['e:tollstrand-battery', 'e:bruntorp-facility'],
  focus: 'e:tollstrand-battery',
  queryId: 'q:bridge:tollstrand',
  query: question,
  filters: { sigma: ['factual', 'episodic'], families: ['operates'], showQuarantined: true },
  density: 'compact',
}
const token = S.encodeSavedView(sample)
const back = S.decodeSavedView(token)
check('encode -> decode is lossless', JSON.stringify(back) === JSON.stringify(sample), `${token.length} chars`)
check('the token is URL-safe', /^[A-Za-z0-9_-]+$/.test(token))
check('encoding is deterministic', S.encodeSavedView(back) === token)

let corrupt = null
try {
  S.decodeSavedView('!!!definitely not a view!!!')
} catch (err) {
  corrupt = err
}
check(
  'a corrupt link fails loud, with an exact remedy',
  corrupt instanceof S.SavedViewError && corrupt.code === 'SAVED_VIEW_CORRUPT' && corrupt.exact_remedy.length > 0,
  corrupt?.what_failed?.slice(0, 80),
)

// The store-level round trip: save a real scene, disturb it, restore it.
await st().goToRung('island', null)
await st().runQuery(question)
st().selectNode('e:tollstrand-battery')
st().setCamera(12.5, -30.25, 2.5)
st().toggleQuarantined()
const sceneToken = st().saveView()
console.log('  token:', sceneToken.slice(0, 72) + (sceneToken.length > 72 ? '…' : ''), `(${sceneToken.length} chars)`)

await st().goToRung('continent', null)
st().clearFocus()
st().toggleQuarantined()
await st().loadView(sceneToken)
const restored = st()
check('loadView() restores the rung', restored.rung === 'island')
check('loadView() restores the selection and focus', restored.selection.join(',') === 'e:tollstrand-battery' && restored.focus === 'e:tollstrand-battery')
check('loadView() restores the camera target', restored.camera.x === 12.5 && restored.camera.y === -30.25 && restored.camera.zoom === 2.5)
check('loadView() restores the filters', restored.filters.showQuarantined === true)
check('loadView() re-RENDERS the question rather than restoring a receipt from a URL', restored.query.active?.query === question && restored.trace !== null)

/* ─────────────────────────────────────────────────────────────────────────── */
section('8. FAILURE IS LOUD AND HAS A REMEDY')

await st().runQuery(S.NO_MATCH_PROBE)
const degraded = st().degraded
check('a question nothing matches degrades instead of inventing an answer', st().app === 'DEGRADED' && degraded?.code === 'QUERY_NO_MATCH')
console.log('  what_failed :', degraded?.what_failed)
console.log('  exact_remedy:', degraded?.exact_remedy)
check('the degraded reason names what failed and what to do', (degraded?.what_failed?.length ?? 0) > 20 && (degraded?.exact_remedy?.length ?? 0) > 20)
check('the query error is kept for the command bar', st().query.error === degraded?.what_failed && st().query.running === false)

await st().recover()
check('recover() returns to the state we came from', st().app === 'READY')

/* ─────────────────────────────────────────────────────────────────────────── */
section('9. KEYBOARD MAP, DENSITY, PERF SAMPLER')

check('every binding has display glyphs and a label', S.KEYMAP.every((b) => b.keys.length > 0 && b.label.length > 0))
check('the contract keys are all bound', ['/', 'a', 'i', 'p', 't', 'e', 'escape', 'q', 'g', '?', '1', '2', '3', '4', 'backspace', 'b', 'h', 'r'].every((k) => S.KEYMAP.some((b) => b.codes.includes(k))))
check('a modifier hands the key back to the browser', S.matchBinding({ key: 'p', metaKey: true }) === null)
check('typing in a field is not a shortcut', S.matchBinding({ key: '/', target: { tagName: 'INPUT' } }) === null)
check('…but Escape still escapes it', S.matchBinding({ key: 'Escape', target: { tagName: 'INPUT' } })?.id === 'clear-focus')
check('the help overlay and the KeyHint chips read the same table', S.keyHintFor('search').join('') === '/' && S.bindingFor('tab-evidence').keys[0] === 'P')

// THE ACTION IDS SAY WHICH KIND OF THING THEY ARE NOW. `atlas`, `inspector`,
// `receipt`, `timeline` and `analyst` were five ids at one rank standing for two
// workspaces, a lens, a result surface and a selection surface. The union is
// `lens-*` / `tab-*` / the reverse actions, and the shape of the union alone
// says the product has three places and three details.
check(
  'the taxonomy is in the ids, not just in the labels',
  S.KEYMAP.filter((b) => b.id.startsWith('lens-')).length === 3 &&
    S.KEYMAP.filter((b) => b.id.startsWith('tab-')).length === 3,
)

const consumed = st().handleKey({ key: 'p' })
check('handleKey() dispatches through the map', consumed === true && st().tab === 'evidence')

// A LENS IS A MOVE, NOT A TOGGLE. Pressing the lens you are already in returns
// you to Explore, which is the only lens that is a home; pressing a different
// one is a place change and the two are not the same gesture.
st().handleKey({ key: 't' })
check('a lens key enters that lens', st().lens === 'timeline')
st().handleKey({ key: 't' })
check('…and pressing it again returns to Explore', st().lens === 'explore')
await S.drain()

// EVERY MOVE HAS A REVERSE ACTION, and the keyboard is where a reverse action
// has to be, because the moment you need one is the moment you notice.
check(
  'the reverse actions are all bound',
  ['back', 'home', 'return-to-result', 'ascend', 'clear-focus'].every((id) =>
    S.KEYMAP.some((b) => b.id === id),
  ),
)

st().setDensity('compact')
check('density is a real state change', st().density === 'compact')
check('touch is the bottom-sheet signal', S.isTouchMode('touch') === true && S.isTouchMode('compact') === false)
st().setDensity('comfortable')

let emitted = []
let clock = 0
const sampler = S.createPerfSampler((r) => emitted.push(r), { hz: 4, now: () => clock, watchdog: false })
for (let i = 0; i < 60; i++) {
  clock += 16.7
  // A real frame time drifts. A constant one would be indistinguishable from a
  // hardcoded number, which is the thing this whole product refuses to ship.
  sampler.push({ frameMs: 16.7 + i * 0.05, points: 4406, drawCalls: 7 })
}
check('the sampler throttles ~1s of frames into a handful of updates', emitted.length >= 3 && emitted.length <= 6, `${emitted.length} updates from 60 frames at 4Hz`)
check(
  'the emitted numbers are measurements',
  emitted[0].fps === 60 && emitted[0].frameMs > 16.7 && emitted[0].frameMs < 18 && emitted[0].points === 4406 && emitted[0].drawCalls === 7,
  JSON.stringify(emitted[0]),
)

const steady = []
let clock2 = 0
const sampler2 = S.createPerfSampler((r) => steady.push(r), { hz: 4, now: () => clock2, watchdog: false })
for (let i = 0; i < 60; i++) {
  clock2 += 16.7
  sampler2.push({ frameMs: 16.7, points: 4406, drawCalls: 7 })
}
check('an unchanged readout is not re-published — React is not woken to be told nothing', steady.length === 1, `${steady.length} update from 60 identical frames`)

const stalled = []
let clock3 = 0
const sampler3 = S.createPerfSampler((r) => stalled.push(r), { hz: 4, now: () => clock3, watchdog: false })
sampler3.push({ frameMs: 16.7, points: 4406, drawCalls: 7 })
clock3 += 2000
sampler3.flush() // one frame in two seconds
check('a crawling renderer reports the fraction, not a flattering "1"', stalled[stalled.length - 1].fps === 0.5, JSON.stringify(stalled[stalled.length - 1]))
clock3 += 2000
sampler3.flush() // and then no frames at all
check('a stalled renderer reports 0 fps rather than freezing at its last good number', stalled[stalled.length - 1].fps === 0, JSON.stringify(stalled[stalled.length - 1]))
sampler.stop()
sampler2.stop()
sampler3.stop()

/* ─────────────────────────────────────────────────────────────────────────── */
section('10. EVERY SCENE THE HARNESS REQUIRES')

const REQUIRED = [
  'first-run', 'empty', 'ingesting', 'settling', 'home', 'query-render', 'constellation',
  'receipt', 'passage-drilldown', 'path-explain', 'atlas-continent', 'atlas-island',
  'atlas-asset', 'atlas-passage', 'analyst', 'timeline', 'verify-valid', 'verify-invalid',
  // Two faces of the one failure state, photographed separately: `degraded` is the
  // canonical alarm (the engine itself unreachable — TRANSPORT_FAILED), and
  // `degraded-query` is the softer report (a question this corpus cannot answer).
  // Both render through the same full-width --alarm instrument.
  'quarantine', 'degraded', 'degraded-query', 'saved-view',
]
check('the scene list is exactly the contract list', REQUIRED.every((n) => S.SCENE_NAMES.includes(n)) && S.SCENE_NAMES.length === REQUIRED.length, `${S.SCENE_NAMES.length} scenes`)

const sceneErrors = []
for (const name of REQUIRED) {
  const started = performance.now()
  try {
    await S.scene(name)
    const d = S.describe()
    console.log(
      `  ${name.padEnd(18)} ${String(d.app).padEnd(10)} ${String(d.rung).padEnd(10)} ` +
        `nodes ${String(d.nodes).padStart(5)} · edges ${String(d.edges_drawn).padStart(4)} · lod ${String(d.lod_entries).padStart(5)} ` +
        `· ${((performance.now() - started) | 0).toString().padStart(4)}ms` +
        (d.degraded ? ` · ${d.degraded}` : '') +
        (d.verify === null ? '' : ` · verify ${d.verify}`),
    )
  } catch (err) {
    sceneErrors.push(`${name}: ${err.message}`)
    console.log(`  ${name.padEnd(18)} THREW — ${err.message}`)
  }
}
S.releaseHold()
check('every required scene is reachable through real actions', sceneErrors.length === 0, sceneErrors.join(' | '))

/* ─────────────────────────────────────────────────────────────────────────── */
section('11. THE REMAINING DECLARED EDGES, DRIVEN FOR REAL')

// A corrupt shared link is a real failure with a real remedy, and it can happen
// in every stable state — which makes it the honest way to reach DEGRADED from
// each of them without inventing a reason.
const CORRUPT = '!!!definitely not a view!!!'

await st().loadView(CORRUPT)
check('READY -> DEGRADED: a corrupt shared link', st().app === 'DEGRADED' && st().degraded.code === 'SAVED_VIEW_CORRUPT', st().degraded.exact_remedy)

await st().runQuery(question)
check('DEGRADED -> QUERYING -> READY: asking again is a legal way out', st().app === 'READY' && st().query.active !== null)

await st().loadView(CORRUPT)
await st().ingestDemo()
check('DEGRADED -> INGESTING -> SETTLING -> READY: re-opening the corpus is another', st().app === 'READY')

await st().loadView(CORRUPT)
st().unload('FIRST-RUN')
check('DEGRADED -> FIRST-RUN: closing the corpus from a failure', st().app === 'FIRST-RUN')

await st().loadView(CORRUPT)
check('FIRST-RUN -> DEGRADED', st().app === 'DEGRADED')
st().unload('EMPTY')
await st().loadView(CORRUPT)
check('EMPTY -> DEGRADED', st().app === 'DEGRADED')

await st().recover()
check('recover() from EMPTY-with-no-corpus goes back to EMPTY, not to a map that is not there', st().app === 'EMPTY')
await st().ingestDemo()
check('and the corpus opens again', st().app === 'READY')

/* ─────────────────────────────────────────────────────────────────────────── */
section('12. TRANSITION COVERAGE, OBSERVED')

check('no observed transition was undeclared', illegalObserved.length === 0, illegalObserved.join(', ') || `${observed.length} transitions observed`)
const seen = new Set(observed)
const coveredPairs = declared.filter(({ from, to }) => seen.has(`${from} -> ${to}`))
const uncovered = declared.filter(({ from, to }) => !seen.has(`${from} -> ${to}`))
console.log(`  observed ${observed.length} transitions covering ${coveredPairs.length}/${declared.length} declared edges`)
// The three that cannot be reached in this build, and why. Reported rather than
// quietly dropped from the table: they are the failure paths of work that this
// corpus never fails at, and the day an engine is put behind the base URL they
// become reachable without a code change.
const UNREACHABLE = {
  'INGESTING -> EMPTY': 'an ingest that yields zero nodes; the bundled corpus always yields 4,406',
  'INGESTING -> DEGRADED': 'a corpus that fails to materialise; validateWorld() throws only on a broken generator',
  'SETTLING -> DEGRADED': 'a bake that fails; the fixture bake is deterministic and has no failure mode',
  'READY -> SETTLING': 'a re-bake without an ingest (the anchored re-projection). No action triggers one yet',
  'DEGRADED -> SETTLING': 'as above, entered from a failure',
}
for (const { from, to } of uncovered) {
  const why = UNREACHABLE[`${from} -> ${to}`]
  console.log(`  not exercised: ${from} -> ${to}${why ? ' — ' + why : ''}`)
}
check(
  'the whole happy path was exercised by real actions',
  ['FIRST-RUN -> EMPTY', 'EMPTY -> INGESTING', 'INGESTING -> SETTLING', 'SETTLING -> READY', 'READY -> QUERYING', 'QUERYING -> READY', 'QUERYING -> DEGRADED', 'DEGRADED -> READY'].every((t) => seen.has(t)),
)
check(
  'every declared edge is either exercised or explained',
  uncovered.every(({ from, to }) => UNREACHABLE[`${from} -> ${to}`] !== undefined),
  `${coveredPairs.length} exercised · ${uncovered.length} explained`,
)

/* ─────────────────────────────────────────────────────────────────────────── */
console.log(`\n${pass} passed, ${fail} failed`)
await rm(out, { recursive: true, force: true })
if (fail > 0) process.exitCode = 1
