// Pure helpers for the boosters page. Stay decoupled from React so they
// can be unit tested and reused. No mock economy — coins, gems, daily
// free packs and milestones are intentionally NOT here; adding them
// would require server-side anti-abuse work and a real currency
// service. Document those as TODO in the page so it's obvious why
// they're absent.

import type { Card } from '../game/types';
import type { PackPurchase, ProfileState } from '../shared/profile';

export interface SetMetaLike {
  id: string;
  name: string;
  series: string;
  releaseDate: string;
  totalCards?: number;
  logo?: string;
  symbol?: string;
}

export interface SetCompletionStats {
  owned: number;       // unique NFT-owned cards from this set
  total: number;       // total cards in the set
  pct: number;         // 0-100
  packsPurchased: number;
}

export type BoosterFilter = 'all' | 'owned' | 'not-completed' | 'completed';
export type BoosterSort = 'newest' | 'oldest' | 'name-asc' | 'completion-desc' | 'most-owned';

export interface BoosterEra {
  id: string;
  label: string;
  /** Substrings to match against `set.series`. */
  match: RegExp;
  /** Whether this era is expanded by default. */
  defaultExpanded: boolean;
  order: number;
}

/** Era buckets used to group the booster grid. Match priority: first
 *  hit wins. "Other / Legacy" is the catch-all. */
export const BOOSTER_ERAS: BoosterEra[] = [
  { id: 'scarlet-violet', label: 'Scarlet & Violet', match: /scarlet|violet|sv/i, defaultExpanded: true, order: 0 },
  { id: 'sword-shield', label: 'Sword & Shield', match: /sword|shield|swsh/i, defaultExpanded: true, order: 1 },
  { id: 'sun-moon', label: 'Sun & Moon', match: /sun|moon|sm/i, defaultExpanded: false, order: 2 },
  { id: 'xy', label: 'XY', match: /^xy|^x &|^kalos/i, defaultExpanded: false, order: 3 },
  { id: 'bw', label: 'Black & White', match: /black|white|bw/i, defaultExpanded: false, order: 4 },
  { id: 'dp', label: 'Diamond & Pearl / Platinum / HGSS', match: /diamond|pearl|platinum|heart|soul/i, defaultExpanded: false, order: 5 },
  { id: 'ex', label: 'EX Era', match: /^ex /i, defaultExpanded: false, order: 6 },
  { id: 'legacy', label: 'Other / Legacy', match: /.*/, defaultExpanded: false, order: 99 },
];

export function eraForSet(set: SetMetaLike): BoosterEra {
  for (const era of BOOSTER_ERAS) {
    if (era.id === 'legacy') continue;
    if (era.match.test(set.series) || era.match.test(set.id)) return era;
  }
  return BOOSTER_ERAS.find((e) => e.id === 'legacy')!;
}

export function groupSetsByEra<T extends SetMetaLike>(sets: T[]): Array<{ era: BoosterEra; sets: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const set of sets) {
    const era = eraForSet(set);
    const list = buckets.get(era.id) ?? [];
    list.push(set);
    buckets.set(era.id, list);
  }
  return BOOSTER_ERAS
    .filter((era) => buckets.has(era.id))
    .map((era) => ({ era, sets: buckets.get(era.id)! }));
}

// ---- Set-completion stats (NFT-owned only, not starter seeds) ----

function setIdOf(cardId: string): string {
  const dash = cardId.indexOf('-');
  return dash > 0 ? cardId.slice(0, dash) : cardId;
}

export function computeSetCompletion(
  profile: ProfileState,
  set: { id: string; totalCards?: number },
  cardLibrary: Record<string, Card>,
): SetCompletionStats {
  const ownedCardIdsInSet = new Set<string>();
  for (const purchase of profile.packPurchases ?? []) {
    for (const mint of purchase.mints ?? []) {
      if (setIdOf(mint.cardId) === set.id) ownedCardIdsInSet.add(mint.cardId);
    }
  }
  for (const imported of profile.importedNfts ?? []) {
    if (setIdOf(imported.cardId) === set.id) ownedCardIdsInSet.add(imported.cardId);
  }
  const total = set.totalCards ?? Object.values(cardLibrary).filter((c) => setIdOf(c.id) === set.id).length;
  const packsPurchased = (profile.packPurchases ?? []).filter((purchase) => {
    return purchase.cardIds.some((cardId) => setIdOf(cardId) === set.id);
  }).length;
  const pct = total > 0 ? (ownedCardIdsInSet.size / total) * 100 : 0;
  return { owned: ownedCardIdsInSet.size, total, pct, packsPurchased };
}

export function applyFilterAndSort<T extends SetMetaLike>(
  sets: T[],
  filter: BoosterFilter,
  sort: BoosterSort,
  searchQuery: string,
  completionFor: (set: T) => SetCompletionStats,
): T[] {
  const needle = searchQuery.trim().toLowerCase();
  let out = sets;
  if (needle) {
    out = out.filter((set) =>
      set.name.toLowerCase().includes(needle)
      || set.series.toLowerCase().includes(needle)
      || set.id.toLowerCase().includes(needle),
    );
  }
  if (filter !== 'all') {
    out = out.filter((set) => {
      const c = completionFor(set);
      if (filter === 'owned') return c.packsPurchased > 0;
      if (filter === 'completed') return c.total > 0 && c.owned >= c.total;
      if (filter === 'not-completed') return c.total === 0 || c.owned < c.total;
      return true;
    });
  }
  switch (sort) {
    case 'newest':
      return [...out].sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
    case 'oldest':
      return [...out].sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
    case 'name-asc':
      return [...out].sort((a, b) => a.name.localeCompare(b.name));
    case 'completion-desc':
      return [...out].sort((a, b) => completionFor(b).pct - completionFor(a).pct);
    case 'most-owned':
      return [...out].sort((a, b) => completionFor(b).packsPurchased - completionFor(a).packsPurchased);
  }
}

// ---- Pack purchase grouping for "Recent Openings" tab ----

export interface OpenedPackEntry {
  purchase: PackPurchase;
  setId: string;
  newCards: number;  // count we didn't already have
  rarities: Record<string, number>;
}

export function summarisePackPurchase(
  purchase: PackPurchase,
  cardLibrary: Record<string, Card>,
  alreadyOwnedAtTime: Set<string>,
): OpenedPackEntry {
  let setId = '';
  let newCards = 0;
  const rarities: Record<string, number> = {};
  for (const cardId of purchase.cardIds) {
    if (!setId) setId = setIdOf(cardId);
    if (!alreadyOwnedAtTime.has(cardId)) newCards += 1;
    const rarity = cardLibrary[cardId]?.rarity ?? 'Unknown';
    rarities[rarity] = (rarities[rarity] ?? 0) + 1;
  }
  return { purchase, setId, newCards, rarities };
}

/** Rarity → glow class for reveal effects + booster card chips. */
export function getRarityEffectClass(rarity: string | undefined): string {
  if (!rarity) return 'rarity-effect-common';
  if (/Secret|Rainbow|Hyper/i.test(rarity)) return 'rarity-effect-hyper';
  if (/Illustration|Trainer Gallery/i.test(rarity)) return 'rarity-effect-illustration';
  if (/Ultra|Double|EX|GX|VMAX|VSTAR|V$/i.test(rarity)) return 'rarity-effect-ultra';
  if (/Rare Holo/i.test(rarity)) return 'rarity-effect-holo';
  if (/Rare/i.test(rarity)) return 'rarity-effect-rare';
  if (/Uncommon/i.test(rarity)) return 'rarity-effect-uncommon';
  return 'rarity-effect-common';
}
