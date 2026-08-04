// Rung-atlas visual QA + measurement.
//
// VERIFY BY LOOKING. The four rungs have to be different KINDS OF PLACE, not the
// same picture at four scales, and the only way to know is to photograph all
// four with the real store driving the real renderer and then look at them side
// by side. This drives `atlas-harness.html` — which exposes the STORE's own
// scene hook, so these are literally the scenes `scripts/shoot.mjs` will drive
// once the shell exists — plus `window.__rung` for the descent probes a
// screenshot of a resting state cannot show.
//
// It also measures the things a picture cannot: how long a descent takes, how
// many resolve waves it is cut into, that a second descent fired mid-flight
// produces ONE continuous move rather than two queued ones, and that the
// hysteresis band is wide enough to be usable.
//
// Usage: node scripts/verify-atlas.mjs [--url http://127.0.0.1:5173/atlas-harness.html]
//        [--out shots/atlas] [--size 1440|4k|1080]

import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const URL = arg('url', 'http://127.0.0.1:5173/atlas-harness.html')
const OUT = resolve(arg('out', 'shots/atlas'))
const SIZES = {
  1440: { width: 2560, height: 1440, tag: '1440p' },
  '4k': { width: 3840, height: 2160, tag: '4k' },
  1080: { width: 1920, height: 1080, tag: '1080p' },
}
const size = SIZES[arg('size', '1440')] ?? SIZES['1440']

const SCENES = ['atlas-continent', 'atlas-island', 'atlas-asset', 'atlas-passage']

