// Server-side wrapper around the Phygitals Partner API (Jun 2026 surface).
//
// **New API surface (Jun 2026):**
//
//   GET  /api/vm/available                                   - list packs
//   POST /api/orpc/config/signers/pubkeys                    - get phygitals signer pubkeys
//   POST /api/vm/buy/crypto                                  - buy a pack (client-signed Solana tx)
//   POST /api/vm/buy/status                                  - poll for fulfillment
//   POST /api/marketplace/transaction/take-claw-bid-init     - start a sellback
//   POST /api/marketplace/transaction/take-claw-bid-finish   - finish a sellback
//
// The previous /api/v1/* surface (inventory, ship, card detail, recent-pulls,
// etc.) has been retired by Phygitals; we no longer support it. Sellback /
// "buyback" is now a client-signed marketplace transaction instead of an
// instant server-side settle.
//
// API key format: `phy_...`. Held in PHYGITALS_API_KEY env var, scoped to
// vm.buy.crypto + marketplace.take-claw-bid.
//
// USDC/USDT payment for the buy is now handled by the user's own wallet
// signing a Solana tx that we BUILD server-side and pass back to the
// client for signature. The server never holds the user's private key,
// and the buy-tx fee payer is Phygitals' own signer (returned from
// /api/orpc/config/signers/pubkeys), not the user — so the user pays
// only USDC + token rent, no SOL gas.

import * as Token from '@solana/spl-token';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const DEFAULT_BASE_URL = 'https://api.phygitals.com';
const DEFAULT_SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';

// Currency mints accepted by /api/vm/buy/crypto.
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDT_MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');

const CURRENCY_TO_MINT: Record<string, PublicKey> = {
  usdc: USDC_MINT,
  usdt: USDT_MINT,
};

// Phygitals' Address Lookup Table for the buy tx. Reduces tx size enough
// that buy/crypto fits inside Solana's 1232-byte limit even with rewards
// transfers. Pubkey + address list mirrors the public buy-with-crypto-v6
// script that Phygitals distributes to partners.
const LOOKUP_TABLE_KEY = new PublicKey('H5yQkXsVg9X21MvngdhCvzavTR9FC1R22Rm5sx8BERyJ');
const LOOKUP_TABLE_ADDRESSES = [
  '62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS',
  'Fufk5zDZao3YiEa8ZCaU319U8BuX84gEbHCsrc2ye9uq',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'AyW32YPRoy7YvsfJmotMiEv3qMQyqvTJLgpfdiWG8vyd',
  '8d56BJgENF7v9A6YJnMinXqrQb7KKLxMhe3WmUf1Pa4N',
  'hAsrSYBkzdaz4r3EJ6pwxNL1YbGbM5c1jNuhLV6Uzqi',
  'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV',
  'cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK',
  '11111111111111111111111111111111',
  'GCKQVnqNiPSwYNNWYR2BbRXQPhKdNrQtCCaQR2cEyznd',
  '3kVjWDszwTz6aFzBVPsfGschFFCKDgG4tLNkH8QgLeUN',
  'BMXiYRt6XMHVMG39My9c1ptPiocZzbGJ5hbVkD2W2Bid',
  'EDkeaWtLoh2AHbkBVvykw4b3Z5i9AJ3aP89hyYjrqtGK',
  'JDh7eiWiUWtiWn623iybHqjQ6AQ6c2Czz8m6ZxwSCkta',
  'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY',
  'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV',
  '8c4LJmTnDi3pAsqXELwpYJKjxjHCnQ1mzWqfLLkNe5CD',
  'DQPERZ9e86pNJ4mhUnCEP8V75yxZofsipoVrRWT5Wdxd',
  'CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf',
  'BSG6DyEihFFtfvxtL9mKYsvTwiZXB1rq5gARMTJC2xAM',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K',
  'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg',
  'eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9',
].map((a) => new PublicKey(a));

