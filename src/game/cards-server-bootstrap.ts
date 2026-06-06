// Server-only manifest bootstrap. esbuild bundles this into
// dist-server/server.mjs; the client never imports it (so the 8 MB manifest
// never ends up in the Vite client chunk).
//
// The bundled manifest is only consulted on the very first deploy where the
// `app_cards` Postgres table is empty. After the one-time migration, every
// boot loads cards straight from Postgres and this module is dead weight on
// disk only.

import slimCardManifest from '../data/card-manifest.generated.json' with { type: 'json' };
import { convertManifestToCards, type SourceCard } from './cards-converter';
import type { Card } from './types';

export function loadBundledCards(): Card[] {
  return convertManifestToCards(slimCardManifest as SourceCard[]);
}
