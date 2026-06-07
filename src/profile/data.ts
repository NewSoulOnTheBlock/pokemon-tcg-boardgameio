// Mock-isolated profile data. Everything in this file is either
// computed from REAL profile/library state OR clearly tagged as mock
// fallback. Achievements and the collection-region map are mock; the
// underlying counts they read are real. Replace the mock arrays /
// region map with backend data when those services land.

import { CARD_LIBRARY } from '../game/cards';
import type { PokemonType } from '../game/types';
import type { ProfileState } from '../shared/profile';
import { nftOwnedCount, nftOwnedUniqueCount } from '../shared/profile';
import { getTrainerStats } from '../matchmaking/helpers';

export interface Achievement {
  id: string;
  icon: string;
  name: string;
  description: string;
  /** Whether the achievement is unlocked given the current profile. */
  unlocked: (profile: ProfileState) => boolean;
  /** Optional 0-100 progress value when locked. */
  progress?: (profile: ProfileState) => number;
}

/** MOCK_ACHIEVEMENTS — the achievement *catalogue* is a curated list,
 *  but each unlock check reads REAL profile state. Swap to a backend
 *  fetch later by replacing this array. */
export const MOCK_ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first-victory',
    icon: '🏆',
    name: 'First Victory',
    description: 'Win your first multiplayer match.',
    unlocked: (p) => (p.matchRecords ?? []).some((r) => r.result === 'win'),
  },
  {
    id: 'opened-10-packs',
    icon: '📦',
    name: 'Pack Hunter',
    description: 'Open 10 booster packs.',
    unlocked: (p) => p.packsOpened >= 10,
    progress: (p) => Math.min(100, (p.packsOpened / 10) * 100),
  },
  {
    id: 'opened-100-packs',
    icon: '🎁',
    name: 'Pack Master',
    description: 'Open 100 booster packs.',
    unlocked: (p) => p.packsOpened >= 100,
    progress: (p) => Math.min(100, (p.packsOpened / 100) * 100),
  },
  {
    id: 'built-first-deck',
    icon: '🛠',
    name: 'Deckbuilder',
    description: 'Save your first custom deck.',
    unlocked: (p) => (p.deckLibrary ?? []).length >= 1,
  },
  {
    id: 'pulled-secret-rare',
    icon: '🌟',
    name: 'Secret Hunter',
    description: 'Pull a Secret / Hyper / Rainbow / Illustration Rare from a pack.',
    unlocked: (p) => (p.packPurchases ?? []).some((pack) =>
      pack.cardIds.some((cardId) => {
        const rarity = CARD_LIBRARY[cardId]?.rarity ?? '';
        return /Secret|Rainbow|Hyper|Illustration|Trainer Gallery/i.test(rarity);
      }),
    ),
  },
  {
    id: 'fire-specialist',
    icon: '🔥',
    name: 'Fire Specialist',
    description: 'Own 20 Fire-type Pokémon NFTs.',
    unlocked: (p) => countOwnedNftsByType(p, 'Fire') >= 20,
    progress: (p) => Math.min(100, (countOwnedNftsByType(p, 'Fire') / 20) * 100),
  },
  {
    id: 'grass-starter',
    icon: '🌱',
    name: 'Grass Starter',
    description: 'Win 5 matches with a Grass-starter deck.',
    unlocked: (p) => (p.matchRecords ?? []).filter((r) =>
      r.result === 'win' && r.playerDeckLabel?.toLowerCase().includes('grass'),
    ).length >= 5,
    progress: (p) => Math.min(100, ((p.matchRecords ?? []).filter((r) =>
      r.result === 'win' && r.playerDeckLabel?.toLowerCase().includes('grass'),
    ).length / 5) * 100),
  },
  {
    id: 'ranked-climber',
    icon: '📈',
    name: 'Ranked Climber',
    description: 'Win 10 Ranked matches.',
    unlocked: (p) => getTrainerStats(p).rankedWins >= 10,
    progress: (p) => Math.min(100, (getTrainerStats(p).rankedWins / 10) * 100),
  },
  {
    id: 'collector-i',
    icon: '🃏',
    name: 'Collector I',
    description: 'Own 25 NFT cards.',
    unlocked: (p) => nftOwnedCount(p) >= 25,
    progress: (p) => Math.min(100, (nftOwnedCount(p) / 25) * 100),
  },
  {
    id: 'collector-ii',
    icon: '🎴',
    name: 'Collector II',
    description: 'Own 100 NFT cards.',
    unlocked: (p) => nftOwnedCount(p) >= 100,
    progress: (p) => Math.min(100, (nftOwnedCount(p) / 100) * 100),
  },
  {
    id: 'phygital-importer',
    icon: '📥',
    name: 'Phygital Importer',
    description: 'Import at least one phygital / Collector Crypt NFT card.',
    unlocked: (p) => (p.importedNfts ?? []).length >= 1,
  },
  {
    id: 'wager-warrior',
    icon: '💰',
    name: 'Wager Warrior',
    description: 'Win a Wager match.',
    unlocked: (p) => (p.matchRecords ?? []).some((r) => r.matchType === 'Wager' && r.result === 'win'),
  },
];

