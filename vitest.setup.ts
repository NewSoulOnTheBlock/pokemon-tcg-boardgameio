// Vitest global setup. Loads the bundled card manifest into the runtime
// CARD_LIBRARY so tests can call cloneCard / makeDeck without booting the
// server. Equivalent to what src/server.ts does on first boot, minus the
// Postgres round-trip.

import { initCardLibrary } from './src/game/cards';
import { loadBundledCards } from './src/game/cards-server-bootstrap';

// src/chain/config.ts snapshots its addresses at module-evaluation time, so
// the fixture addresses have to exist in the environment BEFORE any test
// file imports it. Setting them here (rather than inside a test) is what
// makes the chain modules loadable at all under vitest.
process.env.POKETCG_TOKEN_ADDRESS ??= '0x1111111111111111111111111111111111111111';
process.env.CARD_NFT_ADDRESS ??= '0x2222222222222222222222222222222222222222';

initCardLibrary(loadBundledCards());
