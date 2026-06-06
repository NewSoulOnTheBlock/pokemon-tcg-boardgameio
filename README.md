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
| `VITE_PACK_PAYMENT_RECIPIENT` | Solana address that receives booster pack payments. |
| `VITE_SOLANA_RPC_URL` | Solana RPC endpoint (defaults to mainnet-beta). |
| `NODE_OPTIONS` | Caps the V8 heap (`--max-old-space-size=420` in the Render blueprint). Bump to ~1800 if you upgrade to the Standard plan (2 GB RAM). |

## Deploying to Render.com

This repo includes a `render.yaml` blueprint that provisions one Node web service + one free Postgres database, wires `DATABASE_URL` automatically, sets `NODE_OPTIONS=--max-old-space-size=420` so V8 GCs aggressively below the 512 MB starter cap, and points the Render health check at `/api/health`.

1. Push this repo to GitHub.
2. In the Render dashboard: **New → Blueprint**, point at the repo, click **Apply**.
3. Render runs `npm ci && npm run build` (which produces `dist/` + `dist-server/server.mjs`) and starts `npm start` (plain `node dist-server/server.mjs`).
4. After the first deploy, set `ALLOW_ORIGIN` to the production URL (e.g. `https://your-app.onrender.com`).

If you see OOM kills under sustained load, the cheapest fix is to upgrade the web service to the **Standard** plan (2 GB RAM) and bump `NODE_OPTIONS` to `--max-old-space-size=1800` in the dashboard. The starter plan is enough for boot + a handful of concurrent matches but will get tight if many players are online simultaneously.

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

