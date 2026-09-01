// Robinhood Chain network + contract configuration.
//
// This module is imported by BOTH the browser bundle and the Node server
// bundle, so every lookup has to work in either environment:
//
//   * Browser — Vite substitutes `import.meta.env.VITE_X` at BUILD time.
//     The substitution only happens at *literal* member accesses, which is
//     why the block below spells each variable out instead of indexing
//     `import.meta.env` with a computed key. A computed key survives into
//     the bundle and evaluates to undefined in production, so the app would
//     work in `npm run dev` and then report "$POKETCG not configured" on a
//     real deploy. Consequence worth remembering: every VITE_ value must be
//     present at build time, not just at boot.
//
//   * Server — `import.meta.env` does not exist, so the property access
//     throws and the try/catch drops us onto process.env, read at runtime.

let VITE: Record<string, string | undefined> = {};
try {
  VITE = {
    RHC_RPC_URL: import.meta.env.VITE_RHC_RPC_URL,
    RHC_EXPLORER_URL: import.meta.env.VITE_RHC_EXPLORER_URL,
    POKETCG_TOKEN_ADDRESS: import.meta.env.VITE_POKETCG_TOKEN_ADDRESS,
    CARD_NFT_ADDRESS: import.meta.env.VITE_CARD_NFT_ADDRESS,
  };
} catch {
  // Node server bundle: import.meta.env is undefined. process.env wins below.
}

function envVar(name: string): string | undefined {
  const fromNode = typeof process !== 'undefined' && process.env
    ? process.env[name]?.trim() || process.env[`VITE_${name}`]?.trim()
    : undefined;
  return fromNode || VITE[name]?.trim() || undefined;
}

/** Robinhood Chain mainnet. Verified live 2026-08-31. */
export const RHC_CHAIN_ID = 4663;
/** 0x1237 — the hex form every EIP-1193 wallet method expects. */
export const RHC_CHAIN_ID_HEX = `0x${RHC_CHAIN_ID.toString(16)}`;

export const RHC_RPC_URL = envVar('RHC_RPC_URL') ?? 'https://rpc.mainnet.chain.robinhood.com';
export const RHC_EXPLORER_URL = envVar('RHC_EXPLORER_URL') ?? 'https://explorer.mainnet.chain.robinhood.com';

/** Params for `wallet_addEthereumChain` when the user's wallet has never
 *  seen Robinhood Chain before. */
export const RHC_CHAIN_PARAMS = {
  chainId: RHC_CHAIN_ID_HEX,
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: [RHC_RPC_URL],
  blockExplorerUrls: [RHC_EXPLORER_URL],
} as const;

/** The launched game token: `Pokemasters` / `POKE`, an 18-decimal ERC-20 on
 *  chain 4663 (verified against the RPC on 2026-09-01). Hard-coded as the
 *  default rather than left to `VITE_POKETCG_TOKEN_ADDRESS` because that
 *  variable is inlined at BUILD time — setting it on the host after a build
 *  leaves the browser bundle reporting "not configured". The env vars still
 *  win when present, so a testnet or replacement token needs no code change.
 *  Every token-gated feature checks `hasPoketcgToken()` and degrades
 *  gracefully rather than throwing. */
export const POKETCG_TOKEN_ADDRESS = (
  envVar('POKETCG_TOKEN_ADDRESS') ?? '0x63be1538875a3ee7937c80ec90a1e1aa5c92ecc7'
).toLowerCase();
/** Pons v2 launches 18-decimal ERC-20s (config[0] supply is 1e27 raw = 1e9 whole tokens). */
export const POKETCG_DECIMALS = 18;

export function hasPoketcgToken(): boolean {
  return /^0x[0-9a-f]{40}$/.test(POKETCG_TOKEN_ADDRESS);
}

/** PokemonCardNFT (ERC-721) deployed from `contracts/`. Empty disables minting. */
export const CARD_NFT_ADDRESS = (envVar('CARD_NFT_ADDRESS') ?? '').toLowerCase();

export function hasCardNft(): boolean {
  return /^0x[0-9a-f]{40}$/.test(CARD_NFT_ADDRESS);
}

/** Burn sink. Robinhood Chain has no native burn opcode for ERC-20s and
 *  Pons v2 tokens do not expose `burn()`, so "burning" means an ordinary
 *  `transfer` to an address nobody holds the key for. The server verifies
 *  the Transfer event targets exactly this address. */
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

export function explorerTxUrl(hash: string): string {
  return `${RHC_EXPLORER_URL}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${RHC_EXPLORER_URL}/address/${address}`;
}

/** Explorer page for one card NFT. Blockscout addresses an ERC-721
 *  instance as /token/<contract>/instance/<tokenId>. Falls back to the
 *  contract page when no token id is known. */
export function cardNftTokenUrl(tokenId: string): string {
  const base = `${RHC_EXPLORER_URL}/token/${CARD_NFT_ADDRESS}`;
  return tokenId ? `${base}/instance/${tokenId}` : base;
}
