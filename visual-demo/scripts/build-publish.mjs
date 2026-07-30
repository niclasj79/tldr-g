/**
 * =============================================================================
 * THE PUBLISH BUILD
 * =============================================================================
 *
 * `npm run publish-build` — typecheck, then build with PUBLISH=1 so vite.config.ts
 * applies the `/visual-demo/` base, then stamp the output with a hash of the source
 * it was built from.
 *
 * WHY A SCRIPT AND NOT `PUBLISH=1 vite build`
 * -------------------------------------------
 * That syntax is POSIX-only; it fails on Windows cmd, which is where this repo is
 * developed. `cross-env` would fix it and cost a dependency — but every other script
 * in this directory is dependency-free Node, and a build script is exactly the wrong
 * place to start an exception.
 *
 * WHY THE STAMP
 * -------------
 * The built output lives in the host repo's `site/visual-demo/` and is published by a
 * separate Python sync. Nothing in that pipeline can tell whether the bundle it is
 * about to ship was built from the source sitting next to it. A stale bundle at a
 * branded URL is the worst outcome available here: it is silent, it is public, and it
 * shows behaviour the source no longer has.
 *
 * So the build records `.build-stamp.json` — a SHA-256 over the exact source files a
 * build depends on — and the sync recomputes it and refuses to publish on a mismatch.
 * The check is content-addressed rather than mtime-based on purpose: mtimes survive
 * neither a fresh clone nor a branch switch, and would fail open on both.
 * =============================================================================
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, '..', '..', 'site', 'visual-demo');

/**
 * Everything a build's OUTPUT depends on. `src/` and `index.html` are the obvious
 * half; the configs and the lockfile are the half that is easy to forget and that
 * changes the bundle just as surely — a vite.config edit with untouched sources
 * still produces different output.
 */
const SOURCES = [
  'src',
  // `public/` is copied verbatim into the bundle by vite, so favicon.svg and og.png
  // change the published output without touching a line of src/. Omitting it would
  // let the social card be swapped while the stamp still read "fresh".
  'public',
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'tsconfig.json',
];

/** Directories that never contribute to a build and would make the hash machine-specific. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite', '.git', 'shots']);

/**
 * Extensions hashed with line endings normalised to LF.
 *
 * The repo's .gitattributes declares `* text=auto eol=lf`, so git stores and checks
 * these out as LF — but a working tree can still hold CRLF (an editor, a copy from
 * another checkout, core.autocrlf on an older clone). Hashing raw bytes would then
 * make the same logical source hash differently on two machines, and the gate would
 * fire on a clean checkout. A gate that cries wolf on a fresh clone is a gate someone
 * disables within a week.
 *
 * Line endings do not change what vite emits, so normalising them loses no signal.
 * Binary assets under public/ are hashed raw — a stray 0x0D0A in a PNG is content.
 */
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.html', '.css', '.svg', '.md', '.txt',
]);

function walk(abs, acc) {
  const st = statSync(abs);
  if (st.isFile()) {
    acc.push(abs);
    return acc;
  }
  for (const name of readdirSync(abs).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    walk(join(abs, name), acc);
  }
  return acc;
}

/**
 * A stable digest over the source tree. Paths are normalised to forward slashes and
 * sorted, so the same tree hashes identically on Windows and on CI.
 */
export function sourceHash() {
  const files = [];
  for (const entry of SOURCES) {
    try {
      walk(resolve(ROOT, entry), files);
    } catch {
      // A declared source that does not exist is a real problem, not a soft one:
      // it means SOURCES has drifted from the tree and the stamp is covering less
      // than it claims to.
      throw new Error(`build-publish: declared source '${entry}' does not exist under ${ROOT}`);
    }
  }

  // Sort by the REPO-RELATIVE POSIX path, not the absolute native one. Sorting
  // absolute paths would order by '\' on Windows and '/' elsewhere (0x5C vs 0x2F),
  // so the same tree could hash differently on two machines and the gate would fire
  // on a clean checkout. The digest is a cross-language contract — the Python side
  // in tools/sync_public_repo.py reproduces exactly this — so the ordering has to be
  // a property of the tree, not of the OS.
  const rels = files.map((abs) => [relative(ROOT, abs).split(sep).join('/'), abs]);
  rels.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const h = createHash('sha256');
  for (const [rel, abs] of rels) {
    let bytes = readFileSync(abs);
    const dot = rel.lastIndexOf('.');
    if (dot !== -1 && TEXT_EXT.has(rel.slice(dot))) {
      // Normalise CRLF -> LF. Must stay byte-identical to the Python side in
      // tools/sync_public_repo.py: replace(b'\r\n', b'\n') and nothing else. In
      // particular do NOT also strip lone \r — that would diverge from a plain
      // two-byte replace and silently break the cross-language agreement.
      bytes = Buffer.from(bytes.toString('binary').split('\r\n').join('\n'), 'binary');
    }
    h.update(rel);
    h.update('\0');
    h.update(bytes);
    h.update('\0');
  }
  return h.digest('hex');
}

// Running this file directly builds; importing it (the sync's verifier does) does not.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const typecheck = spawnSync('npx', ['tsc', '-b', '--noEmit'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (typecheck.status !== 0) process.exit(typecheck.status ?? 1);

  const build = spawnSync('npx', ['vite', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, PUBLISH: '1' },
  });
  if (build.status !== 0) process.exit(build.status ?? 1);

  const hash = sourceHash();
  writeFileSync(
    join(OUT, '.build-stamp.json'),
    `${JSON.stringify({ source_sha256: hash, base: '/visual-demo/' }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\nbuild-publish: ${OUT}`);
  console.log(`build-publish: source_sha256 ${hash}`);
}
