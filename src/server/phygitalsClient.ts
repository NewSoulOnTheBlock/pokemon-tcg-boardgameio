// Server-side wrapper around the Phygitals Partner API
// (https://api.phygitals.com — see https://dev.phygitals.com).
//
// All requests carry our partner X-API-Key from the PHYGITALS_API_KEY env
// var. The key MUST stay server-side; the browser only ever sees our
// /api/phygitals/* proxy routes which strip the key from outbound headers.
//
// Base URL is configurable via PHYGITALS_BASE_URL so we can swap to the
// sandbox (`https://api.phygitals.com/_`) without a code change.

const DEFAULT_BASE_URL = 'https://api.phygitals.com';

export interface PhygitalsConfig {
  baseUrl: string;
  apiKey: string;
}

export interface PhygitalsPack {
  id: string;
  slug: string;
  platform?: string;
  name: string;
  description?: string;
  enable?: boolean;
  in_stock?: boolean;
  mint_price?: number;
  max_per_mint?: number;
  categories?: string[];
  ev?: number;
  min_ev?: number;
  max_ev?: number;
  buyback_percent?: number;
  claw_image_url?: string;
  rarity_distribution?: Array<{ id: number; name: string; color?: string; lower?: number; upper?: number; weight?: number }>;
  chase?: Array<{ id: string; name: string; image: string; back_image?: string | null; fmv: number }>;
  type?: 'CORE' | 'EBAY' | string;
  num_pulls_7d?: number;
  repack?: boolean;
  last_pull?: string | null;
  variant_of?: string | null;
  variants?: unknown;
  // forward-compat: anything we don't model just rides as `unknown`
  [key: string]: unknown;
}

export interface PhygitalsChaseCard {
  id: string;
  name: string;
  image: string;
  back_image?: string | null;
  fmv: number;
}

export interface PhygitalsPull {
  id: string;
  claw_id: string;
  claw_slug?: string | null;
  value: number;
  buyback_price: number;
  created_at: string;
  metadata: {
    name: string;
    image: string;
    back_image?: string | null;
    attributes?: Array<{ trait_type: string; value: string | number }>;
  };
}

export interface PhygitalsBuyInitResult {
  session_id: string;
  nfts?: PhygitalsItem[];
}

export interface PhygitalsBuyStatusResult {
  result?: {
    session_id: string;
    user_id: string;
    public_id?: string;
    tx_hash?: string;
    nfts: PhygitalsItem[];
  };
  status?: 'pending';
  error?: string;
}

export interface PhygitalsItem {
  id: string;
  buyback_price?: number;
  mint_address?: string | null;
  type?: string;
  collection_address?: string | null;
  token_standard?: string | null;
  purchased_at?: string;
  buyback_expires_at?: string | null;
  claw_id?: string;
  claw_slug?: string;
  content: {
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

export interface PhygitalsCard {
  id: string;
  name: string;
  image: string;
  back_image?: string | null;
  fmv: number;
  metadata: PhygitalsItem['content']['metadata'];
}

export interface PhygitalsShipQuote {
  session_id: string;
  expires_at: string;
  quotes: Array<{
    id: string;
    carrier: string;
    service: string;
    amount: number;
    estimated_days_min: number;
    estimated_days_max: number;
    insured: boolean;
  }>;
}

export interface PhygitalsShipOrder {
  order_id: string;
  status: 'queued' | 'processing' | 'label_created' | 'shipped' | 'delivered' | 'cancelled' | 'failed';
  carrier?: string | null;
  service?: string | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  amount?: number;
  currency?: string;
  destination?: Record<string, unknown>;
  items?: Array<{ item_id: string; name: string; image: string; back_image?: string | null }>;
  created_at?: string;
  shipped_at?: string | null;
  delivered_at?: string | null;
  error_message?: string | null;
}

export interface PhygitalsDestination {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postal_code?: string;
  country: string;
  phone?: string;
  email?: string;
}

export class PhygitalsError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = 'PhygitalsError';
  }
}

export interface PhygitalsClient {
  enabled: boolean;
  baseUrl: string;
  listPacks(): Promise<PhygitalsPack[]>;
  listChase(slug: string): Promise<PhygitalsChaseCard[]>;
  recentPulls(opts?: { claw_ids?: string[]; limit?: number }): Promise<PhygitalsPull[]>;
  buyInit(body: { id: string; amount: number; user_id: string }): Promise<PhygitalsBuyInitResult>;
  buyStatus(body: { session_id: string }): Promise<PhygitalsBuyStatusResult>;
  inventory(userId: string): Promise<{ user_id: string; items: PhygitalsItem[] }>;
  card(itemId: string): Promise<PhygitalsCard>;
  buyback(body: { item_id: string }): Promise<{ success: true; amount: number }>;
  shipQuote(body: { item_ids: string[]; destination: PhygitalsDestination }): Promise<PhygitalsShipQuote>;
  shipRequest(body: { quote_id: string }): Promise<{ order_id: string; status: 'success' }>;
  shipOrder(orderId: string): Promise<PhygitalsShipOrder>;
}

