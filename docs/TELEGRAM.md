# Telegram Mini App Setup

The Pokemon TCG Arena (https://pokemasterstcg.xyz) is a fully
functional Telegram Mini App in addition to a standalone web app. The
same URL serves both — opening it inside Telegram auto-detects the
runtime and switches to the Telegram-friendly flow.

## What works inside Telegram

- **Sign-in** — your Telegram username is used as the trainer name; no
  wallet popup. A stable Telegram-derived identity (`tg:<userId>`)
  replaces the wallet for profile, leaderboard, and match-record
  lookups.
- **CPU matches** — full vs-bot play.
- **Casual multiplayer** — create / accept matches against other
  players.
- **Deckbuilder, collection, imports view, leaderboard, match history.**
- **BackButton** — Telegram's native back arrow navigates the app.
- **Theme** — picks up the user's Telegram color scheme.
- **Music** — same menu + battle loops as the web build.

## What requires a browser

These features need a real Solana wallet (Phantom / Solflare / Backpack)
which Telegram's webview can't host:

- **Booster packs** — pump.fun $6 USDC payments + NFT minting.
- **Wager matches** — wallet address is needed for off-app settlement.
- **NFT match prizes** — the prize card is still rolled, but the NFT
  mint is skipped (the card lands in the collection without an NFT).

Users see a friendly "Open in browser to connect a wallet" hint on
those pages.

## Registering the bot with @BotFather

1. Open Telegram and message [@BotFather](https://t.me/botfather).
2. `/newbot` -> pick a display name (e.g. `Pokemon Masters TCG`) and a
   handle (e.g. `pokemasterstcg_bot`).
3. Copy the bot token BotFather gives you. Store it as a secret; you
   don't need it in the web app build (Mini App runtime doesn't require
   a token to render). You **will** need it later if you want to verify
   Telegram `initData` server-side for trusted operations.
4. `/setdomain` -> choose the bot -> enter `pokemasterstcg.xyz` (without
   a scheme). This whitelists the domain for Mini App embedding.
5. `/newapp` -> choose the bot ->
   - **Title**: `Pokemon TCG Arena`
   - **Description**: `Build decks, mint cards, battle in 8-bit.`
   - **Photo**: upload `public/site-logo.png` (or any 640x360 PNG).
   - **GIF/demo**: optional.
   - **Web App URL**: `https://pokemasterstcg.xyz`
   - **Short name**: `play` (will appear in `t.me/<bot>/play`).
6. After BotFather confirms, share the launch URL with users:
   - **Direct link**: `https://t.me/<your_bot>/play`
   - **Inline button** in any chat: see the JSON below.

## Inline "Play" button (optional)

If you run a custom bot backend you can post chat messages with a
`web_app` button that opens the Mini App in one tap:

```json
{
  "chat_id": "<USER_OR_CHAT_ID>",
  "text": "Open the arena",
  "reply_markup": {
    "inline_keyboard": [[
      { "text": "Play Pokemon TCG", "web_app": { "url": "https://pokemasterstcg.xyz" } }
    ]]
  }
}
```

POST that to `https://api.telegram.org/bot<TOKEN>/sendMessage`.

## Trusted `initData` verification (later)

When the Mini App boots, `window.Telegram.WebApp.initData` is a signed
querystring. For anything that grants real value (NFTs, payouts,
leaderboard rank), the server must verify the signature using the bot
token before trusting the claimed user id:

1. Parse the querystring, extract the `hash` parameter.
2. Sort the remaining key=value pairs alphabetically, join with `\n`.
3. Compute `HMAC-SHA256(secret, dataString)` where
   `secret = HMAC-SHA256("WebAppData", BOT_TOKEN)`.
4. Compare to the `hash` parameter.

We don't currently grant Telegram identities any wallet-gated rewards,
so `initData` is used client-side only for display/identity. If we ever
want a Telegram leaderboard mint or daily-prize stream we'll add this
verification on the relevant endpoints.

## Local testing

Telegram doesn't render Mini Apps from `localhost`. To test:

1. Run `npm run dev` locally.
2. Tunnel via Cloudflare Tunnel / ngrok: `cloudflared tunnel --url http://localhost:5173`.
3. Set the tunnel URL temporarily as the Mini App URL via
   `/setmenubutton` or `/myapps` in BotFather.
4. Open the bot in Telegram -> tap the menu button -> Mini App opens.

Restore the production URL when done.
