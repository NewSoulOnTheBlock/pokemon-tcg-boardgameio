// Server-side booster pack rolling. Mirrors the client-side logic in
// src/App.tsx but with a deterministic PRNG seeded by the invoice memo,
// so the same invoice always rolls the same pack contents. That makes
// /api/boosters/redeem safely retryable without giving the user different
// cards on each retry.

import setsManifest from '../data/pokemon-tcg-data/sets/en.json' with { type: 'json' };
import { CARD_LIBRARY } from '../game/cards';
import type { Card } from '../game/types';

export type BoosterSlot = 'Common' | 'Uncommon' | 'Rare';
export interface BoosterPull {
  card: Card;
  slot: BoosterSlot;
}

interface RawSet {
  id: string;
  name: string;
  series?: string;
  releaseDate?: string;
  ptcgoCode?: string;
  images?: { logo?: string; symbol?: string };
}

interface SetMeta {
  id: string;
  name: string;
  series: string;
  releaseDate: string;
  ptcgoCode?: string;
}

export interface BoosterableSet extends SetMeta {
  commons: Card[];
  uncommons: Card[];
  rares: Card[];
}

let cached: BoosterableSet[] | undefined;
const setMetaById = new Map<string, SetMeta>(
  (setsManifest as RawSet[]).map((set) => [
    set.id,
    {
      id: set.id,
      name: set.name,
      series: set.series ?? 'Other',
      releaseDate: set.releaseDate ?? '0000/00/00',
      ptcgoCode: set.ptcgoCode,
    },
  ]),
);

function setIdOf(card: Card): string {
  const dash = card.id.indexOf('-');
  return dash > 0 ? card.id.slice(0, dash) : card.id;
}

function isRareForBoosters(card: Card): boolean {
  if (card.kind === 'energy') return false;
  const rarity = card.rarity;
  if (!rarity) return false;
  if (rarity === 'Common' || rarity === 'Uncommon' || rarity === 'Promo') return false;
  return true;
}

export function buildBoosterableSets(): BoosterableSet[] {
  if (cached) return cached;
  const canonical: Card[] = Object.values(CARD_LIBRARY).filter(
    (card) => card.id === (card.sourceId ?? card.id),
  );
  const byId = new Map<string, Card[]>();
  for (const card of canonical) {
    const id = setIdOf(card);
    const list = byId.get(id);
    if (list) list.push(card);
    else byId.set(id, [card]);
  }
  const out: BoosterableSet[] = [];
  for (const [setId, cards] of byId) {
    const meta = setMetaById.get(setId);
    if (!meta) continue;
    const commons = cards.filter((card) => card.rarity === 'Common');
    const uncommons = cards.filter((card) => card.rarity === 'Uncommon');
    const rares = cards.filter(isRareForBoosters);
    if (commons.length === 0 || uncommons.length === 0 || rares.length === 0) continue;
    out.push({ ...meta, commons, uncommons, rares });
  }
  cached = out;
  return cached;
}

// ----- Deterministic PRNG --------------------------------------------------
//
// xmur3 hash -> sfc32 PRNG. Tiny, no deps, gives uniform doubles in [0,1).
// Used to deterministically pick rare-bucket weights and per-slot card
// indexes from the invoice memo string.

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return function () {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function seededRng(seed: string): () => number {
  const h = xmur3(seed);
  return sfc32(h(), h(), h(), h());
}

function rareBucket(card: Card): 'rare' | 'ultra' | 'illustration' | 'secret' {
  const rarity = card.rarity ?? '';
  if (/Secret|Rainbow|Hyper|Mega Hyper|Black White/i.test(rarity)) return 'secret';
  if (/Illustration|Trainer Gallery|Amazing|Radiant|Shiny|Classic/i.test(rarity)) return 'illustration';
  if (/Ultra|Double|EX|GX|VMAX|VSTAR|BREAK|Prime|LEGEND|ACE|Shining/i.test(rarity)) return 'ultra';
  return 'rare';
}

function pick(pool: Card[], used: Set<string>, rng: () => number): Card {
  const available = pool.filter((card) => !used.has(card.id));
  const source = available.length > 0 ? available : pool;
  const idx = Math.floor(rng() * source.length);
  const card = source[idx];
  if (!card) throw new Error('Booster pool is empty.');
  used.add(card.id);
  return card;
}

function pickRare(rares: Card[], used: Set<string>, rng: () => number): Card {
  const weights = [
    { bucket: 'rare', weight: 78 },
    { bucket: 'ultra', weight: 14 },
    { bucket: 'illustration', weight: 6 },
    { bucket: 'secret', weight: 2 },
  ] as const;
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
  const roll = rng() * total;
  let cursor = 0;
  for (const entry of weights) {
    cursor += entry.weight;
    if (roll <= cursor) {
      const bucket = rares.filter((card) => rareBucket(card) === entry.bucket);
      if (bucket.length > 0) return pick(bucket, used, rng);
    }
  }
  return pick(rares, used, rng);
}

/**
 * Roll a 4C/3U/1R pack from the given set, deterministically seeded by
 * `seed` (typically the invoice memo so retries reproduce the same pack).
 */
export function rollBoosterPack(set: BoosterableSet, seed: string): BoosterPull[] {
  const rng = seededRng(`${set.id}:${seed}`);
  const used = new Set<string>();
  return [
    ...Array.from({ length: 4 }, () => ({ card: pick(set.commons, used, rng), slot: 'Common' as const })),
    ...Array.from({ length: 3 }, () => ({ card: pick(set.uncommons, used, rng), slot: 'Uncommon' as const })),
    { card: pickRare(set.rares, used, rng), slot: 'Rare' as const },
  ];
}
