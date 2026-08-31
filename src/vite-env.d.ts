/// <reference types="vite/client" />

// Declared so src/chain/config.ts reads them as `string | undefined`
// rather than `any`, and so a typo in a variable name is a type error.
// Every one of these is inlined at BUILD time — see the note at the top
// of src/chain/config.ts.
interface ImportMetaEnv {
  readonly VITE_RHC_RPC_URL?: string;
  readonly VITE_RHC_EXPLORER_URL?: string;
  readonly VITE_POKETCG_TOKEN_ADDRESS?: string;
  readonly VITE_CARD_NFT_ADDRESS?: string;
  readonly VITE_BGIO_SERVER?: string;
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
