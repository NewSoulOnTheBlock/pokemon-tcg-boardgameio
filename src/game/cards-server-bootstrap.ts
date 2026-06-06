// Server-only manifest bootstrap. Used by src/server.ts on the very first
// boot (when the `app_cards` Postgres table is empty) to seed Postgres from
// the bundled slim manifest.
//
// We deliberately use `fs.readFileSync` instead of an `import ... with { type:
// 'json' }` static import. The static-import path inlines the 8 MB JSON into
// the esbuild output, which OOMs Render's 512 MB free-tier build container.
// Reading at runtime keeps the server bundle small (~30 KB) and lets us
// load + parse the file lazily, only when we actually need it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertManifestToCards, type SourceCard } from './cards-converter';
import type { Card } from './types';

const MANIFEST_URL = new URL('../data/card-manifest.generated.json', import.meta.url);

export function loadBundledCards(): Card[] {
  const raw = readFileSync(fileURLToPath(MANIFEST_URL), 'utf8');
  const sources = JSON.parse(raw) as SourceCard[];
  return convertManifestToCards(sources);
}
