// Mechanical proof that the hands work.
//
// Taste is argued; these are not. Every assertion below drives REAL browser input
// — real wheel events, real pointer drags, real keystrokes — against the real
// store and the real renderer, and then reads the camera the renderer actually
// has. Nothing is stubbed, and no behaviour is asserted by calling the function
// that implements it.
//
// The one that matters most is the first: CURSOR-ANCHORED ZOOM. The world point
// under the pointer must not move while you zoom. Not "barely move". The
// tolerance is one CSS pixel across ten consecutive wheel events, measured by
// converting the same client point back to world space afterwards and scaling
// the difference by the zoom that ended up applied.
//
// Usage:
//   node scripts/verify-interaction.mjs [--url http://127.0.0.1:5173/interaction-harness.html]
//                                       [--out shots/interaction] [--keep]

import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const URL = arg('url', 'http://127.0.0.1:5173/interaction-harness.html')
const OUT = resolve(arg('out', 'shots/interaction'))
const VIEWPORT = { width: 1600, height: 900 }

/* ── the tiny harness ────────────────────────────────────────────────────── */

let passed = 0
const failures = []
const notes = []

function ok(label, detail = '') {
  passed++
  console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`)
}
function fail(label, detail) {
  failures.push(`${label}: ${detail}`)
  console.log(`  FAIL ${label} — ${detail}`)
}
function check(cond, label, detail = '') {
  if (cond) ok(label, detail)
  else fail(label, detail || 'assertion false')
}
function note(text) {
  notes.push(text)
  console.log(`     · ${text}`)
}
function section(title) {
  console.log(`\n${title}`)
}

/* ── page helpers ────────────────────────────────────────────────────────── */

const ix = (page, fn, ...args) => page.evaluate(fn, ...args)

async function waitReady(page) {
  await page.waitForFunction(() => window.__ix?.ready() === true, null, { timeout: 60_000 })
  await page.waitForFunction(() => ['READY', 'DEGRADED'].includes(window.__ix.state().app), null, {
    timeout: 60_000,
  })
  await page.evaluate(() => window.__ix.settle())
}

/** Wait until the camera stops changing — flights AND momentum. No fixed sleep. */
async function waitCameraStill(page, quietMs = 220, timeoutMs = 8000) {
  await page
    .waitForFunction(
      async (quiet) => {
        const read = () => {
          const c = window.__ix.camera()
          return `${c.x}|${c.y}|${c.zoom}`
        }
        const a = read()
        await new Promise((r) => setTimeout(r, quiet))
        return a === read() && window.__ix.idle()
      },
      quietMs,
      { timeout: timeoutMs, polling: 120 },
    )
    .catch(() => {})
}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

/** Let the renderer dispatch what it has been sent before sending more. */
const nextFrame = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))))

/**
 * Flick like a hand, at the rate this renderer can actually sample a pointer.
 *
 * Chromium dispatches queued input ONCE PER FRAME. Sent faster than that, six
 * CDP moves arrive as one `pointermove` — and CDP-injected events do not populate
 * `getCoalescedEvents()`, so there is genuinely no sample stream to fit a velocity
 * to and the control correctly refuses to invent one (`window-too-short`). Waiting
 * a frame between moves produces one sample per frame, which is exactly what a
 * real pointer produces on a machine rendering at this rate.
 */
async function flick(page, fromX, fromY, dx, steps = 5) {
  await page.mouse.move(fromX, fromY)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(fromX + (dx / steps) * i, fromY)
    // Not after the last one: a frame of stillness before the release is a hand
    // that stopped, and the control is right to refuse to throw anything.
    if (i < steps) await nextFrame(page)
  }
}

/**
 * Jump to a rung through the REAL keyboard map and wait for the store to arrive.
 *
 * `goToRung` is async and the app never leaves READY while it runs, so "wait for
 * READY" would happily pass against the previous rung. And pressing 2 while
 * already at the island rung is a legitimate no-op navigation that does NOT
 * re-frame, so the rig frames explicitly rather than assuming a known camera.
 */
async function goRung(page, digit, rung) {
  await page.locator('.ix-surface').focus()
  await page.keyboard.press(digit)
  await page.waitForFunction((r) => window.__ix.state().rung === r, rung, { timeout: 20_000 })
  await waitReady(page)
  await page.evaluate(() => window.__ix.frame())
  await waitCameraStill(page)
}

/* ── 1. CURSOR-ANCHORED ZOOM ─────────────────────────────────────────────── */

async function testAnchoredZoom(page, direction) {
  const rect = await ix(page, () => window.__ix.canvasRect())
  // Deliberately off-centre and not on a round number: a bug that only cancels
  // out at the exact middle of the viewport is the classic way this passes by
  // accident.
  const ax = Math.round(rect.left + rect.width * 0.683)
  const ay = Math.round(rect.top + rect.height * 0.371)

  await page.mouse.move(ax, ay)
  const before = await ix(page, ([x, y]) => window.__ix.screenToWorld(x, y), [ax, ay])

  let worst = 0
  const trail = []
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, direction * 120)
    // The camera is updated synchronously inside the wheel handler; the frame
    // that draws it is not what is being measured here.
    const state = await ix(
      page,
      ([x, y, wx, wy]) => {
        const now = window.__ix.screenToWorld(x, y)
        return { dx: now[0] - wx, dy: now[1] - wy, zoom: window.__ix.camera().zoom }
      },
      [ax, ay, before[0], before[1]],
    )
    const driftPx = Math.hypot(state.dx, state.dy) * state.zoom
    trail.push(driftPx)
    if (driftPx > worst) worst = driftPx
  }

  const label = direction < 0 ? 'zoom in' : 'zoom out'
  check(
    worst <= 1,
    `cursor-anchored ${label}: the world point under the cursor holds within 1px over 10 wheel events`,
    `worst drift ${worst.toFixed(6)}px (per event: ${trail.map((n) => n.toFixed(4)).join(', ')})`,
  )
  return worst
}

/* ── main ────────────────────────────────────────────────────────────────── */

async function main() {
  await mkdir(OUT, { recursive: true })

  const browser = await chromium.launch({
    args: [
      // Headless Chromium needs a real GL backend or the WebGL2 terrain renders
      // nothing, every pick misses, and the whole run passes vacuously.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  })
  const page = await ctx.newPage()

  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

  console.log(`interaction verification against ${URL}`)
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await waitReady(page)

  const start = await ix(page, () => window.__ix.state())
  check(start.app === 'READY', 'the harness reaches READY through the real actions', `app=${start.app}`)
  check(start.nodes > 0, 'the island rung has nodes to aim at', `${start.nodes} nodes in view`)
  await shot(page, 'home')

  /* ---------------------------------------------------------------------- */
  section('1. CURSOR-ANCHORED ZOOM — the single most felt detail')

  // Semantic zoom is OFF for this measurement, and that is not a dodge: crossing
  // a rung re-frames the camera BY DESIGN, so measuring the anchor across a
  // descent measures the descent. Section 2 turns it back on and proves it fires.
  await page.evaluate(() => window.__ix.setSemanticZoom(false))
  const worstIn = await testAnchoredZoom(page, -1)
  await waitCameraStill(page)
  const worstOut = await testAnchoredZoom(page, +1)
  await waitCameraStill(page)
  note(`worst drift overall: ${Math.max(worstIn, worstOut).toFixed(6)}px`)

  const zoomBefore = (await ix(page, () => window.__ix.camera())).zoom
  await page.mouse.wheel(0, -600)
  const zoomAfter = (await ix(page, () => window.__ix.camera())).zoom
  check(
    zoomAfter > zoomBefore,
    'the wheel actually changes altitude',
    `${zoomBefore.toFixed(4)} -> ${zoomAfter.toFixed(4)}`,
  )
  await shot(page, 'zoomed')

  /* ---------------------------------------------------------------------- */
  section('2. SEMANTIC ZOOM — past the threshold the ONTOLOGY changes')

  await page.evaluate(() => window.__ix.setSemanticZoom(true))
  await goRung(page, '2', 'island')

  const beforeDescent = await ix(page, () => window.__ix.state())
  const rectSem = await ix(page, () => window.__ix.canvasRect())
  const scx = Math.round(rectSem.left + rectSem.width / 2)
  const scy = Math.round(rectSem.top + rectSem.height / 2)
  await page.mouse.move(scx, scy)
  for (let i = 0; i < 14; i++) {
    if ((await ix(page, () => window.__ix.state())).rung !== 'island') break
    await page.mouse.wheel(0, -120)
    await new Promise((r) => setTimeout(r, 45))
  }
  await page
    .waitForFunction(() => window.__ix.state().rung !== 'island', null, { timeout: 8000 })
    .catch(() => {})
  const afterDescent = await ix(page, () => window.__ix.state())
  check(
    afterDescent.rung !== beforeDescent.rung,
    'zooming past --rung-zoom-in descends a rung by itself',
    `${beforeDescent.rung} -> ${afterDescent.rung}`,
  )
  check(
    afterDescent.stack > beforeDescent.stack,
    'the descent is scoped to a real body, not a bare rung change',
    `breadcrumb depth ${beforeDescent.stack} -> ${afterDescent.stack}`,
  )
  await waitReady(page)
  await shot(page, 'semantic-descent')

  const stackBefore = afterDescent.stack
  const rungBeforeAscent = afterDescent.rung
  await new Promise((r) => setTimeout(r, 1000)) // the declared --rung-zoom-cooldown
  for (let i = 0; i < 16; i++) {
    const s = await ix(page, () => window.__ix.state())
    if (s.stack < stackBefore || s.rung !== rungBeforeAscent) break
    await page.mouse.wheel(0, 120)
    await new Promise((r) => setTimeout(r, 45))
  }
  const afterAscent = await ix(page, () => window.__ix.state())
  check(
    afterAscent.stack < stackBefore || afterAscent.rung !== rungBeforeAscent,
    'zooming back out past --rung-zoom-out ascends again',
    `${rungBeforeAscent}/${stackBefore} -> ${afterAscent.rung}/${afterAscent.stack}`,
  )

  await page.evaluate(() => window.__ix.setSemanticZoom(false))

  /* ---------------------------------------------------------------------- */
  section('3. THE HARD CLAMP — you can never get lost in empty space')

  await goRung(page, '2', 'island')

  const overscroll = await ix(page, () =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pan-overscroll')),
  )
  check(Number.isFinite(overscroll), 'the clamp reads --pan-overscroll from the token file', `${overscroll}`)

  const rect = await ix(page, () => window.__ix.canvasRect())
  const cx = Math.round(rect.left + rect.width / 2)
  const cy = Math.round(rect.top + rect.height / 2)

  for (const [dx, dy, name] of [
    [1, 0, 'left'],
    [-1, 0, 'right'],
    [0, 1, 'up'],
    [0, -1, 'down'],
  ]) {
    for (let i = 0; i < 14; i++) {
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      await page.mouse.move(cx + dx * 700, cy + dy * 700, { steps: 6 })
      await page.mouse.up()
    }
    await waitCameraStill(page)

    const probe = await ix(page, () => ({
      cam: window.__ix.camera(),
      f: window.__ix.frustum(),
      b: window.__ix.bounds(),
    }))
    const padX = (probe.f.w / 2) * overscroll
    const padY = (probe.f.h / 2) * overscroll
    const insideX = probe.cam.x >= probe.b.min_x - padX - 0.5 && probe.cam.x <= probe.b.max_x + padX + 0.5
    const insideY = probe.cam.y >= probe.b.min_y - padY - 0.5 && probe.cam.y <= probe.b.max_y + padY + 0.5
    // The real promise: some of the world is still on screen.
    const overlaps =
      probe.cam.x - probe.f.w / 2 < probe.b.max_x &&
      probe.cam.x + probe.f.w / 2 > probe.b.min_x &&
      probe.cam.y - probe.f.h / 2 < probe.b.max_y &&
      probe.cam.y + probe.f.h / 2 > probe.b.min_y
    check(
      insideX && insideY && overlaps,
      `pan clamps at the world bound (${name}), and the terrain is still on screen`,
      `centre (${probe.cam.x.toFixed(1)}, ${probe.cam.y.toFixed(1)}) inside ` +
        `[${(probe.b.min_x - padX).toFixed(1)}, ${(probe.b.max_x + padX).toFixed(1)}] x ` +
        `[${(probe.b.min_y - padY).toFixed(1)}, ${(probe.b.max_y + padY).toFixed(1)}]`,
    )
  }
  await shot(page, 'clamped')

  /* ---------------------------------------------------------------------- */
  section('4. MOMENTUM — a fling decays and stops on its own')

  await goRung(page, '2', 'island')

  /* RETRIED, AND THE REASON IS IN THE DIAGNOSTIC RATHER THAN IN A LOOSER PRODUCT
     CONSTANT. `--fling-release` is 140ms: let go more than that after your hand
     stopped moving and nothing is thrown, which is correct for a hand and matches
     every platform's velocity tracker. The driver cannot meet it reliably —
     `mouse.up()` is a separate round trip after the last move, and the measured
     gap ranges 30-115ms with occasional excursions past 140ms. So the rig flicks
     up to four times and requires ONE of them to throw. A genuine regression
     still fails loudly: every attempt reports the verdict the control reached,
     and "never flung" is a failure whatever the gaps were.

     THE DECAY IS SAMPLED IN THE SAME CALL as the release is read. Sampling from a
     later `evaluate` costs several round trips, and a short fling can be over
     before the first window opens — which showed up as four zero-length windows
     on a run whose flick had visibly travelled. */
  let attemptResult = null
  let atRelease = null
  const attempts = []
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await goRung(page, '2', 'island')
    await flick(page, cx, cy, -330)
    atRelease = await ix(page, () => window.__ix.camera())
    await page.mouse.up()
    attemptResult = await page.evaluate(async () => {
      const rel = window.__ix.release()
      const out = []
      const t0 = performance.now()
      let last = window.__ix.camera().x
      for (const at of [250, 500, 750, 1000]) {
        await new Promise((resolve) => {
          const tick = () => (performance.now() - t0 >= at ? resolve() : requestAnimationFrame(tick))
          tick()
        })
        const now = window.__ix.camera().x
        out.push(Math.abs(now - last))
        last = now
      }
      return { rel, legs: out }
    })
    attempts.push(`${attemptResult.rel?.verdict}@${attemptResult.rel?.gapMs?.toFixed(0)}ms`)
    if (attemptResult.rel?.verdict === 'flung') break
    await waitCameraStill(page)
  }

  const releaseInfo = attemptResult.rel
  const legs = attemptResult.legs
  note(`release attempts: ${attempts.join(', ')} (--fling-release is 140ms)`)
  note(
    `release: verdict=${releaseInfo?.verdict} gap=${releaseInfo?.gapMs?.toFixed(1)}ms ` +
      `window=${releaseInfo?.dtMs?.toFixed(1)}ms over ${releaseInfo?.samples} samples ` +
      `speed=${releaseInfo?.speed?.toFixed(3)}px/ms`,
  )

  await waitCameraStill(page)
  const settled = await ix(page, () => window.__ix.camera())
  const flungInfo = await ix(page, () => window.__ix.release())
  note(`fling ran ${flungInfo?.flingFrames} frames for ${flungInfo?.flingPx?.toFixed(1)} CSS px`)

  const glide = Math.abs(settled.x - atRelease.x)
  check(glide > 0, 'a flick keeps travelling after the pointer is released', `glided ${glide.toFixed(1)} world units`)
  /* Decay is asserted over HALVES rather than over each consecutive pair. Under
     v(t)=v0·e^(-t/τ) the four windows are ~52/25/12/6% of the journey, so the
     first half should carry roughly four times the second — a wide margin. A
     per-pair assertion is not robust to the frame rate: under a software
     rasteriser one 250ms window occasionally catches no frame at all and the next
     catches its motion too, which reads as the terrain speeding up. The halves
     survive a stalled window; a fling that did not decay does not. */
  const firstHalf = legs[0] + legs[1]
  const secondHalf = legs[2] + legs[3]
  check(
    legs[0] > 0 && firstHalf > secondHalf * 1.5 && legs[0] > legs[3],
    'the momentum decays: the first half of the glide carries far more than the second',
    `250ms windows: ${legs.map((n) => n.toFixed(2)).join(' | ')} world units ` +
      `(first half ${firstHalf.toFixed(1)}, second ${secondHalf.toFixed(1)})`,
  )

  // A hand that stops before letting go must not throw anything.
  await goRung(page, '2', 'island')
  await flick(page, cx, cy, -220, 4)
  await new Promise((r) => setTimeout(r, 400))
  const beforeStillRelease = await ix(page, () => window.__ix.camera())
  await page.mouse.up()
  await waitCameraStill(page)
  const afterStillRelease = await ix(page, () => window.__ix.camera())
  check(
    Math.abs(afterStillRelease.x - beforeStillRelease.x) < 1e-6,
    'a drag that stopped before release does NOT fling',
    `moved ${Math.abs(afterStillRelease.x - beforeStillRelease.x).toExponential(2)} world units after release`,
  )

  /* ---------------------------------------------------------------------- */
  section('5. THE CAMERA IS WRITTEN BACK TO THE STORE WHEN THE HAND STOPS')

  // The store's camera is a TARGET and is deliberately NOT written during a
  // gesture — 60 targets a second would put React in the pan loop. It is written
  // once the camera is genuinely at rest, so the rig waits for that rather than
  // racing it.
  await page
    .waitForFunction(
      () => {
        const a = window.__ix.camera()
        const b = window.__ix.storeCamera()
        return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.zoom - b.zoom) < 1e-6
      },
      null,
      { timeout: 6000 },
    )
    .catch(() => {})

  const agree = await ix(page, () => ({ live: window.__ix.camera(), store: window.__ix.storeCamera() }))
  const delta = Math.max(Math.abs(agree.live.x - agree.store.x), Math.abs(agree.live.y - agree.store.y))
  check(agree.store.version > 0, 'the store camera target was written at all', `version ${agree.store.version}`)
  check(
    delta < 0.5 && Math.abs(agree.live.zoom - agree.store.zoom) < 1e-6,
    'the store target agrees with the camera the renderer actually has',
    `Δcentre ${delta.toFixed(4)}, Δzoom ${Math.abs(agree.live.zoom - agree.store.zoom).toExponential(2)}`,
  )

  /* ---------------------------------------------------------------------- */
  section('6. POINTER — hover, click, double-click')

  await goRung(page, '2', 'island')

  // Find a point that actually lands on a node — with the REAL pointer, reading
  // the REAL store, rather than trusting that the middle of the screen is a node.
  let nodePoint = null
  {
    const r = await ix(page, () => window.__ix.canvasRect())
    outer: for (let ring = 1; ring < 30; ring++) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        const x = Math.round(r.left + r.width / 2 + Math.cos(a) * ring * 11)
        const y = Math.round(r.top + r.height / 2 + Math.sin(a) * ring * 11)
        if (x < r.left + 2 || y < r.top + 2 || x > r.left + r.width - 2 || y > r.top + r.height - 2) continue
        await page.mouse.move(x, y)
        const hover = await ix(page, () => window.__ix.state().hover)
        if (hover !== null) {
          nodePoint = { x, y, id: hover }
          break outer
        }
      }
    }
  }

  check(nodePoint !== null, 'the pointer finds a real node on the terrain', nodePoint?.id ?? 'nothing hovered')

  if (nodePoint !== null) {
    await page.mouse.move(nodePoint.x, nodePoint.y)
    await page.waitForFunction(() => window.__ix.state().hover !== null, null, { timeout: 4000 })
    const cardVisible = await page.locator('.ix-card').count()
    check(cardVisible === 1, 'the hover card appears, anchored, exactly once', `${cardVisible} card(s)`)

    // The card must carry engine-sourced figures, not decoration.
    const cardText = (await page.locator('.ix-card').innerText()).replace(/\s+/g, ' ').trim()
    check(/Degree/i.test(cardText) && /\d/.test(cardText), 'the card carries measured fields', cardText.slice(0, 120))
    await shot(page, 'hover')

    // The one-hop neighbourhood is a REAL request. It lands as its own block on
    // the card — and at the island rung it honestly reports zero relations,
    // because a region node has no relations of its own. The class mix is
    // checked at the asset rung below, where there are relations to count.
    await page
      .waitForFunction(() => document.querySelector('.ix-card__mix') !== null, null, { timeout: 10_000 })
      .catch(() => {})
    const mixBlock = await page.locator('.ix-card__mix').count()
    check(
      mixBlock === 1,
      'the debounced neighbourhood request lands and adds its own block to the card',
      `${mixBlock} block(s)`,
    )
    await shot(page, 'hover-neighborhood')

    await page.mouse.click(nodePoint.x, nodePoint.y)
    const afterClick = await ix(page, () => window.__ix.state())
    check(
      afterClick.focus === nodePoint.id,
      'a click that did not move focuses the node under it',
      `focus=${afterClick.focus}`,
    )

    const rungBefore = afterClick.rung
    await page.mouse.dblclick(nodePoint.x, nodePoint.y)
    await page
      .waitForFunction((r) => window.__ix.state().rung !== r, rungBefore, { timeout: 10_000 })
      .catch(() => {})
    const afterDouble = await ix(page, () => window.__ix.state())
    check(
      afterDouble.rung !== rungBefore,
      'a double-click descends a rung',
      `${rungBefore} -> ${afterDouble.rung}`,
    )
    await waitReady(page)
    await shot(page, 'descended')
  }

  // At the asset rung the nodes DO carry relations, so the σ-class mix has
  // something real to count. This is the rung the hover-neighbourhood edge
  // policy is engaged at, too — the region rungs draw corridors, and swapping
  // those for their exemplar relations would tell the eye the corridors had gone.
  await goRung(page, '3', 'asset')
  {
    const r = await ix(page, () => window.__ix.canvasRect())
    let mixChips = 0
    outer2: for (let ring = 1; ring < 26; ring++) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2
        const x = Math.round(r.left + r.width / 2 + Math.cos(a) * ring * 12)
        const y = Math.round(r.top + r.height / 2 + Math.sin(a) * ring * 12)
        if (x < r.left + 2 || y < r.top + 2 || x > r.left + r.width - 2 || y > r.top + r.height - 2) continue
        await page.mouse.move(x, y)
        if ((await ix(page, () => window.__ix.state().hover)) === null) continue
        await page
          .waitForFunction(() => document.querySelectorAll('.ix-card__chips .chip').length > 0, null, {
            timeout: 3500,
          })
          .catch(() => {})
        mixChips = await page.locator('.ix-card__chips .chip').count()
        if (mixChips > 0) break outer2
      }
    }
    check(
      mixChips > 0,
      'at the asset rung the neighbourhood fills a real σ-class mix on the card',
      `${mixChips} class(es) counted from the response's own edges`,
    )
    await shot(page, 'hover-sigma-mix')
  }

  /* ---------------------------------------------------------------------- */
  section('7. SHIFT-DRAG RUBBER BAND')

  await goRung(page, '3', 'asset')
  const rBand = await ix(page, () => window.__ix.canvasRect())
  await page.keyboard.down('Shift')
  await page.mouse.move(Math.round(rBand.left + rBand.width * 0.32), Math.round(rBand.top + rBand.height * 0.3))
  await page.mouse.down()
  await page.mouse.move(Math.round(rBand.left + rBand.width * 0.68), Math.round(rBand.top + rBand.height * 0.7), {
    steps: 8,
  })
  const bandVisible = await page.locator('.ix-marquee').isVisible()
  check(bandVisible, 'the rubber band is drawn while the shift-drag is in flight', `${bandVisible}`)
  await shot(page, 'marquee')
  await page.mouse.up()
  await page.keyboard.up('Shift')
  const banded = await ix(page, () => window.__ix.state())
  check(banded.selection.length > 1, 'the band selects every node inside it', `${banded.selection.length} selected`)

  const readoutText = (await page.locator('.ix-selection').innerText()).replace(/\s+/g, ' ').trim()
  const figures = readoutText.match(/\d[\d ]*/g) ?? []
  check(readoutText.length > 0, 'the selection count is reported on screen', readoutText)
  // The band is capped. A cap that is applied silently is a lie about what was
  // selected, so when it binds the readout shows BOTH numbers.
  const cap = await ix(page, () =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--marquee-max')),
  )
  if (banded.selection.length >= cap) {
    check(
      figures.length >= 2,
      'when the rubber-band cap binds, the readout says what it caught as well as what it took',
      `cap ${cap}, readout "${readoutText}"`,
    )
  } else {
    note(`the rubber band caught ${banded.selection.length}, below the ${cap} cap — nothing to report`)
  }

  /* ---------------------------------------------------------------------- */
  section('8. THE WORLD-MAP STRIP EARNS ITS PLACE')

  await goRung(page, '2', 'island')
  const stripAtDepth = await page.locator('.ix-worldmap').count()
  check(stripAtDepth === 1, 'the strip is present below the continent rung (at island)', `${stripAtDepth} strip(s)`)

  const stripBox = await page.locator('.ix-worldmap').boundingBox()
  if (stripBox !== null) {
    check(
      Math.round(stripBox.width) >= 160 && Math.round(stripBox.height) >= 90,
      'the strip is the declared 160x90 (plus its own hairline)',
      `${Math.round(stripBox.width)}x${Math.round(stripBox.height)}`,
    )
    const canvasRect = await ix(page, () => window.__ix.canvasRect())
    check(
      stripBox.x + stripBox.width <= canvasRect.left + canvasRect.width + 1 &&
        stripBox.x > canvasRect.left + canvasRect.width / 2 &&
        stripBox.y >= canvasRect.top - 1,
      'the strip is docked top-right INSIDE the viewport',
      `x=${Math.round(stripBox.x)}, y=${Math.round(stripBox.y)} within ${Math.round(canvasRect.width)}x${Math.round(canvasRect.height)}`,
    )
  }

  // Dragging the strip pans the terrain.
  const camBeforeStrip = await ix(page, () => window.__ix.camera())
  if (stripBox !== null) {
    await page.mouse.move(Math.round(stripBox.x + 24), Math.round(stripBox.y + 24))
    await page.mouse.down()
    await page.mouse.move(Math.round(stripBox.x + stripBox.width - 24), Math.round(stripBox.y + stripBox.height - 24), {
      steps: 6,
    })
    await page.mouse.up()
  }
  const camAfterStrip = await ix(page, () => window.__ix.camera())
  check(
    Math.abs(camAfterStrip.x - camBeforeStrip.x) > 1e-6 || Math.abs(camAfterStrip.y - camBeforeStrip.y) > 1e-6,
    'dragging the strip pans the terrain',
    `(${camBeforeStrip.x.toFixed(1)}, ${camBeforeStrip.y.toFixed(1)}) -> (${camAfterStrip.x.toFixed(1)}, ${camAfterStrip.y.toFixed(1)})`,
  )
  await shot(page, 'worldmap')

  await goRung(page, '1', 'continent')
  const stripAtContinent = await page.locator('.ix-worldmap').count()
  check(stripAtContinent === 0, 'the strip is ABSENT at the continent rung', `${stripAtContinent} strip(s)`)
  await shot(page, 'continent-no-strip')

  /* ---------------------------------------------------------------------- */
  section("9. '/' OPENS SEARCH, AND ENTER FLIES THE CAMERA")

  await goRung(page, '2', 'island')
  await page.keyboard.press('Escape')
  await page.keyboard.press('/')
  await page.waitForFunction(() => window.__ix.state().search === true, null, { timeout: 4000 })
  const palette = await page.locator('.ix-palette').count()
  check(palette === 1, "'/' opens command search", `${palette} palette(s)`)

  await page.locator('.ix-palette__input').fill('Bruntorp')
  await page.waitForFunction(() => document.querySelectorAll('.ix-palette__row').length > 0, null, {
    timeout: 40_000,
  })
  const rows = await page.locator('.ix-palette__row').count()
  const groups = await page.locator('.ix-palette__group').allTextContents()
  check(rows > 0, 'the label index matches a real entity by name', `${rows} rows across ${groups.length} group(s)`)
  await shot(page, 'search')

  // Step onto the first "On the map" row so Enter is unambiguously a node fly.
  const nodeRowIndex = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('.ix-palette__slot')]
    for (let i = 0; i < slots.length; i++) {
      const header = slots[i].querySelector('.ix-palette__group')
      if (header && header.textContent && /map/i.test(header.textContent)) return i
    }
    return -1
  })
  check(nodeRowIndex >= 0, 'results are grouped, with the map group present', `first map row at index ${nodeRowIndex}`)
  for (let i = 0; i < Math.max(0, nodeRowIndex); i++) await page.keyboard.press('ArrowDown')

  const camBeforeFly = await ix(page, () => window.__ix.camera())
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__ix.state().search === false, null, { timeout: 4000 })
  await waitReady(page)
  await waitCameraStill(page)
  const camAfterFly = await ix(page, () => window.__ix.camera())
  const flew =
    Math.abs(camAfterFly.x - camBeforeFly.x) > 1e-3 ||
    Math.abs(camAfterFly.y - camBeforeFly.y) > 1e-3 ||
    Math.abs(camAfterFly.zoom - camBeforeFly.zoom) / camBeforeFly.zoom > 1e-3
  check(
    flew,
    'selecting a result flies the camera',
    `(${camBeforeFly.x.toFixed(1)}, ${camBeforeFly.y.toFixed(1)}, z${camBeforeFly.zoom.toFixed(4)}) -> ` +
      `(${camAfterFly.x.toFixed(1)}, ${camAfterFly.y.toFixed(1)}, z${camAfterFly.zoom.toFixed(4)})`,
  )

  const flown = await ix(page, () => window.__ix.state())
  check(
    flown.selection.length > 0,
    'the result it flew to is selected, not merely centred',
    flown.selection.join(', ').slice(0, 60),
  )
  // And it is actually on screen afterwards, which is the point of flying.
  const onScreen = await ix(page, (id) => {
    const p = window.__ix.pos(id)
    if (p === null) return null
    const f = window.__ix.frustum()
    return Math.abs(p.x - f.x) <= f.w / 2 && Math.abs(p.y - f.y) <= f.h / 2
  }, flown.selection[0])
  check(onScreen === true, 'the node it flew to is inside the frustum when the flight ends', `${onScreen}`)
  await shot(page, 'flown')

  /* ---------------------------------------------------------------------- */
  section('10. ESC CLEARS FOCUS EVERYWHERE')

  const beforeEsc = await ix(page, () => window.__ix.state())
  check(
    beforeEsc.focus !== null || beforeEsc.selection.length > 0,
    'there is something to clear',
    `focus=${beforeEsc.focus}`,
  )
  await page.keyboard.press('Escape')
  const afterEsc = await ix(page, () => window.__ix.state())
  check(
    afterEsc.focus === null && afterEsc.selection.length === 0 && afterEsc.search === false,
    'Escape clears focus, selection and the transient overlays',
    `focus=${afterEsc.focus} selection=${afterEsc.selection.length} search=${afterEsc.search}`,
  )

  /* ---------------------------------------------------------------------- */
  section('11. KEYBOARD TRAVERSAL — the graph without a pointer')

  await page.locator('.ix-surface').focus()
  await page.keyboard.press('ArrowRight')
  const firstFocus = await ix(page, () => window.__ix.state())
  check(firstFocus.focus !== null, 'the first arrow press lands on a node in front of you', `${firstFocus.focus}`)

  const seen = new Set([firstFocus.focus])
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown']) {
    await page.keyboard.press(key)
    const s = await ix(page, () => window.__ix.state())
    if (s.focus !== null) seen.add(s.focus)
  }
  check(seen.size > 1, 'arrows move focus between nodes', `${seen.size} distinct nodes reached in 6 presses`)

  // DIRECTION HAS TO MEAN DIRECTION. A nearest-neighbour search would answer a
  // different question, and the hand would lose its place after two presses.
  let rightMoves = 0
  let rightRegressions = 0
  for (let i = 0; i < 8; i++) {
    const before = await ix(page, () => window.__ix.state().focus)
    await page.keyboard.press('ArrowRight')
    const after = await ix(page, () => window.__ix.state().focus)
    if (after === null || before === null || after === before) continue
    const [a, b] = await ix(page, ([x, y]) => [window.__ix.pos(x), window.__ix.pos(y)], [before, after])
    if (a === null || b === null) continue
    rightMoves++
    if (b.x <= a.x) rightRegressions++
  }
  check(
    rightMoves > 0 && rightRegressions === 0,
    'ArrowRight only ever moves focus to a node further right',
    `${rightMoves} move(s), ${rightRegressions} going the wrong way`,
  )
  await shot(page, 'keyboard-focus')

  /* ---------------------------------------------------------------------- */
  section('12. σ-CLASS FILTER CHIPS')

  const chipCount = await page.locator('.ix-filters .chip').count()
  check(chipCount >= 7, 'six σ-class chips plus the quarantine toggle', `${chipCount} chips`)

  const sigmaBefore = (await ix(page, () => window.__ix.state())).sigma.length
  await page.locator('.ix-filters .chip').first().click()
  const sigmaAfter = (await ix(page, () => window.__ix.state())).sigma.length
  check(
    sigmaAfter === sigmaBefore - 1,
    'turning a class off removes exactly that class from the filter',
    `${sigmaBefore} -> ${sigmaAfter}`,
  )

  const withheld = await page.locator('.ix-filters__withheld').innerText()
  check(
    /\d/.test(withheld),
    'the bar reports what the filters removed, as a measured number',
    withheld.replace(/\s+/g, ' ').trim(),
  )
  await shot(page, 'filters')

  /* ---------------------------------------------------------------------- */
  section('13. PATH FINDING — typed hops with evidence')

  const pickers = page.locator('.ix-picker__input')
  await pickers.nth(0).fill('Rimsdal Group')
  await page.locator('.ix-picker__row').first().click()
  await pickers.nth(1).fill('Bruntorp Facility')
  await page.locator('.ix-picker__row').first().click()

  await page.locator('.ix-path .btn-primary').click()
  await page.waitForFunction(
    () => document.querySelectorAll('.ix-hop').length > 0 || document.querySelector('.ix-path__verdict') !== null,
    null,
    { timeout: 30_000 },
  )
  const hops = await page.locator('.ix-hop').count()
  check(hops > 0, 'the engine returns a chain between the two endpoints', `${hops} hop(s)`)

  if (hops > 0) {
    const text = (await page.locator('.ix-path__hops').innerText()).replace(/\s+/g, ' ').trim()
    check(
      /Rimsdal Group/.test(text) && /Bruntorp Facility/.test(text),
      'the gold chain reads end to end',
      text.slice(0, 170),
    )
    check(/acquired/.test(text), 'the traversal names the episodic family that carried it', 'acquired')
    check(/operates/.test(text), 'and the factual one', 'operates')
    check(/EVIDENCE\s*\d/i.test(text), 'every hop carries a measured evidence count', 'evidence counted per hop')
    const straits = await page.locator('.ix-hop .chip', { hasText: 'strait' }).count()
    check(straits > 0, 'the strait crossing is called out on the hop that makes it', `${straits} hop(s) marked`)
  }
  await shot(page, 'path')

  /* ---------------------------------------------------------------------- */
  section('14. NO CONSOLE ERRORS')
  check(
    consoleErrors.length === 0,
    'the run produced no console errors',
    consoleErrors.slice(0, 3).join(' | ') || 'clean',
  )

  /* ---------------------------------------------------------------------- */

  if (!has('keep')) await browser.close()

  const report = { url: URL, viewport: VIEWPORT, passed, failed: failures.length, failures, notes, consoleErrors }
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2))

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    console.log('FAILURES:')
    for (const f of failures) console.log(`  ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
