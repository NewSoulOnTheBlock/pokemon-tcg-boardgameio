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

// Per-deck Pokemon lists matching the requested 60-card starter
// composition (20 Pokémon, 20 Trainers, 20 Energy).
// Each entry pairs a card ID with a copy count.
type CardCount = readonly [string, number];

const STARTER_POKEMON: Record<StarterEnergyType, ReadonlyArray<CardCount>> = {
  Grass: [
    ['base1-44', 4], ['base1-30', 3], ['base1-15', 2], // Bulbasaur / Ivysaur / Venusaur
    ['base2-58', 3], ['base2-37', 2], ['base2-15', 1], // Oddish / Gloom / Vileplume
    ['base2-52', 3], ['base2-35', 2],                  // Exeggcute / Exeggutor
  ],
  Fire: [
    ['base1-46', 4], ['base1-24', 3], ['base1-4', 2],  // Charmander / Charmeleon / Charizard
    ['base1-28', 3], ['base1-23', 2],                  // Growlithe / Arcanine
    ['base1-60', 3], ['base2-44', 2],                  // Ponyta / Rapidash
    ['base3-12', 1],                                   // Moltres
  ],
  Water: [
    ['base1-63', 4], ['base1-42', 3], ['base1-2', 2],  // Squirtle / Wartortle / Blastoise
    ['base1-35', 3], ['base1-6', 2],                   // Magikarp / Gyarados
    ['base3-53', 3], ['base3-35', 2],                  // Psyduck / Golduck
    ['base3-10', 1],                                   // Lapras
  ],
  Lightning: [
    ['base1-58', 4], ['base1-14', 3],                  // Pikachu / Raichu
    ['base1-53', 3], ['base1-9', 2],                   // Magnemite / Magneton
    ['base1-67', 3], ['base1-21', 2],                  // Voltorb / Electrode
    ['base1-20', 2], ['base1-16', 1],                  // Electabuzz / Zapdos
  ],
  Psychic: [
    ['base1-43', 4], ['base1-32', 3], ['base1-1', 2],  // Abra / Kadabra / Alakazam
    ['base1-49', 3], ['base3-8', 2],                   // Drowzee / Hypno
    ['bw11-59', 3], ['bw11-60', 2], ['bw11-RC10', 1],  // Ralts / Kirlia / Gardevoir
  ],
  Fighting: [
    ['base1-52', 4], ['base1-34', 3], ['base1-8', 2],  // Machop / Machoke / Machamp
    ['base3-47', 3], ['base3-37', 2], ['base3-36', 1], // Geodude / Graveler / Golem
    ['base1-62', 3], ['base3-41', 2],                  // Sandshrew / Sandslash
  ],
  Darkness: [
    ['bw10-55', 4], ['bw10-56', 3],                    // Houndour / Houndoom
    ['bw6-72', 3], ['bw6-73', 2],                      // Murkrow / Honchkrow
    ['dp6-116', 3], ['dp6-66', 2],                     // Poochyena / Mightyena
    ['bw4-69', 2], ['bw4-70', 1],                      // Sneasel / Weavile
  ],
  Metal: [
    ['bw10-57', 4], ['bw10-58', 3], ['bw10-59', 2],    // Aron / Lairon / Aggron
    ['base1-53', 3], ['base1-9', 2],                   // Magnemite / Magneton (reused)
    ['bw9-50', 3], ['bw9-51', 2], ['bw9-52', 1],       // Beldum / Metang / Metagross
  ],
  Dragon: [
    ['base1-26', 4], ['base1-18', 3], ['base3-4', 2],  // Dratini / Dragonair / Dragonite
    ['bw10-62', 3], ['bw10-63', 2], ['bw10-64', 1],    // Bagon / Shelgon / Salamence
    ['bw7-83', 3], ['bw7-98', 2],                      // Trapinch / Vibrava
  ],
  Fairy: [
    ['base1-5', 4], ['base2-1', 3],                    // Clefairy / Clefable
    ['col1-71', 3], ['col1-26', 2],                    // Snubbull / Granbull
    ['me3-35', 3], ['me3-36', 2],                      // Spritzee / Aromatisse
    ['basep-30', 2], ['bw8-103', 1],                   // Togepi / Togetic
  ],
  Colorless: [
    ['base2-51', 4],                                   // Eevee
    ['base2-56', 3], ['base2-42', 2],                  // Meowth / Persian
    ['base2-62', 3], ['base2-36', 2],                  // Spearow / Fearow
    ['base1-57', 3], ['base1-22', 2], ['base2-8', 1],  // Pidgey / Pidgeotto / Pidgeot
  ],
};

