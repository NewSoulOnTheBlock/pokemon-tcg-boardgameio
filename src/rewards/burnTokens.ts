// Browser-side helper that builds + signs + sends a $POKETCG burn
// transaction. The user pays no SOL fee directly (just gas), the
// 250,000 $POKETCG per pack is permanently destroyed via spl-token's
// burn instruction. Returns the on-chain signature so the caller can
// pass it to the server's /api/rewards/burn-pack endpoint for
// verification + pack issuance.

import { POKETCG_TOKEN_MINT } from '../game/types';

const POKETCG_DECIMALS = 6;

// Pack-tier pricing — must match POKETCG_PACK_TIERS in
// src/server/tokenBurn.ts. The server validates the burn amount
// against the declared tier, so a client that fakes a different
// price/pack ratio will fail server-side verification.
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

const SOLANA_RPC_URL = (
  (typeof process !== 'undefined' && process.env?.SOLANA_RPC_URL?.trim()) ||
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_SOLANA_RPC_URL?.trim() ||
  'https://api.mainnet-beta.solana.com'
);

/** Build a tx with a single SPL-token `burnChecked` instruction that
 *  destroys the tier's `costTokens` of $POKETCG from the buyer's ATA,
 *  sign it with the connected wallet, and submit it. Returns the
 *  signature. */
export async function burnPoketcgForPacks(args: {
  buyerWallet: string;
  packs: number;
}): Promise<string> {
  const tier = findPoketcgTier(args.packs);
  if (!tier) {
    throw new Error(`packs must be one of: ${POKETCG_PACK_TIERS.map((t) => t.packs).join(', ')}`);
  }
  const [{ PublicKey, Connection, Transaction }, Token] = await Promise.all([
    import('@solana/web3.js'),
    import('@solana/spl-token'),
  ]);
  const mint = new PublicKey(POKETCG_TOKEN_MINT);
  const buyer = new PublicKey(args.buyerWallet);
  const ata = Token.getAssociatedTokenAddressSync(mint, buyer, false);
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  const ataInfo = await connection.getAccountInfo(ata);
  if (!ataInfo) {
    throw new Error('No $POKETCG token account found on this wallet. Buy some $POKETCG first.');
  }

  const amount = BigInt(tier.costTokens) * BigInt(10 ** POKETCG_DECIMALS);
  // burnChecked is preferred over burn — the cluster validates the
  // declared decimals against the mint, catching client-side mistakes.
  const burnIx = Token.createBurnCheckedInstruction(
    ata,
    mint,
    buyer,
    amount,
    POKETCG_DECIMALS,
  );

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: buyer, recentBlockhash: blockhash }).add(burnIx);

  const { signAndSendBase64Transaction } = await import('../walletPayment');
  const transactionBase64 = btoa(
    Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }))
      .map((b) => String.fromCharCode(b))
      .join(''),
  );
  return signAndSendBase64Transaction({
    payerAddress: args.buyerWallet,
    rpcUrl: SOLANA_RPC_URL,
    transactionBase64,
  });
}

/** Read the user's current $POKETCG balance from chain. Returns it as
 *  a UI-friendly number (already divided by decimals). Returns 0 if
 *  the wallet has no token account yet. */
export async function fetchPoketcgBalance(walletAddress: string): Promise<number> {
  const [{ PublicKey, Connection }, Token] = await Promise.all([
    import('@solana/web3.js'),
    import('@solana/spl-token'),
  ]);
  const mint = new PublicKey(POKETCG_TOKEN_MINT);
  const owner = new PublicKey(walletAddress);
  const ata = Token.getAssociatedTokenAddressSync(mint, owner, false);
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  try {
    const balance = await connection.getTokenAccountBalance(ata, 'confirmed');
    return Number(balance.value.uiAmountString ?? balance.value.uiAmount ?? 0);
  } catch {
    return 0;
  }
}
