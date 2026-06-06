import type { ConnectedWallet } from '../wallet';
import type { PlayerID } from '../game/types';

export interface PackPurchase {
  signature: string;
  openedAt: string;
  cardIds: string[];
}

export interface MatchRecord {
  completedAt?: string;
  matchID: string;
  opponentDeckLabel: string;
  playerDeckLabel: string;
  playerID: PlayerID;
  reason?: string;
  result: 'in_progress' | 'win' | 'loss' | 'draw';
  startedAt: string;
  winner?: PlayerID;
}

export interface CustomDeck {
  cardIds: string[];
  createdAt: string;
  id: string;
  name: string;
  updatedAt: string;
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
