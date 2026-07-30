/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — ENTRY
 * =============================================================================
 *
 * Mount the shell. Nothing else happens here.
 *
 * NO `React.StrictMode`. Not because the checks are unwelcome — because in dev
 * StrictMode double-invokes every effect, and this application's effects create a
 * WebGL2 context, register the settle gate and the idle probe, and subscribe the
 * frame sampler to the renderer. Running that pair twice means two GL contexts
 * fighting over one canvas and a settle gate registered against a disposed
 * terrain, which is a fake failure that costs real hours. The discipline
 * StrictMode enforces is enforced here instead by `scripts/verify-state.mjs` and
 * by `scripts/shoot.mjs` exiting non-zero on a single console error.
 *
 * `boot()` is called by the shell rather than here: it is idempotent and
 * shareable, and FIRST-RUN is a screen the shell has to already be mounted to
 * show.
 * =============================================================================
 */

import { createRoot } from 'react-dom/client';

import { App } from '@/App';

/* THE VISUAL-QA SURFACE is not declared here. `src/graph/harness.tsx` already
   declares `Window.__atlas` for the dev harnesses, and a second `declare global`
   with a wider shape is a compile error rather than a merge. `@/state` owns
   `scenes` / `scene` / `settled` / `describe` / `store`; `@/ui/shell/hook` adds
   `audit` and upgrades `perf` to the renderer's full frame stats, writing through
   one narrow cast in that file. Both installers MERGE, so the order they run in
   does not matter. */

const host = document.getElementById('root');

if (host === null) {
  // FAIL LOUD. There is no fallback mount point, and inventing one would hide a
  // broken document from whoever has to fix it.
  throw new Error(
    '[main] no #root element in the document. index.html must contain <div id="root"></div>.',
  );
}

createRoot(host).render(<App />);
