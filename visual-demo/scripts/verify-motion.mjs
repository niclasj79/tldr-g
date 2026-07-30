// Motion & microinteraction QA.
//
// VERIFY BY LOOKING, AND THEN BY MEASURING.
//
// Two passes, because a moving thing cannot be judged from a resting screenshot
// and cannot be trusted from a token file:
//
//   1. THE VIRTUAL CLOCK PASS. `page.clock` mocks Date, performance.now, the
//      timers AND requestAnimationFrame, so the whole product can be stepped
//      frame by frame and photographed AT AN EXACT MILLISECOND. Without it a
//      screenshot costs seconds under swiftshader and every "80ms" frame is
//      really a 14-second frame — i.e. the strip photographs the resting state
//      five times and proves nothing. With it, `descent--0180ms.png` is the
//      frame at 180ms, exactly, every run.
//
//   2. THE REAL CLOCK PASS. Durations are read out of `window.__atlas.motion`,
//      which records the WALL-CLOCK ms every run measured between its first
//      frame and its last — never the duration it asked for. The receipt's count
//      is measured a third way, off the DOM, by sampling the printed figure.
//
// It also runs the whole thing again under prefers-reduced-motion, where the
// rule is absolute: every scene animation is ONE 120ms crossfade, and the
// instruments still update on the frame their value changes.
//
// Usage: node scripts/verify-motion.mjs [--url http://127.0.0.1:4173]
//        [--out shots/motion] [--strips yes|no]

import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const URL = arg('url', 'http://127.0.0.1:4173')
const OUT = resolve(arg('out', 'shots/motion'))
const STRIPS = arg('strips', 'yes') !== 'no'
const VIEW = { width: 1600, height: 900 }

const GL = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
]

const report = { url: URL, measured: {}, reduced: {}, strips: [], checks: [], errors: [] }
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail })
  process.stdout.write(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`)
}

/** The citation control, by its own copy. Never by a class that can be renamed. */
const OPEN_CITATION = 'Open the passage'

async function newPage(browser, { reduced = false, clock = false } = {}) {
  const ctx = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  })
  const page = await ctx.newPage()
  const tag = reduced ? 'reduced' : 'full'
  page.on('pageerror', (e) => report.errors.push(`[${tag}] pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(`[${tag}] console: ${m.text()}`)
  })
  if (clock) await page.clock.install()
  await page.goto(URL, { waitUntil: clock ? 'domcontentloaded' : 'networkidle', timeout: 60_000 })
  if (clock) await page.clock.runFor(4000)
  await page.waitForFunction(() => !!window.__atlas?.scene && !!window.__atlas?.motion, null, {
    timeout: 30_000,
  })
  return { ctx, page }
}

/* =============================================================================
 * PASS 1 — THE REAL CLOCK. What every animation actually took.
 * ========================================================================== */

