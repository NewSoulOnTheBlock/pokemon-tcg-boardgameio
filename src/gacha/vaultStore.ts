// Per-wallet localStorage cache of every gacha pull the user has
// opened in this browser. The gacha API has no "list my pulls"
// endpoint, so we keep our own record so the My Pulls tab can show
// them + offer buyback within the 72-hour window.

import type { GachaPackType, GachaRarity } from '../api/gacha';

export interface GachaPullRecord {
  memo: string;            // pack-purchase memo from generatePack
  packType: GachaPackType;
  openedAt: string;        // ISO when openPack succeeded
  nftAddress: string;
  nftName: string;
  nftImage?: string;
  rarity: GachaRarity;
  insuredValueUsdc?: number;   // base units (6 dp); read from nft attributes when present
  turboBuybackAmount?: number; // base units; present if turbo auto-sold this pull
  buybackSignature?: string;   // set once we receive the buyback tx signature
  buybackedAt?: string;        // ISO when buyback succeeded
}

const VAULT_KEY_PREFIX = 'gacha-vault-';
const RECENT_PULLS_KEY = 'gacha-recent-feed';
const VAULT_VERSION = 1;
const MAX_PER_WALLET = 500; // keep vault bounded even for heavy players

interface VaultBlob {
  version: number;
  pulls: GachaPullRecord[];
}

function vaultKey(walletAddress: string | undefined): string {
  return `${VAULT_KEY_PREFIX}${walletAddress ?? 'anon'}`;
}

export function loadGachaVault(walletAddress: string | undefined): GachaPullRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(vaultKey(walletAddress));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as VaultBlob | GachaPullRecord[];
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || typeof parsed !== 'object') return [];
    if (!Array.isArray(parsed.pulls)) return [];
    return parsed.pulls;
  } catch {
    return [];
  }
}

function persistVault(walletAddress: string | undefined, pulls: GachaPullRecord[]): void {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = pulls.slice(-MAX_PER_WALLET);
    const blob: VaultBlob = { version: VAULT_VERSION, pulls: trimmed };
    window.localStorage.setItem(vaultKey(walletAddress), JSON.stringify(blob));
  } catch {
    /* quota / private mode — ignore */
  }
}

export function recordGachaPull(walletAddress: string | undefined, pull: GachaPullRecord): GachaPullRecord[] {
  const existing = loadGachaVault(walletAddress);
  const filtered = existing.filter((p) => p.memo !== pull.memo);
  const next = [...filtered, pull];
  persistVault(walletAddress, next);
  return next;
}

export function markBuybackComplete(
  walletAddress: string | undefined,
  memo: string,
  signature: string,
): GachaPullRecord[] {
  const existing = loadGachaVault(walletAddress);
  const next = existing.map((p) => (p.memo === memo ? { ...p, buybackSignature: signature, buybackedAt: new Date().toISOString() } : p));
  persistVault(walletAddress, next);
  return next;
}

export const BUYBACK_WINDOW_MS = 72 * 60 * 60 * 1000;

export function canBuyback(pull: GachaPullRecord, nowMs = Date.now()): boolean {
  if (pull.buybackSignature) return false;
  if (pull.turboBuybackAmount !== undefined) return false;
  const opened = Date.parse(pull.openedAt);
  if (!Number.isFinite(opened)) return false;
  return (nowMs - opened) < BUYBACK_WINDOW_MS;
}

export function buybackWindowRemainingMs(pull: GachaPullRecord, nowMs = Date.now()): number {
  const opened = Date.parse(pull.openedAt);
  if (!Number.isFinite(opened)) return 0;
  return Math.max(0, opened + BUYBACK_WINDOW_MS - nowMs);
}

interface RecentFeedBlob {
  fetchedAt: number;
  rows: unknown[];
}

const FEED_TTL_MS = 30_000;

export function loadCachedRecentFeed(): unknown[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(RECENT_PULLS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecentFeedBlob;
    if (!parsed || typeof parsed !== 'object') return null;
    if (Date.now() - parsed.fetchedAt > FEED_TTL_MS) return null;
    return Array.isArray(parsed.rows) ? parsed.rows : null;
  } catch {
    return null;
  }
}

export function saveCachedRecentFeed(rows: unknown[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RECENT_PULLS_KEY, JSON.stringify({ fetchedAt: Date.now(), rows }));
  } catch {
    /* ignore */
  }
}
