// Browser-side REST API client for the custom profile/leaderboard endpoints
// served by src/server.ts. Centralised so pages don't roll their own fetch
// boilerplate and so error handling is uniform.

import type {
  MatchLeaderboardEntry,
  MatchRecord,
  PackPurchase,
  ProfileState,
} from '../shared/profile';
import { apiUrl } from './server';

class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new ApiError(response.status, text || `${path} failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

export async function loginProfile(profile: ProfileState): Promise<ProfileState> {
  return request<ProfileState>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ profile }),
  });
}

export async function persistProfile(profile: ProfileState): Promise<ProfileState> {
  if (!profile.userId) {
    throw new Error('Sign in again before saving your profile.');
  }
  return request<ProfileState>(`/api/profiles/${profile.userId}`, {
    method: 'PUT',
    body: JSON.stringify({ profile }),
  });
}

export async function persistPackPurchase(
  profile: ProfileState,
  purchase: PackPurchase,
): Promise<ProfileState> {
  if (!profile.userId) {
    throw new Error('Sign in again before opening booster packs.');
  }
  return request<ProfileState>(`/api/profiles/${profile.userId}/packs`, {
    method: 'POST',
    body: JSON.stringify({ profile, purchase }),
  });
}

export async function persistMatchRecord(
  profile: ProfileState,
  record: MatchRecord,
): Promise<ProfileState> {
  if (!profile.userId) {
    throw new Error('Sign in again before recording matches.');
  }
  return request<ProfileState>(`/api/profiles/${profile.userId}/matches`, {
    method: 'POST',
    body: JSON.stringify({ record }),
  });
}

export async function fetchLeaderboard(): Promise<MatchLeaderboardEntry[]> {
  return request<MatchLeaderboardEntry[]>('/api/leaderboard');
}

export interface FreeBoosterPull {
  card: {
    id: string;
    name: string;
    rarity?: string;
    images?: { small?: string; large?: string };
  };
  slot: 'Common' | 'Uncommon' | 'Rare';
}

export interface FreeBoosterResult {
  pack: FreeBoosterPull[];
  set: { id: string; name: string; series: string };
  source: string;
  claimedAt: string;
}

export class DailyClaimError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number, message?: string) {
    super(message ?? `Daily free pack already claimed. Try again in ${Math.ceil(retryAfterMs / 1000 / 3600)}h.`);
    this.name = 'DailyClaimError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Claim a free Pokemon TCG booster pack. The server roll is local-only
 * (no on-chain mint). `source: 'daily'` is gated to one claim per
 * ~22 hours; other sources (quest rewards, level-ups) bypass the
 * cooldown and rely on the client-side eligibility check.
 */
export async function claimFreeBooster(input: {
  userId?: string;
  walletAddress?: string;
  setId?: string;
  source?: string;
}): Promise<FreeBoosterResult> {
  const response = await fetch(apiUrl('/api/boosters/claim-free'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); }
    catch { parsed = null; }
  }
  if (response.status === 429) {
    const retryAfterMs = (parsed && typeof parsed === 'object' && 'retryAfterMs' in parsed && typeof (parsed as { retryAfterMs: unknown }).retryAfterMs === 'number')
      ? (parsed as { retryAfterMs: number }).retryAfterMs
      : 22 * 60 * 60 * 1000;
    throw new DailyClaimError(retryAfterMs);
  }
  if (!response.ok) {
    const msg = (parsed && typeof parsed === 'object' && 'error' in parsed) ? String((parsed as { error: unknown }).error) : `Claim failed (${response.status})`;
    throw new ApiError(response.status, msg);
  }
  return parsed as FreeBoosterResult;
}

export interface ClaimedPrize {
  alreadyClaimed: boolean;
  card: { id: string; name: string; rarity?: string; images?: { small?: string; large?: string } } | null;
  mint: { mintAddress: string; signature: string } | null;
}

export async function claimMatchPrize(input: { matchID: string; walletAddress: string; playerID: string }): Promise<ClaimedPrize> {
  return request<ClaimedPrize>(`/api/matches/${encodeURIComponent(input.matchID)}/prize`, {
    method: 'POST',
    body: JSON.stringify({ walletAddress: input.walletAddress, playerID: input.playerID }),
  });
}

export interface ImportCandidate {
  mintAddress: string;
  nftName: string;
  nftImage?: string;
  cardId?: string;
  cardName?: string;
  setName?: string;
  cardImage?: string;
  confidence: 'app-mint' | 'attribute-match' | 'fuzzy-match' | 'none';
  metadataUri?: string;
}

export interface ImportScanResponse {
  ownerAddress: string;
  candidates: ImportCandidate[];
}

export async function scanWalletForImports(ownerAddress: string): Promise<ImportScanResponse> {
  return request<ImportScanResponse>('/api/imports/scan', {
    method: 'POST',
    body: JSON.stringify({ ownerAddress }),
  });
}

export { ApiError };