function countOwnedNftsByType(profile: ProfileState, type: PokemonType): number {
  let count = 0;
  for (const pack of profile.packPurchases ?? []) {
    for (const mint of pack.mints ?? []) {
      const card = CARD_LIBRARY[mint.cardId];
      if (card?.kind === 'pokemon' && card.pokemonType === type) count += 1;
      else if (card?.kind === 'energy' && card.energyType === type) count += 1;
    }
  }
  for (const imported of profile.importedNfts ?? []) {
    const card = CARD_LIBRARY[imported.cardId];
    if (card?.kind === 'pokemon' && card.pokemonType === type) count += 1;
  }
  return count;
}

export const POKEMON_TYPE_COLORS: Record<string, string> = {
  Grass: '#22c55e',
  Fire: '#ef4444',
  Water: '#38bdf8',
  Lightning: '#facc15',
  Psychic: '#c084fc',
  Fighting: '#b45309',
  Darkness: '#1f2937',
  Metal: '#94a3b8',
  Dragon: '#f97316',
  Fairy: '#f9a8d4',
  Colorless: '#e5e7eb',
};

export interface TypeBreakdownEntry {
  type: string;
  owned: number;
  total: number;
  color: string;
}

/** Per-type collection breakdown computed from real CARD_LIBRARY + the
 *  user's NFT mints / imports. Counts UNIQUE Pokemon cards per type. */
export function computeTypeBreakdown(profile: ProfileState): TypeBreakdownEntry[] {
  const totalsByType = new Map<string, number>();
  for (const card of Object.values(CARD_LIBRARY)) {
    if (card.kind !== 'pokemon') continue;
    const t = card.pokemonType ?? 'Colorless';
    totalsByType.set(t, (totalsByType.get(t) ?? 0) + 1);
  }
  const ownedByType = new Map<string, Set<string>>();
  function record(cardId: string) {
    const card = CARD_LIBRARY[cardId];
    if (!card || card.kind !== 'pokemon') return;
    const t = card.pokemonType ?? 'Colorless';
    if (!ownedByType.has(t)) ownedByType.set(t, new Set());
    ownedByType.get(t)!.add(cardId);
  }
  for (const pack of profile.packPurchases ?? []) {
    for (const mint of pack.mints ?? []) record(mint.cardId);
  }
  for (const imported of profile.importedNfts ?? []) record(imported.cardId);

  return Object.keys(POKEMON_TYPE_COLORS).map((type) => ({
    type,
    owned: ownedByType.get(type)?.size ?? 0,
    total: totalsByType.get(type) ?? 0,
    color: POKEMON_TYPE_COLORS[type],
  }));
}