class DisabledPhygitalsClient implements PhygitalsClient {
  enabled = false as const;
  baseUrl = DEFAULT_BASE_URL;
  private fail<T>(): Promise<T> {
    return Promise.reject(new PhygitalsError(503, { error: 'Phygitals not configured' }, 'PHYGITALS_API_KEY is not set on the server.'));
  }
  listPacks() { return this.fail<PhygitalsPack[]>(); }
  listChase() { return this.fail<PhygitalsChaseCard[]>(); }
  recentPulls() { return this.fail<PhygitalsPull[]>(); }
  buyInit() { return this.fail<PhygitalsBuyInitResult>(); }
  buyStatus() { return this.fail<PhygitalsBuyStatusResult>(); }
  inventory() { return this.fail<{ user_id: string; items: PhygitalsItem[] }>(); }
  card() { return this.fail<PhygitalsCard>(); }
  buyback() { return this.fail<{ success: true; amount: number }>(); }
  shipQuote() { return this.fail<PhygitalsShipQuote>(); }
  shipRequest() { return this.fail<{ order_id: string; status: 'success' }>(); }
  shipOrder() { return this.fail<PhygitalsShipOrder>(); }
}

class RealPhygitalsClient implements PhygitalsClient {
  enabled = true as const;
  baseUrl: string;
  private apiKey: string;
  constructor(config: PhygitalsConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'X-API-Key': this.apiKey,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const msg = (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string')
        ? (parsed as { error: string }).error
        : `${method} ${path} failed (${res.status})`;
      throw new PhygitalsError(res.status, parsed, msg);
    }
    return parsed as T;
  }

  async listPacks() {
    return this.request<PhygitalsPack[]>('GET', '/api/v1/vm/available');
  }

  async listChase(slug: string) {
    return this.request<PhygitalsChaseCard[]>('GET', `/api/v1/vm/chase/${encodeURIComponent(slug)}`);
  }

  async recentPulls(opts?: { claw_ids?: string[]; limit?: number }) {
    const params = new URLSearchParams();
    opts?.claw_ids?.forEach((id) => params.append('claw_ids', id));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.request<PhygitalsPull[]>('GET', `/api/v1/vm/recent-pulls${qs ? `?${qs}` : ''}`);
  }

  async buyInit(body: { id: string; amount: number; user_id: string }) {
    return this.request<PhygitalsBuyInitResult>('POST', '/api/v1/vm/buy/init', body);
  }

  async buyStatus(body: { session_id: string }) {
    return this.request<PhygitalsBuyStatusResult>('POST', '/api/v1/vm/buy/status', body);
  }

  async inventory(userId: string) {
    return this.request<{ user_id: string; items: PhygitalsItem[] }>('GET', `/api/v1/inventory/${encodeURIComponent(userId)}`);
  }

  async card(itemId: string) {
    return this.request<PhygitalsCard>('GET', `/api/v1/card/${encodeURIComponent(itemId)}`);
  }

  async buyback(body: { item_id: string }) {
    return this.request<{ success: true; amount: number }>('POST', '/api/v1/vm/buyback', body);
  }

  async shipQuote(body: { item_ids: string[]; destination: PhygitalsDestination }) {
    return this.request<PhygitalsShipQuote>('POST', '/api/v1/ship/quote', body);
  }

  async shipRequest(body: { quote_id: string }) {
    return this.request<{ order_id: string; status: 'success' }>('POST', '/api/v1/ship/request', body);
  }

  async shipOrder(orderId: string) {
    return this.request<PhygitalsShipOrder>('GET', `/api/v1/ship/order/${encodeURIComponent(orderId)}`);
  }
}

/**
 * Build a PhygitalsClient from environment variables. If
 * PHYGITALS_API_KEY isn't set, returns a "disabled" client that throws
 * a 503 on every method so the matching proxy endpoints respond
 * cleanly instead of crashing.
 */
export function createPhygitalsClient(): PhygitalsClient {
  const apiKey = process.env.PHYGITALS_API_KEY?.trim();
  if (!apiKey) {
    return new DisabledPhygitalsClient();
  }
  const baseUrl = process.env.PHYGITALS_BASE_URL?.trim() || DEFAULT_BASE_URL;
  return new RealPhygitalsClient({ baseUrl, apiKey });
}

/** Convenience helper for the buy/init → buy/status polling loop. Used
 *  server-side by /api/phygitals/buy so the client only sees the
 *  fulfilled result. */
export async function awaitPurchase(
  client: PhygitalsClient,
  sessionId: string,
  opts?: { intervalMs?: number; timeoutMs?: number },
): Promise<NonNullable<PhygitalsBuyStatusResult['result']>> {
  const intervalMs = opts?.intervalMs ?? 1500;
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.buyStatus({ session_id: sessionId });
    if (res.result?.nfts) return res.result;
    if (res.error) {
      throw new PhygitalsError(400, res, res.error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new PhygitalsError(504, null, 'Phygitals purchase polling timed out');
}
