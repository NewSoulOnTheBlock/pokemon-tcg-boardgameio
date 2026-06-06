import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

export type WalletChain = 'evm' | 'solana';
type SolanaProvider = NonNullable<Window['solana']>;

export interface ConnectedWallet {
  chain: WalletChain;
  address: string;
}

export type SolanaWalletKind = 'phantom' | 'solflare' | 'backpack';

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<string[]>;
    };
    solana?: {
      publicKey?: { toString: () => string };
      connect: (options?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: { toString: () => string } }>;
      signAndSendTransaction?: (transaction: Transaction) => Promise<{ signature?: string } | string>;
      signTransaction?: (transaction: Transaction) => Promise<Transaction>;
    };
    solflare?: Window['solana'];
    backpack?: Window['solana'];
    phantom?: { solana?: Window['solana'] };
  }

}

export interface SolanaPaymentRequest {
  payerAddress: string;
  recipientAddress: string;
  amountSol: number;
  rpcUrl: string;
}

export function shortAddr(address: string | null | undefined): string {
  if (!address) return '';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export async function connectEvm(): Promise<ConnectedWallet> {
  if (!window.ethereum) {
    throw new Error('No EVM wallet detected. Install MetaMask, Rabby, or Coinbase Wallet.');
  }

  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const address = accounts[0]?.toLowerCase();
  if (!address) {
    throw new Error('Wallet returned no account.');
  }

  return { chain: 'evm', address };
}

function solanaProvider(kind: SolanaWalletKind): Window['solana'] | undefined {
  if (kind === 'phantom') return window.phantom?.solana ?? window.solana;
  return window[kind];
}

function isSolanaProvider(provider: Window['solana'] | undefined): provider is SolanaProvider {
  return Boolean(provider);
}

function solanaProviders(): SolanaProvider[] {
  const providers = [
    window.phantom?.solana,
    window.solflare,
    window.backpack,
    window.solana,
  ].filter(isSolanaProvider);

  return providers.filter((provider, index) => providers.indexOf(provider) === index);
}

export function detectSolanaWallets(): Array<{ kind: SolanaWalletKind; label: string; installed: boolean }> {
  return [
    { kind: 'phantom', label: 'Phantom', installed: Boolean(solanaProvider('phantom')) },
    { kind: 'solflare', label: 'Solflare', installed: Boolean(solanaProvider('solflare')) },
    { kind: 'backpack', label: 'Backpack', installed: Boolean(solanaProvider('backpack')) },
  ];
}

export async function connectSolanaWith(kind: SolanaWalletKind): Promise<ConnectedWallet> {
  const provider = solanaProvider(kind);
  if (!provider) {
    throw new Error(`${kind} wallet not detected.`);
  }

  const response = await provider.connect();
  const address = response.publicKey?.toString() ?? provider.publicKey?.toString();
  if (!address) {
    throw new Error(`${kind} wallet returned no public key.`);
  }

  return { chain: 'solana', address };
}

export async function connectSolana(): Promise<ConnectedWallet> {
  const installed = detectSolanaWallets().find((wallet) => wallet.installed);
  if (!installed) {
    throw new Error('No Solana wallet detected. Install Phantom, Solflare, or Backpack.');
  }

  return connectSolanaWith(installed.kind);
}

export async function sendSolPayment({
  payerAddress,
  recipientAddress,
  amountSol,
  rpcUrl,
}: SolanaPaymentRequest): Promise<string> {
  const providers = solanaProviders();
  const provider = providers.find((candidate) => candidate.publicKey?.toString() === payerAddress) ?? providers[0];
  if (!provider) {
    throw new Error('No Solana wallet detected. Connect Phantom, Solflare, or Backpack to buy packs.');
  }

  const response = await provider.connect().catch(() => provider.connect({ onlyIfTrusted: false }));
  const connectedAddress = response.publicKey?.toString() ?? provider.publicKey?.toString();
  if (connectedAddress !== payerAddress) {
    throw new Error(`Connected Solana wallet ${shortAddr(connectedAddress)} does not match profile wallet ${shortAddr(payerAddress)}.`);
  }

  if (!provider.signAndSendTransaction && !provider.signTransaction) {
    throw new Error('Connected Solana wallet does not support transaction signing.');
  }

  const payer = new PublicKey(payerAddress);
  const recipient = new PublicKey(recipientAddress);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const connection = new Connection(rpcUrl, 'confirmed');
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: payer,
    recentBlockhash: latestBlockhash.blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: recipient,
      lamports,
    }),
  );

  let signature: string | undefined;
  if (provider.signAndSendTransaction) {
    const result = await provider.signAndSendTransaction(transaction);
    signature = typeof result === 'string' ? result : result.signature;
  } else if (provider.signTransaction) {
    const signed = await provider.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signed.serialize());
  }

  if (!signature) {
    throw new Error('Wallet did not return a transaction signature.');
  }

  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    'confirmed',
  );
  if (confirmation.value.err) {
    throw new Error(`Solana payment failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return signature;
}
