// Server-only manifest bootstrap. Used by src/server.ts on the very first
// boot (when the `app_cards` Postgres table is empty) to seed Postgres from
// the bundled slim manifest.
//
// We deliberately use `fs.readFileSync` instead of an `import ... with { type:
// 'json' }` static import. The static-import path inlines the 8 MB JSON into
// the esbuild output, which OOMs Render's 512 MB free-tier build container.
// Reading at runtime keeps the server bundle small (~60 KB) and only parses
// the file when we actually need it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertManifestToCards, type SourceCard } from './cards-converter';
import type { Card } from './types';

// Two locations to look for the manifest:
//   1. Production (esbuild bundle): copied next to dist-server/server.mjs by
//      scripts/build-server.mjs. import.meta.url points at server.mjs.
//   2. Dev (tsx running this file from src/game/): relative path to
//      src/data/card-manifest.generated.json.
const MANIFEST_CANDIDATES = [
  './card-manifest.generated.json',
  '../data/card-manifest.generated.json',
];

function readManifest(): string {
  let lastError: unknown;
  for (const rel of MANIFEST_CANDIDATES) {
    try {
      return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      lastError = err;
    }
  }
  throw new Error(
    `card-manifest.generated.json not found in any candidate path ` +
    `(${MANIFEST_CANDIDATES.join(', ')}). Last error: ${String(lastError)}`,
  );
}

export function loadBundledCards(): Card[] {
  const sources = JSON.parse(readManifest()) as SourceCard[];
  return convertManifestToCards(sources);
}
