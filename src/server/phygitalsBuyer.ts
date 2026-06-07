// Server-side Phygitals buyer. Holds the API-key-bound wallet secret
// and executes the buy flow on behalf of the user after verifying the
// user paid the pack price (USDC) to our treasury.
//
// **Why this exists:** Phygitals' API key is bound to a specific
// wallet — only that wallet can sign /api/vm/buy/crypto txs. Users
// don't have the key, so we can't have them sign Phygitals' tx
// directly. Instead:
//
//   1. User signs a regular USDC transfer to TREASURY_PUBKEY for
//      pack.mint_price * amount
//   2. Server verifies that on-chain payment, then signs + submits
//      a Phygitals buy with the API wallet
//   3. NFTs land in the treasury wallet — we track ownership in
//      our own DB and surface them in the user's "My Pulls" tab
//
// Required env vars:
//   PHYGITALS_API_KEY                 phy_… key bound to the wallet
//   PHYGITALS_BUYER_SECRET_KEY        base58 secret key for the bound wallet
//   PHYGITALS_BASE_URL                defaults to https://api.phygitals.com
//                                     (set to the CORS-proxy Worker if the
//                                     server hits the WAF block; less critical
//                                     here than on the browser since this
//                                     runs server-side)
//   SOLANA_RPC_URL                    fast RPC for tx building + verification

import * as Token from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

const PHYGITALS_BASE_URL = (process.env.PHYGITALS_BASE_URL?.trim() || 'https://api.phygitals.com').replace(/\/$/, '');
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDT_MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
const CURRENCY_MINTS: Record<string, PublicKey> = {
  usdc: USDC_MINT,
  usdt: USDT_MINT,
};

const LOOKUP_TABLE_KEY = new PublicKey('H5yQkXsVg9X21MvngdhCvzavTR9FC1R22Rm5sx8BERyJ');

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

export class PhygitalsBuyerError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = 'PhygitalsBuyerError';
  }
}

export interface PhygitalsBuyerService {
  enabled: boolean;
  treasuryPubkey: string;
  /** Preflight: confirms Phygitals is reachable + the pack exists +
   *  is in stock, BEFORE asking the user to pay. */
  preflight(args: {
    packId: string;
    amount: number;
    currency?: 'usdc' | 'usdt';
  }): Promise<{ pack: { id: string; mint_price: number; rewards: Array<{ mint: string; amount: number }> }; expectedAmount: number; treasuryPubkey: string }>;
  /** Verify a user's USDC payment landed in our treasury and matches
   *  the expected pack price, then execute the Phygitals buy with the
   *  bound API wallet. Returns the pulled NFTs. Auto-refunds the user
   *  if the Phygitals call fails after their payment is verified. */
  buy(args: {
    buyerWallet: string;
    packId: string;
    amount: number;
    currency?: 'usdc' | 'usdt';
    paymentSignature: string;
  }): Promise<{ nfts: PhygitalsPullItem[]; sessionId?: string; publicId?: string; txHash?: string }>;
}

class DisabledPhygitalsBuyer implements PhygitalsBuyerService {
  enabled = false as const;
  treasuryPubkey = '';
  async preflight(): Promise<never> {
    throw new PhygitalsBuyerError(
      503,
      null,
      'Phygitals server-buy is not configured. Set PHYGITALS_API_KEY + PHYGITALS_BUYER_SECRET_KEY on the server.',
    );
  }
  async buy(): Promise<never> {
    throw new PhygitalsBuyerError(
      503,
      null,
      'Phygitals server-buy is not configured. Set PHYGITALS_API_KEY + PHYGITALS_BUYER_SECRET_KEY on the server.',
    );
  }
}

class RealPhygitalsBuyer implements PhygitalsBuyerService {
  enabled = true as const;
  treasuryPubkey: string;
  private apiKey: string;
  private treasury: Keypair;
  private connection: Connection;

  constructor(apiKey: string, secret: Uint8Array) {
    this.apiKey = apiKey;
    this.treasury = secret.length === 64 ? Keypair.fromSecretKey(secret) : Keypair.fromSeed(secret);
    this.treasuryPubkey = this.treasury.publicKey.toBase58();
    this.connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  }

