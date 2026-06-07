// Browser-side wrappers for the /api/phygitals/* proxy endpoints. The
// server holds the X-API-Key; the browser only ever calls our own
// origin. See https://dev.phygitals.com for the underlying schema.

import { apiUrl } from './server';

export interface PhygitalsPack {
  id: string;
  slug: string;
  name: string;
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

export class PhygitalsApiError extends Error {
  status: number;
  body: unknown;
  // Set when /ship/quote returns an "Invalid destination address" 400 with
  // a Google-suggested correction the user can confirm.
  suggested?: PhygitalsDestination;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = 'PhygitalsApiError';
    if (body && typeof body === 'object' && 'suggested' in body) {
      this.suggested = (body as { suggested?: PhygitalsDestination }).suggested;
    }
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

export async function fetchPhygitalsChase(slug: string): Promise<PhygitalsChaseCard[]> {
  const { chase } = await request<{ chase: PhygitalsChaseCard[] }>('GET', `/api/phygitals/chase/${encodeURIComponent(slug)}`);
  return chase ?? [];
}

export async function fetchPhygitalsRecentPulls(opts?: { clawIds?: string[]; limit?: number }): Promise<PhygitalsPull[]> {
  const params = new URLSearchParams();
  opts?.clawIds?.forEach((id) => params.append('claw_ids', id));
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const { pulls } = await request<{ pulls: PhygitalsPull[] }>('GET', `/api/phygitals/recent-pulls${qs ? `?${qs}` : ''}`);
  return pulls ?? [];
}

export async function phygitalsBuy(body: { id: string; amount: number; user_id: string }): Promise<{
  session_id: string;
  user_id: string;
  public_id?: string;
  tx_hash?: string;
  nfts: PhygitalsItem[];
}> {
  return request('POST', '/api/phygitals/buy', body);
}

export async function fetchPhygitalsInventory(userId: string): Promise<{ user_id: string; items: PhygitalsItem[] }> {
  return request('GET', `/api/phygitals/inventory/${encodeURIComponent(userId)}`);
}

export async function fetchPhygitalsCard(itemId: string): Promise<PhygitalsCard> {
  return request('GET', `/api/phygitals/card/${encodeURIComponent(itemId)}`);
}

export async function phygitalsSellback(itemId: string): Promise<{ success: true; amount: number }> {
  return request('POST', '/api/phygitals/buyback', { item_id: itemId });
}

export async function phygitalsShipQuote(body: { item_ids: string[]; destination: PhygitalsDestination }): Promise<PhygitalsShipQuote> {
  return request('POST', '/api/phygitals/ship/quote', body);
}

export async function phygitalsShipRequest(quoteId: string): Promise<{ order_id: string; status: 'success' }> {
  return request('POST', '/api/phygitals/ship/request', { quote_id: quoteId });
}

export async function fetchPhygitalsShipOrder(orderId: string): Promise<PhygitalsShipOrder> {
  return request('GET', `/api/phygitals/ship/order/${encodeURIComponent(orderId)}`);
}
