// Browser-direct Phygitals client. Bypasses our Render server entirely
// because Phygitals' Cloudflare WAF rejects Render's outbound IPs at
// the edge.
//
// **Security note:** with this architecture, the Phygitals API key
// lives in the browser bundle (VITE_PHYGITALS_API_KEY env var). It's
// visible to anyone with DevTools. This is acceptable for read-only
// usage and for client-signed-tx flows (the key only authorizes API
// access, not unilateral spending — every state-changing action still
// needs the user to sign with their wallet). DO NOT put a key with
// admin/treasury scopes in here.
//
// Endpoints used:
//   GET  https://api.phygitals.com/api/vm/available
//   POST https://api.phygitals.com/api/orpc/config/signers/pubkeys
//   POST https://api.phygitals.com/api/vm/buy/crypto
//   POST https://api.phygitals.com/api/vm/buy/status
//   POST https://api.phygitals.com/api/marketplace/transaction/take-claw-bid-init
//   POST https://api.phygitals.com/api/marketplace/transaction/take-claw-bid-finish

const PHYGITALS_BASE_URL = (import.meta.env.VITE_PHYGITALS_BASE_URL?.trim() || 'https://api.phygitals.com').replace(/\/$/, '');
const PHYGITALS_API_KEY = (import.meta.env.VITE_PHYGITALS_API_KEY ?? '').trim();
const SOLANA_RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';

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
  mint_price?: number | string;
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
  rewards_mint_addresses?: string[];
  rewards_amounts?: Array<number | string>;
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

// ============================================================================
// HTTP helper — talks directly to Phygitals from the browser
// ============================================================================

