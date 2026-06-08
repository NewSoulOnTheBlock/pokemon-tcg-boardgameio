// Browser-side client for our own /api/gacha/* proxy. The proxy is in
// src/server.ts and forwards to gacha.collectorcrypt.com with the
// server-only x-api-key. None of these helpers touch the gacha API
// directly — they always go through our same-origin proxy so the key
// stays on the server.

import { apiUrl } from './server';

export type GachaPackType = 'pokemon_50' | 'pokemon_250' | string;
export type GachaRarity = 'Epic' | 'Rare' | 'Uncommon' | 'Common';

export interface GachaMachine {
  code: string;
  name: string;
  shortName?: string;
  image?: string;
  thumbnailUrl?: string;
  videoSrc?: string;
  videoHevc?: string;
  public?: boolean;
  price: number;
  contains?: string;
  instantBuyback?: number;
  freeSpins?: boolean;
  turboMode?: boolean;
  pointsMultiplier?: number;
  odds?: Partial<Record<'epic' | 'rare' | 'uncommon' | 'common', number>>;
  tierRanges?: Record<string, { start: number; end: number }>;
  stock?: Partial<Record<'epic' | 'rare' | 'uncommon' | 'common', number>>;
  ev?: number;
  status?: 'open' | 'closed';
  isOpen?: boolean;
}

export interface GachaGeneratePackResponse {
  memo: string;
  transaction: string;
}

export interface GachaOpenPackSuccess {
  success: true;
  transactionSignature: string;
  nft_address: string;
  nftWon: {
    content: {
      metadata: {
        name: string;
        description?: string;
        image?: string;
        attributes?: Array<{ trait_type?: string; value?: string | number }>;
      };
      links?: { image?: string };
    };
  };
  points: number;
  roll: number;
  rarity: GachaRarity;
  code?: 'TURBO_MODE_BUYBACK';
  buybackAmount?: number;
}

export interface GachaOpenPackWaiting {
  success: true;
  code: 'WAITING_FOR_WEBHOOK';
  memo: string;
}

export type GachaOpenPackResponse = GachaOpenPackSuccess | GachaOpenPackWaiting;

export interface GachaStatus {
  enabled: boolean;
  machineStatus?: 'running' | 'stopped';
  gachas?: Array<{ code: string; name: string; price: number; status?: string; isOpen?: boolean }>;
  error?: string;
}

export interface GachaBuybackResponse {
  success: true;
  serializedTransaction: string;
  refundAmount: number;
  memo: string;
}

export interface GachaBuybackAvailableResponse {
  available: boolean;
  amount?: number;
}

export interface GachaSubmitResponse {
  success: true;
  signature: string;
  confirmationStatus: 'submitted' | 'confirmed' | 'finalized';
}

export class GachaApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = 'GachaApiError';
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)
      ? String((body as { error: unknown }).error)
      : `${path} failed (${res.status})`;
    throw new GachaApiError(res.status, msg, body);
  }
  return body as T;
}

export function fetchGachaStatus(): Promise<GachaStatus> {
  return req<GachaStatus>('/api/gacha/status').catch((err) => {
    if (err instanceof GachaApiError && err.status === 503) {
      return { enabled: false, error: err.message };
    }
    throw err;
  });
}

export function fetchGachaMachines(): Promise<{ machines: GachaMachine[] }> {
  return req('/api/gacha/machines');
}

export function generateGachaPack(args: { playerAddress: string; packType: GachaPackType; turbo?: boolean }): Promise<GachaGeneratePackResponse> {
  return req('/api/gacha/buy', { method: 'POST', body: JSON.stringify(args) });
}

export function submitGachaTransaction(signedTransaction: string): Promise<GachaSubmitResponse> {
  return req('/api/gacha/submit', { method: 'POST', body: JSON.stringify({ signedTransaction }) });
}

export function openGachaPack(memo: string): Promise<GachaOpenPackResponse> {
  return req('/api/gacha/open', { method: 'POST', body: JSON.stringify({ memo }) });
}

export function generateGachaBuyback(args: { playerAddress: string; nftAddress: string }): Promise<GachaBuybackResponse> {
  return req('/api/gacha/buyback', { method: 'POST', body: JSON.stringify(args) });
}

export function gachaBuybackAvailable(wallet: string, nft: string): Promise<GachaBuybackAvailableResponse> {
  const q = new URLSearchParams({ wallet, nft });
  return req(`/api/gacha/buyback/available?${q}`);
}

/**
 * Sign a base64-encoded partially-signed Solana transaction (from
 * /api/gacha/buy or /api/gacha/buyback) with the connected wallet, and
 * return the base64-encoded SIGNED transaction ready to be submitted
 * via /api/gacha/submit. Dynamic-imports @solana/web3.js so the heavy
 * bundle only loads when the user actually triggers a purchase.
 */
export async function signGachaBase64Transaction(args: {
  payerAddress: string;
  base64Tx: string;
}): Promise<string> {
  const { Transaction, VersionedTransaction } = await import('@solana/web3.js');
  const { solanaProviders, shortAddr } = await import('../wallet');
  const providers = solanaProviders();
  const provider = providers.find((c) => c.publicKey?.toString() === args.payerAddress) ?? providers[0];
  if (!provider) {
    throw new Error('No Solana wallet detected. Connect Phantom, Solflare, or Backpack first.');
  }
  const response = await provider.connect().catch(() => provider.connect({ onlyIfTrusted: false }));
  const connected = response.publicKey?.toString() ?? provider.publicKey?.toString();
  if (connected !== args.payerAddress) {
    throw new Error(`Connected wallet ${shortAddr(connected)} doesn't match buyer wallet ${shortAddr(args.payerAddress)}.`);
  }
  if (!provider.signTransaction) {
    throw new Error('Connected Solana wallet does not support transaction signing.');
  }
  const bytes = Uint8Array.from(atob(args.base64Tx), (c) => c.charCodeAt(0));
  // Try v0 first; fall back to legacy.
  let tx: InstanceType<typeof Transaction> | InstanceType<typeof VersionedTransaction>;
  try { tx = VersionedTransaction.deserialize(bytes); }
  catch { tx = Transaction.from(bytes); }
  const signed = (await provider.signTransaction(tx as never)) as { serialize(): Uint8Array };
  const serialized = signed.serialize();
  let bin = '';
  for (let i = 0; i < serialized.length; i += 1) bin += String.fromCharCode(serialized[i]!);
  return btoa(bin);
}
