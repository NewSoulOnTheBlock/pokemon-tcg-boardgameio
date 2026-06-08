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
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  // Detect the correct token program for the mint (classic SPL Token
  // vs Token-2022). The mint account's owner IS the program ID. This
  // matters because createBurnCheckedInstruction defaults to classic
  // SPL Token and would silently produce an invalid ix for a 2022 mint.
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) {
    throw new Error(`$POKETCG mint not found on chain: ${POKETCG_TOKEN_MINT}`);
  }
  const programId = mintInfo.owner;

  // Resolve the wallet's token account that ACTUALLY holds the
  // balance (rather than blindly deriving the canonical ATA). This
  // handles legacy non-ATA accounts and avoids the "ATA doesn't exist
  // even though there's a balance under a different account" bug.
  const accounts = await connection.getParsedTokenAccountsByOwner(buyer, { mint, programId });
  const sourceAccount = accounts.value.find((entry) => {
    const ui = Number((entry.account.data.parsed?.info as { tokenAmount?: { uiAmount?: number } } | undefined)
      ?.tokenAmount?.uiAmount ?? 0);
    return ui > 0;
  }) ?? accounts.value[0];
  if (!sourceAccount) {
    throw new Error(
      'No $POKETCG token account on this wallet. Buy some $POKETCG on pump.fun first, then refresh.',
    );
  }
  const ata = sourceAccount.pubkey;

  const amount = BigInt(tier.costTokens) * BigInt(10 ** POKETCG_DECIMALS);
  // burnChecked is preferred over burn — the cluster validates the
  // declared decimals against the mint, catching client-side mistakes.
  const burnIx = Token.createBurnCheckedInstruction(
    ata,
    mint,
    buyer,
    amount,
    POKETCG_DECIMALS,
    [],
    programId, // route to whichever token program owns the mint
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

/** Read the user's current $POKETCG balance from chain. Returns the
 *  UI-friendly value (already divided by decimals). Robust to:
 *    - non-canonical / legacy SPL token accounts
 *    - Token-2022 mints (some pump.fun launches use this program)
 *    - multiple token accounts for the same mint
 *  by walking every parsed token account on the wallet for our mint
 *  on BOTH the classic SPL Token program AND Token-2022. Throws on
 *  RPC failure so the caller can surface the error rather than
 *  silently showing 0 balance. */
export async function fetchPoketcgBalance(walletAddress: string): Promise<number> {
  const { PublicKey, Connection } = await import('@solana/web3.js');
  const mint = new PublicKey(POKETCG_TOKEN_MINT);
  const owner = new PublicKey(walletAddress);
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  // Walk both token programs. pump.fun originally uses TOKEN_PROGRAM_ID
  // (classic SPL Token) but Token-2022 launches exist too — the wallet
  // might hold the balance under either program.
  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

  let totalUi = 0;
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(
        owner,
        { mint, programId },
      );
      for (const entry of accounts.value) {
        const info = entry.account.data.parsed?.info as { tokenAmount?: { uiAmountString?: string; uiAmount?: number } } | undefined;
        const ui = Number(info?.tokenAmount?.uiAmountString ?? info?.tokenAmount?.uiAmount ?? 0);
        if (Number.isFinite(ui)) totalUi += ui;
      }
    } catch (err) {
      // Token-2022 may not be queryable on every RPC node; only rethrow
      // if the classic-program lookup also fails.
      if (programId === TOKEN_PROGRAM_ID) throw err;
    }
  }
  return totalUi;
}
