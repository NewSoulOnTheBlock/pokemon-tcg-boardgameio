# Pokemon TCG boardgame.io

A playable boardgame.io implementation of the core Pokemon Trading Card Game rules from the official Pokemon TCG rulebook.

## Scope

This project implements the rules engine for a two-player Pokemon TCG match: setup with mulligans, hidden hands/decks/Prize cards, Bench limits, turn actions, Energy attachment, evolution timing, Trainer limits, retreating, attacking, Weakness/Resistance, Knock Outs, Prize cards, Pokemon Checkup, Special Conditions, and primary win conditions.

It includes compact starter decks backed by a vendored English Pokemon TCG card database from `PokemonTCG/pokemon-tcg-data`, stored under `src/data/pokemon-tcg-data` so cards are loaded locally instead of from the API.

## Commands

```bash
npm install
npm run dev:server
npm run dev
npm test
npm run build
```

Run `npm run dev:server` in one terminal and `npm run dev` in another for online matches. Local Vite browsers connect to `http://localhost:8000` by default. In production, the browser uses the same origin as the hosted app; set `VITE_BGIO_SERVER=http://host:8000` only when the frontend and lobby/game server are hosted separately.

The multiplayer server uses PostgreSQL when `DATABASE_URL` is set, otherwise it falls back to local FlatFile storage in `./storage` unless `BGIO_STORAGE_DIR` is set. On Render, add your Postgres database's Internal Database URL as `DATABASE_URL` on the web service. If your database URL requires SSL, set `PGSSLMODE=require`; use `PGSSLMODE=no-verify` only for providers with self-signed certificates.

## Paid boosters

Booster packs cost `0.1 SOL` and require a connected Solana wallet. Set the recipient address before running the Vite app:

```bash
VITE_PACK_PAYMENT_RECIPIENT=<your-solana-recipient-address>
VITE_SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

`VITE_SOLANA_RPC_URL` defaults to mainnet-beta if omitted. Booster pulls are added to the local profile collection and become usable in the Profile deckbuilder.

## How to play

1. Each player chooses an opening Active Pokemon and optional Benched Basic Pokemon from their opening hand.
2. On your turn, draw, then take actions in any order.
3. Attack or pass to end your turn.
4. Take all 6 Prize cards, leave your opponent with no Pokemon in play, or deck your opponent at the start of their turn to win.

Use Matchmaking to create an online challenge as Player 0 or accept an open challenge as Player 1. Hidden hands stay filtered per player by boardgame.io credentials and `playerView`.
