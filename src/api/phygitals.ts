// Browser-side wrappers for the /api/phygitals/* proxy endpoints. The
// server holds the X-API-Key; the browser only ever calls our own
// origin.
//
// The flow is now CLIENT-SIGNED for both buy and sellback — the server
// builds (or relays) unsigned Solana txs, the user signs with Phantom,
// the client sends the signed bytes back, the server forwards to
// Phygitals.

import { apiUrl } from './server';

export interface PhygitalsPack {
  id: string;
  slug: string;
  name?: string;
  description?: string;
  enable?: boolean;
  in_stock?: boolean;
  mint_price?: number;
  max_per_mint?: number;
  categories?: string[];
  ev?: number;
  buyback_percent?: number;
  claw_image_url?: string;
  rarity_distribution?: Array<{ id: number; name: string; color?: string; lower?: number; upper?: number; weight?: number }>;
  chase?: Array<{ id: string; name: string; image: string; back_image?: string | null; fmv: number }>;
  type?: string;
  num_pulls_7d?: number;
  repack?: boolean;
}

export interface PhygitalsPullItem {
  id: string;
  buyback_price?: number;
  mint_address?: string | null;
  type?: string;
  content?: {
    metadata: {
      name: string;
      image: string;
      back_image?: string | null;
      attributes?: Array<{ trait_type: string; value: string | number }>;
      description?: string;
    };
    links?: {
      image: string;
      back_image?: string | null;
    };
  };
}

export interface PhygitalsBuyPreparation {
  packId: string;
  amount: number;
  currency: 'usdc' | 'usdt';
  priceInToken: number;
  transactionBase64: string;
}

export interface PhygitalsBuySubmitResult {
  session_id?: string;
  nfts: PhygitalsPullItem[];
  public_id?: string;
  tx_hash?: string;
}

export interface PhygitalsSellbackInit {
  session_id: string;
  /** Each entry is a base64 string or number[] of the serialized
   *  VersionedTransaction the client must sign. */
  txV0s: Array<number[] | string>;
}

export class PhygitalsApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = 'PhygitalsApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); }
    catch { parsed = text; }
  }
  if (!res.ok) {
    const msg = (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string')
      ? (parsed as { error: string }).error
      : `${method} ${path} failed (${res.status})`;
    throw new PhygitalsApiError(res.status, parsed, msg);
  }
  return parsed as T;
}

export async function fetchPhygitalsStatus(): Promise<{ enabled: boolean; baseUrl: string }> {
  return request('GET', '/api/phygitals/status');
}

export async function fetchPhygitalsPacks(): Promise<PhygitalsPack[]> {
  const { packs } = await request<{ packs: PhygitalsPack[] }>('GET', '/api/phygitals/packs');
  return packs ?? [];
}

/**
 * Step 1: ask the server to build an unsigned buy tx. Server returns
 * `transactionBase64`. Pass it to a wallet helper (see
 * src/walletPayment.ts) to deserialize, prompt the user via Phantom,
 * and produce the signed-tx bytes. Then call submitPhygitalsBuy().
 */
export async function preparePhygitalsBuy(args: {
  buyerWallet: string;
  packId: string;
  amount: number;
  currency?: 'usdc' | 'usdt';
}): Promise<PhygitalsBuyPreparation> {
  return request('POST', '/api/phygitals/buy/prepare', {
    buyerWallet: args.buyerWallet,
    packId: args.packId,
    amount: args.amount,
    currency: args.currency ?? 'usdc',
  });
}

export async function submitPhygitalsBuy(args: {
  packId: string;
  amount: number;
  currency?: 'usdc' | 'usdt';
  signedTxBytes: number[];
}): Promise<PhygitalsBuySubmitResult> {
  return request('POST', '/api/phygitals/buy/submit', {
    packId: args.packId,
    amount: args.amount,
    currency: args.currency ?? 'usdc',
    signedTxBytes: args.signedTxBytes,
  });
}

export async function initPhygitalsSellback(mintAddress: string): Promise<PhygitalsSellbackInit> {
  return request('POST', '/api/phygitals/sellback/init', { mint_address: mintAddress });
}

export async function finishPhygitalsSellback(args: {
  session_id: string;
  signedTxBytes: Array<number[]>;
}): Promise<unknown> {
  return request('POST', '/api/phygitals/sellback/finish', args);
}