async function measure(page) {
  const out = {}
  const reset = () => page.evaluate(() => window.__atlas.motion.reset())
  const log = () => page.evaluate(() => window.__atlas.motion.log())
  const settle = () => page.evaluate(() => window.__atlas.settled())

  /* THE RECEIPT IS MEASURED FIRST, and the order is the assertion. The count is
     guarded ONCE PER QUERY at module scope, so any earlier step that renders the
     same question spends it — which is the property this file exists to prove and
     would otherwise silently destroy the measurement of. */
  // 4. THE RECEIPT — measured two ways: the run, and the printed figure.
  await page.evaluate(() => window.__atlas.scene('home'))
  await reset()
  const counted = await page.evaluate(async () => {
    const s = window.__atlas.store.getState()
    if (!s.ui.receipt) s.toggle('receipt')
    const read = () =>
      Number((document.querySelector('.pv-rl-hero .num-f')?.textContent ?? '').replace(/\D+/g, ''))
    const samples = []
    void s.runQuery(s.stagedQueries[0].query)
    const t0 = performance.now()
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => requestAnimationFrame(r))
      const v = read()
      if (Number.isFinite(v) && v > 0) samples.push({ at: Math.round(performance.now() - t0), v })
      if (samples.length > 4 && samples.at(-1).v === samples.at(-2).v && samples.at(-1).v === samples.at(-3).v) break
    }
    await window.__atlas.settled()
    const counterfactual = Number(
      (document.querySelectorAll('.pv-receipt-blk .num-f')[0]?.textContent ?? '').replace(/\D+/g, ''),
    )
    const first = samples[0] ?? null
    const settledAt = samples.find((s2) => s2.v === samples.at(-1)?.v) ?? null
    return {
      from: first?.v ?? null,
      to: samples.at(-1)?.v ?? null,
      domMs: first && settledAt ? settledAt.at - first.at : null,
      distinct: new Set(samples.map((s2) => s2.v)).size,
      counterfactual: Number.isFinite(counterfactual) ? counterfactual : null,
      // THE FIRST PAINTED FIGURE IS THE ASSERTION. A count that starts on the
      // second frame has already shown the answer it was about to celebrate.
      firstPaintCounted: first !== null && first.v === counterfactual,
    }
  })
  out.receiptDom = counted
  out.receipt = await log()

  // ...and it must NOT replay on a tab switch. Close the receipt, reopen it.
  await reset()
  await page.evaluate(async () => {
    const s = window.__atlas.store.getState()
    s.toggle('receipt')
    await new Promise((r) => requestAnimationFrame(r))
    s.toggle('receipt')
    await new Promise((r) => setTimeout(r, 400))
  })
  out.receiptReplay = await log()

  // 1. THE DESCENT — a real `descend()` into a real body of the current rung.
  await page.evaluate(() => window.__atlas.scene('atlas-continent'))
  await reset()
  await page.evaluate(async () => {
    const s = window.__atlas.store.getState()
    const target = s.view.nodes.find((n) => n.kind === s.rung)
    await s.descend(target.id)
    await window.__atlas.settled()
  })
  out.descent = await log()

  // 2. THE RENDER REVEAL — the staged bridge question, rendered for real.
  await page.evaluate(() => window.__atlas.scene('home'))
  await reset()
  await page.evaluate(async () => {
    const s = window.__atlas.store.getState()
    await s.runQuery(s.stagedQueries[0].query)
    await window.__atlas.settled()
  })
  out.reveal = await log()

  // 3. THE TRACE PING — the receipt's first citation, opened by its own control.
  await page.evaluate(() => window.__atlas.scene('receipt'))
  await reset()
  /* THE DOT'S TRAVEL IS MEASURED OFF THE HAIRLINE IT LEAVES. The mark is scaled
     along the chord by the same timeline that drives the renderer's comet, so
     the frame its length stops growing on IS the frame the dot landed on. */
  out.traceDom = await page.evaluate(async (label) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
    if (!btn) return null
    const width = () => {
      const el = document.querySelector('.mo-hair')
      return el === null ? 0 : el.getBoundingClientRect().width
    }
    const ringUp = () => {
      const el = document.querySelector('.mo-ring')
      return el === null ? 0 : Number(getComputedStyle(el).opacity)
    }
    btn.click()
    const t0 = performance.now()
    let start = null
    let grewAt = null
    let last = 0
    let ring = 0
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 20))
      const w = width()
      ring = Math.max(ring, ringUp())
      if (w > 0 && start === null) start = performance.now() - t0
      if (w > last + 0.5) grewAt = performance.now() - t0
      last = Math.max(last, w)
      if (start !== null && w === 0) break
    }
    return { firstMarkAt: start === null ? null : Math.round(start), travelMs: grewAt === null ? null : Math.round(grewAt - (start ?? 0)), lengthPx: Math.round(last), ringOpacity: Number(ring.toFixed(2)) }
  }, OPEN_CITATION)
  out.tracePresent = out.traceDom !== null
  out.trace = await log()

  /* INTERRUPTION. MOTION LAW 2 generalised: a second run of the same name takes
     over from the first rather than queueing behind it, the superseded run
     RESOLVES rather than rejecting, and it hands its authority back — so the
     root must not be left wearing a reveal attribute that belongs to a render
     nobody is looking at any more. */
  await page.evaluate(() => window.__atlas.scene('home'))
  await reset()
  out.interrupt = await page.evaluate(async () => {
    const s = window.__atlas.store.getState()
    void s.runQuery(s.stagedQueries[0].query)
    await new Promise((r) => setTimeout(r, 120))
    void s.runQuery(s.stagedQueries[1]?.query ?? s.stagedQueries[0].query)
    await new Promise((r) => setTimeout(r, 1800))
    await window.__atlas.settled()
    return {
      attribute: document.documentElement.getAttribute('data-reveal'),
      marks: document.querySelectorAll('.mo-hair, .mo-ring').length,
    }
  })
  out.interruptLog = await log()

  // 5. INGEST SETTLING — a real ingest, from a really closed corpus.
  await page.evaluate(() => window.__atlas.scene('empty'))
  await reset()
  await page.evaluate(async () => {
    await window.__atlas.store.getState().ingestDemo()
    await window.__atlas.settled()
  })
  out.ingest = await log()

  await settle()
  out.idleAfter = await page.evaluate(() => ({
    idle: window.__atlas.motion.idle(),
    active: window.__atlas.motion.active(),
  }))
  out.violations = await page.evaluate(() => window.__atlas.motion.violations())
  /* THE MOTION LAYER DRAWS ON THE TERRAIN, so it has to prove it did not TAKE any
     of it. `.mo-layer` is transparent and its marks are one pixel tall; the audit
     measures obstruction off the live DOM and this is the number that says so. */
  out.audit = await page.evaluate(() => {
    const a = window.__atlas.audit()
    return {
      animationsWithoutState: a.animationsWithoutState,
      viewportPct: Number(a.viewportPct.toFixed(2)),
      occluders: a.occluders.map((o) => o.what),
    }
  })
  out.budget = await page.evaluate(() => window.__atlas.motion.budget())
  return out
}