/** MOCK_COLLECTION_PROGRESS — region progress map. Real region/set
 *  groupings would need a metadata lookup we don't have on the slim
 *  manifest. For now we approximate by set-id prefix. Replace with a
 *  proper region map when one is added to the sets manifest. */
export interface RegionProgress {
  region: string;
  emoji: string;
  /** Set-id prefixes that count toward this region (heuristic). */
  setPrefixes: string[];
}

export const MOCK_REGION_MAP: RegionProgress[] = [
  { region: 'Kanto', emoji: '🌳', setPrefixes: ['base', 'jungle', 'fossil', 'gym1', 'gym2', 'g1', 'pgo'] },
  { region: 'Johto', emoji: '🌾', setPrefixes: ['neo', 'hgss', 'cl', 'pgo'] },
  { region: 'Hoenn', emoji: '🌊', setPrefixes: ['ex1', 'ex2', 'ex3', 'xy', 'sv'] },
  { region: 'Sinnoh', emoji: '❄️', setPrefixes: ['dp', 'pl'] },
  { region: 'Unova', emoji: '🏙', setPrefixes: ['bw'] },
  { region: 'Galar', emoji: '⚔️', setPrefixes: ['swsh'] },
  { region: 'Paldea', emoji: '🍊', setPrefixes: ['sv'] },
];

export interface RegionProgressResult {
  region: string;
  emoji: string;
  owned: number;
  total: number;
}

export function computeRegionProgress(profile: ProfileState): RegionProgressResult[] {
  const ownedSetCounts = new Map<string, Set<string>>();
  const totalSetCounts = new Map<string, number>();
  for (const card of Object.values(CARD_LIBRARY)) {
    const dash = card.id.indexOf('-');
    if (dash < 0) continue;
    const setId = card.id.slice(0, dash).toLowerCase();
    totalSetCounts.set(setId, (totalSetCounts.get(setId) ?? 0) + 1);
  }
  function recordOwned(cardId: string) {
    const dash = cardId.indexOf('-');
    if (dash < 0) return;
    const setId = cardId.slice(0, dash).toLowerCase();
    if (!ownedSetCounts.has(setId)) ownedSetCounts.set(setId, new Set());
    ownedSetCounts.get(setId)!.add(cardId);
  }
  for (const pack of profile.packPurchases ?? []) {
    for (const mint of pack.mints ?? []) recordOwned(mint.cardId);
  }
  for (const imported of profile.importedNfts ?? []) recordOwned(imported.cardId);

  return MOCK_REGION_MAP.map((region) => {
    let owned = 0;
    let total = 0;
    for (const [setId, totalCount] of totalSetCounts) {
      if (region.setPrefixes.some((prefix) => setId.startsWith(prefix))) {
        total += totalCount;
        owned += ownedSetCounts.get(setId)?.size ?? 0;
      }
    }
    return { region: region.region, emoji: region.emoji, owned, total };
  });
}

/** Find a "favourite" card to showcase. Prefers the rarest NFT-owned
 *  card; falls back to the most-recently-imported NFT; falls back to
 *  the first card in ownedCards. Returns undefined if nothing owned. */
export function findShowcaseCard(profile: ProfileState): { cardId: string; reason: string } | undefined {
  const rarityRank: Record<string, number> = {
    'Secret Rare': 100, 'Rainbow Rare': 95, 'Hyper Rare': 95,
    'Illustration Rare': 90, 'Trainer Gallery Rare Holo': 85,
    'Ultra Rare': 80, 'Double Rare': 75,
    'Rare Holo VMAX': 70, 'Rare Holo VSTAR': 70, 'Rare Holo V': 65, 'Rare Holo ex': 65,
    'Rare Holo': 50, 'Rare': 40, 'Uncommon': 20, 'Common': 10,
  };
  let best: { cardId: string; rarity: string; rank: number } | undefined;
  function consider(cardId: string) {
    const card = CARD_LIBRARY[cardId];
    if (!card) return;
    const rarity = card.rarity ?? '';
    const rank = rarityRank[rarity] ?? 5;
    if (!best || rank > best.rank) best = { cardId, rarity, rank };
  }
  for (const pack of profile.packPurchases ?? []) {
    for (const mint of pack.mints ?? []) consider(mint.cardId);
  }
  for (const imported of profile.importedNfts ?? []) consider(imported.cardId);
  if (best) return { cardId: best.cardId, reason: `Rarest NFT owned (${best.rarity || 'unknown'})` };
  const firstOwned = Object.keys(profile.ownedCards ?? {})[0];
  if (firstOwned) return { cardId: firstOwned, reason: 'From your starter pool' };
  return undefined;
}

