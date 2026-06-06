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

export interface BoosterMintResponse {
  treasury: string;
  mints: Array<{ cardId: string; mintAddress: string; signature: string }>;
}

export async function mintBoosterNfts(recipient: string, cardIds: string[]): Promise<BoosterMintResponse> {
  return request<BoosterMintResponse>('/api/boosters/mint', {
    method: 'POST',
    body: JSON.stringify({ recipient, cardIds }),
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
