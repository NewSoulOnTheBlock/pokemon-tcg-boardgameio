// Server-side proxy for the Collector Crypt Gacha Machine API
// (gacha.collectorcrypt.com). Hides the x-api-key from the browser
// and surfaces typed wrappers for the endpoints we use.
//
// Required env vars:
//   GACHA_API_KEY     partner x-api-key issued by Collector Crypt.
//                     Defaults to the literal string 'API_KEY' which
//                     the public Collector Crypt API currently accepts
//                     as a pass-through — set a real key once they
//                     issue one for production.
//   GACHA_BASE_URL    optional, defaults to https://gacha.collectorcrypt.com
//                     (set to https://dev-gacha.collectorcrypt.com on devnet)

const DEFAULT_BASE_URL = 'https://gacha.collectorcrypt.com';

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
  transaction: string; // base64
}

export interface GachaOpenPackResponseSuccess {
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
  buybackAmount?: number; // USDC base units
}

export interface GachaOpenPackResponseWaiting {
  success: true;
  code: 'WAITING_FOR_WEBHOOK';
  memo: string;
}

export type GachaOpenPackResponse = GachaOpenPackResponseSuccess | GachaOpenPackResponseWaiting;

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

export interface GachaStatusResponse {
  machineStatus: 'running' | 'stopped';
  gachas?: Array<{ code: string; name: string; price: number; status?: string; isOpen?: boolean }>;
  [legacyKey: string]: unknown;
}

export interface GachaSubmitResponse {
  success: true;
  signature: string;
  confirmationStatus: 'submitted' | 'confirmed' | 'finalized';
}

export class GachaError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = 'GachaError';
  }
}

export interface GachaService {
  enabled: boolean;
  baseUrl: string;
  machines(): Promise<{ machines: GachaMachine[] }>;
  status(): Promise<GachaStatusResponse>;
  generatePack(args: { playerAddress: string; packType?: GachaPackType; turbo?: boolean; altPlayerAddress?: string }): Promise<GachaGeneratePackResponse>;
  submitTransaction(signedTransaction: string): Promise<GachaSubmitResponse>;
  openPack(memo: string): Promise<GachaOpenPackResponse>;
  packStatus(memo: string): Promise<unknown>;
  buyback(args: { playerAddress: string; nftAddress: string; altRecipient?: string }): Promise<GachaBuybackResponse>;
  buybackAvailable(wallet: string, nft: string): Promise<GachaBuybackAvailableResponse>;
  buybackCheck(memo: string): Promise<unknown>;
  getAllWinners(opts?: { timestamp?: string; slug?: string; epic?: boolean; packType?: GachaPackType; count?: number }): Promise<{ success: true; data: unknown[] }>;
}

class DisabledGacha implements GachaService {
  enabled = false as const;
  baseUrl = '';
  private rej(): Promise<never> {
    return Promise.reject(new GachaError(503, null, 'Collector Crypt Gacha is not configured. Set GACHA_API_KEY.'));
  }
  machines() { return this.rej(); }
  status() { return this.rej(); }
  generatePack() { return this.rej(); }
  submitTransaction() { return this.rej(); }
  openPack() { return this.rej(); }
  packStatus() { return this.rej(); }
  buyback() { return this.rej(); }
  buybackAvailable() { return this.rej(); }
  buybackCheck() { return this.rej(); }
  getAllWinners() { return this.rej(); }
}

class LiveGacha implements GachaService {
  enabled = true as const;
  constructor(public readonly baseUrl: string, private readonly apiKey: string) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const detail = body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
      throw new GachaError(res.status, body, `${path} failed: ${detail}`);
    }
    return body as T;
  }

  machines() { return this.req<{ machines: GachaMachine[] }>('/api/machines'); }
  status()   { return this.req<GachaStatusResponse>('/api/status'); }

  generatePack(args: { playerAddress: string; packType?: GachaPackType; turbo?: boolean; altPlayerAddress?: string }) {
    return this.req<GachaGeneratePackResponse>('/api/generatePack', {
      method: 'POST',
      body: JSON.stringify(args),
    });
  }

  submitTransaction(signedTransaction: string) {
    return this.req<GachaSubmitResponse>('/api/submitTransaction', {
      method: 'POST',
      body: JSON.stringify({ signedTransaction }),
    });
  }

  openPack(memo: string) {
    return this.req<GachaOpenPackResponse>('/api/openPack', {
      method: 'POST',
      body: JSON.stringify({ memo }),
    });
  }

  packStatus(memo: string) {
    return this.req<unknown>(`/api/pack/status?memo=${encodeURIComponent(memo)}`);
  }

  buyback(args: { playerAddress: string; nftAddress: string; altRecipient?: string }) {
    return this.req<GachaBuybackResponse>('/api/buyback', {
      method: 'POST',
      body: JSON.stringify(args),
    });
  }

  buybackAvailable(wallet: string, nft: string) {
    const q = new URLSearchParams({ wallet, nft });
    return this.req<GachaBuybackAvailableResponse>(`/api/buyback/available?${q}`);
  }

  buybackCheck(memo: string) {
    const q = new URLSearchParams({ memo });
    return this.req<unknown>(`/api/buyback/check?${q}`);
  }

  getAllWinners(opts: { timestamp?: string; slug?: string; epic?: boolean; packType?: GachaPackType; count?: number } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
    return this.req<{ success: true; data: unknown[] }>(`/api/getAllWinners?${q}`);
  }
}

export function createGachaService(): GachaService {
  // Collector Crypt's public Gacha API doesn't currently enforce
  // partner keys for the storefront endpoints — sending the literal
  // string 'API_KEY' is accepted as a pass-through. We default to
  // that so the storefront works out of the box; set GACHA_API_KEY in
  // env once a real partner key is issued.
  const apiKey = process.env.GACHA_API_KEY?.trim() || 'API_KEY';
  const baseUrl = (process.env.GACHA_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, '');
  return new LiveGacha(baseUrl, apiKey);
}