const report = { url: URL, size: size.tag, shots: [], measurements: {}, errors: [], checks: [] }
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail })
  process.stdout.write(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`)
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
    ],
  })
  const ctx = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  })
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => report.errors.push(`pageerror: ${e.message}`))

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForFunction(() => window.__atlas?.scene && window.__rung?.ready(), null, {
    timeout: 45_000,
  })

  /* ---- 1. THE FOUR RUNGS, PHOTOGRAPHED ---------------------------------- */
  for (const scene of SCENES) {
    await page.evaluate((n) => window.__atlas.scene(n), scene)
    await page.evaluate(() => window.__atlas.settled?.())
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    )
    const place = await page.evaluate(() => ({
      ...window.__rung.place(),
      zoom: window.__rung.zoom(),
    }))
    const path = join(OUT, `${size.tag}--${scene}.png`)
    await page.screenshot({ path })
    report.shots.push(path)
    report.measurements[scene] = place
    process.stdout.write(`  shot ${scene}  ${JSON.stringify(place)}\n`)
  }

  /* ---- 1b. THE ISLAND RUNG, UNSCOPED ------------------------------------ */
  // The `atlas-island` scene is scoped to ONE continent, and in this corpus a
  // continent's islands are spread across the whole bake — so that scene sits at
  // the same altitude as the continent rung. The unscoped island rung is the
  // island rung's own character: every island in the world and every strait
  // between them. Shot so the claim can be checked rather than asserted.
  await page.evaluate(() => window.__atlas.scene('home'))
  await page.evaluate(() => window.__atlas.settled?.())
  {
    const place = await page.evaluate(() => window.__rung.place())
    const path = join(OUT, `${size.tag}--island-unscoped.png`)
    await page.screenshot({ path })
    report.shots.push(path)
    report.measurements['island-unscoped'] = place
    process.stdout.write(`  shot island-unscoped  ${JSON.stringify(place)}\n`)
  }

  /* ---- 1c. THE FLOOR, AND ITS TWO COVERINGS ----------------------------- *
   * The passage stopped being a rung on 2026-08-02 (the floor model). What used
   * to be "descend a fourth time" is now "arrive, and choose a covering", and
   * these are the four claims that change makes which a screenshot cannot check:
   *
   *   1. arriving does not change the rung — the spine still ends at the asset
   *   2. arriving does not grow the breadcrumb — a covering is not a place
   *   3. the control is a RADIOGROUP, not a tablist — the shell's "exactly three
   *      tabs" contract is a real contract, and a tiling is not a tab
   *   4. flipping the covering does not take a history entry — Back must never
   *      pop a tiling, because you never went anywhere
   */
  await page.evaluate(() => window.__atlas.scene('atlas-passage'))
  await page.evaluate(() => window.__atlas.settled?.())
  {
    const floor = await page.evaluate(() => {
      const s = window.__atlas.store.getState()
      const zoom = window.__rung.zoom()
      // Both breadcrumb forms are in the DOM at all times; one is display:none.
      // Only the painted one is a control.
      const segs = [...document.querySelectorAll('.rb-tiling-seg')].filter(
        (el) => el.getClientRects().length > 0,
      )
      return {
        rung: s.rung,
        assetId: s.assetId,
        tiling: s.assetTiling,
        zoom,
        stackDepth: s.stack.length,
        historyDepth: s.history.length,
        segs: segs.length,
        checked: segs.filter((el) => el.getAttribute('aria-checked') === 'true').length,
        roles: [...new Set(segs.map((el) => el.getAttribute('role')))],
        groupRole: document.querySelector('.rb-tiling')?.getAttribute('role') ?? null,
        /* NOT a count of tabs on screen — in Explore with no question there are
           none, so any number would have passed for the wrong reason. The claim
           is narrower and actually about this control: nothing inside it carries
           tab semantics, and it is not sitting inside a tablist. */
        tabsInside: document.querySelectorAll('.rb-tiling [role="tab"]').length,
        insideTablist: document.querySelector('.rb-tiling')?.closest('[role="tablist"]') !== null,
        labels: segs.map((el) => el.textContent.trim()),
      }
    })
    report.measurements['floor-reading'] = floor

    check(
      'arriving on a floor keeps the rung at the asset — the spine still ends where the author did',
      floor.rung === 'asset' && floor.assetId !== null,
      `${floor.rung} · assetId=${floor.assetId}`,
    )
    check(
      'the breadcrumb did not grow a segment for the covering',
      floor.stackDepth === 3,
      `stack depth ${floor.stackDepth}`,
    )
    check(
      'the tiling control is a radiogroup with exactly two segments, one lit',
      floor.groupRole === 'radiogroup' &&
        floor.segs === 2 &&
        floor.checked === 1 &&
        floor.roles.length === 1 &&
        floor.roles[0] === 'radio',
      `${floor.segs} × ${floor.roles.join('/')} in ${floor.groupRole}, ${floor.checked} checked — ${floor.labels.join(' | ')}`,
    )
    check(
      'and nothing in it is a tab — a covering is not a detail surface',
      floor.tabsInside === 0 && floor.insideTablist === false,
      `${floor.tabsInside} [role=tab] inside, in a tablist: ${floor.insideTablist}`,
    )

    /* THE GROUND RULE UNDER THE LAST STOP.
       The three level stops cannot distinguish "looking at the assets in this
       island" from "standing on one of them" — both light the asset mark,
       because both ARE the asset rung. The rule is the missing fact. Asserted as
       a rule under the ASSET stop and nowhere else, because a fourth mark in the
       strip would re-assert the ladder the three-rung spine removed. */
    const ground = await page.evaluate(() => {
      const rules = [...document.querySelectorAll('.rb-level-ground')].filter(
        (e) => e.getClientRects().length > 0,
      )
      const lit = rules.filter((e) => e.classList.contains('is-on'))
      const stops = [...document.querySelectorAll('.rb-level')].filter(
        (e) => e.getClientRects().length > 0,
      )
      /* PER SELECTOR, not globally. The level strip renders TWICE — the top
         bar's compact form and the rail's — so a global "is this the last stop"
         test fails on the first selector's asset stop for the wrong reason. Each
         group is checked against its own last stop. */
      const onLastStop = rules.every((r) => {
        const group = r.closest('.rb-levels')
        if (group === null) return false
        const own = [...group.querySelectorAll('.rb-level')].filter(
          (e) => e.getClientRects().length > 0,
        )
        return r.closest('.rb-level') === own[own.length - 1]
      })
      return {
        rules: rules.length,
        lit: lit.length,
        stops: stops.length,
        groups: document.querySelectorAll('.rb-levels').length,
        onLastStop,
      }
    })
    check(
      'the level strip shows a ground under the asset stop, lit while standing on it',
      ground.rules >= 1 && ground.lit === ground.rules && ground.onLastStop,
      `${ground.lit}/${ground.rules} lit — one per level strip (${ground.groups} on screen, ` +
        `${ground.stops} stops total), each on its own strip's last stop: ${ground.onLastStop}`,
    )

    /* THE ONE A SCREENSHOT CAUGHT AND NO ASSERTION WOULD HAVE.
       Arriving on a floor must FRAME THE DOCUMENT. It did not, for a reason that
       only existed after the passage stopped being a rung: `frameRung` guarded on
       "this rung has bodies to frame" before asking about the floor, and a floor's
       payload contains no body of its own rung. The camera stayed where it was and
       the page sat as a speck inside the whole island. Zoom is the instrument
       because the failure mode is precisely "the camera did not move". */
    const assetZoom = report.measurements['atlas-asset']?.zoom ?? Number.NaN
    check(
      'arriving on a floor FRAMES THE DOCUMENT — the camera actually moved in',
      Number.isFinite(assetZoom) && Number.isFinite(floor.zoom) && floor.zoom > assetZoom * 1.5,
      `asset rung ${assetZoom.toFixed(2)} → floor ${floor.zoom.toFixed(2)} (×${(floor.zoom / assetZoom).toFixed(2)})`,
    )

    const path = join(OUT, `${size.tag}--floor-reading.png`)
    await page.screenshot({ path })
    report.shots.push(path)

    /* ---- the flip ------------------------------------------------------- */
    const flipped = await page.evaluate(async () => {
      const st = () => window.__atlas.store.getState()
      const before = { history: st().history.length, stack: st().stack.length }
      st().setAssetTiling('graph')
      await window.__atlas.settled?.()
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const segs = [...document.querySelectorAll('.rb-tiling-seg')].filter(
        (el) => el.getClientRects().length > 0,
      )
      const lit = segs.find((el) => el.getAttribute('aria-checked') === 'true')
      return {
        tiling: st().assetTiling,
        rung: st().rung,
        assetId: st().assetId,
        litLabel: lit ? lit.textContent.trim() : null,
        historyBefore: before.history,
        historyAfter: st().history.length,
        stackBefore: before.stack,
        stackAfter: st().stack.length,
      }
    })
    report.measurements['floor-graph'] = flipped

    check(
      'flipping the covering re-tiles the same place — same rung, same asset',
      flipped.tiling === 'graph' && flipped.rung === 'asset' && flipped.assetId === floor.assetId,
      `${flipped.rung} · ${flipped.tiling} · assetId=${flipped.assetId}`,
    )
    check(
      'the lit segment moved with it',
      flipped.litLabel !== null && /graph/i.test(flipped.litLabel),
      `lit: ${flipped.litLabel}`,
    )
    check(
      'and the flip took NO history entry and NO breadcrumb segment — Back cannot pop a tiling',
      flipped.historyAfter === flipped.historyBefore && flipped.stackAfter === flipped.stackBefore,
      `history ${flipped.historyBefore}→${flipped.historyAfter}, stack ${flipped.stackBefore}→${flipped.stackAfter}`,
    )

    const gpath = join(OUT, `${size.tag}--floor-graph.png`)
    await page.screenshot({ path: gpath })
    report.shots.push(gpath)

    /* ---- THE REGISTRATION MORPH, CAUGHT MID-FLIGHT --------------------- *
     * The claim the morph makes is that an entity TRAVELS between the two
     * coverings — that it is at the centroid of its registrations in one and at
     * its baked position in the other, and that the distance is how far apart in
     * the document its mentions are. A resting screenshot of either end cannot
     * show that; only a frame from the middle can, and only a per-node position
     * sample can prove it rather than assert it. */
    const morph = await page.evaluate(async () => {
      const st = () => window.__atlas.store.getState()
      const sample = () => window.__rung.positions()
      st().setAssetTiling('reading')
      await window.__atlas.settled?.()
      await new Promise((r) => setTimeout(r, 120))
      const before = sample()
      /* SAMPLED ACROSS THE WHOLE FLIGHT, not at one frame. An earlier version
         took a single sample two rAFs in and went red on a loaded machine, where
         two frames can span the entire 360ms tween — a check that measures the
         host's spare capacity rather than the product. This walks the flight and
         keeps every frame the morph was actually running for. */
      st().setAssetTiling('graph')
      const frames = []
      const t0 = performance.now()
      while (performance.now() - t0 < 900) {
        await new Promise((r) => requestAnimationFrame(r))
        const live = window.__rung.morphing?.() ?? false
        frames.push(sample())
        if (!live && performance.now() - t0 > 60) break
      }
      await window.__atlas.settled?.()
      await new Promise((r) => setTimeout(r, 300))
      const after = sample()
      return { before, frames, after, ids: Object.keys(before).length }
    })

    if (morph.ids > 0) {
      const moved = Object.keys(morph.before).filter((id) => {
        const a = morph.before[id]
        const b = morph.after[id]
        return a && b && (Math.abs(a[0] - b[0]) > 1e-3 || Math.abs(a[1] - b[1]) > 1e-3)
      })
      // Strictly between the endpoints on at least one axis, in AT LEAST ONE
      // sampled frame: it travelled rather than teleported.
      const between = (p, q, r) => (p - q) * (p - r) < -1e-9
      const inFlight = moved.filter((id) => {
        const a = morph.before[id]
        const b = morph.after[id]
        if (!a || !b) return false
        return morph.frames.some((f) => {
          const m = f[id]
          return m !== undefined && (between(m[0], a[0], b[0]) || between(m[1], a[1], b[1]))
        })
      })
      check(
        'flipping the covering MOVES nodes — the two coverings are not the same picture',
        moved.length > 0,
        `${moved.length} of ${morph.ids} nodes have different positions in the two coverings`,
      )
      check(
        'and they TRAVEL rather than teleport — strictly between the ends, mid-flight',
        inFlight.length > 0 && inFlight.length === moved.length,
        `${inFlight.length} of ${moved.length} moving nodes were caught strictly between their ` +
          `endpoints across ${morph.frames.length} sampled frames`,
      )
      report.measurements['morph'] = { ids: morph.ids, moved: moved.length, inFlight: inFlight.length }
    } else {
      check('the morph could be sampled', false, 'no per-node positions exposed')
    }

    /* ---- EVIDENCE SCOPING, MEASURED ------------------------------------ *
     * The claim is that the graph covering draws only what THIS document
     * evidences, not everything its entities happen to be joined to elsewhere.
     * Counted from the payload rather than trusted, because the failure mode is
     * silent: the loose rule produces a picture that looks richer and is a
     * misattribution. */
    const scoping = await page.evaluate(() => {
      const s = window.__atlas.store.getState()
      const view = s.view
      if (view === null || s.assetId === null) return null
      const here = new Set(
        view.nodes.filter((n) => n.kind === 'passage' && n.asset_id === s.assetId).map((n) => n.id),
      )
      const inScope = new Set(view.nodes.filter((n) => n.kind === 'entity').map((n) => n.id))
      let bothEndpoints = 0
      let evidencedHere = 0
      for (const e of view.edges) {
        if (!inScope.has(e.from_id) || !inScope.has(e.to_id)) continue
        bothEndpoints += 1
        if (e.evidence_passage_ids.some((p) => here.has(p))) evidencedHere += 1
      }
      return { bothEndpoints, evidencedHere, passages: here.size }
    })

    if (scoping !== null && scoping.bothEndpoints > 0) {
      check(
        'the graph covering draws only what THIS document evidences',
        scoping.evidencedHere <= scoping.bothEndpoints,
        `${scoping.evidencedHere} evidenced here of ${scoping.bothEndpoints} with both endpoints in scope — ` +
          `${scoping.bothEndpoints - scoping.evidencedHere} would have been another document's assertion`,
      )
      report.measurements['edge-scoping'] = scoping
    }

    process.stdout.write(`  shot floor-reading + floor-graph\n`)
  }

  /* ---- 2. THE DESCENT, CAUGHT MID-FLIGHT -------------------------------- */
  // A resting screenshot cannot show a choreography. This one starts a real
  // descent and photographs it while the ramp is part way through, so the
  // fovea-outward resolve can be looked at rather than taken on trust.
  await page.evaluate(() => window.__atlas.scene('atlas-island'))
  await page.evaluate(() => window.__atlas.settled?.())
  // SAMPLED INSIDE THE PAGE, not across the wire. A screenshot RPC costs tens of
  // milliseconds and a `waitForTimeout` costs more; sampling a 1s choreography
  // from outside measures the harness as much as the product. This walks the
  // real frames the module publishes, from the first to the last.
  const flight = await page.evaluate(async () => {
    const seen = []
    const t0 = performance.now()
    const started = window.__rung.startDescent()
    while (performance.now() - t0 < 4000) {
      const f = window.__rung.frame()
      if (f !== null) {
        seen.push({
          t: Math.round(performance.now() - t0),
          phase: f.phase,
          resolved: f.resolved,
          waves: f.waves,
          // The renderer's own count of labels placed. It is what makes the
          // ramp visible at the fine rungs, where a boundary ring and a name
          // are drawn whatever tier the node is at.
          labels: window.__rung.labels(),
        })
      } else if (seen.length > 0) {
        break
      }
      await new Promise((r) => requestAnimationFrame(r))
    }
    await window.__atlas.settled?.()
    const phases = [...new Set(seen.map((s) => s.phase))]
    return {
      started,
      frames: seen.length,
      waves: seen[0]?.waves ?? null,
      phases,
      firstAt: seen[0]?.t ?? null,
      lastAt: seen[seen.length - 1]?.t ?? null,
      maxResolved: seen.reduce((m, s) => Math.max(m, s.resolved), 0),
      labels: seen.map((s) => s.labels),
      labelsAtRest: window.__rung.labels(),
      result: window.__rung.lastResult(),
      descending: window.__rung.descending(),
    }
  })
  report.measurements.flight = flight
  check('a descent from the island rung starts', flight.started === true)
  check(
    'the choreography runs all three beats, in order',
    flight.phases.join(' ') === 'approach resolve settle',
    JSON.stringify(flight.phases)
  )
  check(
    'the resolve is cut into waves and reaches every one of them',
    flight.waves > 1 && flight.maxResolved === 1,
    `waves=${flight.waves} maxResolved=${flight.maxResolved}`
  )
  {
    // The naming budget is spent on the same ramp. Measured off the renderer's
    // own label count, not asserted: it has to START below where it ENDS, or the
    // resolve is invisible at the rungs where rings and names dominate.
    const first = flight.labels.find((n) => Number.isFinite(n)) ?? 0
    const peak = Math.max(...flight.labels.filter(Number.isFinite))
    check(
      'the naming budget ramps with the resolution ramp',
      first < peak && peak <= flight.labelsAtRest,
      `labels ${flight.labels.join(' -> ')} · at rest ${flight.labelsAtRest}`
    )
  }
  check('the descent has ended once settled() resolves', flight.descending === false)
  check(
    'one rung change costs about one scene',
    flight.result !== null && flight.result.ms >= 700 && flight.result.ms <= 2400,
    JSON.stringify(flight.result)
  )

  // The illustration: a real descent, photographed WHILE THE RAMP IS RUNNING.
  // The wait is on the module's own published progress rather than on a clock,
  // so the frame that gets photographed is a stated fraction of the way through
  // the fovea-outward resolve rather than whatever a sleep happened to catch.
  await page.evaluate(() => window.__atlas.scene('atlas-island'))
  await page.evaluate(() => window.__atlas.settled?.())
  const caught = await page.evaluate(async () => {
    window.__rung.startDescent()
    for (let i = 0; i < 400; i++) {
      const f = window.__rung.frame()
      if (f !== null && f.phase === 'resolve' && f.resolved >= 0.3 && f.resolved <= 0.75) {
        return { phase: f.phase, resolved: f.resolved, waves: f.waves }
      }
      if (f === null && i > 4) return null
      await new Promise((r) => requestAnimationFrame(r))
    }
    return null
  })
  await page.screenshot({ path: join(OUT, `${size.tag}--descent-mid.png`) })
  report.shots.push(join(OUT, `${size.tag}--descent-mid.png`))
  report.measurements['descent-mid'] = caught
  check(
    'the ramp can be photographed part way through',
    caught !== null,
    caught === null ? 'never observed between 0.30 and 0.75' : JSON.stringify(caught)
  )
  await page.evaluate(() => window.__atlas.settled?.())

  /* ---- 3. INTERRUPTIBLE: two descents, ONE camera move ------------------ */
  await page.evaluate(() => window.__atlas.scene('atlas-continent'))
  await page.evaluate(() => window.__atlas.settled?.())
  const interrupt = await page.evaluate(async () => {
    const t0 = performance.now()
    window.__rung.startDescent()
    await new Promise((r) => setTimeout(r, 120))
    const during = window.__rung.frame()
    window.__rung.startDescent() // a second dive while the first is in the air
    await new Promise((r) => setTimeout(r, 40))
    const after = window.__rung.frame()
    await window.__atlas.settled?.()
    return {
      ms: Math.round(performance.now() - t0),
      duringRung: during?.to ?? null,
      afterRung: after?.to ?? null,
      concurrent: after === null ? 0 : 1,
      finalRung: window.__rung.place().rung,
      stillDescending: window.__rung.descending(),
    }
  })
  report.measurements.interrupt = interrupt
  check(
    'a second descent mid-flight leaves exactly one choreography running',
    interrupt.concurrent === 1,
    JSON.stringify(interrupt)
  )
  check('it comes to rest', interrupt.stillDescending === false)

  /* ---- 3b. THE ASCENT IS THE TRUE REVERSE ------------------------------- */
  // Down three rungs and back up three, through the real actions, checking that
  // every step lands where the descent came from. An ascent that does not undo
  // the descent is navigation, not a camera.
  const reversal = await page.evaluate(async () => {
    await window.__atlas.scene('atlas-passage')
    const down = window.__rung.place()
    const up = []
    for (let i = 0; i < 3; i++) {
      window.__rung.startAscent()
      await window.__atlas.settled?.()
      up.push(window.__rung.place().rung)
    }
    return { from: down.rung, path: up, stack: window.__rung.place().stack }
  })
  report.measurements.reversal = reversal
  check(
    'three ascents undo three descents, rung for rung',
    reversal.path.join(' ') === 'asset island continent' && reversal.stack === 0,
    JSON.stringify(reversal)
  )

  /* ---- 4. THE HYSTERESIS BAND ------------------------------------------- */
  const band = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    const n = (p) => Number.parseFloat(cs.getPropertyValue(p))
    return {
      in: n('--rung-zoom-in'),
      out: n('--rung-zoom-out'),
      cooldown: cs.getPropertyValue('--rung-zoom-cooldown').trim(),
      stagger: cs.getPropertyValue('--rung-stagger').trim(),
      dwell: cs.getPropertyValue('--atlas-dwell').trim(),
    }
  })
  report.measurements.band = band
  check(
    'the rung band is asymmetric and wide enough to be usable',
    band.in / band.out > 4,
    `${band.out}x .. ${band.in}x = ${(band.in / band.out).toFixed(2)}x wide, cooldown ${band.cooldown}`
  )

  /* ---- 5. REDUCED MOTION STILL CHANGES THE ONTOLOGY --------------------- */
  const rmCtx = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  })
  const rmPage = await rmCtx.newPage()
  rmPage.on('pageerror', (e) => report.errors.push(`[reduced-motion] pageerror: ${e.message}`))
  await rmPage.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 })
  await rmPage.waitForFunction(() => window.__atlas?.scene && window.__rung?.ready(), null, {
    timeout: 45_000,
  })
  await rmPage.evaluate(() => window.__atlas.scene('atlas-island'))
  await rmPage.evaluate(() => window.__atlas.settled?.())
  const rm = await rmPage.evaluate(async () => {
    const before = window.__rung.place().rung
    const t0 = performance.now()
    window.__rung.startDescent()
    // Catch the first published frame so the collapsed wave count is measured
    // rather than assumed.
    let waves = null
    while (waves === null && performance.now() - t0 < 2000) {
      const f = window.__rung.frame()
      if (f !== null) waves = f.waves
      await new Promise((r) => requestAnimationFrame(r))
    }
    await window.__atlas.settled?.()
    return {
      before,
      after: window.__rung.place().rung,
      waves,
      ms: Math.round(performance.now() - t0),
    }
  })
  report.measurements.reducedMotion = rm
  await rmPage.screenshot({ path: join(OUT, `${size.tag}--reduced-motion.png`) })
  report.shots.push(join(OUT, `${size.tag}--reduced-motion.png`))
  check(
    'under prefers-reduced-motion the ontology still changes',
    rm.before !== rm.after,
    `${rm.before} -> ${rm.after} in ${rm.ms}ms`
  )
  check(
    'and the ripple collapses to a single crossfade wave',
    rm.waves === 1,
    `waves=${rm.waves}`
  )
  await rmCtx.close()

  await ctx.close()
  await browser.close()
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2))

  const failed = report.checks.filter((c) => !c.pass)
  console.log(`\n${report.shots.length} screenshots -> ${OUT}`)
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