const HARDCODED_LOOKUP_TABLE = new AddressLookupTableAccount({
  key: LOOKUP_TABLE_KEY,
  state: {
    deactivationSlot: BigInt('18446744073709551615'),
    lastExtendedSlot: 382933344,
    lastExtendedSlotStartIndex: 16,
    authority: new PublicKey('62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS'),
    addresses: LOOKUP_TABLE_ADDRESSES,
  },
});

// ============================================================================
// Public types
// ============================================================================

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
  // Fields the buy/crypto flow needs.
  rewards_mint_addresses?: string[];
  rewards_amounts?: Array<number | string>;
  [key: string]: unknown;
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

export interface PhygitalsBuyStatusResult {
  result?: {
    session_id?: string;
    user_id?: string;
    public_id?: string;
    tx_hash?: string;
    nfts: PhygitalsPullItem[];
  };
  status?: 'pending' | 'success' | 'failed';
  error?: string;
}

export interface PhygitalsSignerPubkeys {
  solanaFeePayer: string;
  vmBuyback: string;
}

/** Unsigned buy tx the client has to sign with the user wallet. */
export interface PhygitalsBuyPreparation {
  packId: string;
  amount: number;
  currency: 'usdc' | 'usdt';
  priceInToken: number;
  /** Base64-encoded VersionedTransaction the client signs with Phantom. */
  transactionBase64: string;
}

export interface PhygitalsSellbackInit {
  session_id: string;
  /** Each entry is a serialized VersionedTransaction (number[]) the
   *  client must sign. */
  txV0s: Array<number[] | string>;
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

// ============================================================================
// Client
// ============================================================================

export interface PhygitalsClient {
  enabled: boolean;
  baseUrl: string;
  rpcUrl: string;
  listPacks(): Promise<PhygitalsPack[]>;
  fetchSignerPubkeys(): Promise<PhygitalsSignerPubkeys>;
  /**
   * Build an unsigned buy tx for the user wallet to sign. Returns
   * base64 so the client can deserialize, sign with Phantom, and
   * send back via submitBuy().
   */
  prepareBuy(args: {
    buyerWallet: string;
    packId: string;
    amount: number;
    currency: 'usdc' | 'usdt';
  }): Promise<PhygitalsBuyPreparation>;
  /**
   * Submit the signed tx bytes to Phygitals' /api/vm/buy/crypto endpoint.
   */
  submitBuy(args: {
    packId: string;
    amount: number;
    currency: 'usdc' | 'usdt';
    signedTxBytes: number[];
  }): Promise<{ session_id?: string; nfts?: PhygitalsPullItem[] }>;
  buyStatus(args: { session_id: string }): Promise<PhygitalsBuyStatusResult>;
  takeClawBidInit(args: { mint_address: string }): Promise<PhygitalsSellbackInit>;
  takeClawBidFinish(args: { session_id: string; signedTxBytes: Array<number[]> }): Promise<unknown>;
}

class DisabledPhygitalsClient implements PhygitalsClient {
  enabled = false as const;
  baseUrl = DEFAULT_BASE_URL;
  rpcUrl = DEFAULT_SOLANA_RPC_URL;
  private fail<T>(): Promise<T> {
    return Promise.reject(new PhygitalsError(503, { error: 'Phygitals not configured' }, 'PHYGITALS_API_KEY is not set on the server.'));
  }
  listPacks() { return this.fail<PhygitalsPack[]>(); }
  fetchSignerPubkeys() { return this.fail<PhygitalsSignerPubkeys>(); }
  prepareBuy() { return this.fail<PhygitalsBuyPreparation>(); }
  submitBuy() { return this.fail<{ session_id?: string; nfts?: PhygitalsPullItem[] }>(); }
  buyStatus() { return this.fail<PhygitalsBuyStatusResult>(); }
  takeClawBidInit() { return this.fail<PhygitalsSellbackInit>(); }
  takeClawBidFinish() { return this.fail<unknown>(); }
}

class RealPhygitalsClient implements PhygitalsClient {
  enabled = true as const;
  baseUrl: string;
  rpcUrl: string;
  private apiKey: string;
  private signerPubkeysCache: { value: PhygitalsSignerPubkeys; fetchedAt: number } | null = null;
  private packsCache: { value: PhygitalsPack[]; fetchedAt: number } | null = null;
  private connection: Connection | null = null;

