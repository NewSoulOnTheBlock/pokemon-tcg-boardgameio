// Vitest global setup. Loads the bundled card manifest into the runtime
// CARD_LIBRARY so tests can call cloneCard / makeDeck without booting the
// server. Equivalent to what src/server.ts does on first boot, minus the
// Postgres round-trip.

import { initCardLibrary } from './src/game/cards';
import { loadBundledCards } from './src/game/cards-server-bootstrap';

initCardLibrary(loadBundledCards());
