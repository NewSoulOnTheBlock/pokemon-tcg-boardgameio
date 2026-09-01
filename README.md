# Pokemon TCG boardgame.io

A playable boardgame.io implementation of the core Pokemon Trading Card Game rules from the official Pokemon TCG rulebook.

## Scope

This project implements the rules engine for a two-player Pokemon TCG match: setup with mulligans, hidden hands/decks/Prize cards, Bench limits, turn actions, Energy attachment, evolution timing, Trainer limits, retreating, attacking, Weakness/Resistance, Knock Outs, Prize cards, Pokemon Checkup, Special Conditions, and primary win conditions.

It includes compact starter decks backed by a vendored English Pokemon TCG card database from `PokemonTCG/pokemon-tcg-data`, stored under `src/data/pokemon-tcg-data` so cards are loaded locally instead of from the API.

## Commands

```bash
npm install
npm run dev:server   # terminal 1 — boardgame.io server + REST API on :8000
npm run dev          # terminal 2 — Vite dev server on :5173 (proxies /api, /games, /socket.io to :8000)
npm test             # vitest run
npm run build        # full prod build: card manifest + tsc + vite + esbuild server bundle
npm start            # run the built server bundle with plain `node` (production-style)
npm run build:cards  # regenerate the slim card manifest only
npm run build:server # rebuild dist-server/server.mjs only
```

