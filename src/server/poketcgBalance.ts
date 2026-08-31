// Server-side $POKETCG balance helper for the Champions Row eligibility
// scan. One `balanceOf` eth_call per candidate wallet on Robinhood Chain.

import { POKETCG_DECIMALS, POKETCG_TOKEN_ADDRESS, hasPoketcgToken } from '../chain/config';
import { fromRawUnits } from '../chain/abi';
import { erc20BalanceOf } from './evmRpc';

export { POKETCG_TOKEN_ADDRESS, hasPoketcgToken };

/** $POKETCG held by this wallet, in whole tokens. Returns 0 (rather than
 *  throwing) on RPC failure or when no token is configured — the
 *  eligibility scan treats that as "not eligible" for this round instead
 *  of failing the whole draw. */
export async function fetchPoketcgBalance(walletAddress: string): Promise<number> {
  if (!hasPoketcgToken()) return 0;
  try {
    const raw = await erc20BalanceOf(POKETCG_TOKEN_ADDRESS, walletAddress);
    return fromRawUnits(raw, POKETCG_DECIMALS);
  } catch {
    return 0;
  }
}
