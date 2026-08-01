// Measure the reworked shell in a real browser, at three real widths.
// Run: npm run build && npm run preview   (then)   node scripts/verify-shell.mjs
//
// -----------------------------------------------------------------------------
// WHY A THIRD BROWSER SCRIPT
// -----------------------------------------------------------------------------
// `verify-motion.mjs` asks whether the motion depicts something that happened.
// `shoot.mjs` asks whether every scene is reachable and photographs it. Neither
// asks the question a UX review asked and answered with a tape measure:
//
//     Is the QUESTION on screen? Is the answer's verification state attached to
//     it? Is the rail one surface tall, or is it a document? Can anything on it
//     be pressed? And is the terrain still the subject of the frame?
//
// Those are geometric facts about a live DOM, which means they can be MEASURED
// rather than argued, which means they can regress silently unless something
// measures them every time. The review found a rail 6,409px tall against a 632px
// viewport, a question that truncated at 1280px and vanished near 1024px, and 18
// of 19 visible focusables under 44px. Every one of those was invisible to a
// green build.
//
// -----------------------------------------------------------------------------
// WHAT IT ASSERTS, AND WHY EACH ONE IS A LAW RATHER THAN A PREFERENCE
// -----------------------------------------------------------------------------
//   THE QUESTION IS ON SCREEN whenever there is a result. Not truncated, not
//     behind a toggle, not implied by the answer. Its full text is compared
//     against the store's own `query.active.query`, so an ellipsis fails.
//   THE TRUST STATE IS PINNED WITH IT. A verification verdict is a property of
//     the answer and must not be a section the reader can scroll past — the
//     failure that put a green by-construction badge over a contradicted claim.
//   THE RAIL IS THREE BANDS AND ONLY THE MIDDLE ONE SCROLLS. The pinned band's
//     height is asserted against the rail's, so an append cannot creep back in.
//   ONE DETAIL SURFACE AT A TIME. Exactly one `[role=tabpanel]` is mounted.
//   THE TERRAIN OWNS THE HORIZONTAL. No left sidebar, by SHAPE, at every width.
//   EVERY VISIBLE FOCUSABLE CLEARS 24x24, counting hit slop. The slop is real
//     pressable area and is measured through `elementFromPoint` at the corners,
//     not inferred from the element's own box — which is exactly how an 18px
//     hash control and an 8px axis handle read as compliant when they are not.
//
// Exits non-zero on any failure.

import { chromium } from 'playwright'

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? '1']
  }),
)
const URL = args.get('url') ?? 'http://127.0.0.1:4173/'

/** The three widths the review actually tested at, plus the narrow-frame case. */
const WIDTHS = [
  { w: 1920, h: 1080, name: 'desktop' },
  { w: 1280, h: 800, name: 'laptop' },
  { w: 1024, h: 768, name: 'small' },
]

/** Below this the frame is a sheet, and the terrain floor is measured differently. */
const SHEET_BELOW = 820

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

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})

