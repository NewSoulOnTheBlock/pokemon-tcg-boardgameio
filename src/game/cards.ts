// Runtime card library shared by client and server.
//
// The library starts empty. `initCardLibrary(cards)` populates it, and is
// called from two places only:
//
//   * src/server.ts (via cards-server-bootstrap or Postgres on boot)
//   * src/main.tsx (after fetching /api/cards/library from the server)
//
// The static manifest import lives in cards-server-bootstrap.ts so the client
// Vite bundle never pulls it in. CARD_LIBRARY is a Proxy so all the legacy
// callers (`CARD_LIBRARY[id]`, `Object.values(CARD_LIBRARY)`) keep working
// without change, and any access before init throws a clear error.

import type { Card } from './types';

let _library: Record<string, Card> | undefined;

export function initCardLibrary(cards: Card[]): void {
  const library: Record<string, Card> = {};
  for (const card of cards) {
    if (card?.id) library[card.id] = card;
  }
  _library = library;
}

export function isCardLibraryReady(): boolean {
  return _library !== undefined;
}

export function cardLibrarySize(): number {
  return _library ? Object.keys(_library).length : 0;
}

function requireLibrary(): Record<string, Card> {
  if (!_library) {
    throw new Error(
      'CARD_LIBRARY accessed before initialization. ' +
      'Call initCardLibrary() with the source cards first (server-side via ' +
      'cards-server-bootstrap, client-side via main.tsx).',
    );
  }
  return _library;
}

export const CARD_LIBRARY: Record<string, Card> = new Proxy({} as Record<string, Card>, {
  get(_target, prop) {
    if (typeof prop === 'symbol') return undefined;
    return requireLibrary()[prop];
  },
  has(_target, prop) {
    if (typeof prop === 'symbol') return false;
    return prop in requireLibrary();
  },
  ownKeys() {
    return Reflect.ownKeys(requireLibrary());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(requireLibrary(), prop);
  },
});

export function cloneCard(cardId: string): Card {
  const card = requireLibrary()[cardId];
  if (!card) {
    throw new Error(`Unknown card id: ${cardId}`);
  }
  return structuredClone(card);
}

export function makeDeck(cardIds: string[]): Card[] {
  return cardIds.map(cloneCard);
}

// ----- Starter deck definitions (no library lookups) ------------------- //

export type StarterEnergyType =
  | 'Grass'
  | 'Fire'
  | 'Water'
  | 'Lightning'
  | 'Psychic'
  | 'Fighting'
  | 'Darkness'
  | 'Metal'
  | 'Dragon'
  | 'Fairy'
  | 'Colorless';

export const STARTER_ENERGY_TYPES: StarterEnergyType[] = [
  'Grass',
  'Fire',
  'Water',
  'Lightning',
  'Psychic',
  'Fighting',
  'Darkness',
  'Metal',
  'Dragon',
  'Fairy',
  'Colorless',
];

export const ENERGY_TYPE_META: Record<StarterEnergyType, { hex: string; ink: string; description: string }> = {
  Grass: { hex: '#22c55e', ink: '#052e16', description: 'Healing pressure and efficient early attackers.' },
  Fire: { hex: '#ef4444', ink: '#fff7ed', description: 'High damage basics backed by aggressive Fire Energy.' },
  Water: { hex: '#38bdf8', ink: '#082f49', description: 'Reliable setup attackers with flexible Water costs.' },
  Lightning: { hex: '#facc15', ink: '#422006', description: 'Fast tempo Pokemon that punish slow starts.' },
  Psychic: { hex: '#c084fc', ink: '#2e1065', description: 'Tricky attackers with status and draw pressure.' },
  Fighting: { hex: '#b45309', ink: '#fff7ed', description: 'Durable Pokemon with direct, efficient attacks.' },
  Darkness: { hex: '#111827', ink: '#f9fafb', description: 'Disruptive basics and heavy Darkness hits.' },
  Metal: { hex: '#94a3b8', ink: '#0f172a', description: 'Resilient attackers with sturdy retreat lines.' },
  Dragon: { hex: '#f97316', ink: '#111827', description: 'Dragon Pokemon with special Dragon Energy support.' },
  Fairy: { hex: '#f9a8d4', ink: '#500724', description: 'Classic Fairy attackers from the expanded card pool.' },
  Colorless: { hex: '#e5e7eb', ink: '#111827', description: 'Flexible Colorless attackers and universal energy.' },
};

const STARTER_POKEMON: Record<StarterEnergyType, string[]> = {
  Grass: ['sv1-13', 'sv1-1', 'sv1-2', 'sv1-3'],
  Fire: ['sv3pt5-4', 'pgo-8', 'sv3-26', 'sv1-31'],
  Water: ['sv1-52', 'sv1-32', 'sv1-33', 'sv1-37'],
  Lightning: ['sv1-81', 'sv1-70', 'sv1-74', 'sv1-76'],
  Psychic: ['sv1-83', 'sv1-84', 'sv1-85', 'sv1-87'],
  Fighting: ['sv1-112', 'sv1-113', 'sv1-115', 'sv1-117'],
  Darkness: ['sv1-130', 'sv1-132', 'sv1-134', 'sv1-136'],
  Metal: ['sv1-150', 'sv1-152', 'sv1-153', 'sv1-155'],
  Dragon: ['bw10-62', 'bw10-67', 'bw10-70', 'bw11-93'],
  Fairy: ['det1-14', 'det1-15', 'g1-50', 'g1-RC19'],
  Colorless: ['pgo-55', 'base1-26', 'base1-27', 'base1-48'],
};

const STARTER_ENERGY: Record<StarterEnergyType, string> = {
  Grass: 'sve-1',
  Fire: 'sve-2',
  Water: 'sve-3',
  Lightning: 'sve-4',
  Psychic: 'sve-5',
  Fighting: 'sve-6',
  Darkness: 'sve-7',
  Metal: 'sve-8',
  Dragon: 'xy6-97',
  Fairy: 'xy1-140',
  Colorless: 'base1-96',
};

const STARTER_TRAINERS = ['sv1-188', 'sv1-198', 'sv4pt5-87', 'sv1-194', 'sv1-181'];

export function starterDeck(type: StarterEnergyType): string[] {
  const deck = [
    ...STARTER_POKEMON[type].flatMap((cardId) => Array(4).fill(cardId)),
    ...Array(24).fill(STARTER_ENERGY[type]),
    ...STARTER_TRAINERS.flatMap((cardId) => Array(4).fill(cardId)),
  ];

  return deck.slice(0, 60);
}

export const STARTER_DECKS: Record<StarterEnergyType, string[]> = Object.fromEntries(
  STARTER_ENERGY_TYPES.map((type) => [type, starterDeck(type)]),
) as Record<StarterEnergyType, string[]>;

export const DEFAULT_DECK_0: string[] = [
  ...STARTER_DECKS.Grass,
];

export const DEFAULT_DECK_1: string[] = [
  ...STARTER_DECKS.Fire,
];