async function phygitalsRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  withApiKey = true,
): Promise<T> {
  if (withApiKey && !PHYGITALS_API_KEY) {
    throw new PhygitalsApiError(503, null, 'VITE_PHYGITALS_API_KEY is not set in the client bundle');
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (withApiKey) headers['X-API-Key'] = PHYGITALS_API_KEY;
  const res = await fetch(`${PHYGITALS_BASE_URL}${path}`, {
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
    // Surface friendlier messages for common partner-side errors.
    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get('retry-after')) || 60;
      throw new PhygitalsApiError(
        429,
        parsed,
        `Phygitals is rate-limiting us. Wait ~${retryAfterSec}s and try again. (This usually clears in a couple of minutes.)`,
      );
    }
    const msg = (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string')
      ? (parsed as { error: string }).error
      : `${method} ${path} failed (${res.status})`;
    throw new PhygitalsApiError(res.status, parsed, msg);
  }
  return parsed as T;
}

// ============================================================================
// Public API
// ============================================================================

export function fetchPhygitalsStatus(): Promise<{ enabled: boolean; baseUrl: string }> {
  return Promise.resolve({ enabled: Boolean(PHYGITALS_API_KEY), baseUrl: PHYGITALS_BASE_URL });
}

export async function fetchPhygitalsPacks(): Promise<PhygitalsPack[]> {
  return phygitalsRequest<PhygitalsPack[]>('GET', '/api/vm/available');
}

interface SignerPubkeys {
  solanaFeePayer: string;
  vmBuyback: string;
}

async function fetchPhygitalsSignerPubkeys(): Promise<SignerPubkeys> {
  // The signer-pubkeys endpoint uses an ORPC envelope. Response is
  // either { json: { ... } } or the bare object. Handle both.
  const raw = await phygitalsRequest<{ json?: SignerPubkeys } | SignerPubkeys>(
    'POST',
    '/api/orpc/config/signers/pubkeys',
    {},
    false,
  );
  const value = 'json' in raw && raw.json ? raw.json : (raw as SignerPubkeys);
  if (!value?.solanaFeePayer || !value?.vmBuyback) {
    throw new PhygitalsApiError(502, raw, 'Phygitals signer pubkeys response missing fields');
  }
  return value;
}

/**
 * Step 1 of the buy flow. Builds the unsigned VersionedTransaction in
 * the BROWSER (using @solana/web3.js + @solana/spl-token), and returns
 * it as base64 for the wallet to sign.
 *
 * Note: this hits Solana RPC and Phygitals' signer-pubkeys endpoint —
 * the user needs to have USDC/USDT in their wallet and a fast RPC.
 */
export async function preparePhygitalsBuy(args: {
  buyerWallet: string;
  packId: string;
  amount: number;
  currency?: 'usdc' | 'usdt';
}): Promise<PhygitalsBuyPreparation> {
  const currency = args.currency ?? 'usdc';
  const [{
    PublicKey, Connection, TransactionMessage, VersionedTransaction,
  }, Token] = await Promise.all([
    import('@solana/web3.js'),
    import('@solana/spl-token'),
  ]);

  const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const USDT_MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
  const paymentMint = currency === 'usdc' ? USDC_MINT : USDT_MINT;

  // Phygitals' partner Address Lookup Table — fetched LIVE each buy.
  // The previous hardcoded snapshot went stale as Phygitals extended
  // the table (more addresses added on-chain), which broke their
  // transaction-fingerprint check ("fingerprint mismatch"). Fetching
  // live guarantees our compiled v0 message uses the same ALT state
  // their backend uses to reconstruct + hash the canonical tx.
  const LOOKUP_TABLE_KEY = new PublicKey('H5yQkXsVg9X21MvngdhCvzavTR9FC1R22Rm5sx8BERyJ');

  const pubkeys = await fetchPhygitalsSignerPubkeys();
  const packs = await fetchPhygitalsPacks();
  const pack = packs.find((p) => p.id === args.packId || p.slug === args.packId);
  if (!pack) {
    throw new PhygitalsApiError(404, null, `Pack not found: ${args.packId}`);
  }
  if (pack.in_stock === false || pack.enable === false) {
    throw new PhygitalsApiError(400, null, 'Pack is out of stock');
  }
  const maxPerMint = Math.max(1, pack.max_per_mint ?? 10);
  if (!Number.isInteger(args.amount) || args.amount < 1 || args.amount > maxPerMint) {
    throw new PhygitalsApiError(400, null, `Amount must be between 1 and ${maxPerMint}`);
  }

  const buyer = new PublicKey(args.buyerWallet);
  const mintPrice = Number(pack.mint_price ?? 0);
  const priceInToken = args.amount * mintPrice * 1e6;
  const feePayerPk = new PublicKey(pubkeys.solanaFeePayer);
  const vmBuybackPk = new PublicKey(pubkeys.vmBuyback);

  // Per-pack payment receiver overrides. Mirrors Phygitals' reference
  // script — fwog/gboy franchise packs route to dedicated wallets.
  const paymentReceiver = pack.id.includes('fwog')
    ? 'H7Tou5HugVHFyJYZ3wfxJGfruYN47Xjjc6xQhjzwySUz'
    : pack.id.includes('gboy')
      ? 'DQ1LJZ2ET1oHcCgojCN3kXakTQSkuCxgEqXguf2UrYS5'
      : pubkeys.vmBuyback;

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  // Fetch the live ALT state. If unavailable for any reason we fall
  // back to a no-ALT compile — message will be larger but functionally
  // identical, and Phygitals' backend should still recompute a
  // matching fingerprint since they re-decode the raw tx bytes.
  const liveLookupTable = await connection
    .getAddressLookupTable(LOOKUP_TABLE_KEY)
    .then((r) => r.value)
    .catch(() => null);

  // Phygitals' backend re-derives the expected token-transfer
  // instruction using the canonical ATA (getAssociatedTokenAddressSync),
  // NOT an RPC lookup. If the buyer has an old non-ATA USDC account
  // or multiple USDC accounts, `getParsedTokenAccountsByOwner` may
  // return a different account first, producing a different
  // transaction-fingerprint than what Phygitals expects. Always use
  // the canonical ATA for both sides of the payment + rewards.
  async function ensureAtaExists(owner: string, mint: InstanceType<typeof PublicKey>, ata: InstanceType<typeof PublicKey>): Promise<void> {
    const info = await connection.getAccountInfo(ata);
    if (!info) {
      throw new PhygitalsApiError(
        400,
        null,
        `Wallet ${owner} has no ${mint.equals(USDC_MINT) ? 'USDC' : mint.equals(USDT_MINT) ? 'USDT' : mint.toBase58()} associated token account. Fund the wallet first.`,
      );
    }
  }

  const senderAta = Token.getAssociatedTokenAddressSync(paymentMint, buyer, false);
  const receiverAta = Token.getAssociatedTokenAddressSync(paymentMint, new PublicKey(paymentReceiver), false);
  // Only check the BUYER side exists — receiver wallets (Phygitals')
  // may use Token-2022 or special ATAs which we can't introspect, but
  // they'll always exist if the pack is enabled.
  await ensureAtaExists(args.buyerWallet, paymentMint, senderAta);

  const paymentIx = Token.createTransferInstruction(senderAta, receiverAta, buyer, priceInToken);

  const rewards = (pack.rewards_mint_addresses ?? []).map((mint, i) => ({
    mint,
    amount: Number(pack.rewards_amounts?.[i] ?? 0),
  }));
  const rewardsTransferIxGroups = rewards.map((reward) => {
    const mintPublicKey = new PublicKey(reward.mint);
    const destAta = Token.getAssociatedTokenAddressSync(mintPublicKey, buyer, false);
    const sourceAta = Token.getAssociatedTokenAddressSync(mintPublicKey, vmBuybackPk, false);
    const createDestAtaIx = Token.createAssociatedTokenAccountIdempotentInstruction(
      feePayerPk,
      destAta,
      buyer,
      mintPublicKey,
    );
    const transferIx = Token.createTransferInstruction(
      sourceAta,
      destAta,
      vmBuybackPk,
      reward.amount * args.amount,
    );
    return [createDestAtaIx, transferIx];
  });

  // Phygitals' canonical buy tx does NOT include a ComputeBudget
  // priority-fee instruction — including one alters the message-byte
  // layout and breaks their tx-fingerprint check. Use only the
  // payment ix (+ any rewards transfers) so our compiled v0 message
  // matches what their backend reconstructs.
  //
  // (The reference partner script ships with a priority fee, but
  // their backend appears to fingerprint-check on the canonical
  // tx without it. If you re-introduce the priority fee, expect
  // 'Transaction fingerprint mismatch' on every buy.)
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: feePayerPk,
    recentBlockhash: blockhash,
    instructions: [paymentIx, ...rewardsTransferIxGroups.flat()],
  }).compileToV0Message(liveLookupTable ? [liveLookupTable] : []);
  const tx = new VersionedTransaction(message);

  const serialized = tx.serialize();
  // VersionedTransaction.serialize() returns Uint8Array; base64-encode
  // in a way that works in any browser without relying on Buffer.
  let binary = '';
  for (let i = 0; i < serialized.length; i++) binary += String.fromCharCode(serialized[i]!);
  const transactionBase64 = btoa(binary);

  return {
    packId: pack.id,
    amount: args.amount,
    currency,
    priceInToken,
    transactionBase64,
  };
}

