// Server-side prize-card rolling. After each multiplayer win the server
// rolls one random card from the canonical CARD_LIBRARY (weighted toward
// Common but with a small chance of a Rare) and mints it as a Metaplex
// Core NFT to the winner's wallet.
//
// Idempotency is enforced at the database layer via the prize_claimed
// boolean column on app_match_records — only the first call for a given
// (user, match, player) tuple will roll + mint.

import { CARD_LIBRARY } from '../game/cards';
import type { Card } from '../game/types';

export interface PrizeRollResult {
  card: Card;
}

interface RarityBucket {
  weight: number;
  matches: (rarity: string) => boolean;
}

// Roughly mirrors the booster pack rarity mix but distilled into a
// single roll: most prizes are Commons, with a meaningful chance of an
// Uncommon and a small payoff for a Rare or better.
const RARITY_BUCKETS: RarityBucket[] = [
  { weight: 60, matches: (rarity) => rarity === 'Common' },
  { weight: 30, matches: (rarity) => rarity === 'Uncommon' },
  {
    weight: 10,
    matches: (rarity) =>
      rarity !== 'Common' &&
      rarity !== 'Uncommon' &&
      rarity !== 'Promo' &&
      rarity !== '',
  },
];

function isMintable(card: Card): boolean {
  if (card.kind === 'energy') return false;
  if (!card.rarity) return false;
  // Only allow the canonical print, not alt-print duplicates that share
  // images. canonical = id === (sourceId ?? id).
  return card.id === (card.sourceId ?? card.id);
}

let cachedByBucket: Card[][] | undefined;
function poolsByBucket(): Card[][] {
  if (cachedByBucket) return cachedByBucket;
  const canonical: Card[] = Object.values(CARD_LIBRARY).filter(isMintable);
  cachedByBucket = RARITY_BUCKETS.map((bucket) =>
    canonical.filter((card) => bucket.matches(card.rarity ?? '')),
  );
  return cachedByBucket;
}

/**
 * Pick one prize card using the weighted-bucket scheme. Falls through
 * to lower-weight buckets if the chosen bucket happens to be empty.
 */
export function rollPrizeCard(): PrizeRollResult {
  const pools = poolsByBucket();
  const totalWeight = RARITY_BUCKETS.reduce((sum, bucket) => sum + bucket.weight, 0);
  const roll = Math.random() * totalWeight;
  let cursor = 0;
  for (let i = 0; i < RARITY_BUCKETS.length; i += 1) {
    cursor += RARITY_BUCKETS[i].weight;
    if (roll <= cursor && pools[i].length > 0) {
      const card = pools[i][Math.floor(Math.random() * pools[i].length)];
      return { card };
    }
  }
  // Last-resort: pick from any non-empty pool.
  for (const pool of pools) {
    if (pool.length > 0) {
      return { card: pool[Math.floor(Math.random() * pool.length)] };
    }
  }
  throw new Error('No mintable prize cards available in the card library.');
}