  constructor(config: { baseUrl: string; apiKey: string; rpcUrl: string }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.rpcUrl = config.rpcUrl;
  }

  private getConnection(): Connection {
    if (!this.connection) {
      this.connection = new Connection(this.rpcUrl, 'confirmed');
    }
    return this.connection;
  }

  private async apiCall<T>(method: 'GET' | 'POST', path: string, body?: unknown, withApiKey = true): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      // A modern Chrome User-Agent helps slip past basic bot heuristics.
      // The bigger blocker is Phygitals' Cloudflare IP allow-list — if
      // your server IPs aren't whitelisted you'll see 403s with a
      // Cloudflare cf-ray header regardless of how the request is
      // shaped. Email partners@phygitals.com to add your egress IPs.
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (withApiKey) headers['X-API-Key'] = this.apiKey;
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try { parsed = JSON.parse(text); }
      catch { parsed = text; }
    }
    if (!res.ok) {
      // Cloudflare WAF returns text/html "Attention Required" with a
      // cf-ray header. Detect that specifically and replace with a
      // partner-friendly message instead of dumping the HTML.
      const cfRay = res.headers.get('cf-ray');
      const isCloudflareWaf = cfRay && typeof parsed === 'string' && parsed.toLowerCase().includes('cloudflare');
      if (isCloudflareWaf) {
        throw new PhygitalsError(
          res.status,
          { error: 'Phygitals Cloudflare WAF blocked this request', cfRay },
          `Phygitals Cloudflare is blocking this server's IP. Ask Phygitals (partners@phygitals.com) to allow-list your egress IPs. cf-ray=${cfRay}`,
        );
      }
      const msg = (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string')
        ? (parsed as { error: string }).error
        : `${method} ${path} failed (${res.status})`;
      throw new PhygitalsError(res.status, parsed, msg);
    }
    return parsed as T;
  }

  async listPacks(): Promise<PhygitalsPack[]> {
    // Cache for 30s to avoid hammering Phygitals from busy lobby renders.
    if (this.packsCache && Date.now() - this.packsCache.fetchedAt < 30_000) {
      return this.packsCache.value;
    }
    // GET /api/vm/available accepts (and may require) the X-API-Key
    // header for partner accounts — sent via the default apiCall path.
    const packs = await this.apiCall<PhygitalsPack[]>('GET', '/api/vm/available');
    this.packsCache = { value: packs, fetchedAt: Date.now() };
    return packs;
  }

  async fetchSignerPubkeys(): Promise<PhygitalsSignerPubkeys> {
    // Cache forever — these pubkeys don't rotate. If they ever did the
    // server would need a restart, which is fine.
    if (this.signerPubkeysCache) return this.signerPubkeysCache.value;
    // The signer-pubkeys endpoint uses the ORPC wire format. Response
    // shape is either `{ json: { solanaFeePayer, vmBuyback } }` (newer
    // ORPC) or the bare object (older). Handle both.
    const raw = await this.apiCall<{ json?: PhygitalsSignerPubkeys } | PhygitalsSignerPubkeys>(
      'POST',
      '/api/orpc/config/signers/pubkeys',
      {},
      false,
    );
    const value = 'json' in raw && raw.json ? raw.json : (raw as PhygitalsSignerPubkeys);
    if (!value?.solanaFeePayer || !value?.vmBuyback) {
      throw new PhygitalsError(502, raw, 'Phygitals signer pubkeys response missing solanaFeePayer or vmBuyback');
    }
    this.signerPubkeysCache = { value, fetchedAt: Date.now() };
    return value;
  }

