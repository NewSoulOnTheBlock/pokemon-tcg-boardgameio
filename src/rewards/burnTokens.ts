// Browser-side helper for the $POKETCG burn-to-buy-pack flow on
// Robinhood Chain.
//
// Pons v2 launches a plain ERC-20 with no `burn()` entry point, so a burn
// here is an ordinary `transfer` to 0x…dEaD — an address with no known
// private key. The tokens are gone just as permanently as an SPL burn,
// they simply still count toward totalSupply. The server verifies the
// resulting Transfer event before rolling any cards, so a client that
// lies about what it sent gets nothing.
//
// Returns the transaction hash for /api/rewards/burn-pack to verify.

import { DEAD_ADDRESS, POKETCG_DECIMALS, POKETCG_TOKEN_ADDRESS, hasPoketcgToken } from '../chain/config';
import { encodeTransfer, fromRawUnits, toRawUnits } from '../chain/abi';
import { erc20BalanceOf, sendTransaction } from '../chain/evm';

// Pack-tier pricing — must match POKETCG_PACK_TIERS in
// src/server/tokenBurn.ts. The server validates the burned amount
// against the declared tier, so a client that fakes a different
// price/pack ratio fails server-side verification.
export interface PoketcgPackTier {
  packs: number;
  costTokens: number;
}
export const POKETCG_PACK_TIERS: readonly PoketcgPackTier[] = [
  { packs: 1, costTokens: 100_000 },
  { packs: 3, costTokens: 250_000 },
  { packs: 7, costTokens: 500_000 },
] as const;

export function findPoketcgTier(packs: number): PoketcgPackTier | undefined {
  return POKETCG_PACK_TIERS.find((t) => t.packs === packs);
}

function requireToken(): string {
  if (!hasPoketcgToken()) {
    throw new Error(
      '$POKETCG is not configured on this deployment. Set VITE_POKETCG_TOKEN_ADDRESS to the Pons-launched token address.',
    );
  }
  return POKETCG_TOKEN_ADDRESS;
}

/**
 * Send the tier's `costTokens` of $POKETCG to the burn address and wait
 * for the receipt. Returns the transaction hash.
 */
export async function burnPoketcgForPacks(args: {
  buyerWallet: string;
  packs: number;
}): Promise<string> {
  const tier = findPoketcgTier(args.packs);
  if (!tier) {
    throw new Error(`packs must be one of: ${POKETCG_PACK_TIERS.map((t) => t.packs).join(', ')}`);
  }
  const token = requireToken();

  const amount = toRawUnits(tier.costTokens, POKETCG_DECIMALS);
  const balance = await erc20BalanceOf(token, args.buyerWallet);
  if (balance < amount) {
    throw new Error(
      `Not enough $POKETCG: you hold ${fromRawUnits(balance, POKETCG_DECIMALS).toLocaleString('en-US')} but this tier costs ${tier.costTokens.toLocaleString('en-US')}.`,
    );
  }

  const receipt = await sendTransaction({
    from: args.buyerWallet,
    to: token,
    data: encodeTransfer(DEAD_ADDRESS, amount),
  });
  return receipt.transactionHash;
}

/** Current $POKETCG balance in whole tokens. Throws on RPC failure so the
 *  caller can surface the error rather than silently showing 0. */
export async function fetchPoketcgBalance(walletAddress: string): Promise<number> {
  const token = requireToken();
  return fromRawUnits(await erc20BalanceOf(token, walletAddress), POKETCG_DECIMALS);
}
