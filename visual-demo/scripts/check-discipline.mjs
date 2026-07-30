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