/**
 * Step 2 of the buy flow. Posts the signed-tx bytes directly to
 * Phygitals' /api/vm/buy/crypto. Phygitals adds the fee-payer
 * signature and submits the tx server-side, then returns either
 * the NFTs inline or a session_id to poll for status.
 */
export async function submitPhygitalsBuy(args: {
  packId: string;
  amount: number;
  currency?: 'usdc' | 'usdt';
  signedTxBytes: number[];
}): Promise<PhygitalsBuySubmitResult> {
  const currency = args.currency ?? 'usdc';
  const body = {
    txs: [args.signedTxBytes],
    claw_id: args.packId,
    amount: args.amount,
    currency,
    chain: 'solana',
  };
  const resp = await phygitalsRequest<{
    result?: { session_id?: string; nfts?: PhygitalsPullItem[]; public_id?: string; tx_hash?: string };
    session_id?: string;
    nfts?: PhygitalsPullItem[];
    public_id?: string;
    tx_hash?: string;
  }>('POST', '/api/vm/buy/crypto', body);
  const inner = resp.result ?? resp;
  if (inner.nfts && inner.nfts.length > 0) {
    return {
      session_id: inner.session_id,
      nfts: inner.nfts,
      public_id: inner.public_id,
      tx_hash: inner.tx_hash,
    };
  }
  // Poll status until fulfilled or timeout.
  if (!inner.session_id) {
    throw new PhygitalsApiError(502, resp, 'Phygitals returned neither session_id nor inline NFTs');
  }
  const result = await pollBuyStatus(inner.session_id);
  return {
    session_id: inner.session_id,
    nfts: result.nfts,
    public_id: result.public_id,
    tx_hash: result.tx_hash,
  };
}

async function pollBuyStatus(sessionId: string): Promise<{
  nfts: PhygitalsPullItem[];
  public_id?: string;
  tx_hash?: string;
}> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const res = await phygitalsRequest<{
      result?: { nfts?: PhygitalsPullItem[]; public_id?: string; tx_hash?: string };
      status?: 'pending' | 'success' | 'failed';
      error?: string;
    }>('POST', '/api/vm/buy/status', { session_id: sessionId });
    if (res.result?.nfts?.length) {
      return {
        nfts: res.result.nfts,
        public_id: res.result.public_id,
        tx_hash: res.result.tx_hash,
      };
    }
    if (res.status === 'failed' || res.error) {
      throw new PhygitalsApiError(400, res, res.error ?? 'Phygitals transaction failed');
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new PhygitalsApiError(504, null, 'Phygitals buy polling timed out');
}

export async function initPhygitalsSellback(mintAddress: string): Promise<PhygitalsSellbackInit> {
  return phygitalsRequest<PhygitalsSellbackInit>(
    'POST',
    '/api/marketplace/transaction/take-claw-bid-init',
    { mint_address: mintAddress },
  );
}

export async function finishPhygitalsSellback(args: {
  session_id: string;
  signedTxBytes: Array<number[]>;
}): Promise<unknown> {
  return phygitalsRequest<unknown>(
    'POST',
    '/api/marketplace/transaction/take-claw-bid-finish',
    { session_id: args.session_id, txs: args.signedTxBytes },
  );
}