/** The one run of a given name that was not interrupted. */
const runOf = (log, name) => (log ?? []).filter((r) => r.name === name && !r.interrupted).at(-1) ?? null

/* =============================================================================
 * PASS 2 — THE VIRTUAL CLOCK. Frames at an exact millisecond.
 * ========================================================================== */

const OFFSETS = {
  descent: [0, 60, 140, 260, 420, 700, 1100],
  reveal: [0, 60, 120, 240, 360, 480, 700],
  trace: [0, 40, 100, 180, 240, 400, 900],
  ingest: [0, 120, 300, 500, 760, 1120, 1500],
}

async function strip(page, name, offsets, prefix) {
  let at = 0
  for (const off of offsets) {
    if (off > at) {
      // Step in small slices so every intermediate rAF actually fires.
      for (let left = off - at; left > 0; left -= 20) await page.clock.runFor(Math.min(20, left))
      at = off
    }
    const path = join(OUT, `${prefix}--${name}--${String(off).padStart(4, '0')}ms.png`)
    await page.screenshot({ path })
    report.strips.push(path)
  }
  process.stdout.write(`  strip ${prefix} ${name}: ${offsets.length} frames\n`)
}

/** Start something in the page without awaiting it — the clock has to advance first. */
async function kick(page, body, argValue = null) {
  await page.evaluate(
    ([src, a]) => {
      window.__done = false
      window.__err = null
      const fn = new Function('arg', `return (${src})(arg)`)
      Promise.resolve(fn(a)).then(
        () => {
          window.__done = true
        },
        (e) => {
          window.__err = String(e)
          window.__done = true
        },
      )
    },
    [body.toString(), argValue],
  )
}

/** Advance the virtual clock until the kicked promise settles, or a bound. */
async function spin(page, maxMs = 30_000, step = 100) {
  for (let t = 0; t < maxMs; t += step) {
    await page.clock.runFor(step)
    if (await page.evaluate(() => window.__done === true)) return true
  }
  return false
}

/**
 * Advance until the page says the animation has actually started.
 *
 * A strip measured from the CLICK is a strip of whatever the engine was doing:
 * the store commits on a promise chain that owes nothing to the clock, so the
 * first frame of a reveal lands some unknowable number of ticks after the query
 * was asked for. Every strip therefore starts from the animation's own first
 * frame, which is the only origin the offsets in the file names can honestly
 * refer to.
 */
