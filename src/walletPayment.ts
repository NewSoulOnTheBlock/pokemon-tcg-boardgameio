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
  const tx = Transaction.from(Buffer.from(transactionBase64, 'base64'));
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
