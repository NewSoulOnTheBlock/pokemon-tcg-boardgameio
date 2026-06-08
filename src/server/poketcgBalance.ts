// Server-side $POKETCG balance helper for the Champions Row eligibility
// scan. Mirrors the browser-side getParsedTokenAccountsByOwner walk
// across both Token-2022 (the canonical $POKETCG program) and the
// classic SPL Token program (so a future migration just works).

import { Connection, PublicKey } from '@solana/web3.js';

export const POKETCG_TOKEN_MINT = 'N9Curnf2ZQWBZWrjBkzP6xBe6n5WRhBhouRfiSqpump';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';

let cachedConnection: Connection | undefined;
function getConnection(): Connection {
  if (!cachedConnection) cachedConnection = new Connection(SOLANA_RPC_URL, 'confirmed');
  return cachedConnection;
}

/** Sum of $POKETCG (UI value) held by this wallet across BOTH token
 *  programs. Returns 0 (rather than throwing) on RPC failure — the
 *  eligibility scan treats that as "not eligible" for this round. */
export async function fetchPoketcgBalance(walletAddress: string): Promise<number> {
  const connection = getConnection();
  const owner = new PublicKey(walletAddress);
  const mint = new PublicKey(POKETCG_TOKEN_MINT);
  let total = 0;
  for (const programId of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint, programId });
      for (const entry of accounts.value) {
        const info = entry.account.data.parsed?.info as { tokenAmount?: { uiAmountString?: string; uiAmount?: number } } | undefined;
        const ui = Number(info?.tokenAmount?.uiAmountString ?? info?.tokenAmount?.uiAmount ?? 0);
        if (Number.isFinite(ui)) total += ui;
      }
    } catch {
      // Try the other program; if both fail we just return 0.
    }
  }
  return total;
}
