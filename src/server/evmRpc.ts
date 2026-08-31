// Minimal server-side JSON-RPC client for Robinhood Chain.
//
// Reads only — no keys, no signing. Node 20 ships a global `fetch`, so
// this needs no dependency at all. Anything that has to sign (the NFT
// minter) uses ethers instead; see src/server/nftMinter.ts.

import { RHC_RPC_URL } from '../chain/config';
import { decodeUint256, encodeBalanceOf } from '../chain/abi';

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

export interface EvmReceipt {
  transactionHash: string;
  /** '0x1' success, '0x0' reverted. */
  status: string;
  blockNumber: string;
  from: string;
  to: string | null;
  logs: EvmLog[];
}

export interface EvmTransaction {
  hash: string;
  from: string;
  to: string | null;
  /** Hex wei. */
  value: string;
  input: string;
}

let rpcId = 0;

export async function rpcCall<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(RHC_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params }),
  });
  if (!response.ok) {
    throw new Error(`Robinhood Chain RPC ${method} failed: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as { result?: T; error?: { message?: string } };
  if (json.error) {
    throw new Error(`Robinhood Chain RPC ${method} error: ${json.error.message ?? 'unknown'}`);
  }
  return json.result as T;
}

export function ethCall(to: string, data: string): Promise<string> {
  return rpcCall<string>('eth_call', [{ to, data }, 'latest']);
}

export async function erc20BalanceOf(token: string, owner: string): Promise<bigint> {
  return decodeUint256(await ethCall(token, encodeBalanceOf(owner)));
}

/**
 * Fetch a receipt, retrying while the transaction is still propagating.
 * A wallet hands the client a hash the moment it broadcasts, and the
 * client posts it to us immediately — so a first lookup returning null
 * is the normal case, not an error.
 */
export async function getReceipt(hash: string, timeoutMs = 30_000): Promise<EvmReceipt | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await rpcCall<EvmReceipt | null>('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

export function getTransaction(hash: string): Promise<EvmTransaction | null> {
  return rpcCall<EvmTransaction | null>('eth_getTransactionByHash', [hash]);
}

export function isTxHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}