async function spinUntil(page, predicate, maxMs = 8000, step = 20) {
  for (let t = 0; t < maxMs; t += step) {
    if (await page.evaluate(predicate)) return true
    await page.clock.runFor(step)
  }
  return false
}

/**
 * FREEZE TIME.
 *
 * `clock.install()` alone leaves the fake clock RUNNING with real time, and a
 * screenshot of a WebGL canvas under swiftshader costs three to six real
 * seconds — so every frame after the first was photographed several seconds
 * into an animation that lasts half of one. Measured, not assumed: the strips
 * taken that way were pixel-identical from 60ms to 1100ms because all of them
 * were the resting state. `pauseAt` stops the clock dead; from there only
 * `runFor` moves it, and an offset in a file name is exactly what it says.
 */
async function freeze(page) {
  const at = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(new Date(at + 1))
}

async function strips(browser) {
  const { ctx, page } = await newPage(browser, { clock: true })
  await freeze(page)

  // THE DESCENT, from the continent rung into a real continent.
  await kick(page, async () => window.__atlas.scene('atlas-continent'))
  await spin(page)
  await kick(page, () => {
    const s = window.__atlas.store.getState()
    return s.descend(s.view.nodes.find((n) => n.kind === s.rung).id)
  })
  await strip(page, 'descent', OFFSETS.descent, 'clock')
  await spin(page)

  // THE RENDER REVEAL.
  await kick(page, async () => window.__atlas.scene('home'))
  await spin(page)
  await kick(page, () => {
    const s = window.__atlas.store.getState()
    return s.runQuery(s.stagedQueries[0].query)
  })
  await spinUntil(page, () => document.documentElement.hasAttribute('data-reveal'))
  await strip(page, 'reveal', OFFSETS.reveal, 'clock')
  await spin(page)

  // THE TRACE PING, fired from the receipt's own control.
  await kick(page, async () => window.__atlas.scene('receipt'))
  await spin(page)
  await kick(
    page,
    (label) => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === label,
      )
      if (btn) btn.click()
      return Promise.resolve()
    },
    OPEN_CITATION,
  )
  await spinUntil(page, () => document.querySelector('.mo-hair') !== null)
  await strip(page, 'trace', OFFSETS.trace, 'clock')
  await spin(page)

  // INGEST SETTLING, from a closed corpus.
  await kick(page, async () => window.__atlas.scene('empty'))
  await spin(page)
  await kick(page, () => window.__atlas.store.getState().ingestDemo())
  await spinUntil(page, () => window.__atlas.motion.active().includes('ingest'))
  await strip(page, 'ingest', OFFSETS.ingest, 'clock')
  await spin(page)

  await ctx.close()
}

/* =============================================================================
 * MAIN
 * ========================================================================== */

