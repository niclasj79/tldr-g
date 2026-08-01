// The falsifiable half of the critic's checklist, run as code.
//
// Taste is argued; these are not. A checklist item cannot be waived by taste, so
// the ones that can be mechanically decided are decided mechanically here and the
// rest are checked at runtime by window.__atlas.audit() during the screenshot pass.
//
// Usage: node scripts/check-discipline.mjs

import { readFile, readdir } from 'node:fs/promises'
import { join, relative, extname } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SRC = join(ROOT, 'src')
const TOKEN_FILE = join(SRC, 'styles', 'design-tokens.css')

const failures = []
const notes = []

async function walk(dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, acc)
    else acc.push(p)
  }
  return acc
}

const files = await walk(SRC)
const code = files.filter((f) => ['.ts', '.tsx', '.css', '.glsl'].includes(extname(f)))

// ── 1. Zero hardcoded hex outside the token file ────────────────────────────
// Colors are a shared language; a stray #2ee6d0 is a private dialect that drifts
// the moment the token changes. The token file is the only place a hex is legal.
{
  const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g
  for (const f of code) {
    if (f === TOKEN_FILE) continue
    const text = await readFile(f, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      // Ignore hexes inside comments that are *citing* a token, and ignore
      // non-color hex payloads (hashes, signatures) which are data, not style.
      if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return
      if (/sha256:|0x[0-9a-fA-F]{8,}|content_hash|payload_hash|key_id/.test(line)) return
      const m = line.match(HEX)
      if (m) failures.push(`hardcoded hex ${m.join(' ')} — ${relative(ROOT, f)}:${i + 1}`)
    })
  }
}

// ── 2. Also ban raw rgb()/hsl() literals outside the token file ─────────────
// Same rule, different syntax. rgb(var(--render-rgb) / .12) is the legal form.
{
  const RAW = /\b(?:rgba?|hsla?)\(\s*[\d.]+[\s,]/g
  for (const f of code) {
    if (f === TOKEN_FILE) continue
    const text = await readFile(f, 'utf8')
    text.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (RAW.test(line)) failures.push(`raw color literal — ${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 90)}`)
      RAW.lastIndex = 0
    })
  }
}

