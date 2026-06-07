import { shortAddr, solanaProviders } from './wallet';

export interface SignAndSendOptions {
  payerAddress: string;
  rpcUrl: string;
  /** Base64-encoded unsigned Transaction (legacy format). */
  transactionBase64: string;
}

/**
 * Decode a base64 unsigned transaction, ask the connected Solana wallet
 * to sign it, send it to the network, and wait for confirmation. Returns
 * the on-chain signature. The Solana web3.js SDK is dynamic-imported so
 * the heavy bundle only loads when the user actually triggers a payment.
 */
export async function signAndSendBase64Transaction({
  payerAddress,
  rpcUrl,
  transactionBase64,
}: SignAndSendOptions): Promise<string> {
  const providers = solanaProviders();
  const provider = providers.find((candidate) => candidate.publicKey?.toString() === payerAddress) ?? providers[0];
  if (!provider) {
    throw new Error('No Solana wallet detected. Connect Phantom, Solflare, or Backpack first.');
  }

  const response = await provider.connect().catch(() => provider.connect({ onlyIfTrusted: false }));
  const connectedAddress = response.publicKey?.toString() ?? provider.publicKey?.toString();
  if (connectedAddress !== payerAddress) {
    throw new Error(`Connected Solana wallet ${shortAddr(connectedAddress)} does not match profile wallet ${shortAddr(payerAddress)}.`);
  }
  if (!provider.signTransaction && !provider.signAndSendTransaction) {
    throw new Error('Connected Solana wallet does not support transaction signing.');
  }

  const { Connection, Transaction } = await import('@solana/web3.js');
  const txBytes = Uint8Array.from(atob(transactionBase64), (c) => c.charCodeAt(0));
  const tx = Transaction.from(txBytes);
  const connection = new Connection(rpcUrl, 'confirmed');

  let signature: string | undefined;
  if (provider.signTransaction) {
    const signed = await provider.signTransaction(tx);
    signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
  } else if (provider.signAndSendTransaction) {
    const result = await provider.signAndSendTransaction(tx);
    signature = typeof result === 'string' ? result : result.signature;
  }

  if (!signature) {
    throw new Error('Wallet did not return a transaction signature.');
  }

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const confirmation = await connection.confirmTransaction(
    { signature, ...latestBlockhash },
    'confirmed',
  );
  if (confirmation.value.err) {
    throw new Error(`Transaction failed on chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  return signature;
}

/**
 * Sign a live VersionedTransaction with the connected wallet but do
 * NOT submit it. Caller passes the VersionedTransaction INSTANCE (not
 * a serialized blob) so we avoid base64 round-tripping that can shift
 * tx bytes and trip partner-side fingerprint checks (e.g. Phygitals).
 * Returns the signed-tx byte array for transport to the partner.
 */
export async function signVersionedTransaction({
  payerAddress,
  tx,
}: {
  payerAddress: string;
  /** Live @solana/web3.js VersionedTransaction instance. Typed as
   *  unknown so callers don't have to import the heavy SDK type at
   *  every call site. */
  tx: unknown;
}): Promise<number[]> {
  const providers = solanaProviders();
  const provider = providers.find((candidate) => candidate.publicKey?.toString() === payerAddress) ?? providers[0];
  if (!provider) {
    throw new Error('No Solana wallet detected. Connect Phantom, Solflare, or Backpack first.');
  }
  const response = await provider.connect().catch(() => provider.connect({ onlyIfTrusted: false }));
  const connectedAddress = response.publicKey?.toString() ?? provider.publicKey?.toString();
  if (connectedAddress !== payerAddress) {
    throw new Error(`Connected Solana wallet ${shortAddr(connectedAddress)} does not match profile wallet ${shortAddr(payerAddress)}.`);
  }
  if (!provider.signTransaction) {
    throw new Error('Connected Solana wallet does not support transaction signing.');
  }
  const signed = (await provider.signTransaction(tx)) as { serialize(): Uint8Array };
  // VersionedTransaction.serialize() returns Uint8Array; convert to
  // a plain number[] for JSON transport.
  return Array.from(signed.serialize());
}

/**
 * @deprecated Use signVersionedTransaction() with a live instance
 * instead. The base64 round-trip caused fingerprint mismatches with
 * partner backends that re-derive tx bytes (e.g. Phygitals).
 */
export async function signVersionedTransactionBase64({
  payerAddress,
  transactionBase64,
}: {
  payerAddress: string;
  transactionBase64: string;
}): Promise<number[]> {
  const providers = solanaProviders();
  const provider = providers.find((candidate) => candidate.publicKey?.toString() === payerAddress) ?? providers[0];
  if (!provider) {
    throw new Error('No Solana wallet detected. Connect Phantom, Solflare, or Backpack first.');
  }

  const response = await provider.connect().catch(() => provider.connect({ onlyIfTrusted: false }));
  const connectedAddress = response.publicKey?.toString() ?? provider.publicKey?.toString();
  if (connectedAddress !== payerAddress) {
    throw new Error(`Connected Solana wallet ${shortAddr(connectedAddress)} does not match profile wallet ${shortAddr(payerAddress)}.`);
  }
  if (!provider.signTransaction) {
    throw new Error('Connected Solana wallet does not support transaction signing.');
  }

  const { VersionedTransaction } = await import('@solana/web3.js');
  const txBytes = Uint8Array.from(atob(transactionBase64), (c) => c.charCodeAt(0));
  const tx = VersionedTransaction.deserialize(txBytes);
  const signed = await provider.signTransaction(tx);
  return Array.from(signed.serialize());
}

/**
 * Sign multiple base64-encoded VersionedTransactions in series. Used
 * for Phygitals' take-claw-bid sellback flow where init returns an
 * array of unsigned txs. Returns the array of signed-tx byte arrays.
 */
export async function signManyVersionedTransactions({
  payerAddress,
  transactions,
}: {
  payerAddress: string;
  /** Each entry can be base64 or a number[] of serialized bytes. */
  transactions: Array<string | number[]>;
}): Promise<Array<number[]>> {
  const out: Array<number[]> = [];
  for (const entry of transactions) {
    const base64 = typeof entry === 'string'
      ? entry
      : btoa(String.fromCharCode(...entry));
    out.push(await signVersionedTransactionBase64({ payerAddress, transactionBase64: base64 }));
  }
  return out;
}