async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({ args: GL })

  /* ---- full motion ------------------------------------------------------ */
  {
    const { ctx, page } = await newPage(browser)
    report.measured = await measure(page)
    await ctx.close()
  }

  const m = report.measured
  const budget = m.budget ?? {}
  const descent = runOf(m.descent, 'descent')
  const reveal = runOf(m.reveal, 'reveal')
  /* A trace run is EXPECTED to be interrupted: opening the cited passage is a
     place change, and a place change cancels the mark rather than letting it
     survive into the view it sent you to. So this one is not filtered. */
  const trace = (m.trace ?? []).filter((x) => x.name === 'trace').at(-1) ?? null
  const receipt = runOf(m.receipt, 'receipt')
  const ingest = runOf(m.ingest, 'ingest')

  check('1. THE DESCENT ran, and it is a rung change', descent !== null,
    descent && `measured ${descent.ms}ms, approach ${descent.requestedMs}ms, ${descent.steps} defocus steps`)
  check('   the descent defocuses through the whole ramp', descent?.steps === 4,
    `steps=${descent?.steps}`)
  check('2. THE RENDER REVEAL ran in three tiers', reveal !== null && reveal.steps === 3,
    reveal && `measured ${reveal.ms}ms, asked ${reveal.requestedMs}ms, ${reveal.steps} tiers`)
  check('   its budget is two --reveal-step offsets plus one --t-ui fade',
    reveal !== null && reveal.requestedMs === budget.stepMs * 2 + budget.uiMs,
    reveal && `${reveal.requestedMs} = ${budget.stepMs} * 2 + ${budget.uiMs}`)
  check('3. THE TRACE PING travelled', trace !== null,
    trace && `run measured ${trace.ms}ms of a ${trace.requestedMs}ms travel+hold budget`)
  /* TWO CHECKS, BECAUSE THEY ANSWER TWO QUESTIONS. The first is exact: the
     volley's budget must BE the tokens — one --t-ui of travel per dot, a third
     of it between dots, one --t-scene of hold. The second is a sighting: the
     hairline really grew along the chord and really stopped. It is deliberately
     loose, because it is measured on a software rasteriser where one frame costs
     50-100ms, and a tight bound there would be measuring the GPU. */
  check('   the volley is budgeted in tokens: --t-ui travel, --t-ui/3 stagger, --t-scene hold',
    trace !== null && trace.requestedMs === budget.uiMs + budget.sceneMs,
    trace && `${trace.requestedMs} = ${budget.uiMs} + ${budget.sceneMs} (one cited edge)`)
  check('   and the hairline really grew along the chord and stopped',
    (m.traceDom?.travelMs ?? -1) > 0 &&
      (m.traceDom?.travelMs ?? 0) <= budget.uiMs + 250 &&
      (m.traceDom?.lengthPx ?? 0) > 40,
    m.traceDom && `travel ${m.traceDom.travelMs}ms (--t-ui ${budget.uiMs}ms + frame slop), hairline ${m.traceDom.lengthPx}px`)
  /* THE PEAK IS SAMPLED, AND THE SAMPLER IS NOT THE ANIMATION. The ring rises
     over the last fifth of the dot's travel and the run is cancelled a frame
     after it lands — and on this rasteriser a frame is 50-100ms, during which
     the polling timer is starved by the WebGL draw and the passage rung's React
     commit. So the bar is "it was really drawn and really rising", not a precise
     peak; `shots/motion/zoom--trace-ring.png` is the frame that shows it whole. */
  check('   and the source gained its evidence ring',
    (m.traceDom?.ringOpacity ?? 0) > 0.3,
    m.traceDom && `ring opacity sampled at ${m.traceDom.ringOpacity} of full`)
  check('4. THE RECEIPT counted down, once', receipt !== null,
    receipt && `measured ${receipt.ms}ms, asked ${receipt.requestedMs}ms`)
  /* THE THRESHOLD IS A FRAME COUNT, AND IT IS DELIBERATELY LOW. This runs on
     swiftshader with four thousand nodes on screen, where a frame costs 50-100ms
     — six distinct figures across a 700ms count is every frame the machine had.
     A higher bar would be measuring the GPU, not the animation. */
  check('   the figure really moved, in the DOM',
    (m.receiptDom?.distinct ?? 0) >= 4 &&
      m.receiptDom?.from > m.receiptDom?.to &&
      m.receiptDom?.from === (m.receiptDom?.counterfactual ?? m.receiptDom?.from),
    m.receiptDom && `${m.receiptDom.from} -> ${m.receiptDom.to} over ${m.receiptDom.domMs}ms, ${m.receiptDom.distinct} distinct figures`)
  check('   it starts from the counterfactual on the FIRST painted frame',
    m.receiptDom?.firstPaintCounted === true,
    m.receiptDom && `first figure printed was ${m.receiptDom.from}`)
  check('   and it does NOT replay on a tab switch',
    (m.receiptReplay ?? []).filter((r) => r.name === 'receipt').length === 0,
    `${(m.receiptReplay ?? []).filter((r) => r.name === 'receipt').length} replays`)
  check('5. INGEST SETTLING ran for --ingest-settle', ingest !== null,
    ingest && `measured ${ingest.ms}ms, asked ${ingest.requestedMs}ms`)

  const reveals = (m.interruptLog ?? []).filter((x) => x.name === 'reveal')
  check('MOTION LAW 2 — a second render supersedes the first, and resolves it',
    reveals.length >= 2 && reveals.filter((x) => x.interrupted).length >= 1,
    reveals.map((x) => `${x.ms}ms${x.interrupted ? ' (superseded)' : ''}`).join(', '))
  check('   and the interrupted run handed its authority back',
    m.interrupt?.attribute === null && m.interrupt?.marks === 0,
    JSON.stringify(m.interrupt))

  check('MOTION LAW 3 — nothing animated without state', (m.violations ?? []).length === 0,
    (m.violations ?? []).join(' | '))
  check('   and audit() reports the same list',
    (m.audit?.animationsWithoutState ?? []).length === 0,
    (m.audit?.animationsWithoutState ?? []).join(' | '))
  check('   the mark layer takes none of the terrain',
    !(m.audit?.occluders ?? []).some((w) => String(w).includes('mo-layer')),
    `unobstructed terrain ${m.audit?.viewportPct}% of the window; occluders: ${(m.audit?.occluders ?? []).join(', ') || 'none'}`)
  check('settled() is honest: nothing is animating when it resolves',
    m.idleAfter?.idle === true, JSON.stringify(m.idleAfter))

  /* ---- reduced motion --------------------------------------------------- */
  {
    const { ctx, page } = await newPage(browser, { reduced: true })
    report.reduced = await measure(page)
    /* ONE FRAME OF THE REDUCED PATH, photographed after it settles. The numbers
       above say the animations collapsed; this says the SCREEN is the same
       screen — nothing left half-revealed, no tier stuck at latent because its
       step never came. */
    await page.evaluate(() => window.__atlas.scene('receipt'))
    const shot = join(OUT, 'reduced--receipt.png')
    await page.screenshot({ path: shot })
    report.strips.push(shot)
    await ctx.close()
  }

  const r = report.reduced
  const rBudget = r.budget ?? {}
  const rRuns = [
    ...(r.descent ?? []),
    ...(r.reveal ?? []),
    ...(r.trace ?? []),
    ...(r.receipt ?? []),
    ...(r.ingest ?? []),
  ]
  const collapsed = rRuns.filter((x) => x.requestedMs === rBudget.fastMs)
  check('REDUCED MOTION — the media query is live', rBudget.reduced === true,
    `--t-scene collapsed to ${rBudget.sceneMs}ms, --t-ui to ${rBudget.uiMs}ms`)
  check('   every scene animation collapses to one --t-fast crossfade',
    rRuns.length > 0 && collapsed.length === rRuns.length,
    `${collapsed.length}/${rRuns.length} runs at ${rBudget.fastMs}ms`)
  check('   and every stagger collapses to a single step',
    rRuns.every((x) => x.steps === 1), rRuns.map((x) => `${x.name}:${x.steps}`).join(' '))
  check('   the receipt does not count under reduced motion',
    (r.receiptDom?.distinct ?? 0) <= 2,
    r.receiptDom && `${r.receiptDom.distinct} distinct figures printed`)
  check('   INSTRUMENTS STILL UPDATE: the figure is the rendered one, immediately',
    r.receiptDom?.to === m.receiptDom?.to,
    `reduced printed ${r.receiptDom?.to}, full printed ${m.receiptDom?.to}`)
  check('   nothing animated without state under reduced motion either',
    (r.violations ?? []).length === 0, (r.violations ?? []).join(' | '))
  check('   and the audit agrees under reduced motion',
    (r.audit?.animationsWithoutState ?? []).length === 0,
    (r.audit?.animationsWithoutState ?? []).join(' | '))

  /* ---- the frames themselves -------------------------------------------- */
  if (STRIPS) await strips(browser)

  await browser.close()
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2))

  const failed = report.checks.filter((c) => !c.pass)
  console.log(`\n${report.strips.length} strip frames -> ${OUT}`)
  if (report.errors.length) {
    console.log(`ERRORS (${report.errors.length}):`)
    for (const e of report.errors) console.log(`  ${e}`)
  }
  if (failed.length || report.errors.length) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
