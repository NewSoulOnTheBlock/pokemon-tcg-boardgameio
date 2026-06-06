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
npm run build        # tsc + vite build (also rebuilds the card manifest)
npm run build:cards  # regenerate the slim card manifest only
```

Open `http://localhost:5173` in two different browser windows for online matches — each window logs in as a separate profile, picks a deck, and creates or joins a match. In production the Vite build is served by the same Koa server as the API and socket.io, so the browser uses `window.location.origin`; only set `VITE_BGIO_SERVER` when the static client is hosted on a different origin than the game server.

### Card data manifest

The vendored Pokemon TCG dataset ships as ~25 MB of raw JSON across 168 files. To keep the production bundle reasonable, `scripts/build-card-manifest.mjs` runs as a `prebuild` step and emits one slim `src/data/card-manifest.generated.json` containing only the fields the game actually uses (image URLs follow the canonical `images.pokemontcg.io/<set>/<number>.png` pattern and are derived at runtime). The generated manifest is gitignored. Re-run `npm run build:cards` after pulling new upstream card data.

### Backend storage

The multiplayer server uses PostgreSQL when `DATABASE_URL` is set, otherwise it falls back to local FlatFile storage in `./storage` (override with `BGIO_STORAGE_DIR`). When Postgres is configured the same database stores:

- boardgame.io match state in `bgio_matches`
- profile/login records in `app_profiles`
- opened booster pack history and pulled card IDs in `app_pack_purchases`
- per-user match records in `app_match_records`

`/api/health` returns `{ ok, storage, profileStorage }` for liveness checks.

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
| `VITE_PACK_PAYMENT_RECIPIENT` | Solana address that receives booster pack payments. |
| `VITE_SOLANA_RPC_URL` | Solana RPC endpoint (defaults to mainnet-beta). |

## Deploying to Render.com

This repo includes a `render.yaml` blueprint that provisions one Node web service + one free Postgres database, wires `DATABASE_URL` automatically, and points the Render health check at `/api/health`.

1. Push this repo to GitHub.
2. In the Render dashboard: **New → Blueprint**, point at the repo, click **Apply**.
3. Render runs `npm ci && npm run build` and starts `npm run server`. The boardgame.io socket.io server, lobby REST API, custom `/api/*` profile endpoints, and the static React build are all served from the same port.
4. After the first deploy, set `ALLOW_ORIGIN` to the production URL (e.g. `https://your-app.onrender.com`).

## Paid boosters

Booster packs cost `0.1 SOL` and require a connected Solana wallet. Set the recipient address before running the Vite app:

```bash
VITE_PACK_PAYMENT_RECIPIENT=<your-solana-recipient-address>
VITE_SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

`VITE_SOLANA_RPC_URL` defaults to mainnet-beta if omitted. Booster pulls are added to the local profile collection and become usable in the Profile deckbuilder. When `VITE_PACK_PAYMENT_RECIPIENT` is unset the build tree-shakes the payment path entirely and `@solana/web3.js` is never downloaded.

## How to play

1. Each player chooses an opening Active Pokemon and optional Benched Basic Pokemon from their opening hand.
2. On your turn, draw, then take actions in any order.
3. Attack or pass to end your turn.
4. Take all 6 Prize cards, leave your opponent with no Pokemon in play, or deck your opponent at the start of their turn to win.

Use Matchmaking to create an online challenge as Player 0 or accept an open challenge as Player 1. Hidden hands stay filtered per player by boardgame.io credentials and `playerView`.

