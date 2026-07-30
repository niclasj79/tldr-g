// Capture the social preview image from the REAL interface.
//
// The visual doctrine requires marketing assets to be "stylized truths" —
// reproducible from the real product, never drawn. So this drives the actual app
// through the actual scene hook and photographs it. If the instrument changes,
// re-running this changes the card; nothing here can drift into fiction.
//
// WHY IT CAPTURES WIDE AND SCALES DOWN. The output must be exactly 1200x630
// (the Open Graph standard). Rendering the app AT 1200 CSS px puts the shell in
// its narrow layout, where the command bar truncates mid-word — a real layout,
// but one that reads as a broken screenshot on a share card. Capturing at a
// comfortable width and scaling the bitmap keeps the composition the product
// actually has at desktop size, which is the honest thing to show, and keeps the
// telemetry legible. The scale is done on a canvas with smoothing rather than by
// cropping, so nothing is cut off.
//
// Usage: node scripts/og.mjs [--url ...] [--scene receipt] [--width 1600] [--out og.png]

import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'

const OG_W = 1200
const OG_H = 630

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const TARGET = arg('url', 'http://127.0.0.1:4173')
const SCENE = arg('scene', 'receipt')
const CAP_W = Number(arg('width', '1600'))
const CAP_H = Math.round((CAP_W * OG_H) / OG_W) // hold the 1.905:1 OG aspect exactly
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'public', arg('out', 'og.png'))

const b = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-color-profile=srgb'],
})
const ctx = await b.newContext({ viewport: { width: CAP_W, height: CAP_H }, deviceScaleFactor: 1, colorScheme: 'dark' })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })

await p.goto(TARGET, { waitUntil: 'networkidle', timeout: 60_000 })
await p.waitForFunction(() => !!window.__atlas?.scene, null, { timeout: 45_000 })
await p.evaluate((s) => window.__atlas.scene(s), SCENE)
await p.evaluate(() => window.__atlas.settled?.())
await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
const shot = await p.screenshot()

// Scale to exactly 1200x630 in a blank page, so the artefact on disk is the
// standard size regardless of the capture width.
const scaler = await ctx.newPage()
await scaler.setContent('<canvas id="c"></canvas>')
const dataUrl = await scaler.evaluate(
  async ({ b64, w, h }) => {
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64 })
    const c = document.getElementById('c')
    c.width = w; c.height = h
    const g = c.getContext('2d')
    g.imageSmoothingEnabled = true
    g.imageSmoothingQuality = 'high'
    g.drawImage(img, 0, 0, w, h)
    return c.toDataURL('image/png')
  },
  { b64: shot.toString('base64'), w: OG_W, h: OG_H },
)
await writeFile(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'))
await b.close()

if (errs.length) { console.error('page errors:', errs.slice(0, 3)); process.exitCode = 1 }
const bytes = (await readFile(OUT)).length
console.log(`og image -> ${OUT}  (captured ${CAP_W}x${CAP_H}, written ${OG_W}x${OG_H}, ${bytes} bytes, scene "${SCENE}")`)
