// Champions Row daily-lottery resolver. The drama lives here:
//
//   1. List every profile flagged as campaign-complete (8 badges +
//      Champion defeated). This is server-trusted because the client
//      pushes a campaignProgress snapshot on every win.
//   2. For each candidate, check the on-chain $POKETCG balance.
//      Anyone with > 0 stays in the pool.
//   3. Roll an HMAC-SHA-256 seed (server-side, daily-keyed) and pick
//      one winner uniformly at random from the surviving pool.
//   4. Roll the major pack (3C + 3U + 4 chase-rares).
//
// The whole resolver is called from inside storage.ensureChampionsRowDraw,
// which is idempotent per date_key — the very first call rolls, every
// subsequent call returns the same draw.

import { createHmac, randomBytes } from 'node:crypto';
import type { ProfileStorage, ChampionsRowDraw } from './profileStorage';
import type { StoredProfile } from '../shared/profile';
import { fetchPoketcgBalance } from './poketcgBalance';
import { rollChampionsMajorPack } from './packRoller';

/** YYYY-MM-DD in UTC. We use UTC so all players share the same draw
 *  window regardless of where they live. */
export function championsRowDateKey(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface ChampionsRowEligibility {
  campaignComplete: number;
  withPoketcg: number;
}

/** Cheap eligibility view (no card roll) for the UI. */
export async function describeChampionsRowEligibility(storage: ProfileStorage): Promise<ChampionsRowEligibility> {
  if (!storage.listCampaignCompleteProfiles) return { campaignComplete: 0, withPoketcg: 0 };
  const candidates = await storage.listCampaignCompleteProfiles();
  let withPoketcg = 0;
  await Promise.all(candidates.map(async (p) => {
    const wallet = p.wallet?.address;
    if (!wallet) return;
    const bal = await fetchPoketcgBalance(wallet);
    if (bal > 0) withPoketcg += 1;
  }));
  return { campaignComplete: candidates.length, withPoketcg };
}

interface ResolveOutcome {
  winnerUserId: string | null;
  winnerWallet: string | null;
  cardIds: string[];
  eligibleCount: number;
  seed: string;
}

/** Build a resolver fn the storage layer can call once per date_key. */
export function buildChampionsRowResolver(storage: ProfileStorage, dateKey: string): () => Promise<ResolveOutcome> {
  return async () => {
    const candidates = storage.listCampaignCompleteProfiles
      ? await storage.listCampaignCompleteProfiles()
      : [];
    // Filter by live $POKETCG balance.
    const survivors: StoredProfile[] = [];
    await Promise.all(candidates.map(async (p) => {
      const wallet = p.wallet?.address;
      if (!wallet) return;
      const bal = await fetchPoketcgBalance(wallet);
      if (bal > 0) survivors.push(p);
    }));

    const seed = randomBytes(32).toString('hex');
    const cardIds = rollChampionsMajorPack();

    if (survivors.length === 0) {
      return { winnerUserId: null, winnerWallet: null, cardIds, eligibleCount: 0, seed };
    }

    // HMAC the seed by date_key for the public-verifiable proof.
    const digest = createHmac('sha256', seed).update(dateKey).digest();
    // First 4 bytes → uint32 → modulo to pick a winner. Plenty of
    // entropy for the candidate-pool sizes we care about.
    const u32 = digest.readUInt32BE(0);
    const winner = survivors[u32 % survivors.length]!;
    return {
      winnerUserId: winner.userId,
      winnerWallet: winner.wallet?.address ?? null,
      cardIds,
      eligibleCount: survivors.length,
      seed,
    };
  };
}

export async function rollChampionsRow(storage: ProfileStorage, dateKey = championsRowDateKey()): Promise<ChampionsRowDraw> {
  if (!storage.ensureChampionsRowDraw) {
    throw new Error('ensureChampionsRowDraw not supported by this storage backend');
  }
  return storage.ensureChampionsRowDraw(dateKey, buildChampionsRowResolver(storage, dateKey));
}