// Shared 20-card trainer baseline used by most decks (4 Professor's
// Research, 4 Poké Ball, 3 Great Ball, 3 Switch, 2 Potion,
// 2 Energy Retrieval, 2 Rare Candy).
const STARTER_TRAINERS_BASELINE: ReadonlyArray<CardCount> = [
  ['sv4pt5-87', 4], // Professor's Research
  ['base2-64', 4],  // Poké Ball
  ['bw2-93', 3],    // Great Ball
  ['sv1-194', 3],   // Switch
  ['sv1-188', 2],   // Potion
  ['base1-81', 2],  // Energy Retrieval
  ['bw10-85', 2],   // Rare Candy
];

// Variant: replaces the 2 Rare Candy with 2 Boss's Orders for decks
// the user spec'd that way (Lightning, Psychic, Darkness, Fairy, Colorless).
const STARTER_TRAINERS_BOSS: ReadonlyArray<CardCount> = [
  ['sv4pt5-87', 4],
  ['base2-64', 4],
  ['bw2-93', 3],
  ['sv1-194', 3],
  ['sv1-188', 2],
  ['base1-81', 2],
  ['me1-114', 2],   // Boss's Orders
];

const TRAINER_VARIANT_BY_TYPE: Record<StarterEnergyType, ReadonlyArray<CardCount>> = {
  Grass: STARTER_TRAINERS_BASELINE,
  Fire: STARTER_TRAINERS_BASELINE,
  Water: STARTER_TRAINERS_BASELINE,
  Lightning: STARTER_TRAINERS_BOSS,
  Psychic: STARTER_TRAINERS_BOSS,
  Fighting: STARTER_TRAINERS_BASELINE,
  Darkness: STARTER_TRAINERS_BOSS,
  Metal: STARTER_TRAINERS_BASELINE,
  Dragon: STARTER_TRAINERS_BASELINE,
  Fairy: STARTER_TRAINERS_BOSS,
  Colorless: STARTER_TRAINERS_BOSS,
};

// Per-deck energy lineup. Most decks are 20 of a single basic energy;
// Dragon mixes 10 Dragon (modelled as Double Dragon Energy) + 5 Fire
// + 5 Water as the user specified.
const STARTER_ENERGY_LINEUP: Record<StarterEnergyType, ReadonlyArray<CardCount>> = {
  Grass: [['sve-1', 20]],
  Fire: [['sve-2', 20]],
  Water: [['sve-3', 20]],
  Lightning: [['sve-4', 20]],
  Psychic: [['sve-5', 20]],
  Fighting: [['sve-6', 20]],
  Darkness: [['sve-7', 20]],
  Metal: [['sve-8', 20]],
  Dragon: [['xy6-97', 10], ['sve-2', 5], ['sve-3', 5]],
  Fairy: [['xy1-140', 20]],
  Colorless: [['base1-96', 10], ['sve-2', 5], ['sve-3', 5]], // DCE + filler
};

function expandCardCounts(counts: ReadonlyArray<CardCount>): string[] {
  return counts.flatMap(([cardId, count]) => Array(count).fill(cardId));
}

export function starterDeck(type: StarterEnergyType): string[] {
  const deck = [
    ...expandCardCounts(STARTER_POKEMON[type]),
    ...expandCardCounts(TRAINER_VARIANT_BY_TYPE[type]),
    ...expandCardCounts(STARTER_ENERGY_LINEUP[type]),
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
