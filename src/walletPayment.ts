import { shortAddr, solanaProviders } from './wallet';

export interface SolanaPaymentRequest {
  payerAddress: string;
  recipientAddress: string;
  amountSol: number;
  rpcUrl: string;
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

  const { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } = await import('@solana/web3.js');

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