  /** GET /api/vm/available so we can resolve packId + price + rewards. */
  private async fetchPacks(): Promise<Array<{
    id: string;
    slug: string;
    name?: string;
    enable?: boolean;
    in_stock?: boolean;
    mint_price?: number | string;
    max_per_mint?: number;
    rewards_mint_addresses?: string[];
    rewards_amounts?: Array<number | string>;
  }>> {
    const res = await fetch(`${PHYGITALS_BASE_URL}/api/vm/available`, {
      headers: { Accept: 'application/json', 'X-API-Key': this.apiKey },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PhygitalsBuyerError(res.status, text, `GET /api/vm/available failed (${res.status})`);
    }
    return res.json();
  }

  /** POST /api/orpc/config/signers/pubkeys */
  private async fetchSignerPubkeys(): Promise<{ solanaFeePayer: string; vmBuyback: string }> {
    const res = await fetch(`${PHYGITALS_BASE_URL}/api/orpc/config/signers/pubkeys`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PhygitalsBuyerError(res.status, text, `signer-pubkeys failed (${res.status})`);
    }
    const raw = (await res.json()) as { json?: { solanaFeePayer: string; vmBuyback: string }; solanaFeePayer?: string; vmBuyback?: string };
    const value = raw.json ?? (raw as { solanaFeePayer: string; vmBuyback: string });
    if (!value.solanaFeePayer || !value.vmBuyback) {
      throw new PhygitalsBuyerError(502, raw, 'signer-pubkeys response missing fields');
    }
    return value;
  }

  /** Verify the user-paid USDC tx exists on-chain, paid the expected
   *  amount to our treasury, and was sent from the claimed buyer
   *  wallet. Treats a non-finalized tx as "needs more time" and
   *  retries a few times. */
  private async verifyUserPayment(args: {
    paymentSignature: string;
    expectedSenderWallet: string;
    expectedAmount: number;
    paymentMint: PublicKey;
  }): Promise<void> {
    const senderAta = Token.getAssociatedTokenAddressSync(args.paymentMint, new PublicKey(args.expectedSenderWallet), false);
    const treasuryAta = Token.getAssociatedTokenAddressSync(args.paymentMint, this.treasury.publicKey, false);

    // Wait up to 30s for confirmation.
    const deadline = Date.now() + 30_000;
    let parsed = null;
    while (Date.now() < deadline) {
      parsed = await this.connection.getParsedTransaction(args.paymentSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (parsed) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!parsed) {
      throw new PhygitalsBuyerError(400, null, 'Payment signature not found on chain yet. Try again in a few seconds.');
    }
    if (parsed.meta?.err) {
      throw new PhygitalsBuyerError(400, parsed.meta.err, 'User payment tx failed on chain.');
    }

    // Scan the parsed instructions for a SPL token transfer matching
    // our expectations. We accept either an inner SplToken transfer
    // or a top-level one; some wallets wrap it inside the priority-fee
    // ComputeBudget setup.
    const ixs: Array<{ program?: string; programId?: { toString(): string }; parsed?: { type?: string; info?: { source?: string; destination?: string; mint?: string; amount?: string; tokenAmount?: { amount?: string; uiAmount?: number } } } }> = [];
    for (const ix of parsed.transaction.message.instructions ?? []) {
      ixs.push(ix as never);
    }
    for (const inner of parsed.meta?.innerInstructions ?? []) {
      for (const ix of inner.instructions ?? []) {
        ixs.push(ix as never);
      }
    }

    const matched = ixs.find((ix) => {
      const program = ix.program ?? '';
      const parsedInfo = ix.parsed;
      if (program !== 'spl-token' || !parsedInfo?.info) return false;
      if (parsedInfo.type !== 'transfer' && parsedInfo.type !== 'transferChecked') return false;
      const info = parsedInfo.info;
      if (info.source !== senderAta.toBase58()) return false;
      if (info.destination !== treasuryAta.toBase58()) return false;
      const amountRaw = info.amount ?? info.tokenAmount?.amount;
      if (!amountRaw) return false;
      return Number(amountRaw) >= args.expectedAmount;
    });

    if (!matched) {
      throw new PhygitalsBuyerError(
        402,
        { senderAta: senderAta.toBase58(), treasuryAta: treasuryAta.toBase58(), expectedAmount: args.expectedAmount },
        `Payment of ${args.expectedAmount / 1e6} ${args.paymentMint.equals(USDC_MINT) ? 'USDC' : 'USDT'} from ${args.expectedSenderWallet} to treasury not found in tx ${args.paymentSignature}.`,
      );
    }
  }

  /**
   * Pre-flight check before asking the user to pay. Verifies Phygitals
   * is reachable from the server AND the requested pack exists + is in
   * stock. Throws a PhygitalsBuyerError with the appropriate status
   * if anything's wrong, so the client knows NOT to ask the user for
   * a payment signature yet.
   */
  async preflight(args: {
    packId: string;
    amount: number;
    currency?: 'usdc' | 'usdt';
  }): Promise<{ pack: { id: string; mint_price: number; rewards: Array<{ mint: string; amount: number }> }; expectedAmount: number; treasuryPubkey: string }> {
    const currency = args.currency ?? 'usdc';
    const paymentMint = CURRENCY_MINTS[currency];
    if (!paymentMint) {
      throw new PhygitalsBuyerError(400, null, `Unsupported currency: ${currency}`);
    }
    const packs = await this.fetchPacks();
    const pack = packs.find((p) => p.id === args.packId || p.slug === args.packId);
    if (!pack) {
      throw new PhygitalsBuyerError(404, null, `Pack not found: ${args.packId}`);
    }
    if (pack.in_stock === false || pack.enable === false) {
      throw new PhygitalsBuyerError(400, null, 'Pack is out of stock');
    }
    const maxPerMint = Math.max(1, pack.max_per_mint ?? 10);
    if (!Number.isInteger(args.amount) || args.amount < 1 || args.amount > maxPerMint) {
      throw new PhygitalsBuyerError(400, null, `Amount must be between 1 and ${maxPerMint}`);
    }
    const mintPrice = Number(pack.mint_price ?? 0);
    const expectedAmount = args.amount * mintPrice * 1e6;
    return {
      pack: {
        id: pack.id,
        mint_price: mintPrice,
        rewards: (pack.rewards_mint_addresses ?? []).map((mint, i) => ({
          mint,
          amount: Number(pack.rewards_amounts?.[i] ?? 0),
        })),
      },
      expectedAmount,
      treasuryPubkey: this.treasuryPubkey,
    };
  }

  /**
   * Refund a user payment by sending the same USDC amount back to
   * their wallet. Called automatically when the Phygitals buy fails
   * after we've already confirmed the user paid.
   */
  private async refundUser(args: {
    buyerWallet: string;
    paymentMint: PublicKey;
    amount: number;
    reason: string;
  }): Promise<string | null> {
    try {
      const buyer = new PublicKey(args.buyerWallet);
      const buyerAta = Token.getAssociatedTokenAddressSync(args.paymentMint, buyer, false);
      const treasuryAta = Token.getAssociatedTokenAddressSync(args.paymentMint, this.treasury.publicKey, false);
      const refundIx = Token.createTransferInstruction(treasuryAta, buyerAta, this.treasury.publicKey, args.amount);
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: this.treasury.publicKey,
          recentBlockhash: blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200 }),
            refundIx,
          ],
        }).compileToV0Message(),
      );
      tx.sign([this.treasury]);
      const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      console.error(`[phygitals-buyer] refunded ${args.amount / 1e6} ${args.paymentMint.equals(USDC_MINT) ? 'USDC' : 'USDT'} to ${args.buyerWallet} (reason: ${args.reason}) sig=${sig}`);
      return sig;
    } catch (err) {
      console.error(`[phygitals-buyer] REFUND FAILED for ${args.buyerWallet}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async buy(args: {
    buyerWallet: string;
    packId: string;
    amount: number;
    currency?: 'usdc' | 'usdt';
    paymentSignature: string;
  }): Promise<{ nfts: PhygitalsPullItem[]; sessionId?: string; publicId?: string; txHash?: string }> {
    const currency = args.currency ?? 'usdc';
    const paymentMint = CURRENCY_MINTS[currency];
    if (!paymentMint) {
      throw new PhygitalsBuyerError(400, null, `Unsupported currency: ${currency}`);
    }

    // Step 0: re-fetch packs + signer pubkeys. We already preflight-
    // checked the catalog before the user paid, but Phygitals can
    // de-list a pack between the preflight and now. Re-checking
    // protects against that race.
    const [packs, pubkeys] = await Promise.all([this.fetchPacks(), this.fetchSignerPubkeys()]);
    const pack = packs.find((p) => p.id === args.packId || p.slug === args.packId);
    if (!pack) {
      throw new PhygitalsBuyerError(404, null, `Pack not found: ${args.packId}`);
    }
    if (pack.in_stock === false || pack.enable === false) {
      throw new PhygitalsBuyerError(400, null, 'Pack is out of stock');
    }
    const maxPerMint = Math.max(1, pack.max_per_mint ?? 10);
    if (!Number.isInteger(args.amount) || args.amount < 1 || args.amount > maxPerMint) {
      throw new PhygitalsBuyerError(400, null, `Amount must be between 1 and ${maxPerMint}`);
    }

    const mintPrice = Number(pack.mint_price ?? 0);
    const expectedAmount = args.amount * mintPrice * 1e6;

    // Step 1: verify the user paid us first.
    await this.verifyUserPayment({
      paymentSignature: args.paymentSignature,
      expectedSenderWallet: args.buyerWallet,
      expectedAmount,
      paymentMint,
    });

    // From this point on, the user has paid. Any failure must trigger
    // a refund so we don't strand their money.
    try {
      return await this.executePhygitalsBuy({
        pack,
        pubkeys,
        amount: args.amount,
        currency,
        paymentMint,
        expectedAmount,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[phygitals-buyer] post-payment buy failed, refunding ${args.buyerWallet}: ${reason}`);
      const refundSig = await this.refundUser({
        buyerWallet: args.buyerWallet,
        paymentMint,
        amount: expectedAmount,
        reason,
      });
      if (err instanceof PhygitalsBuyerError) {
        throw new PhygitalsBuyerError(
          err.status,
          { ...((err.body as object) ?? {}), refunded: Boolean(refundSig), refundSignature: refundSig },
          `${err.message} — your USDC has been ${refundSig ? 'refunded' : 'flagged for manual refund'}.`,
        );
      }
      throw new PhygitalsBuyerError(
        502,
        { refunded: Boolean(refundSig), refundSignature: refundSig },
        `Phygitals buy failed (${reason}) — your USDC has been ${refundSig ? 'refunded' : 'flagged for manual refund'}.`,
      );
    }
  }

  /**
   * The actual Phygitals buy + poll. Only called after we've verified
   * the user paid us. Wrapped by buy() so any failure here triggers
   * the auto-refund.
   */
  private async executePhygitalsBuy(args: {
    pack: { id: string; mint_price?: number | string; rewards_mint_addresses?: string[]; rewards_amounts?: Array<number | string> };
    pubkeys: { solanaFeePayer: string; vmBuyback: string };
    amount: number;
    currency: 'usdc' | 'usdt';
    paymentMint: PublicKey;
    expectedAmount: number;
  }): Promise<{ nfts: PhygitalsPullItem[]; sessionId?: string; publicId?: string; txHash?: string }> {
    const { pack, pubkeys, amount, currency, paymentMint, expectedAmount } = args;
    const buyer = this.treasury.publicKey;
    const feePayerPk = new PublicKey(pubkeys.solanaFeePayer);
    const vmBuybackPk = new PublicKey(pubkeys.vmBuyback);
    const paymentReceiver = pack.id.includes('fwog')
      ? new PublicKey('H7Tou5HugVHFyJYZ3wfxJGfruYN47Xjjc6xQhjzwySUz')
      : pack.id.includes('gboy')
        ? new PublicKey('DQ1LJZ2ET1oHcCgojCN3kXakTQSkuCxgEqXguf2UrYS5')
        : vmBuybackPk;

    // Use canonical ATAs throughout (matches what Phygitals' backend
    // derives). The treasury wallet must already hold USDC/USDT for
    // the buy to succeed.
    const senderAta = Token.getAssociatedTokenAddressSync(paymentMint, buyer, false);
    const receiverAta = Token.getAssociatedTokenAddressSync(paymentMint, paymentReceiver, false);

    const paymentIx = Token.createTransferInstruction(senderAta, receiverAta, buyer, expectedAmount);

    const rewards = (pack.rewards_mint_addresses ?? []).map((mint, i) => ({
      mint,
      amount: Number(pack.rewards_amounts?.[i] ?? 0),
    }));
    const rewardsIxs = rewards.flatMap((reward) => {
      const mintPublicKey = new PublicKey(reward.mint);
      const destAta = Token.getAssociatedTokenAddressSync(mintPublicKey, buyer, false);
      const sourceAta = Token.getAssociatedTokenAddressSync(mintPublicKey, vmBuybackPk, false);
      return [
        Token.createAssociatedTokenAccountIdempotentInstruction(feePayerPk, destAta, buyer, mintPublicKey),
        Token.createTransferInstruction(sourceAta, destAta, vmBuybackPk, reward.amount * amount),
      ];
    });

    const liveLookupTable = await this.connection
      .getAddressLookupTable(LOOKUP_TABLE_KEY)
      .then((r) => r.value)
      .catch(() => null);

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const ixs = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200 }),
      paymentIx,
      ...rewardsIxs,
    ];
    const message = new TransactionMessage({
      payerKey: feePayerPk,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(liveLookupTable ? [liveLookupTable] : []);
    const tx = new VersionedTransaction(message);
    tx.sign([this.treasury]);

    // Step 3: submit to Phygitals' /api/vm/buy/crypto.
    const submitRes = await fetch(`${PHYGITALS_BASE_URL}/api/vm/buy/crypto`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-Key': this.apiKey,
      },
      body: JSON.stringify({
        txs: [Array.from(tx.serialize())],
        claw_id: pack.id,
        amount,
        currency,
        chain: 'solana',
      }),
    });
    const submitText = await submitRes.text();
    let submitParsed: { result?: { session_id?: string; nfts?: PhygitalsPullItem[]; public_id?: string; tx_hash?: string }; session_id?: string; nfts?: PhygitalsPullItem[]; public_id?: string; tx_hash?: string; error?: string } = {};
    try { submitParsed = JSON.parse(submitText); }
    catch { /* keep as-is */ }
    if (!submitRes.ok) {
      throw new PhygitalsBuyerError(submitRes.status, submitParsed, submitParsed.error ?? `Phygitals buy/crypto failed (${submitRes.status})`);
    }
    const inner = submitParsed.result ?? submitParsed;

    // Step 4: poll status if not fulfilled inline.
    if (inner.nfts?.length) {
      return {
        nfts: inner.nfts,
        sessionId: inner.session_id,
        publicId: inner.public_id,
        txHash: inner.tx_hash,
      };
    }
    if (!inner.session_id) {
      throw new PhygitalsBuyerError(502, submitParsed, 'Phygitals returned neither nfts nor session_id');
    }

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const statusRes = await fetch(`${PHYGITALS_BASE_URL}/api/vm/buy/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify({ session_id: inner.session_id }),
      });
      const statusText = await statusRes.text();
      const statusParsed = JSON.parse(statusText) as { result?: { nfts?: PhygitalsPullItem[]; public_id?: string; tx_hash?: string }; status?: string; error?: string };
      if (statusParsed.result?.nfts?.length) {
        return {
          nfts: statusParsed.result.nfts,
          sessionId: inner.session_id,
          publicId: statusParsed.result.public_id,
          txHash: statusParsed.result.tx_hash,
        };
      }
      if (statusParsed.status === 'failed' || statusParsed.error) {
        throw new PhygitalsBuyerError(400, statusParsed, statusParsed.error ?? 'Phygitals tx failed');
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new PhygitalsBuyerError(504, null, 'Phygitals buy polling timed out');
  }
}

export function createPhygitalsBuyer(): PhygitalsBuyerService {
  const apiKey = process.env.PHYGITALS_API_KEY?.trim();
  const secretBase58 = process.env.PHYGITALS_BUYER_SECRET_KEY?.trim();
  if (!apiKey || !secretBase58) {
    return new DisabledPhygitalsBuyer();
  }
  try {
    const secret = bs58.decode(secretBase58);
    return new RealPhygitalsBuyer(apiKey, secret);
  } catch (err) {
    console.error('[phygitals-buyer] failed to init:', err instanceof Error ? err.message : err);
    return new DisabledPhygitalsBuyer();
  }
}
