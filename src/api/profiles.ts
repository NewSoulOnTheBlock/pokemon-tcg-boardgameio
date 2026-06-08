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

export interface DailyLeaderboardYesterdayWinner {
  rank: number;
  userId: string;
  name: string;
  wins: number;
  losses: number;
  draws: number;
  matches: number;
  claimed: boolean;
}

export interface DailyLeaderboardResponse {
  dateKey: string;
  resetAt: string;
  entries: MatchLeaderboardEntry[];
  yesterday: {
    dateKey: string;
    winners: DailyLeaderboardYesterdayWinner[];
  };
}

export interface DailyLeaderboardReward {
  dateKey: string;
  rank: number;
  userId: string;
  name: string;
  wins: number;
  losses: number;
  draws: number;
  matches: number;
  cardIds: string[] | null;
  claimedAt: string | null;
}

export interface DailyLeaderboardClaimResponse {
  dateKey: string;
  rank: number;
  profile: ProfileState;
  purchase: PackPurchase;
  alreadyClaimed: boolean;
}

export async function fetchLeaderboard(dateKey?: string): Promise<DailyLeaderboardResponse> {
  const qs = dateKey ? `?dateKey=${encodeURIComponent(dateKey)}` : '';
  return request<DailyLeaderboardResponse>(`/api/leaderboard${qs}`);
}

export async function fetchLeaderboardEntries(dateKey?: string): Promise<MatchLeaderboardEntry[]> {
  // Convenience wrapper for callers that only need the rows.
  const result = await fetchLeaderboard(dateKey);
  return result.entries;
}

export async function fetchUnclaimedLeaderboardRewards(userId: string): Promise<DailyLeaderboardReward[]> {
  const result = await request<{ rewards: DailyLeaderboardReward[] }>(
    `/api/leaderboard/rewards/${encodeURIComponent(userId)}`,
  );
  return result.rewards;
}

export async function claimLeaderboardReward(
  userId: string,
  dateKey: string,
  rank: number,
): Promise<DailyLeaderboardClaimResponse> {
  return request<DailyLeaderboardClaimResponse>(
    `/api/leaderboard/rewards/${encodeURIComponent(userId)}/claim`,
    {
      method: 'POST',
      body: JSON.stringify({ dateKey, rank }),
    },
  );
}

export interface DailyLeaderboardChampion {
  rank: number;
  userId: string;
  name: string;
  wins: number;
  losses: number;
  draws: number;
  matches: number;
  claimed: boolean;
}

export interface DailyLeaderboardHistoryDay {
  dateKey: string;
  winners: DailyLeaderboardChampion[];
}

export async function fetchLeaderboardHistory(limit = 14): Promise<DailyLeaderboardHistoryDay[]> {
  const result = await request<{ days: DailyLeaderboardHistoryDay[] }>(
    `/api/leaderboard/history?limit=${encodeURIComponent(String(limit))}`,
  );
  return result.days;
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
