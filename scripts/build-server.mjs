// Bundle src/server.ts -> dist-server/server.cjs with esbuild so production
// runs plain `node` instead of `tsx`. That cut RSS at boot from ~450 MB (tsx
// + transpile cache + esbuild loader) to ~120 MB on a 512 MB Render dyno.
//
// esbuild ships as a transitive dep of vite, so no new package needed.
// The bundle stays CJS to keep `createRequire(import.meta.url)` and the
// `require('boardgame.io/server')` workaround for the framework's broken
// ESM subpath exports.

import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

await build({
  entryPoints: [join(REPO_ROOT, 'src', 'server.ts')],
  outfile: join(REPO_ROOT, 'dist-server', 'server.mjs'),
  platform: 'node',
  format: 'esm',
  target: 'node20',
  bundle: true,
  sourcemap: true,
  // Keep dependencies external — node_modules is shipped to Render and
  // resolved at runtime. This keeps the bundle small and lets pg / koa /
  // boardgame.io load their own platform-specific natives correctly.
  external: Object.keys(pkg.dependencies ?? {}),
  loader: { '.json': 'json' },
  // ESM in Node needs an explicit shim for CJS interop (boardgame.io still
  // uses `createRequire(import.meta.url)` to dodge its own broken ESM subpath
  // exports). esbuild handles the require glue automatically when format=esm.
  banner: {
    js: "import { createRequire as __cjsRequire } from 'node:module';\nconst require = __cjsRequire(import.meta.url);",
  },
  logLevel: 'info',
});

console.log('[build-server] dist-server/server.mjs ready');