// ── 3. No live layout on a read path ────────────────────────────────────────
// Position is baked. A force tick in a component is the whole anti-thesis: it
// makes the map move when the data didn't, which destroys spatial memory.
{
  const BANNED = [
    /forceSimulation|d3-force|forceLink|forceManyBody/,
    /requestAnimationFrame\s*\([^)]*\bsimulate\b/,
  ]
  for (const f of code) {
    const text = await readFile(f, 'utf8')
    for (const re of BANNED) {
      if (re.test(text)) failures.push(`live force layout referenced — ${relative(ROOT, f)}`)
    }
  }
  // bakeLayout may only be called from the bake/fixture layer, never from ui/ or graph/.
  for (const f of code) {
    const rel = relative(ROOT, f).replace(/\\/g, '/')
    if (!/^src\/(ui|graph|interaction|motion)\//.test(rel)) continue
    const text = await readFile(f, 'utf8')
    if (/\bbakeLayout\s*\(/.test(text)) {
      failures.push(`layout computed on a read path — ${rel} calls bakeLayout()`)
    }
  }
}

// ── 4. Left sidebar is forbidden; the terrain owns the horizontal ───────────
{
  for (const f of code.filter((f) => extname(f) === '.css')) {
    const text = await readFile(f, 'utf8')
    if (/\bleft-(?:side)?bar\b|\bsidebar-left\b/i.test(text)) {
      failures.push(`left sidebar styling present — ${relative(ROOT, f)}`)
    }
  }
  for (const f of code.filter((f) => extname(f) === '.tsx')) {
    const text = await readFile(f, 'utf8')
    if (/LeftSidebar|SidebarLeft/.test(text)) failures.push(`left sidebar component — ${relative(ROOT, f)}`)
  }
}

// ── 5. Numbers that measure must be monospaced ──────────────────────────────
// Heuristic but load-bearing: any component that formats a measured quantity has
// to route it through the mono numeric primitive rather than dropping it in raw.
{
  const MEASURES = /\.toFixed\(|toLocaleString\(|\btokens_rendered\b|\blatency_ms\b|\bcontent_hash\b|\bpayload_hash\b|\bcache_hits\b|\bsavings_pct\b|\brender_confidence_L\b/
  for (const f of code.filter((f) => extname(f) === '.tsx')) {
    const text = await readFile(f, 'utf8')
    if (!MEASURES.test(text)) continue
    const usesMono = /\b(Num|Mono|Metric|mono)\b/.test(text)
    if (!usesMono) {
      failures.push(
        `measured numbers rendered without the mono primitive — ${relative(ROOT, f)}`
      )
    }
  }
}

// ── 6. No drop shadows; elevation is border + top-edge inner light ─────────
{
  for (const f of code.filter((f) => extname(f) === '.css')) {
    if (f === TOKEN_FILE) continue
    const text = await readFile(f, 'utf8')
    text.split('\n').forEach((line, i) => {
      if (/^\s*(\/\*|\*)/.test(line)) return
      // inset shadows are the sanctioned top-edge light; outer ones are not.
      if (/box-shadow\s*:/.test(line) && !/inset/.test(line) && !/none/.test(line)) {
        failures.push(`outer drop shadow — ${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 80)}`)
      }
    })
  }
}

// ── 7. The product never blooms; glow is data, 6px maximum ─────────────────
{
  for (const f of code.filter((f) => extname(f) === '.css')) {
    if (f === TOKEN_FILE) continue
    const text = await readFile(f, 'utf8')
    text.split('\n').forEach((line, i) => {
      const m = line.match(/drop-shadow\(\s*0\s+0\s+(\d+(?:\.\d+)?)px/)
      if (m && Number(m[1]) > 6) {
        failures.push(`glow exceeds the 6px budget (${m[1]}px) — ${relative(ROOT, f)}:${i + 1}`)
      }
    })
  }
  for (const f of code.filter((f) => /Bloom|UnrealBloom/.test(f))) {
    failures.push(`bloom pass in the product renderer — ${relative(ROOT, f)}`)
  }
  for (const f of code) {
    const text = await readFile(f, 'utf8')
    if (/UnrealBloomPass|EffectComposer.*Bloom/.test(text)) {
      failures.push(`bloom post-process referenced — ${relative(ROOT, f)}`)
    }
  }
}

// ── 8. Banned vocabulary in shipped copy ───────────────────────────────────
// "Fire/Water" as mode names, competitor names, and generic-chatbot wording are
// all bans from the copy brief. Competitors are calibration, never product surface.
{
  const BANNED_COPY = [
    [/\bFire mode\b|\bWater mode\b|mode:\s*['"]fire['"]|['"]water['"]\s*:/i, 'Fire/Water mode naming'],
    [/\bObsidian\b|\bMaltego\b|\bLinkurious\b|\bKeyLines\b|\bArcGIS\b|\bPalantir\b|\bNeo4j\b|\bGephi\b|\bCosmograph\b|\bCytoscape\b/, 'competitor/vendor name'],
    [/\bAsk me anything\b|\bHow can I help\b|\bAI assistant\b/i, 'generic AI-chatbot wording'],
  ]
  const uiFiles = code.filter((f) => /\\(ui|copy)\\|\/(ui|copy)\//.test(f))
  for (const f of uiFiles) {
    const text = await readFile(f, 'utf8')
    for (const [re, why] of BANNED_COPY) {
      if (re.test(text)) failures.push(`${why} in shipped copy — ${relative(ROOT, f)}`)
    }
  }
  // README is shipped copy too.
  try {
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
    for (const [re, why] of BANNED_COPY.slice(1)) {
      if (re.test(readme)) failures.push(`${why} in README.md`)
    }
  } catch {
    failures.push('README.md is missing')
  }
}

// ── 9. The synthetic corpus must be labeled wherever it is served ──────────
{
  const engine = files.filter((f) => /[\\/]engine[\\/]/.test(f))
  let labeled = false
  for (const f of engine) {
    const text = await readFile(f, 'utf8')
    if (/synthetic-design-concept/.test(text)) labeled = true
  }
  if (!labeled) failures.push('no corpus_provenance: synthetic-design-concept marker in the engine layer')
}

// ── 10. Design tokens exist and TS never restates a hex ────────────────────
{
  try {
    const tokens = await readFile(TOKEN_FILE, 'utf8')
    const required = [
      '--void', '--surface', '--surface-2', '--line', '--ink', '--ink-dim', '--ink-faint',
      '--render', '--render-deep', '--evidence', '--curiosity', '--ok', '--warn', '--alarm',
      '--t-fast', '--t-ui', '--t-scene', '--ease-ui', '--ease-camera',
    ]
    for (const t of required) {
      if (!tokens.includes(t)) failures.push(`design-tokens.css is missing ${t}`)
    }
    for (let i = 0; i < 8; i++) {
      if (!tokens.includes(`--hue-${i}`)) failures.push(`design-tokens.css is missing --hue-${i}`)
    }
    if (!/prefers-reduced-motion/.test(tokens)) {
      failures.push('design-tokens.css has no prefers-reduced-motion collapse')
    }
  } catch {
    failures.push('src/styles/design-tokens.css does not exist')
  }
}

// ── 11. The ink ramp meets its stated contrast floors ──────────────────────
// A UX review measured the third ink step at 2.87 / 2.70 / 2.54 : 1 against the
// three grounds, while it was carrying every inactive control label in the top
// bar, all fifteen HUD cell labels, every <h2> panel title and the clickable root
// of the breadcrumb — at 11 to 12.5px, permanently. "Elegant" and "nearly
// unavailable" were the same decision.
//
// The floors are now declared here rather than asserted in a comment, because a
// colour is one keystroke from being darkened again and nobody re-measures a
// hex. This computes real WCAG relative luminance from the token file itself:
//   --ink-dim   >= 4.5  it carries functional text, which is AA body text
//   --ink-faint >= 3.0  it is decoration and non-text, which is the AA floor
//                       for exactly that
{
  const tokens = await readFile(TOKEN_FILE, 'utf8')
  const hexOf = (name) => {
    const m = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(tokens)
    return m === null ? null : m[1]
  }
  // WCAG 2.x relative luminance. No approximation: the sRGB transfer curve, the
  // real coefficients, the real 0.05 flare term.
  const lum = (hex) => {
    const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const lin = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
  }
  const ratio = (a, b) => {
    const [hi, lo] = lum(a) > lum(b) ? [a, b] : [b, a]
    return (lum(hi) + 0.05) / (lum(lo) + 0.05)
  }

  const grounds = ['--void', '--surface', '--surface-2'].map((n) => [n, hexOf(n)])
  const inks = [
    ['--ink', 4.5],
    ['--ink-dim', 4.5],
    ['--ink-faint', 3.0],
  ]
  for (const [ink, floor] of inks) {
    const fg = hexOf(ink)
    if (fg === null) {
      failures.push(`design-tokens.css does not declare ${ink} as a six-digit hex`)
      continue
    }
    for (const [gname, bg] of grounds) {
      if (bg === null) {
        failures.push(`design-tokens.css does not declare ${gname} as a six-digit hex`)
        continue
      }
      const r = ratio(fg, bg)
      if (r + 1e-9 < floor) {
        failures.push(
          `${ink} on ${gname} is ${r.toFixed(2)}:1, under its ${floor}:1 floor. ` +
            `If this step is meant to carry functional text it must clear 4.5; if it is ` +
            `decoration it must still clear 3. Do not lower the floor — move the usage.`
        )
      }
    }
    notes.push(
      `${ink}: ` + grounds.map(([g, bg]) => `${g.slice(2)} ${ratio(fg, bg).toFixed(2)}:1`).join(' · ')
    )
  }
}

// ── 12. A measured figure is never decorative ──────────────────────────────
// <Num> exists to render a MEASUREMENT. There is no such thing as a decorative
// one, so `tone="faint"` on a Num is always the wrong step — and it was how a
// citation count, a truth-gate denominator and a marquee total all ended up
// below every contrast floor while looking deliberate.
//
// THE HARNESSES ARE EXEMPT, and the exemption is narrow. `*/harness.tsx` are
// development entries that are never mounted by the app — their own banners say
// so — and they exist to lay out every tone of every primitive side by side,
// which means rendering the faint one is the point rather than a mistake. The
// exemption is by FILENAME rather than by an inline waiver, because a waiver a
// component can grant itself is not a check.
{
  const shipped = code.filter((f) => extname(f) === '.tsx' && !/harness\.tsx$/.test(f))
  for (const f of shipped) {
    const text = await readFile(f, 'utf8')
    const m = /<Num\b[^>]*?tone="faint"/s.exec(text)
    if (m) {
      failures.push(
        `a measured figure on the decorative ink step — ${relative(ROOT, f)}: ${m[0].slice(0, 60)}…`
      )
    }
  }
}

// ── 13. Hit targets clear the WCAG 2.2 minimum at every density ────────────
// SC 2.5.8 is 24x24 CSS px and it is not a preference. In one measured result
// state 18 of 19 visible focusables were under 44px and the two timeline brush
// handles were 8px WIDE — and did not scale with density, so touch mode widened
// every other target by 40% and left the two hardest ones alone.
{
  const tokens = await readFile(TOKEN_FILE, 'utf8')
  const step = (name) => {
    const m = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(tokens)
    return m === null ? null : Number(m[1])
  }
  const hit = (name) => {
    // --hit-min: calc(var(--s-9) * var(--density-hit-scale));
    const m = new RegExp(`${name}:\\s*calc\\(var\\((--s-\\d+)\\)`).exec(tokens)
    return m === null ? null : step(m[1])
  }
  const FLOOR = 24
  for (const name of ['--hit-min', '--hit-row', '--hit-icon']) {
    const px = hit(name)
    if (px === null) {
      failures.push(`design-tokens.css does not declare ${name} as calc(var(--s-N) * …)`)
    } else if (px < FLOOR) {
      failures.push(
        `${name} is ${px}px at comfortable density, under the ${FLOOR}px WCAG 2.2 minimum. ` +
          `A smaller LABEL is a legitimate choice; a smaller thing to press is not.`
      )
    }
  }
  if (!tokens.includes('--hit-slop')) {
    failures.push(
      'design-tokens.css has no --hit-slop. Controls whose visual size is load-bearing ' +
        '(an axis handle, a node name inside a sentence) need pressable area they do not paint.'
    )
  }
}

// ── report ─────────────────────────────────────────────────────────────────
const unique = [...new Set(failures)]
if (unique.length === 0) {
  console.log('discipline: clean — ' + code.length + ' files checked')
  for (const n of notes) console.log('  note: ' + n)
} else {
  console.log(`discipline: ${unique.length} violation(s)\n`)
  for (const f of unique) console.log('  ✗ ' + f)
  process.exitCode = 1
}