  async prepareBuy(args: {
    buyerWallet: string;
    packId: string;
    amount: number;
    currency: 'usdc' | 'usdt';
  }): Promise<PhygitalsBuyPreparation> {
    const paymentMint = CURRENCY_TO_MINT[args.currency];
    if (!paymentMint) {
      throw new PhygitalsError(400, null, `Unsupported currency: ${args.currency}`);
    }
    const pubkeys = await this.fetchSignerPubkeys();
    const packs = await this.listPacks();
    const pack = packs.find((p) => p.id === args.packId || p.slug === args.packId);
    if (!pack) {
      throw new PhygitalsError(404, null, `Pack not found: ${args.packId}`);
    }
    if (pack.in_stock === false || pack.enable === false) {
      throw new PhygitalsError(400, null, 'Pack is out of stock');
    }
    const maxPerMint = Math.max(1, pack.max_per_mint ?? 10);
    if (!Number.isInteger(args.amount) || args.amount < 1 || args.amount > maxPerMint) {
      throw new PhygitalsError(400, null, `Amount must be between 1 and ${maxPerMint}`);
    }

    const buyerPk = new PublicKey(args.buyerWallet);
    const priceInToken = args.amount * (pack.mint_price ?? 0) * 1e6;
    const rewards = (pack.rewards_mint_addresses ?? []).map((mint, i) => ({
      mint,
      amount: Number(pack.rewards_amounts?.[i] ?? 0),
    }));

    const tx = await this.buildBuyTransaction({
      buyer: buyerPk,
      priceInToken,
      clawId: pack.id,
      vmBuyback: pubkeys.vmBuyback,
      solanaFeePayer: pubkeys.solanaFeePayer,
      paymentMint,
      rewards,
      numPulls: args.amount,
    });

    // Serialize as a partially-signed VersionedTransaction — neither
    // the buyer (user wallet) nor the fee payer (Phygitals signer) has
    // signed yet. VersionedTransaction.serialize() always produces
    // the same wire format whether signatures are present or empty.
    const serialized = tx.serialize();
    const transactionBase64 = Buffer.from(serialized).toString('base64');

    return {
      packId: pack.id,
      amount: args.amount,
      currency: args.currency,
      priceInToken,
      transactionBase64,
    };
  }

