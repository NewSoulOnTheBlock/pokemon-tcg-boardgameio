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
  /** Live VersionedTransaction instance — sign directly with the wallet
   *  to avoid base64 round-tripping (which can shift bytes and cause
   *  Phygitals' fingerprint check to fail). */
  tx: unknown;
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
  // Verbatim port of buildEbayClawPurchaseTx from the Phygitals
  // reference partner script (buy-with-crypto-v6.ts). Any structural
  // deviation breaks their tx-fingerprint check, so don't "optimize"
  // anything here — match their script line for line.
  const currency = args.currency ?? 'usdc';
  const [{
    PublicKey, Connection, TransactionMessage, VersionedTransaction,
    ComputeBudgetProgram,
  }, Token] = await Promise.all([
    import('@solana/web3.js'),
    import('@solana/spl-token'),
  ]);

  const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const USDT_MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
  const paymentMint = currency === 'usdc' ? USDC_MINT : USDT_MINT;

  // Phygitals' partner ALT — fetched live from RPC each buy (see below).
  // The hardcoded snapshot mirrored from the reference v6 script went
  // stale; using a live fetch guarantees our compiled v0 message uses
  // the same ALT state Phygitals' backend uses to reconstruct + hash
  // the canonical tx.
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
  // Reference uses `pack.mint_price` raw (it's coerced by JS multiply).
  // Phygitals' /api/vm/available returns mint_price as a STRING ("25")
  // for most packs; `1 * "25" * 1e6` evaluates to 25_000_000 either way.
  const priceInToken = args.amount * (pack.mint_price as unknown as number) * 1e6;
  const feePayerPk = new PublicKey(pubkeys.solanaFeePayer);
  const vmBuybackPk = new PublicKey(pubkeys.vmBuyback);

  // Per-pack payment receiver overrides. Mirrors the reference script.
  const paymentReceiver = pack.id.includes('fwog')
    ? 'H7Tou5HugVHFyJYZ3wfxJGfruYN47Xjjc6xQhjzwySUz'
    : pack.id.includes('gboy')
      ? 'DQ1LJZ2ET1oHcCgojCN3kXakTQSkuCxgEqXguf2UrYS5'
      : pubkeys.vmBuyback;

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  // Item #4 in the audit: ALT changed. Fetch the LIVE ALT from RPC
  // every buy. The hardcoded snapshot at the top of this file went
  // stale as Phygitals extended their on-chain ALT (more addresses
  // added), causing our compiled v0 message to differ from what
  // Phygitals' backend reconstructs. Fall back to no-ALT compile if
  // the RPC lookup fails for any reason.
  const liveLookupTable = await connection
    .getAddressLookupTable(LOOKUP_TABLE_KEY)
    .then((r) => r.value)
    .catch(() => null);

  // RPC token-account lookup (reference uses this for BOTH sides).
  async function getTokenAccountForMint(owner: string, mint: InstanceType<typeof PublicKey>): Promise<InstanceType<typeof PublicKey>> {
    const ownerPk = new PublicKey(owner);
    const accounts = await connection.getParsedTokenAccountsByOwner(ownerPk, { mint });
    if (accounts.value.length === 0) {
      throw new PhygitalsApiError(
        400,
        null,
        `Wallet ${owner} has no token account for mint ${mint.toBase58()}`,
      );
    }
    return accounts.value[0]!.pubkey;
  }

  const [senderTokenAccount, receiverTokenAccount] = await Promise.all([
    getTokenAccountForMint(args.buyerWallet, paymentMint),
    getTokenAccountForMint(paymentReceiver, paymentMint),
  ]);

  const rewards = (pack.rewards_mint_addresses ?? []).map((mint, i) => ({
    mint,
    amount: Number(pack.rewards_amounts?.[i] ?? 0),
  }));

  // Match the reference's Promise.all pattern: paymentIx first, then
  // each rewards group in array order.
  const [paymentIx, ...rewardsTransferIxGroups] = await Promise.all([
    (async () =>
      Token.createTransferInstruction(senderTokenAccount, receiverTokenAccount, buyer, priceInToken))(),
    ...rewards.map(async (reward) => {
      const mintPublicKey = new PublicKey(reward.mint);
      const destAta = Token.getAssociatedTokenAddressSync(mintPublicKey, buyer, false);
      const createDestAtaIx = Token.createAssociatedTokenAccountIdempotentInstruction(
        feePayerPk,
        destAta,
        buyer,
        mintPublicKey,
      );
      const transferIx = Token.createTransferInstruction(
        await getTokenAccountForMint(pubkeys.vmBuyback, mintPublicKey),
        destAta,
        vmBuybackPk,
        reward.amount * args.amount,
      );
      return [createDestAtaIx, transferIx];
    }),
  ]);

  // Item #6 in the audit: priority fee + compute-unit limit must be
  // included BEFORE fingerprinting/signing. Both ixs at the very front
  // of the instruction list so they're locked into the message before
  // any other byte gets serialized.
  const setComputeUnitLimit = ComputeBudgetProgram.setComputeUnitLimit({
    units: 400_000,
  });
  const setComputeUnitPrice = ComputeBudgetProgram.setComputeUnitPrice({
    // Fixed value, NOT random — random microLamports means consecutive
    // fingerprints differ on every attempt, which would mask whether
    // we're actually fixing the underlying mismatch.
    microLamports: 200,
  });
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  type Ix = ReturnType<typeof Token.createTransferInstruction>;
  const allIxs: Ix[] = [
    setComputeUnitLimit as unknown as Ix,
    setComputeUnitPrice as unknown as Ix,
    paymentIx as Ix,
    ...((rewardsTransferIxGroups as unknown[]).flat() as Ix[]),
  ];
  const message = new TransactionMessage({
    payerKey: buyer,
    recentBlockhash: blockhash,
    instructions: allIxs,
  }).compileToV0Message(liveLookupTable ? [liveLookupTable] : []);
  const tx = new VersionedTransaction(message);

  // Debug logger — capture the canonical fingerprint of the freshly
  // built unsigned tx so we can compare against what the wallet sees
  // post-sign. Only logs to console; safe to leave in production.
  try {
    const unsignedBytes = tx.serialize();
    const hash = await crypto.subtle.digest('SHA-1', unsignedBytes.buffer.slice(unsignedBytes.byteOffset, unsignedBytes.byteOffset + unsignedBytes.byteLength) as ArrayBuffer);
    const hex = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
    console.log('[phygitals] unsigned-tx SHA-1:', hex, 'len:', unsignedBytes.length);
  } catch {
    /* ignore */
  }

  return {
    packId: pack.id,
    amount: args.amount,
    currency,
    priceInToken,
    tx,
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

// ============================================================================
// Two-step server-buy flow (used when the Phygitals API key is bound to
// a specific wallet — the API wallet must sign every buy, so the user
// can't sign Phygitals' tx directly).
//
// Step 1: user signs a USDC transfer to OUR treasury wallet for the
//         pack price. Browser sends the resulting on-chain signature
//         to our server.
// Step 2: server verifies the on-chain payment, then signs +
//         submits a Phygitals buy with the API wallet, and returns
//         the pulled NFTs.
// ============================================================================

import { apiUrl } from './server';

export interface PhygitalsBuyerStatus {
  enabled: boolean;
  treasuryPubkey: string;
}

export async function fetchPhygitalsBuyerStatus(): Promise<PhygitalsBuyerStatus> {
  const res = await fetch(apiUrl('/api/phygitals-buyer/status'));
  if (!res.ok) {
    throw new PhygitalsApiError(res.status, null, `phygitals-buyer status failed (${res.status})`);
  }
  return res.json();
}

/**
 * Preflight: verifies Phygitals is reachable from our server + the
 * pack is in stock. MUST be called before payTreasuryUsdc — if this
 * 5xxs we know the user shouldn't pay anything yet.
 */
export async function preflightPhygitalsBuy(args: {
  packId: string;
  amount: number;
  currency?: 'usdc' | 'usdt';
}): Promise<{ pack: { id: string; mint_price: number }; expectedAmount: number; treasuryPubkey: string }> {
  const res = await fetch(apiUrl('/api/phygitals-buyer/preflight'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); }
    catch { parsed = text; }
  }
  if (!res.ok) {
    const msg = (parsed && typeof parsed === 'object' && 'error' in parsed)
      ? String((parsed as { error: unknown }).error)
      : `Preflight failed (${res.status})`;
    throw new PhygitalsApiError(res.status, parsed, msg);
  }
  return parsed as { pack: { id: string; mint_price: number }; expectedAmount: number; treasuryPubkey: string };
}

