// Visual-QA harness. Boots the built demo, drives it into each required screen
// via the deterministic scene hook the app exposes on window.__atlas, and writes
// real screenshots at 1440p and 4K for the critic pass.
//
// The app is responsible for exposing:
//   window.__atlas.scene(name)  -> Promise<void>   drive into a named screen
//   window.__atlas.settled()    -> Promise<void>   resolves when animations quiesce
//   window.__atlas.scenes       -> string[]        the names it supports
// Screenshots are worthless if they catch a half-finished transition, so we wait
// on settled() rather than on a sleep. If the hook is missing we shoot home only
// and say so loudly — a silent partial pass would let the critic review nothing.
//
// Usage: node scripts/shoot.mjs [--url http://127.0.0.1:4173] [--out shots]
//        [--scenes home,query-render] [--sizes 1440,4k]

import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const URL = arg('url', 'http://127.0.0.1:4173')
const OUT = resolve(arg('out', 'shots'))
const SIZES = {
  '1440': { width: 2560, height: 1440, deviceScaleFactor: 1, tag: '1440p' },
  '4k': { width: 3840, height: 2160, deviceScaleFactor: 1, tag: '4k' },
  '1080': { width: 1920, height: 1080, deviceScaleFactor: 1, tag: '1080p' },
}
const wanted = arg('sizes', '1440,4k')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => SIZES[s])

// The full required-screens list from the brief. The harness asks the app which
// of these it actually supports rather than assuming — an unsupported scene is
// reported as a gap, not skipped quietly.
const REQUIRED_SCENES = [
  'first-run',
  'empty',
  'ingesting',
  'settling',
  'home',
  'query-render',
  'constellation',
  'receipt',
  'passage-drilldown',
  'path-explain',
  'atlas-continent',
  'atlas-island',
  'atlas-asset',
  'atlas-passage',
  'analyst',
  'timeline',
  'verify-valid',
  'verify-invalid',
  'quarantine',
  'degraded',
  'degraded-query',
  'saved-view',
]

async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({
    args: [
      // Headless Chromium needs a real GL backend or the WebGL2 scene renders
      // nothing and every screenshot is a black rectangle that looks "calm".
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
    ],
  })

  const report = { url: URL, shots: [], missing: [], errors: [], expected: [] }

  for (const key of wanted) {
    const size = SIZES[key]
    const ctx = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.deviceScaleFactor,
      colorScheme: 'dark',
      reducedMotion: 'no-preference',
    })
    const page = await ctx.newPage()

    // The DEGRADED scenes reach a genuinely unreachable engine on purpose, so the
    // browser logs a failed resource load. That console error is the evidence the
    // failure was real rather than staged — tolerating it is correct. The
    // tolerance is scoped hard: only connection-level errors, and only while a
    // degraded scene is on screen. Every other console error still fails the run,
    // because a harness that swallows errors certifies a lie.
    let currentScene = 'load'
    const EXPECTED_WHILE_DEGRADED =
      /net::ERR_(CONNECTION_REFUSED|UNSAFE_PORT|ADDRESS_INVALID|CONNECTION_RESET|NAME_NOT_RESOLVED)|Failed to fetch/i
    const tolerated = (text) =>
      currentScene.startsWith('degraded') && EXPECTED_WHILE_DEGRADED.test(text)

    page.on('console', (m) => {
      if (m.type() !== 'error') return
      if (tolerated(m.text())) {
        report.expected.push(`[${size.tag}] ${currentScene}: ${m.text()}`)
        return
      }
      report.errors.push(`[${size.tag}] console: ${m.text()}`)
    })
    page.on('pageerror', (e) => {
      if (tolerated(e.message)) {
        report.expected.push(`[${size.tag}] ${currentScene}: ${e.message}`)
        return
      }
      report.errors.push(`[${size.tag}] pageerror: ${e.message}`)
    })

    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 })

    const hasHook = await page
      .waitForFunction(() => !!window.__atlas?.scene, null, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false)

    if (!hasHook) {
      report.errors.push(
        `[${size.tag}] window.__atlas.scene missing — only the landing screen was captured. ` +
          `The app must expose the deterministic scene hook or visual QA cannot review the product.`
      )
      await page.screenshot({ path: join(OUT, `${size.tag}--landing-only.png`) })
      await ctx.close()
      continue
    }

    const supported = await page.evaluate(() => window.__atlas.scenes ?? [])
    for (const s of REQUIRED_SCENES) {
      if (!supported.includes(s) && !report.missing.includes(s)) report.missing.push(s)
    }

    const scenes = arg('scenes', '')
      ? arg('scenes', '').split(',').map((s) => s.trim())
      : REQUIRED_SCENES.filter((s) => supported.includes(s))

    for (const scene of scenes) {
      try {
        currentScene = scene
        await page.evaluate((n) => window.__atlas.scene(n), scene)
        await page.evaluate(() => window.__atlas.settled?.())
        // One extra rAF pair so the compositor has definitely presented the frame
        // the scene hook just resolved on.
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        )
        const path = join(OUT, `${size.tag}--${scene}.png`)
        await page.screenshot({ path })
        report.shots.push(path)
        process.stdout.write(`  shot ${size.tag} ${scene}\n`)
      } catch (e) {
        report.errors.push(`[${size.tag}] scene "${scene}" failed: ${e.message}`)
      }
    }

    // Frame-budget probe: ask the app for its own measured stats rather than
    // timing from outside, so the number matches what the HUD claims.
    try {
      const perf = await page.evaluate(() => window.__atlas.perf?.())
      if (perf) report[`perf_${size.tag}`] = perf
    } catch {
      /* perf hook is optional */
    }

    await ctx.close()
  }

  await browser.close()
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2))

  console.log(`\n${report.shots.length} screenshots -> ${OUT}`)
  if (report.missing.length) console.log(`MISSING SCENES: ${report.missing.join(', ')}`)
  if (report.errors.length) {
    console.log(`ERRORS (${report.errors.length}):`)
    for (const e of report.errors) console.log(`  ${e}`)
  }
  // Missing scenes and page errors are real failures of the deliverable, so the
  // harness exits non-zero — a green shoot means the product actually stood up.
  if (report.missing.length || report.errors.length) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
