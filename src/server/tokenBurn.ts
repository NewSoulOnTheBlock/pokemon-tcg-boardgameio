// Server-side verifier for the $POKE burn-to-buy-pack flow.
//
// The browser sends an ERC-20 `transfer` of the tier's cost to 0x…dEaD
// and posts back the transaction hash. We re-read that transaction from
// chain here BEFORE rolling a pack, so a forged or replayed hash can't
// trick the server into giving away free cards.
//
// What gets checked, in order:
//   1. The receipt exists and the transaction succeeded (status 0x1).
//   2. It was sent by the wallet claiming the packs.
//   3. It contains Transfer log(s) on the $POKE contract, from that
//      wallet, to the burn address, totalling at least the tier cost.
//
// Note on amounts: an 18-decimal token at 100 000 whole units is 1e23 raw,
// well past Number.MAX_SAFE_INTEGER — every raw amount in this module is a
// bigint, and only the display value is ever converted to a number.

import { DEAD_ADDRESS, POKETCG_DECIMALS, POKETCG_TOKEN_ADDRESS, hasPoketcgToken } from '../chain/config';
import { TOPIC_TRANSFER, decodeAddressTopic, decodeUint256, fromRawUnits, toRawUnits } from '../chain/abi';
import { getReceipt } from './evmRpc';

export { POKETCG_DECIMALS, POKETCG_TOKEN_ADDRESS, hasPoketcgToken };

// Pack-tier pricing. Tiers are NOT linear — buying multiple packs at once
// is discounted to encourage larger burns. The client picks one of these
// tiers; the server validates the burned amount against the declared tier
// so a forged "I burned 100k for 7 packs" request fails.
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

/** Raw-unit cost of a tier, as a bigint. */
export function rawCostForTier(tier: PoketcgPackTier): bigint {
  return toRawUnits(tier.costTokens, POKETCG_DECIMALS);
}

export class PoketcgBurnError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'PoketcgBurnError';
  }
}

/**
 * Verify a $POKE burn transaction was authored by `buyerWallet`, moved
 * the right token to the burn address, and cleared at least
 * `minRawAmount`. Returns the amount actually burned so the caller can
 * decide how many packs to award. Throws PoketcgBurnError on any failure.
 */
export async function verifyPoketcgBurn(args: {
  /** Transaction hash of the burn. */
  txHash: string;
  buyerWallet: string;
  /** Minimum acceptable burn in raw token units. */
  minRawAmount: bigint;
}): Promise<{ rawAmount: bigint; uiAmount: number }> {
  if (!hasPoketcgToken()) {
    throw new PoketcgBurnError(503, '$POKE is not configured on this server (set POKETCG_TOKEN_ADDRESS).');
  }

  const receipt = await getReceipt(args.txHash);
  if (!receipt) {
    throw new PoketcgBurnError(400, 'Burn transaction not yet on chain. Try again in a few seconds.');
  }
  if (receipt.status !== '0x1') {
    throw new PoketcgBurnError(400, `Burn transaction reverted on chain: ${args.txHash}`);
  }

  const buyer = args.buyerWallet.toLowerCase();
  if (receipt.from?.toLowerCase() !== buyer) {
    throw new PoketcgBurnError(
      403,
      `Burn transaction was sent by ${receipt.from} but the claim is from ${args.buyerWallet}.`,
    );
  }

  let totalRaw = 0n;
  for (const log of receipt.logs ?? []) {
    if (log.address?.toLowerCase() !== POKETCG_TOKEN_ADDRESS) continue;
    if (log.topics?.[0]?.toLowerCase() !== TOPIC_TRANSFER) continue;
    // Transfer(address indexed from, address indexed to, uint256 value):
    // both addresses are indexed, so the amount is the whole data word.
    if (log.topics.length < 3) continue;
    if (decodeAddressTopic(log.topics[1]) !== buyer) continue;
    if (decodeAddressTopic(log.topics[2]) !== DEAD_ADDRESS) continue;
    totalRaw += decodeUint256(log.data);
  }

  if (totalRaw === 0n) {
    throw new PoketcgBurnError(
      402,
      `No $POKE burn found from ${buyer} to ${DEAD_ADDRESS} in transaction ${args.txHash}.`,
    );
  }
  if (totalRaw < args.minRawAmount) {
    throw new PoketcgBurnError(
      402,
      `Burned ${fromRawUnits(totalRaw, POKETCG_DECIMALS).toLocaleString('en-US')} $POKE, below the required ${fromRawUnits(args.minRawAmount, POKETCG_DECIMALS).toLocaleString('en-US')}.`,
    );
  }

  return { rawAmount: totalRaw, uiAmount: fromRawUnits(totalRaw, POKETCG_DECIMALS) };
}