export interface DeckBreakdown {
  size: number;
  pokemonCount: number;
  trainerCount: number;
  energyCount: number;
  dominantType?: string;
}

export function summariseDeck(cardIds: string[]): DeckBreakdown {
  let pokemonCount = 0;
  let trainerCount = 0;
  let energyCount = 0;
  const typeCounts = new Map<string, number>();
  for (const cardId of cardIds) {
    const card = CARD_LIBRARY[cardId];
    if (!card) continue;
    if (card.kind === 'pokemon') {
      pokemonCount += 1;
      typeCounts.set(card.pokemonType, (typeCounts.get(card.pokemonType) ?? 0) + 1);
    } else if (card.kind === 'trainer') {
      trainerCount += 1;
    } else if (card.kind === 'energy') {
      energyCount += 1;
      typeCounts.set(card.energyType, (typeCounts.get(card.energyType) ?? 0) + 1);
    }
  }
  let dominantType: string | undefined;
  let dominantCount = 0;
  for (const [type, count] of typeCounts) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantType = type;
    }
  }
  return { size: cardIds.length, pokemonCount, trainerCount, energyCount, dominantType };
}

/** Most-played deck label across the player's match history. */
export function mostPlayedDeck(profile: ProfileState): string | undefined {
  const counts = new Map<string, number>();
  for (const record of profile.matchRecords ?? []) {
    counts.set(record.playerDeckLabel, (counts.get(record.playerDeckLabel) ?? 0) + 1);
  }
  let best: { label: string; count: number } | undefined;
  for (const [label, count] of counts) {
    if (!best || count > best.count) best = { label, count };
  }
  return best?.label;
}

export function dominantTypeForProfile(profile: ProfileState): string | undefined {
  const typeCounts = new Map<string, number>();
  for (const pack of profile.packPurchases ?? []) {
    for (const mint of pack.mints ?? []) {
      const card = CARD_LIBRARY[mint.cardId];
      if (card?.kind === 'pokemon') {
        typeCounts.set(card.pokemonType, (typeCounts.get(card.pokemonType) ?? 0) + 1);
      }
    }
  }
  let best: { type: string; count: number } | undefined;
  for (const [type, count] of typeCounts) {
    if (!best || count > best.count) best = { type, count };
  }
  return best?.type;
}

/** Count of distinct "secret / illustration / rainbow" rares the player
 *  owns as NFTs — used in the Collection Stats group. */
export function countOwnedRarity(profile: ProfileState, pattern: RegExp): number {
  let count = 0;
  for (const pack of profile.packPurchases ?? []) {
    for (const mint of pack.mints ?? []) {
      if (pattern.test(CARD_LIBRARY[mint.cardId]?.rarity ?? '')) count += 1;
    }
  }
  for (const imported of profile.importedNfts ?? []) {
    if (pattern.test(CARD_LIBRARY[imported.cardId]?.rarity ?? '')) count += 1;
  }
  return count;
}

export function overallCollectionPct(profile: ProfileState): number {
  const totalUnique = Object.keys(CARD_LIBRARY).length;
  if (totalUnique === 0) return 0;
  return Math.round((nftOwnedUniqueCount(profile) / totalUnique) * 10_000) / 100;
}