Contracts live in their own Hardhat project under `contracts/` — see [Card NFTs](#card-nfts-erc-721-on-robinhood-chain).

Open `http://localhost:5173` in two different browser windows for online matches — each window logs in as a separate profile, picks a deck, and creates or joins a match. In production the Vite build is served by the same Koa server as the API and socket.io, so the browser uses `window.location.origin`; only set `VITE_BGIO_SERVER` when the static client is hosted on a different origin than the game server.

### Card data — Postgres source of truth

The vendored Pokemon TCG dataset ships as ~25 MB of raw JSON across 168 files. `scripts/build-card-manifest.mjs` (`prebuild`) emits one slim `src/data/card-manifest.generated.json` (gitignored) that the server bundles for the **one-time** Postgres migration.

Production lifecycle:

1. **First boot** — `app_cards` is empty, so `src/server.ts` reads the bundled manifest, runs the conversion, populates the in-memory `CARD_LIBRARY`, then bulk-upserts ~20 000 rows into `app_cards`.
2. **Every subsequent boot** — `app_cards` is populated, so the server reads cards from Postgres straight into `CARD_LIBRARY` and never touches the bundled manifest. The manifest stays on disk for disaster recovery; you can edit cards in Postgres directly and the next boot picks them up.
3. **Browsers** — `src/main.tsx` shows a tiny boot splash, fetches `GET /api/cards/library` (~8.5 MB JSON, served with `Cache-Control: public, max-age=3600`), calls `initCardLibrary`, then dynamic-`import('./App')` so the UI's top-level `CANONICAL_CARDS` / `BOOSTERABLE_SETS` derivations all see a populated catalogue.

Because the client never statically imports the manifest, the Vite client chunks dropped from 11.4 MB → ~430 KB (boot + App + vendors). The 8.5 MB card payload is fetched once and cached by the browser.

When `DATABASE_URL` is not set the server uses a `MemoryCardStorage` that recomputes from the manifest on every boot — fine for local dev.

Re-run `npm run build:cards` after pulling new upstream card data; on next deploy you can also `TRUNCATE app_cards` to force the bootstrap to re-import.

### Backend storage

The multiplayer server uses PostgreSQL when `DATABASE_URL` is set, otherwise it falls back to local FlatFile storage in `./storage` (override with `BGIO_STORAGE_DIR`). When Postgres is configured the same database stores:

- boardgame.io match state in `bgio_matches`
- the canonical card catalogue in `app_cards` (~20 000 rows, populated on first boot)
- profile/login records in `app_profiles`
- opened booster pack history and pulled card IDs in `app_pack_purchases`
- per-user match records in `app_match_records`

`/api/health` returns `{ ok, storage, profileStorage, cardStorage, cards }` for liveness checks.

The app signs users in by wallet address when a wallet is connected, or by trainer name otherwise. LocalStorage is kept only as a browser cache/session handoff; the server profile is the source of truth after sign-in.

### Environment variables

| Var | Purpose |
|---|---|
| `PORT` | Server port (Render sets this automatically). Defaults to 8000. |
| `DATABASE_URL` | Postgres connection string. Without it, server uses FlatFile + in-memory profiles. |
| `PGSSLMODE` | Set to `require` to enable SSL on Postgres (required on Render). Use `no-verify` for providers with self-signed certs. |
| `ALLOW_ORIGIN` | Production CORS origin(s) for socket.io + REST. Accepts a single URL or a comma-separated list. |
| `BGIO_STORAGE_DIR` | Where to store FlatFile match data when `DATABASE_URL` is not set. |
| `VITE_BGIO_SERVER` | (Build-time) override the boardgame.io server URL the browser connects to. |
| `VITE_API_BASE` | (Build-time) override the REST API base path. |
| `VITE_API_TARGET` | (Dev-only) where the Vite proxy forwards `/api`, `/games`, `/socket.io`. Defaults to `http://localhost:8000`. |
| `PUBLIC_ORIGIN` | Public URL of this server. Used for NFT metadata links and as the ERC-721 base URI. |
| `NODE_OPTIONS` | Caps the V8 heap (`--max-old-space-size=420` in the Render blueprint). Bump to ~1800 if you upgrade to the Standard plan (2 GB RAM). |

### Robinhood Chain variables

The chain config is read by **both** the server and the browser, so most values
appear twice. The server reads the bare name at runtime; Vite inlines the
`VITE_`-prefixed name into the browser bundle **at build time** — set those
before `npm run build`, not just before `npm start`, or the client ships with
the feature disabled.

| Var | Purpose |
|---|---|
| `POKETCG_TOKEN_ADDRESS` / `VITE_POKETCG_TOKEN_ADDRESS` | $POKE ERC-20. Unset ⇒ burn shop and the Champions Row token gate are disabled, everything else still works. |
| `CARD_NFT_ADDRESS` / `VITE_CARD_NFT_ADDRESS` | `PokemonCardNFT` from `contracts/`. Unset ⇒ cards are granted in-game but not minted. |
| `RHC_TREASURY_PRIVATE_KEY` | Server-side minter key. Needs ETH on chain 4663 for gas. Server-only — never exposed to the browser. |
| `RHC_RPC_URL` / `VITE_RHC_RPC_URL` | Override the RPC endpoint. Defaults to `https://rpc.mainnet.chain.robinhood.com`. |
| `RHC_EXPLORER_URL` / `VITE_RHC_EXPLORER_URL` | Override explorer links. Defaults to `https://explorer.mainnet.chain.robinhood.com`. |

## Deploying to Render.com

This repo includes a `render.yaml` blueprint that provisions one Node web service + one free Postgres database, wires `DATABASE_URL` automatically, sets `NODE_OPTIONS=--max-old-space-size=420` so V8 GCs aggressively below the 512 MB starter cap, and points the Render health check at `/api/health`.

1. Push this repo to GitHub.
2. In the Render dashboard: **New → Blueprint**, point at the repo, click **Apply**.
3. Render runs `npm ci && npm run build` (which produces `dist/` + `dist-server/server.mjs`) and starts `npm start` (plain `node dist-server/server.mjs`).
4. After the first deploy, set `ALLOW_ORIGIN` to the production URL (e.g. `https://your-app.onrender.com`).

If you see OOM kills under sustained load, the cheapest fix is to upgrade the web service to the **Standard** plan (2 GB RAM) and bump `NODE_OPTIONS` to `--max-old-space-size=1800` in the dashboard. The starter plan is enough for boot + a handful of concurrent matches but will get tight if many players are online simultaneously.

## Chain: Robinhood Chain (EVM, id 4663)

Everything on-chain runs on Robinhood Chain. Native currency is ETH; the
default RPC is `https://rpc.mainnet.chain.robinhood.com`.

The browser never loads a chain SDK. `src/chain/` speaks raw JSON-RPC over
`fetch` and hand-encodes the only two ERC-20 calls the client makes
(`balanceOf`, `transfer`), which keeps the client bundle free of a ~120 KB
web3 library. `ethers` is a **server-only** dependency, used for minting and
for reading the NFT contract.

Writes always go through the injected EIP-1193 wallet, and every write first
calls `ensureRobinhoodChain()` — sending a burn while the wallet sits on
another network would destroy real tokens on the wrong chain.

### $POKE burn shop

Packs are bought by burning $POKE. Pons v2 tokens expose no `burn()`, so a
burn is an ERC-20 `transfer` to `0x…dEaD`. The client signs one transaction and
posts the hash to `POST /api/rewards/burn-pack/:userId`; the server re-reads the
receipt from chain and checks it succeeded, was sent by the claiming wallet, and
moved at least the declared tier's cost to the burn address before rolling any
cards. Replaying a hash returns the same cards rather than granting new ones.

Tiers live in **two** places that must agree — `src/rewards/burnTokens.ts`
(client) and `src/server/tokenBurn.ts` (server, authoritative). Amounts are
`bigint` throughout: 100 000 whole tokens at 18 decimals is 1e23, past
`Number.MAX_SAFE_INTEGER`.

### Card NFTs (ERC-721 on Robinhood Chain)

`contracts/` is a self-contained Hardhat project holding `PokemonCardNFT`.

```bash
cd contracts
npm install
npm test                      # 12 tests, local hardhat network
cp .env.example .env          # DEPLOYER_PRIVATE_KEY + PUBLIC_ORIGIN
npm run deploy                # --network robinhood
```

Two constraints are load-bearing and were learned the hard way on other
Robinhood Chain projects:

- **`evmVersion: "shanghai"`.** The chain is Shanghai-era; compiling for cancun
  emits `MCOPY`/`TSTORE`, which it may not implement.
- **`@openzeppelin/contracts` pinned to `5.0.2`, no caret.** OZ ≥ 5.2 requires
  cancun for the same reason.

The contract is `ERC721Enumerable` on purpose: the Import page needs to answer
"what does this wallet own", and Robinhood Chain has no NFT indexer to ask, so
enumeration has to live in the contract. `tokenURI` is derived on chain as
`<baseURI><cardId>/metadata`, which resolves to this app's own
`/api/cards/:id/metadata` route — no IPFS pinning anywhere.

Minting is gated on a minter set rather than on `owner`, so the server's hot key
can be rotated with `npm run grant-minter` without moving contract ownership.
The server serialises mints through a queue: nine mints fired concurrently from
one key would collide on the nonce and silently drop cards.

## How to play

1. Each player chooses an opening Active Pokemon and optional Benched Basic Pokemon from their opening hand.
2. On your turn, draw, then take actions in any order.
3. Attack or pass to end your turn.
4. Take all 6 Prize cards, leave your opponent with no Pokemon in play, or deck your opponent at the start of their turn to win.

Use Matchmaking to create an online challenge as Player 0 or accept an open challenge as Player 1. Hidden hands stay filtered per player by boardgame.io credentials and `playerView`.

