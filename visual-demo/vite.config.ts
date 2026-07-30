import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// Single-command local run: `npm run dev`. No backend, no services.
// The engine client (src/engine/api.ts) reads VITE_TLDRG_BASE_URL; when it is
// unset the client serves the baked fixture corpus from memory. Pointing that
// env var at a live engine is the only change needed to swap the demo for real.
// The visual demo is published at https://tldr-g.ai/visual-demo/ — a sub-path, not
// the domain root, so asset URLs need that prefix. It is applied ONLY when the
// publish build sets PUBLISH=1; local dev, local preview and scripts/shoot.mjs keep
// serving from '/' so the screenshot harness and the deployed site cannot drift apart.
export const PUBLIC_BASE = '/visual-demo/'

// ONLY the publish build writes the host repo's site/ tree — the tree that syncs to
// the public repo and becomes tldr-g.ai. Everything else builds to a local, gitignored
// dist/.
//
// This split is not tidiness. outDir carries emptyOutDir, and `base` is only the
// sub-path under PUBLISH=1 — so a plain `npm run build` pointed at site/visual-demo
// would wipe the published bundle and replace it with one whose asset URLs are
// root-relative and 404 under https://tldr-g.ai/visual-demo/, taking .build-stamp.json
// with it. `npm run build` is the command the README tells a reader to run, and it
// would have silently destroyed the live demo.
const publishing = process.env.PUBLISH === '1'
const base = publishing ? PUBLIC_BASE : '/'
const outDir = fileURLToPath(
  new URL(publishing ? '../../site/visual-demo' : './dist', import.meta.url),
)

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    // Sourcemaps for local work, never for the published build. The map is ~4x the
    // bundle and would be committed on every rebuild — and it buys nothing here,
    // because the publish target ships the actual SOURCE alongside the bundle. A
    // sourcemap is how you inspect a build when you cannot read the source; that is
    // not the situation this demo is in.
    sourcemap: process.env.PUBLISH !== '1',
    outDir,
    emptyOutDir: true,
  },
})
