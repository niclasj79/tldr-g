# tldr-g.ai landing page (static)

Draft of the upgraded `tldr-g.ai` landing page — replaces the sparse placeholder.
Plain static HTML/CSS, no build step (fast, inspectable — on-brand). Authored 2026-06-14
per DP-2 (learn page on the company domain) + `[LANDING-PAGE-LAUNCH-UPGRADE]`.

## Files
- `index.html` — the landing page (hero → problem → how → proof → sovereign → open → install → demo)
- `style.css` — single stylesheet (dark, system-font, no framework)
- `learn/index.html` — the `/learn` thought-leadership section stub (DP-2)

## Before this goes public — the 3 founder gates (see Launch Hub §3, DP-3)
1. **Claims — ✅ CLEARED 2026-06-15.** The `[pending]` tags are removed; numbers use the SSOT wording
   ("~88% at parity on legal multi-hop; 67–88% across benchmarks"). The `<!-- CLAIM (SSOT) -->`
   comments mark each for your **final 6-tuple confirm** (marketing-claim-grounding) before publish —
   but nothing is over-claimed and no retracted figure appears.
2. **Repo must be public** — the install/SDK links point to `github.com/niclasj79/tp-vrg-launch`;
   flip it public (share-gate G7) before/with deploy or those links 404.
3. **DNS.** Point `tldr-g.ai` at the host (registrar change — founder-owned; Claude can't touch it).
4. **Email check.** The footer + early-access CTA use `niclas@tldr-g.ai` — confirm it routes.
5. **Optional, later:** X/LinkedIn handles in the footer (DP-1); embed the 2-min demo when recorded (P2).
See the sequenced 2-day plan: [[../docs/campaigns/2026-06-free-binary-open-sdk-launch/go-live-2day-checklist.md]].

Also fill the placeholders: social handles (X/LinkedIn per DP-1), the desktop-app download link,
and the public-repo URL if the repo is renamed before the public flip.

## Deploy (recommended: GitHub Pages, co-located with the public launch repo — DP-3 lean)
1. Copy `site/` into the public launch repo (`tp-vrg-launch`) — e.g. as `/docs` or a `gh-pages` branch.
   (Claude's GitHub scope here is `niclasj79/tp-vrg`, not the launch repo, so this copy is founder-done.)
2. Enable GitHub Pages on that path/branch.
3. Add a `CNAME` file containing `tldr-g.ai`; set the registrar's DNS records per GitHub Pages docs.
4. Verify HTTPS + that no `[pending]` tag remains.

Alternative hosts (Netlify / Cloudflare Pages / Vercel) work identically — drag the `site/` folder,
set the custom domain, point DNS. Static + portable by design.
