// Server-side card-pack roller. Used by the daily-pack endpoint
// (and, later, the quest-chest pack) to generate the cards a player
// receives when claiming a free reward.
//
// The roller reads from the same `CARD_LIBRARY` the server already
// boots into memory on startup (see src/server.ts initCardLibrary).
// It groups by rarity, weights "rare or better" pulls, and returns a
// list of cardIds. Excludes basic Energy cards because every player
// already gets those in their starter pool.

import { CARD_LIBRARY } from '../game/cards';

// Cards-per-pack composition mirrors a real Pokemon TCG booster.
const COMMONS_PER_PACK = 5;
const UNCOMMONS_PER_PACK = 3;
const RARES_PER_PACK = 1;

const COMMON_RARITY = 'Common';
const UNCOMMON_RARITY = 'Uncommon';

// Weighted lottery for the rare+ slot. Earlier entries are more
// likely; ratios are tuned to feel like a real pack — most "rares"
// are plain Rare or Rare Holo, with the occasional flashy hit.
const RARE_TIER_WEIGHTS: Array<{ rarities: string[]; weight: number }> = [
  { rarities: ['Rare', 'Rare Holo'], weight: 60 },
  { rarities: ['Double Rare'], weight: 15 },
  { rarities: ['Illustration Rare'], weight: 12 },
  { rarities: ['Ultra Rare', 'Rare Ultra'], weight: 7 },
  { rarities: ['Special Illustration Rare'], weight: 3 },
  { rarities: ['Hyper Rare', 'Rare Rainbow'], weight: 2 },
  { rarities: ['Shiny Rare', 'Rare Holo V', 'Rare Shiny'], weight: 1 },
];

let cachedBuckets: { common: string[]; uncommon: string[]; rareByTier: string[][] } | undefined;
let cachedLibraryHandle: object | undefined;

function buildBuckets(): { common: string[]; uncommon: string[]; rareByTier: string[][] } {
  const ownKeys = Object.keys(CARD_LIBRARY);
  // Re-bucket if the library Proxy's underlying map identity changed.
  if (cachedBuckets && cachedLibraryHandle === CARD_LIBRARY && cachedBuckets.common.length + cachedBuckets.uncommon.length > 0) {
    return cachedBuckets;
  }
  const common: string[] = [];
  const uncommon: string[] = [];
  const rareByTier: string[][] = RARE_TIER_WEIGHTS.map(() => []);
  for (const id of ownKeys) {
    const card = CARD_LIBRARY[id];
    if (!card) continue;
    // Exclude basic Energy cards — every player already has them.
    if (card.kind === 'energy' && card.basic) continue;
    const rarity = card.rarity ?? '';
    if (rarity === COMMON_RARITY) common.push(id);
    else if (rarity === UNCOMMON_RARITY) uncommon.push(id);
    else {
      for (let i = 0; i < RARE_TIER_WEIGHTS.length; i += 1) {
        if (RARE_TIER_WEIGHTS[i]!.rarities.includes(rarity)) {
          rareByTier[i]!.push(id);
          break;
        }
      }
    }
  }
  cachedBuckets = { common, uncommon, rareByTier };
  cachedLibraryHandle = CARD_LIBRARY;
  return cachedBuckets;
}

function pickOne<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function pickRareTier(buckets: { rareByTier: string[][] }): string[] {
  // Only consider tiers that actually have cards in this library.
  const usable = RARE_TIER_WEIGHTS.filter((_, i) => buckets.rareByTier[i]!.length > 0);
  const totalWeight = usable.reduce((sum, t) => sum + t.weight, 0);
  if (totalWeight === 0) {
    // Should never happen unless the library has only commons/uncommons.
    return buckets.rareByTier[0] ?? [];
  }
  let roll = Math.random() * totalWeight;
  for (const tier of usable) {
    roll -= tier.weight;
    if (roll <= 0) {
      const idx = RARE_TIER_WEIGHTS.indexOf(tier);
      return buckets.rareByTier[idx]!;
    }
  }
  return buckets.rareByTier[RARE_TIER_WEIGHTS.indexOf(usable[usable.length - 1]!)]!;
}

/** Roll a daily free pack: 5 Commons + 3 Uncommons + 1 Rare-or-better.
 *  Pulls may repeat (commons especially), which mirrors how real packs
 *  feel. Returns an array of cardIds. */
export function rollDailyPack(): string[] {
  const buckets = buildBuckets();
  if (buckets.common.length === 0 || buckets.uncommon.length === 0) {
    throw new Error(
      `Pack roller cannot build a pack: card library has only ${buckets.common.length} commons / ${buckets.uncommon.length} uncommons.`,
    );
  }
  const out: string[] = [];
  for (let i = 0; i < COMMONS_PER_PACK; i += 1) out.push(pickOne(buckets.common));
  for (let i = 0; i < UNCOMMONS_PER_PACK; i += 1) out.push(pickOne(buckets.uncommon));
  for (let i = 0; i < RARES_PER_PACK; i += 1) {
    const tier = pickRareTier(buckets);
    if (tier.length > 0) out.push(pickOne(tier));
    else out.push(pickOne(buckets.uncommon)); // safety fallback
  }
  return out;
}
