import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// Build config for the TERRAIN HARNESS only (graph-harness.html).
//
// It exists because `vite.config.ts` is the product build and its rollup input
// is `index.html`. The harness is a second entry point that must never end up in
// the shipped bundle, so it gets its own config and its own outDir rather than
// being bolted onto the product's. Nothing here is imported by the app.
//
//   npx vite build   --config vite.harness.config.ts
//   npx vite preview --config vite.harness.config.ts --port 4174 --strictPort
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist-harness',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./graph-harness.html', import.meta.url)),
    },
  },
  preview: {
    host: '127.0.0.1',
  },
  server: {
    host: '127.0.0.1',
  },
})