/**
 * Build + sign the USDC transfer the user pays to the treasury wallet.
 * Returns the on-chain signature; pass it to serverBuyPhygitalsPack().
 */
export async function payTreasuryUsdc(args: {
  buyerWallet: string;
  treasuryWallet: string;
  amount: number;        // pack count (used to compute USDC subtotal)
  unitPriceUsd: number;  // pack.mint_price as a number
  currency?: 'usdc' | 'usdt';
}): Promise<string> {
  const currency = args.currency ?? 'usdc';
  const [{ PublicKey, Connection, Transaction }, Token] = await Promise.all([
    import('@solana/web3.js'),
    import('@solana/spl-token'),
  ]);
  const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const USDT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
  const mint = currency === 'usdc' ? USDC : USDT;
  const buyer = new PublicKey(args.buyerWallet);
  const treasury = new PublicKey(args.treasuryWallet);

  const senderAta = Token.getAssociatedTokenAddressSync(mint, buyer, false);
  const treasuryAta = Token.getAssociatedTokenAddressSync(mint, treasury, false);

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  // Create the treasury ATA idempotently in case it doesn't exist yet
  // (only fires once per currency per treasury). Buyer pays the rent.
  const treasuryAtaInfo = await connection.getAccountInfo(treasuryAta);
  const ixs = [];
  if (!treasuryAtaInfo) {
    ixs.push(
      Token.createAssociatedTokenAccountIdempotentInstruction(buyer, treasuryAta, treasury, mint),
    );
  }
  const amountInToken = Math.round(args.amount * args.unitPriceUsd * 1e6);
  ixs.push(Token.createTransferInstruction(senderAta, treasuryAta, buyer, amountInToken));

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: buyer, recentBlockhash: blockhash }).add(...ixs);

  // Ask the wallet to sign + send.
  const { signAndSendBase64Transaction } = await import('../walletPayment');
  const transactionBase64 = btoa(
    Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }))
      .map((b) => String.fromCharCode(b))
      .join(''),
  );
  return signAndSendBase64Transaction({
    payerAddress: args.buyerWallet,
    rpcUrl: SOLANA_RPC_URL,
    transactionBase64,
  });
}

export interface ServerBuyResult {
  nfts: PhygitalsPullItem[];
  sessionId?: string;
  publicId?: string;
  txHash?: string;
}

export async function serverBuyPhygitalsPack(args: {
  buyerWallet: string;
  packId: string;
  amount: number;
  currency?: 'usdc' | 'usdt';
  paymentSignature: string;
}): Promise<ServerBuyResult> {
  const res = await fetch(apiUrl('/api/phygitals-buyer/buy'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); }
    catch { parsed = text; }
  }
  if (!res.ok) {
    const msg = (parsed && typeof parsed === 'object' && 'error' in parsed)
      ? String((parsed as { error: unknown }).error)
      : `server-buy failed (${res.status})`;
    throw new PhygitalsApiError(res.status, parsed, msg);
  }
  return parsed as ServerBuyResult;
}
