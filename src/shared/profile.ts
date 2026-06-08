import type { ConnectedWallet } from '../wallet';
import type { MatchType, PlayerID, WagerCurrency } from '../game/types';

export interface PackPurchase {
  signature: string;
  openedAt: string;
  cardIds: string[];
  mints?: Array<{ cardId: string; mintAddress: string; signature: string }>;
}

export interface MatchRecord {
  completedAt?: string;
  matchID: string;
  matchType?: MatchType;
  opponentDeckLabel: string;
  playerDeckLabel: string;
  playerID: PlayerID;
  reason?: string;
  result: 'in_progress' | 'win' | 'loss' | 'draw';
  startedAt: string;
  wagerAmount?: number;
  wagerCurrency?: WagerCurrency;
  winner?: PlayerID;
  winnerWallet?: string;
}

export interface MatchLeaderboardEntry {
  draws: number;
  losses: number;
  matches: number;
  name: string;
  userId: string;
  wins: number;
}

export interface CustomDeck {
  cardIds: string[];
  createdAt: string;
  id: string;
  name: string;
  updatedAt: string;
}

export interface ImportedNftRecord {
  mintAddress: string;
  cardId: string;
  cardName: string;
  importedAt: string;
  confidence: 'app-mint' | 'attribute-match' | 'fuzzy-match';
}

export interface ProfileState {
  userId?: string;
  name: string;
  wallet: ConnectedWallet | null;
  activeDeckName: string;
  customDeck: string[];
  deckLibrary: CustomDeck[];
  ownedCards: Record<string, number>;
  packsOpened: number;
  packPurchases: PackPurchase[];
  matchRecords: MatchRecord[];
  importedNfts?: ImportedNftRecord[];
  /** USD-denominated credit balance for the Phygitals storefront.
   *  Users top up by signing a USDC transfer to the treasury wallet;
   *  the server credits this field. Spending a pack debits it. */
  phygitalsCreditsUsd?: number;
  /** ISO timestamp of the last daily-free-pack claim. Server-managed
   *  (the daily-pack endpoint sets this atomically with a cooldown
   *  check). Cleared client-side writes via mergeProfiles. */
  lastDailyPackAt?: string;
}

export interface StoredProfile extends ProfileState {
  userId: string;
  loginKey: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;
}

export function loginKeyForProfile(profile: Pick<ProfileState, 'name' | 'wallet'>): string {
  if (profile.wallet) {
    return `wallet:${profile.wallet.chain}:${profile.wallet.address.toLowerCase()}`;
  }
  return `trainer:${profile.name.trim().toLowerCase()}`;
}

export function collectionSize(collection: Record<string, number>): number {
  return Object.values(collection).reduce((total, count) => total + count, 0);
}

/**
 * Count of card NFTs the player actually owns on-chain — sum of every
 * Metaplex Core mint from booster pack purchases plus every imported
 * NFT-backed card. Starter-deck cards are EXCLUDED because those are
 * seeded into ``ownedCards`` for deckbuilding and aren't NFT-backed.
 *
 * Use this for any "Cards owned" UI that should reflect real NFT
 * holdings rather than the broader deckbuilder collection.
 */
export function nftOwnedCount(profile: ProfileState): number {
  const minted = (profile.packPurchases ?? []).reduce(
    (sum, purchase) => sum + (purchase.mints?.length ?? 0),
    0,
  );
  const imported = profile.importedNfts?.length ?? 0;
  return minted + imported;
}

/** Distinct NFT cards owned — counts unique cardIds across mints + imports. */
export function nftOwnedUniqueCount(profile: ProfileState): number {
  const unique = new Set<string>();
  for (const purchase of profile.packPurchases ?? []) {
    for (const mint of purchase.mints ?? []) {
      unique.add(mint.cardId);
    }
  }
  for (const imported of profile.importedNfts ?? []) {
    unique.add(imported.cardId);
  }
  return unique.size;
}

export function collectionFromCards(cards: string[]): Record<string, number> {
  return cards.reduce<Record<string, number>>((counts, cardId) => {
    counts[cardId] = (counts[cardId] ?? 0) + 1;
    return counts;
  }, {});
}

export function addCardsToCollection(collection: Record<string, number>, cardIds: string[]): Record<string, number> {
  const next = { ...collection };
  for (const cardId of cardIds) {
    next[cardId] = (next[cardId] ?? 0) + 1;
  }
  return next;
}

export function maxCollections(...collections: Array<Record<string, number> | undefined>): Record<string, number> {
  const next: Record<string, number> = {};
  for (const collection of collections) {
    if (!collection) {
      continue;
    }
    for (const [cardId, count] of Object.entries(collection)) {
      next[cardId] = Math.max(next[cardId] ?? 0, count);
    }
  }
  return next;
}