  private async buildBuyTransaction(params: {
    buyer: PublicKey;
    priceInToken: number;
    clawId: string;
    vmBuyback: string;
    solanaFeePayer: string;
    paymentMint: PublicKey;
    rewards: Array<{ mint: string; amount: number }>;
    numPulls: number;
  }): Promise<VersionedTransaction> {
    const { buyer, priceInToken, clawId, vmBuyback, solanaFeePayer, paymentMint, rewards, numPulls } = params;
    const connection = this.getConnection();
    const feePayerPk = new PublicKey(solanaFeePayer);
    const vmBuybackPk = new PublicKey(vmBuyback);
    const paymentReceiver = getPaymentReceiver(clawId, vmBuyback);

    const [senderTokenAccount, receiverTokenAccount] = await Promise.all([
      getTokenAccountForMint(connection, buyer.toString(), paymentMint),
      getTokenAccountForMint(connection, paymentReceiver, paymentMint),
    ]);

    const paymentIx = Token.createTransferInstruction(senderTokenAccount, receiverTokenAccount, buyer, priceInToken);
    const rewardsTransferIxGroups = await Promise.all(
      rewards.map(async (reward) => {
        const mintPublicKey = new PublicKey(reward.mint);
        const destAta = Token.getAssociatedTokenAddressSync(mintPublicKey, buyer, false);
        const createDestAtaIx = Token.createAssociatedTokenAccountIdempotentInstruction(
          feePayerPk,
          destAta,
          buyer,
          mintPublicKey,
        );
        const transferIx = Token.createTransferInstruction(
          await getTokenAccountForMint(connection, vmBuyback, mintPublicKey),
          destAta,
          vmBuybackPk,
          reward.amount * numPulls,
        );
        return [createDestAtaIx, transferIx];
      }),
    );
    const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 100 + Math.floor(Math.random() * 300),
    });
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: feePayerPk,
      recentBlockhash: blockhash,
      instructions: [addPriorityFee, paymentIx, ...rewardsTransferIxGroups.flat()],
    }).compileToV0Message([HARDCODED_LOOKUP_TABLE]);
    return new VersionedTransaction(message);
  }

  async submitBuy(args: {
    packId: string;
    amount: number;
    currency: 'usdc' | 'usdt';
    signedTxBytes: number[];
  }): Promise<{ session_id?: string; nfts?: PhygitalsPullItem[] }> {
    const body = {
      txs: [args.signedTxBytes],
      claw_id: args.packId,
      amount: args.amount,
      currency: args.currency,
      chain: 'solana',
    };
    const resp = await this.apiCall<{
      result?: { session_id?: string; nfts?: PhygitalsPullItem[] };
      session_id?: string;
      nfts?: PhygitalsPullItem[];
    }>('POST', '/api/vm/buy/crypto', body);
    return resp.result ?? { session_id: resp.session_id, nfts: resp.nfts };
  }

  async buyStatus(args: { session_id: string }): Promise<PhygitalsBuyStatusResult> {
    return this.apiCall<PhygitalsBuyStatusResult>('POST', '/api/vm/buy/status', { session_id: args.session_id });
  }

  async takeClawBidInit(args: { mint_address: string }): Promise<PhygitalsSellbackInit> {
    return this.apiCall<PhygitalsSellbackInit>(
      'POST',
      '/api/marketplace/transaction/take-claw-bid-init',
      { mint_address: args.mint_address },
    );
  }

  async takeClawBidFinish(args: { session_id: string; signedTxBytes: Array<number[]> }): Promise<unknown> {
    return this.apiCall<unknown>(
      'POST',
      '/api/marketplace/transaction/take-claw-bid-finish',
      { session_id: args.session_id, txs: args.signedTxBytes },
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

async function getTokenAccountForMint(
  connection: Connection,
  ownerAddress: string,
  mint: PublicKey,
): Promise<PublicKey> {
  const owner = new PublicKey(ownerAddress);
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  if (accounts.value.length === 0) {
    throw new PhygitalsError(
      400,
      null,
      `Wallet ${ownerAddress} has no token account for mint ${mint.toBase58()}. Fund the wallet with USDC/USDT first.`,
    );
  }
  return accounts.value[0]!.pubkey;
}

/**
 * Per-pack payment receiver override. Most packs go through the
 * vmBuyback signer; specific franchise packs route to dedicated
 * receivers. Mirrors the Phygitals reference script.
 */
function getPaymentReceiver(clawId: string, vmBuyback: string): string {
  if (clawId.includes('fwog')) return 'H7Tou5HugVHFyJYZ3wfxJGfruYN47Xjjc6xQhjzwySUz';
  if (clawId.includes('gboy')) return 'DQ1LJZ2ET1oHcCgojCN3kXakTQSkuCxgEqXguf2UrYS5';
  return vmBuyback;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Build a PhygitalsClient from environment variables. If
 * PHYGITALS_API_KEY isn't set (or doesn't start with the new `phy_`
 * prefix), returns a "disabled" client that throws 503 on every
 * method so the matching proxy endpoints respond cleanly instead of
 * crashing.
 */
export function createPhygitalsClient(): PhygitalsClient {
  const apiKey = process.env.PHYGITALS_API_KEY?.trim();
  if (!apiKey) {
    return new DisabledPhygitalsClient();
  }
  if (!apiKey.startsWith('phy_')) {
    console.warn('[phygitals] PHYGITALS_API_KEY does not start with "phy_". Make sure you\'re using a current user API key with vm.buy.crypto + marketplace.take-claw-bid scopes.');
  }
  const baseUrl = process.env.PHYGITALS_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim() || DEFAULT_SOLANA_RPC_URL;
  return new RealPhygitalsClient({ baseUrl, apiKey, rpcUrl });
}

/** Convenience helper for the buy/crypto → buy/status polling loop. */
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
    if (res.result?.nfts?.length) return res.result;
    if (res.status === 'failed' || res.error) {
      throw new PhygitalsError(400, res, res.error || 'Phygitals transaction failed');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new PhygitalsError(504, null, 'Phygitals purchase polling timed out');
}
