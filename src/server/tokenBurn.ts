// Server-side verifier for the $POKETCG burn-to-buy-pack flow.
//
// The browser builds a Solana transaction containing a single
// `spl-token burn` instruction that destroys POKETCG_BURN_AMOUNT tokens
// from the user's $POKETCG associated token account, then asks the
// connected wallet to sign + submit it. We verify the resulting
// signature here BEFORE rolling a pack, so a bad/forged signature
// can't trick the server into giving free cards.

import { Connection, PublicKey } from '@solana/web3.js';

// Pump.fun-launched $POKETCG token mint. Mirrors the constant in
// src/game/types.ts (kept duplicated here so the server module
// doesn't pull in client-only game types).
export const POKETCG_TOKEN_MINT = 'N9Curnf2ZQWBZWrjBkzP6xBe6n5WRhBhouRfiSqpump';
// pump.fun tokens are 6-decimal mints, same as USDC/USDT.
export const POKETCG_DECIMALS = 6;
// 250,000 tokens per pack, in raw token units.
export const POKETCG_PACK_PRICE_RAW = 250_000 * 10 ** POKETCG_DECIMALS;

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';

export class PoketcgBurnError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'PoketcgBurnError';
  }
}

let cachedConnection: Connection | undefined;
function getConnection(): Connection {
  if (!cachedConnection) cachedConnection = new Connection(SOLANA_RPC_URL, 'confirmed');
  return cachedConnection;
}

interface ParsedBurnIx {
  parsed: {
    type: string;
    info: {
      account?: string;
      mint?: string;
      authority?: string;
      multisigAuthority?: string;
      amount?: string;
      tokenAmount?: { amount?: string; decimals?: number };
    };
  };
  program?: string;
  programId?: { toString(): string };
}

/** Verify a $POKETCG burn-tx signature was produced by `buyerWallet`,
 *  burned the right mint at the right amount, and is finalized
 *  on-chain. Returns the actual amount of $POKETCG burned (in raw
 *  token units) so the caller can decide how many packs to award.
 *  Throws PoketcgBurnError on any failure. */
export async function verifyPoketcgBurn(args: {
  signature: string;
  buyerWallet: string;
  /** Minimum acceptable burn amount in raw token units. */
  minRawAmount: number;
}): Promise<{ rawAmount: number; uiAmount: number }> {
  const connection = getConnection();
  // Wait up to 30s for the tx to land + finalize. Wallets sometimes
  // return a sig before the cluster's confirmed slot has caught up.
  const deadline = Date.now() + 30_000;
  let parsed: Awaited<ReturnType<Connection['getParsedTransaction']>> = null;
  while (Date.now() < deadline) {
    parsed = await connection.getParsedTransaction(args.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (parsed) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!parsed) {
    throw new PoketcgBurnError(400, 'Burn signature not yet on chain. Try again in a few seconds.');
  }
  if (parsed.meta?.err) {
    throw new PoketcgBurnError(400, `Burn tx failed on chain: ${JSON.stringify(parsed.meta.err)}`);
  }

  // Walk every instruction (top-level + inner) looking for a burn / burnChecked
  // ix on the SPL Token program targeting our mint.
  const ixs: ParsedBurnIx[] = [];
  for (const ix of parsed.transaction.message.instructions ?? []) ixs.push(ix as ParsedBurnIx);
  for (const inner of parsed.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions ?? []) ixs.push(ix as ParsedBurnIx);
  }

  const buyerOwner = new PublicKey(args.buyerWallet).toBase58();
  let totalRaw = 0;
  for (const ix of ixs) {
    const program = ix.program ?? '';
    if (program !== 'spl-token') continue;
    const parsed = ix.parsed;
    if (!parsed?.info) continue;
    if (parsed.type !== 'burn' && parsed.type !== 'burnChecked') continue;
    if (parsed.info.mint !== POKETCG_TOKEN_MINT) continue;
    // Authority on a single-signer burn ix is the wallet that owns the
    // burning ATA. Reject if it doesn't match the claimed buyer.
    const authority = parsed.info.authority ?? parsed.info.multisigAuthority;
    if (authority !== buyerOwner) continue;
    const raw = parsed.info.amount ?? parsed.info.tokenAmount?.amount;
    if (!raw) continue;
    totalRaw += Number(raw);
  }

  if (totalRaw === 0) {
    throw new PoketcgBurnError(
      402,
      `No $POKETCG burn instruction found from ${buyerOwner} for mint ${POKETCG_TOKEN_MINT} in tx ${args.signature}.`,
    );
  }
  if (totalRaw < args.minRawAmount) {
    throw new PoketcgBurnError(
      402,
      `Burn amount ${totalRaw} below required ${args.minRawAmount} ($POKETCG raw units).`,
    );
  }
  return { rawAmount: totalRaw, uiAmount: totalRaw / 10 ** POKETCG_DECIMALS };
}
