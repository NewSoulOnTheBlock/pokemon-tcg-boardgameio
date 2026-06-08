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
