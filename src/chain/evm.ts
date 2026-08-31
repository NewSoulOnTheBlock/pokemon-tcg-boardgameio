// Browser-side Robinhood Chain access.
//
// Two distinct paths on purpose:
//   * READS go straight to the public RPC over `fetch`. They work before a
//     wallet is connected and never pop a wallet prompt, so balance panels
//     can render for any address.
//   * WRITES go through the injected EIP-1193 provider, which is the only
//     thing holding the user's key. We never build, sign, or relay a
//     transaction ourselves — the wallet does all three.
//
// Every write first calls `ensureRobinhoodChain()`. Sending a transaction
// while the wallet sits on another network would broadcast it there, which
// for a `transfer` to the burn address means real tokens destroyed on the
// wrong chain.

import { RHC_CHAIN_ID_HEX, RHC_CHAIN_PARAMS, RHC_RPC_URL } from './config';
import { decodeUint256, encodeBalanceOf } from './abi';

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  providers?: Eip1193Provider[];
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainError';
  }
}

export function hasEvmWallet(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ethereum);
}

export function evmProvider(): Eip1193Provider {
  const provider = typeof window !== 'undefined' ? window.ethereum : undefined;
  if (!provider) {
    throw new ChainError('No EVM wallet detected. Install MetaMask, Rabby, or Coinbase Wallet.');
  }
  return provider;
}

// ----- reads (public RPC, no wallet needed) -------------------------------

let rpcId = 0;

export async function rpcCall<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(RHC_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params }),
  });
  if (!response.ok) {
    throw new ChainError(`Robinhood Chain RPC ${method} failed: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as { result?: T; error?: { message?: string } };
  if (json.error) {
    throw new ChainError(`Robinhood Chain RPC ${method} error: ${json.error.message ?? 'unknown'}`);
  }
  return json.result as T;
}

export function ethCall(to: string, data: string): Promise<string> {
  return rpcCall<string>('eth_call', [{ to, data }, 'latest']);
}

/** Raw ERC-20 balance of `owner` for `token`. */
export async function erc20BalanceOf(token: string, owner: string): Promise<bigint> {
  return decodeUint256(await ethCall(token, encodeBalanceOf(owner)));
}

export interface TxReceipt {
  transactionHash: string;
  status: string;
  blockNumber: string;
  from: string;
  to: string | null;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

/** Poll for a receipt. Wallets return a hash the instant they broadcast,
 *  well before the transaction is in a block. */
export async function waitForReceipt(hash: string, timeoutMs = 90_000): Promise<TxReceipt> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpcCall<TxReceipt | null>('eth_getTransactionReceipt', [hash]);
    if (receipt) {
      if (receipt.status !== '0x1') {
        throw new ChainError(`Transaction reverted on chain: ${hash}`);
      }
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new ChainError(`Timed out waiting for transaction ${hash} to confirm.`);
}

// ----- writes (injected wallet) -------------------------------------------

export async function requestAccounts(): Promise<string[]> {
  const accounts = (await evmProvider().request({ method: 'eth_requestAccounts' })) as string[];
  return (accounts ?? []).map((address) => address.toLowerCase());
}

export async function currentChainId(): Promise<string> {
  return (await evmProvider().request({ method: 'eth_chainId' })) as string;
}

/**
 * Make sure the wallet is pointed at Robinhood Chain, adding the network
 * first if the wallet has never seen it. Error 4902 is the EIP-1193
 * "unrecognized chain" code every major wallet returns for an unknown
 * chainId; some wallets nest it one level down in `error.data`.
 */
export async function ensureRobinhoodChain(): Promise<void> {
  const provider = evmProvider();
  const chainId = (await provider.request({ method: 'eth_chainId' })) as string;
  if (chainId?.toLowerCase() === RHC_CHAIN_ID_HEX) return;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: RHC_CHAIN_ID_HEX }],
    });
  } catch (err) {
    const code = (err as { code?: number; data?: { originalError?: { code?: number } } })?.code
      ?? (err as { data?: { originalError?: { code?: number } } })?.data?.originalError?.code;
    if (code !== 4902) throw err;
    await provider.request({ method: 'wallet_addEthereumChain', params: [RHC_CHAIN_PARAMS] });
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: RHC_CHAIN_ID_HEX }],
    });
  }

  const after = (await provider.request({ method: 'eth_chainId' })) as string;
  if (after?.toLowerCase() !== RHC_CHAIN_ID_HEX) {
    throw new ChainError('Wallet is not on Robinhood Chain. Switch networks and try again.');
  }
}

export interface SendTxRequest {
  from: string;
  to: string;
  /** Hex-encoded calldata, or omitted for a plain value transfer. */
  data?: string;
  /** Value in wei. */
  value?: bigint;
}

/**
 * Ask the wallet to sign and broadcast a transaction, then wait for the
 * receipt. Verifies the wallet's selected account still matches `from` —
 * a user can switch accounts between connecting and clicking Buy, and
 * sending from the wrong account would credit the wrong profile.
 */
export async function sendTransaction(request: SendTxRequest): Promise<TxReceipt> {
  await ensureRobinhoodChain();
  const provider = evmProvider();

  const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
  const active = accounts?.[0]?.toLowerCase();
  if (!active) {
    throw new ChainError('Wallet is locked. Unlock it and try again.');
  }
  if (active !== request.from.toLowerCase()) {
    throw new ChainError(
      `Wallet is on account ${active.slice(0, 6)}…${active.slice(-4)} but your profile is ${request.from.slice(0, 6)}…${request.from.slice(-4)}. Switch accounts and try again.`,
    );
  }

  const hash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from: request.from,
      to: request.to,
      ...(request.data ? { data: request.data } : {}),
      ...(request.value !== undefined ? { value: `0x${request.value.toString(16)}` } : {}),
    }],
  })) as string;

  if (!hash) {
    throw new ChainError('Wallet did not return a transaction hash.');
  }
  return waitForReceipt(hash);
}
