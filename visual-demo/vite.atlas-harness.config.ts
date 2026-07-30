import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// Build config for the RUNG ATLAS HARNESS only (atlas-harness.html).
//
// It has its own config and its own outDir for the same reason the terrain
// harness does: `vite.config.ts` is the PRODUCT build and its rollup input is
// `index.html`, so a second entry point must never be bolted onto it. Nothing
// here is imported by the app.
//
// It is also why the visual pass builds rather than shooting the dev server: a
// shared dev server hot-reloads whenever anybody edits anything, and a full page
// reload in the middle of a screenshot destroys the execution context the scene
// hook was driving. A built preview is immune to what the rest of the workspace
// is doing.
//
//   npx vite build   --config vite.atlas-harness.config.ts
//   npx vite preview --config vite.atlas-harness.config.ts --port 4185 --strictPort
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist-atlas-harness',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./atlas-harness.html', import.meta.url)),
    },
  },
  preview: {
    host: '127.0.0.1',
  },
  server: {
    host: '127.0.0.1',
  },
})