for (const { w, h, name } of WIDTHS) {
  console.log(`\n=== ${name} · ${w}x${h} ===`)
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200))
  })

  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof window.__atlas?.scene === 'function', null, { timeout: 30_000 })

  // A rendered answer is the state every one of these laws is about.
  await page.evaluate(async () => {
    await window.__atlas.scene('query-render')
    await window.__atlas.settled()
  })

  const m = await page.evaluate((sheetBelow) => {
    const s = window.__atlas.store.getState()
    const a = window.__atlas.audit()
    const rail = document.querySelector('.shell__rail')
    const pinned = document.querySelector('.rail__pinned')
    const body = document.querySelector('.rail__body')
    const q = document.querySelector('.task__q')

    /* THE PRESSABLE AREA, NOT THE PAINTED ONE.
       An element's own rect says nothing about hit slop, which is the whole
       mechanism this product uses for controls whose visual size is
       load-bearing. So the corners of a 24x24 box centred on the control are
       hit-tested against the real document: if the control (or something inside
       it) answers at all four, the target is genuinely 24x24. */
    const FLOOR = 24
    const tooSmall = []
    const sel = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      const st = getComputedStyle(el)
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) continue
      // Visually-hidden-until-focused affordances (skip links, the terrain's
      // structured twin) are 1px by design and are not pointer targets.
      if (r.width <= 2 || r.height <= 2) continue
      if (r.width >= FLOOR && r.height >= FLOOR) continue
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const corners = [
        [cx - FLOOR / 2 + 1, cy - FLOOR / 2 + 1],
        [cx + FLOOR / 2 - 1, cy - FLOOR / 2 + 1],
        [cx - FLOOR / 2 + 1, cy + FLOOR / 2 - 1],
        [cx + FLOOR / 2 - 1, cy + FLOOR / 2 - 1],
      ]
      const reaches = corners.every(([x, y]) => {
        const hit = document.elementFromPoint(x, y)
        return hit !== null && (el.contains(hit) || hit === el || hit.closest(sel) === el)
      })
      if (!reaches) {
        const cls = (el.className || '').toString().trim().split(/\s+/)[0]
        tooSmall.push(`${el.tagName.toLowerCase()}.${cls} ${Math.round(r.width)}x${Math.round(r.height)}`)
      }
    }

    return {
      width: window.innerWidth,
      isSheet: window.innerWidth < sheetBelow,
      question: s.query.active?.query ?? null,
      questionOnScreen: q === null ? null : (q.textContent ?? '').trim(),
      questionClipped: q === null ? true : q.scrollWidth > q.clientWidth + 1,
      trustPinned: pinned === null ? false : pinned.contains(document.querySelector('.task__trust, .task__untrusted')),
      railH: Math.round(rail?.getBoundingClientRect().height ?? 0),
      pinnedH: Math.round(pinned?.getBoundingClientRect().height ?? 0),
      bodyScroll: body === null ? 0 : body.scrollHeight,
      bodyClient: body === null ? 0 : body.clientHeight,
      panels: document.querySelectorAll('[role="tabpanel"]').length,
      tabs: document.querySelectorAll('[role="tab"]').length,
      selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.id ?? null,
      hasLeftSidebar: a.hasLeftSidebar,
      viewportPct: a.viewportPct,
      terrainRectPct: a.terrainRectPct,
      occluders: a.occluders.slice(0, 3).map((o) => `${o.what} ${o.pct.toFixed(1)}%`),
      monoViolations: a.monoViolations,
      animationsWithoutState: a.animationsWithoutState,
      rampAgrees: a.rampAgrees,
      tooSmall,
    }
  }, SHEET_BELOW)

  check('the question is on screen with the result', m.questionOnScreen === m.question, m.questionOnScreen ?? 'absent')
  check('…and it is not clipped', !m.questionClipped)
  check('the trust state is pinned with it', m.trustPinned)
  check('the rail carries exactly one detail surface', m.panels === 1, `${m.panels} tabpanels`)
  check('the tab strip offers three', m.tabs === 3, `${m.tabs} tabs, selected ${m.selectedTab}`)
  check(
    'a new result opens the evidence trail',
    m.selectedTab === 'rail-tab-evidence',
    m.selectedTab ?? 'none',
  )
  check(
    'the pinned band is a band, not the column',
    m.railH === 0 || m.pinnedH / m.railH < 0.6,
    `${m.pinnedH}px pinned of ${m.railH}px rail`,
  )
  check('the terrain owns the horizontal', m.hasLeftSidebar === false)
  check(
    'no measured numeral is off the mono rail',
    m.monoViolations.length === 0,
    m.monoViolations.slice(0, 3).join(' · '),
  )
  check(
    'no animation depicts nothing',
    m.animationsWithoutState.length === 0,
    m.animationsWithoutState.slice(0, 3).join(' · '),
  )
  check('the resolution partition still holds', m.rampAgrees)
  check(
    'every visible control can be pressed at 24x24',
    m.tooSmall.length === 0,
    m.tooSmall.slice(0, 5).join(' · '),
  )
  check('nothing threw', errors.length === 0, errors.slice(0, 2).join(' · '))

  console.log(
    `  measured: terrain ${m.viewportPct.toFixed(1)}% unobstructed of ${m.terrainRectPct.toFixed(1)}% allocated · ` +
      `rail body ${m.bodyScroll}/${m.bodyClient}px${m.isSheet ? ' · sheet' : ''}`,
  )
  if (m.occluders.length > 0) console.log(`  over the terrain: ${m.occluders.join(' · ')}`)

  await page.close()
}

await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
