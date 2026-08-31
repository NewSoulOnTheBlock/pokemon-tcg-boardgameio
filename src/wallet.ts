// Wallet identity for the app.
//
// Robinhood Chain is an EVM chain, so there is exactly one wallet path:
// an injected EIP-1193 provider (MetaMask, Rabby, Coinbase Wallet, …).
// The `telegram` chain tag is not a real wallet — it marks a session
// running inside the Telegram mini-app, where no extension exists and
// every on-chain feature is disabled downstream.

import { ensureRobinhoodChain, evmProvider, hasEvmWallet, requestAccounts, type Eip1193Provider } from './chain/evm';

export type WalletChain = 'evm' | 'telegram';

export interface ConnectedWallet {
  chain: WalletChain;
  address: string;
}

export type EvmWalletKind = 'metamask' | 'rabby' | 'coinbase' | 'injected';

export function shortAddr(address: string | null | undefined): string {
  if (!address) return '';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Extensions that coexist announce themselves through `window.ethereum
 *  .providers`; a lone extension is `window.ethereum` itself. */
function injectedProviders(): Eip1193Provider[] {
  if (!hasEvmWallet()) return [];
  const root = window.ethereum!;
  return root.providers?.length ? root.providers : [root];
}

function providerFor(kind: EvmWalletKind): Eip1193Provider | undefined {
  const providers = injectedProviders();
  if (kind === 'metamask') return providers.find((p) => p.isMetaMask && !p.isRabby);
  if (kind === 'rabby') return providers.find((p) => p.isRabby);
  if (kind === 'coinbase') return providers.find((p) => p.isCoinbaseWallet);
  return providers[0];
}

export function detectEvmWallets(): Array<{ kind: EvmWalletKind; label: string; installed: boolean }> {
  return [
    { kind: 'metamask', label: 'MetaMask', installed: Boolean(providerFor('metamask')) },
    { kind: 'rabby', label: 'Rabby', installed: Boolean(providerFor('rabby')) },
    { kind: 'coinbase', label: 'Coinbase Wallet', installed: Boolean(providerFor('coinbase')) },
  ];
}

/**
 * Connect the injected wallet and leave it on Robinhood Chain. Switching
 * the network at connect time (rather than lazily at the first payment)
 * means the user answers both prompts once, up front, instead of being
 * interrupted mid-purchase.
 */
export async function connectEvm(): Promise<ConnectedWallet> {
  if (!hasEvmWallet()) {
    throw new Error('No EVM wallet detected. Install MetaMask, Rabby, or Coinbase Wallet.');
  }

  const accounts = await requestAccounts();
  const address = accounts[0];
  if (!address) {
    throw new Error('Wallet returned no account.');
  }

  await ensureRobinhoodChain();
  return { chain: 'evm', address };
}

/** Address the wallet currently has selected, or null when locked or
 *  never connected. Never prompts — safe to poll on mount. */
export async function currentEvmAccount(): Promise<string | null> {
  if (!hasEvmWallet()) return null;
  try {
    const accounts = (await evmProvider().request({ method: 'eth_accounts' })) as string[];
    return accounts?.[0]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
