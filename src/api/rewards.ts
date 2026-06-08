// Browser-side wrappers for the /api/rewards/* endpoints.
//
// These cover the daily-free-pack flow (and, eventually, the quest-chest
// pack and any future on-cooldown reward types).

import type { PackPurchase, ProfileState, StoredProfile } from '../shared/profile';
import { apiUrl } from './server';

export interface DailyPackStatus {
  lastClaimAt: string | null;
  nextClaimAt: string | null;
  canClaim: boolean;
  cooldownMs: number;
}

export interface DailyPackClaimResult {
  profile: StoredProfile;
  purchase: PackPurchase;
  nextClaimAt: string | null;
}

export interface BurnPackResult {
  profile: StoredProfile;
  purchase: PackPurchase;
  alreadyRedeemed: boolean;
  packs: number;
}

export interface ChampionsRowStatus {
  dateKey: string;
  drawnAt: string;
  eligibility: { totalEligible: number; campaignComplete: number; withPoketcg: number };
  youAreEligible: boolean;
  youWon: boolean;
  youClaimed: boolean;
  winnerWallet: string | null;
  nextDrawAt: string;
}

export interface ChampionsRowClaimResult {
  profile: StoredProfile;
  purchase: PackPurchase;
  alreadyClaimed: boolean;
}

export class RewardCooldownError extends Error {
  nextClaimAt: string | null;
  constructor(message: string, nextClaimAt: string | null) {
    super(message);
    this.name = 'RewardCooldownError';
    this.nextClaimAt = nextClaimAt;
  }
}

export async function fetchDailyPackStatus(profile: ProfileState): Promise<DailyPackStatus> {
  if (!profile.userId) throw new Error('Sign in again to check your daily pack.');
  const res = await fetch(apiUrl(`/api/rewards/daily-pack/status/${profile.userId}`));
  if (!res.ok) throw new Error(`daily-pack status failed (${res.status})`);
  return res.json() as Promise<DailyPackStatus>;
}

export async function claimDailyPack(profile: ProfileState): Promise<DailyPackClaimResult> {
  if (!profile.userId) throw new Error('Sign in again to claim your daily pack.');
  const res = await fetch(apiUrl(`/api/rewards/daily-pack/claim/${profile.userId}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.status === 429) {
    let body: { error?: string; nextClaimAt?: string | null } = {};
    try { body = await res.json(); } catch { /* ignore */ }
    throw new RewardCooldownError(body.error ?? 'Daily pack on cooldown', body.nextClaimAt ?? null);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `daily-pack claim failed (${res.status})`);
  }
  return res.json() as Promise<DailyPackClaimResult>;
}

/** Submit a $POKETCG burn signature to the server in exchange for
 *  `packs` rolled card packs. The server verifies the burn was on-chain,
 *  authored by `buyerWallet`, targets the right mint, and is at least
 *  packs * 250,000 tokens. Idempotent on `signature`. */
export async function redeemBurnPack(args: {
  profile: ProfileState;
  signature: string;
  buyerWallet: string;
  packs: number;
}): Promise<BurnPackResult> {
  if (!args.profile.userId) throw new Error('Sign in again to redeem packs.');
  const res = await fetch(apiUrl(`/api/rewards/burn-pack/${args.profile.userId}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signature: args.signature,
      buyerWallet: args.buyerWallet,
      packs: args.packs,
    }),
  });
  if (!res.ok) {
    let body: { error?: string } = {};
    try { body = await res.json(); } catch { /* ignore */ }
    throw new Error(body.error ?? `burn-pack redeem failed (${res.status})`);
  }
  return res.json() as Promise<BurnPackResult>;
}

export async function fetchChampionsRowStatus(profile: ProfileState): Promise<ChampionsRowStatus> {
  if (!profile.userId) throw new Error('Sign in again to check Champions Row.');
  const res = await fetch(apiUrl(`/api/champions-row/status/${profile.userId}`));
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `champions-row status failed (${res.status})`);
  }
  return res.json() as Promise<ChampionsRowStatus>;
}

export async function claimChampionsRow(profile: ProfileState): Promise<ChampionsRowClaimResult> {
  if (!profile.userId) throw new Error('Sign in again to claim Champions Row.');
  const res = await fetch(apiUrl(`/api/champions-row/claim/${profile.userId}`), { method: 'POST' });
  if (!res.ok) {
    let body: { error?: string } = {};
    try { body = await res.json(); } catch { /* ignore */ }
    throw new Error(body.error ?? `champions-row claim failed (${res.status})`);
  }
  return res.json() as Promise<ChampionsRowClaimResult>;
}
