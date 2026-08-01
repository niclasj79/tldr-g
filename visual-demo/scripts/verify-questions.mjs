// Put EVERY curated question through the whole pipeline before it is offered to
// anybody. Run: node scripts/verify-questions.mjs
//
// -----------------------------------------------------------------------------
// WHY THIS EXISTS, AND IT IS NOT A HYPOTHETICAL
// -----------------------------------------------------------------------------
// The corpus offers five questions with by-construction answers. They are the
// first thing a stranger presses, and they are the product's own claim that the
// engine can be scored rather than believed. One of them shipped as a TRUST
// FAILURE.
//
// The `compare` question is a fork by construction — two subjects joined by one
// shared regulator — and `buildStagedQueries()` says exactly that in its own
// `why` field. `chainEndpoints()` classified the fork as a chain (a fork and a
// chain have identical degree sequences at n = 2; only the DIRECTION of the
// middle hop tells them apart), handed its two outer nodes to `GET /graph/path`,
// and that traversal correctly returned a different route between two nodes that
// were never the ends of anything. The verdict came back `differs`. The app
// raised `PATH_DISAGREEMENT` — the loudest thing it can say — over an answer the
// engine had got right at every step.
//
// A curated question is a promise. This is the check that the promise holds, and
// it is deliberately the FULL path: render, receipt, signature, and the
// independent re-derivation, exactly as a user would trigger them.
//
// -----------------------------------------------------------------------------
// WHAT COUNTS AS A FAILURE
// -----------------------------------------------------------------------------
//   the render throws                         FAIL — the question is unaskable
//   no trace, or the signature does not verify FAIL — the receipt is not a receipt
//   the answer does not contain its own gold   FAIL — it was scored against a
//                                              by-construction answer and lost
//   `explainPath` returns `differs`            FAIL — two surfaces of the engine
//                                              contradict each other
//   the app ends in DEGRADED                   FAIL — whatever the reason
//
// `not-a-chain` and `no-admitted-route` are NOT failures. They are true things
// about answers that are not single routes, and treating them as faults is the
// exact mistake that produced the incident above.
//
// Exits non-zero on any failure, so this can gate a publish.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const out = await mkdtemp(join(tmpdir(), 'tldrg-questions-'))

// One graph, code-split, so the state module and the engine module share a
// single instance of the fixture memo. Two bundles would mean two corpora and
// every id in one would be a stranger to the other.
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

const store = S.useAtlas
const st = () => store.getState()

console.log('\n=== the corpus stands up ===')
await st().boot({ auto: true })
await S.drain()
check('READY after boot', st().app === 'READY', st().app)

const staged = st().stagedQueries
check('the corpus offers curated questions', staged.length > 0, `${staged.length} staged`)
if (staged.length === 0) {
  await rm(out, { recursive: true, force: true })
  process.exit(1)
}

// A one-line census before the detail, so a regression is visible at a glance
// even when the per-question output scrolls.
const results = []

for (const q of staged) {
  console.log(`\n=== ${q.intent} — ${q.query} ===`)

  // A previous question's failure must not be inherited by the next one's
  // verdict. Recovering here is what makes each row below independent.
  if (st().app === 'DEGRADED') await st().recover()

  await st().runQuery(q.query)
  await S.drain()

  const degradedAfterRender = st().app === 'DEGRADED'
  check('renders without degrading', !degradedAfterRender, degradedAfterRender ? st().degraded?.code : '')

  const active = st().query.active
  const rendered = active !== null && active.query === q.query
  check('an answer came back for THIS question', rendered)

  if (!rendered) {
    results.push({ id: q.id, intent: q.intent, ok: false, note: 'no answer' })
    continue
  }

  // --- the receipt ---------------------------------------------------------
  const trace = st().trace
  check('a trace was produced', trace !== null)
  const verify = st().verifyActive()
  check(
    'the signature verifies',
    verify !== null && verify.valid,
    verify === null ? 'no verify result' : `payload=${verify.payload_hash_matches} sig=${verify.signature_valid}`,
  )

  // --- the by-construction answer -----------------------------------------
  // `gold` is present exactly because the question was set up in advance, which
  // is the whole reason the engine can be SCORED here rather than believed.
  const gold = active.gold
  const matches = gold !== undefined && active.answer.includes(gold)
  check('the answer contains its by-construction gold', matches, gold === undefined ? 'no gold declared' : gold)

  // --- the independent re-derivation --------------------------------------
  // This is the step that caught nothing for as long as it was wrong about what
  // a chain is. It runs automatically in the product when an answer lands; here
  // it is driven explicitly so the verdict can be asserted on.
  await st().explainPath()
  await S.drain()
  const explain = st().explain
  const verdict = explain?.verdict ?? 'none'
  check('the re-derivation produced a verdict', explain !== null, verdict)
  check(
    'the re-derivation does not CONTRADICT the receipt',
    verdict !== 'differs',
    verdict === 'differs'
      ? `answer=[${active.constellation.path.map((s) => s.family).join(' + ')}] rederived=[${(explain?.steps ?? []).map((s) => s.family).join(' + ')}]`
      : verdict,
  )

  // A fork is a legitimate shape and must be REPORTED as one rather than
  // silently squeezed into a chain. This is the assertion that pins the fix.
  if (q.intent === 'compare') {
    check(
      'a compare answer is reported as not-a-chain, not as a disagreement',
      verdict === 'not-a-chain',
      verdict,
    )
  }

  const stillDegraded = st().app === 'DEGRADED'
  check('the app is not left degraded', !stillDegraded, stillDegraded ? st().degraded?.code : '')

  results.push({
    id: q.id,
    intent: q.intent,
    ok: rendered && matches && verdict !== 'differs' && !stillDegraded,
    note: verdict,
  })
}

console.log('\n=== census ===')
for (const r of results) {
  console.log(`  ${r.ok ? 'ok  ' : 'BAD '} ${r.intent.padEnd(10)} ${r.id}  (${r.note})`)
}

console.log(`\n${pass} passed, ${fail} failed`)
await rm(out, { recursive: true, force: true })
process.exitCode = fail === 0 ? 0 : 1
