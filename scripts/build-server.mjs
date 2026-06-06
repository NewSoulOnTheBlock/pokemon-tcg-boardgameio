// Bundle src/server.ts -> dist-server/server.mjs with esbuild so production
// runs plain `node` instead of `tsx`. That cut RSS at boot from ~450 MB (tsx
// + transpile cache + esbuild loader) to ~120 MB on a 512 MB Render dyno.
//
// We also copy src/data/card-manifest.generated.json next to the bundle so
// cards-server-bootstrap.ts can find it via `./card-manifest.generated.json`
// at runtime (Render's repo layout puts compiled output at
// /opt/render/project/src/dist-server/ and source at .../src/src/data/,
// which makes `../data/` resolve to a non-existent path in prod).

import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
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
  banner: {
    js: "import { createRequire as __cjsRequire } from 'node:module';\nconst require = __cjsRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// Copy the slim manifest next to the bundle so cards-server-bootstrap can
// find it via `./card-manifest.generated.json` in production.
const manifestSrc = join(REPO_ROOT, 'src', 'data', 'card-manifest.generated.json');
const manifestDst = join(REPO_ROOT, 'dist-server', 'card-manifest.generated.json');
if (!existsSync(manifestSrc)) {
  throw new Error(`Card manifest not found at ${manifestSrc}. Run 'npm run build:cards' first.`);
}
mkdirSync(dirname(manifestDst), { recursive: true });
copyFileSync(manifestSrc, manifestDst);

console.log('[build-server] dist-server/server.mjs + card-manifest.generated.json ready');

