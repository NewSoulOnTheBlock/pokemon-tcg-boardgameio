import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sep as pathSep } from 'node:path';
import type { Context, Next } from 'koa';
import { koaBody } from 'koa-body';
import serve from 'koa-static';
import { CARD_LIBRARY, cardLibrarySize, initCardLibrary } from './game/cards';
import { loadBundledCards } from './game/cards-server-bootstrap';
import { PokemonTCG } from './game/PokemonTCG';
import type { Card } from './game/types';
import { MemoryCardStorage, PostgresCardStorage, type CardStorage } from './server/cardStorage';
import { buildBoosterableSets, rollBoosterPack } from './server/boosters';
import { createNftMinter, type NftMinter } from './server/nftMinter';
import { buildSetNameIndex, scanWalletForPokemonNfts } from './server/nftScanner';
import { PostgresStorage, postgresSslFromEnv } from './server/postgresStorage';
import { MemoryProfileStorage, PostgresProfileStorage, type ProfileStorage } from './server/profileStorage';
import { rollPrizeCard } from './server/prizes';
import { createPumpPaymentService, type PumpPaymentService } from './server/pumpPayments';
import { LOBBY_CHAT_LIMITS, MemoryLobbyChatStore, PostgresLobbyChatStore, RateLimitError, ValidationError, type LobbyChatStore } from './server/lobbyChat';
import type { MatchRecord, PackPurchase, ProfileState } from './shared/profile';
import setsManifest from './data/pokemon-tcg-data/sets/en.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const { FlatFile, Origins, Server } = require('boardgame.io/server') as typeof import('boardgame.io/server');

const port = Number(process.env.PORT ?? 8000);
const databaseUrl = process.env.DATABASE_URL;
const storageDir = process.env.BGIO_STORAGE_DIR ?? './storage';
const allowOrigin = process.env.ALLOW_ORIGIN ?? process.env.CLIENT_ORIGIN ?? '';
const allowedOrigins = allowOrigin
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const origins = allowedOrigins.length > 0
  ? [Origins.LOCALHOST_IN_DEVELOPMENT, ...allowedOrigins]
  : Origins.LOCALHOST_IN_DEVELOPMENT;
const db = databaseUrl
  ? new PostgresStorage({ connectionString: databaseUrl, ssl: postgresSslFromEnv() })
  : new FlatFile({ dir: storageDir, logging: false });
const profileStorage: ProfileStorage = databaseUrl
  ? new PostgresProfileStorage(databaseUrl, postgresSslFromEnv(), {
      leaderboardResetAt: process.env.LEADERBOARD_RESET_AT?.trim() || undefined,
    })
  : new MemoryProfileStorage();
const cardStorage: CardStorage = databaseUrl
  ? new PostgresCardStorage(databaseUrl, postgresSslFromEnv())
  : new MemoryCardStorage();
const lobbyChat: LobbyChatStore = databaseUrl
  ? new PostgresLobbyChatStore(databaseUrl, postgresSslFromEnv())
  : new MemoryLobbyChatStore();
const storageLabel = databaseUrl ? 'postgres' : 'flat-file';
const profileLabel = databaseUrl ? 'postgres' : 'memory';
const cardStorageLabel = databaseUrl ? 'postgres' : 'memory';

// ----- Solana / NFT minter -----------------------------------------------
//
// Server-side mints happen with a treasury keypair so users don't sign N
// transactions per pack. The treasury is normally the same wallet that
// receives the 0.1 SOL pack payment. If SOLANA_TREASURY_SECRET_KEY isn't
// set, the server records pack purchases but skips minting entirely (the
// /api/boosters/mint endpoint returns 503).
const solanaRpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const treasurySecret = process.env.SOLANA_TREASURY_SECRET_KEY?.trim();
const publicOrigin = process.env.PUBLIC_ORIGIN ?? allowedOrigins[0] ?? '';

let nftMinter: NftMinter | undefined;
try {
  if (treasurySecret) {
    nftMinter = createNftMinter({ rpcUrl: solanaRpcUrl, treasurySecretKeyBase58: treasurySecret });
    console.log(`[pokemon-tcg] NFT minter ready (treasury=${nftMinter.treasury})`);
  } else {
    console.log('[pokemon-tcg] NFT minter disabled (SOLANA_TREASURY_SECRET_KEY not set)');
  }
} catch (err) {
  console.error(`[pokemon-tcg] NFT minter init failed: ${err instanceof Error ? err.message : String(err)}`);
  nftMinter = undefined;
}

// ----- Pump.fun payments -------------------------------------------------
//
// Booster pack purchases route through pump.fun's tokenized agent payment
// system. The server builds an unsigned Transaction, the client signs and
// submits it, and the server then verifies the invoice via pump.fun's
// HTTP API (with RPC fallback) before minting NFTs. Disabled gracefully
// if AGENT_TOKEN_MINT_ADDRESS / CURRENCY_MINT / PAYMENT_AMOUNT are unset.
//
// MINT_FEE_LAMPORTS env var: when set + nftMinter is configured, the
// same signed payment tx ALSO transfers this many lamports of SOL to
// the treasury so the user pays the on-chain mint rent up front. 8
// Metaplex Core mints at ~0.0015 SOL each plus tx fees ≈ 0.012 SOL,
// so we default to 15_000_000 lamports (= 0.015 SOL) for a small
// safety margin. Set to 0 to disable.
const agentMintEnv = process.env.AGENT_TOKEN_MINT_ADDRESS?.trim();
const currencyMintEnv = process.env.CURRENCY_MINT?.trim();
const paymentAmountEnv = process.env.PAYMENT_AMOUNT?.trim();
const mintFeeLamportsEnv = process.env.MINT_FEE_LAMPORTS?.trim();
const DEFAULT_MINT_FEE_LAMPORTS = 15_000_000;
let pumpPayments: PumpPaymentService | undefined;
try {
  if (agentMintEnv && currencyMintEnv && paymentAmountEnv) {
    const amount = Number(paymentAmountEnv);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`PAYMENT_AMOUNT must be a positive number (got "${paymentAmountEnv}")`);
    }
    const mintFeeLamports = mintFeeLamportsEnv === undefined || mintFeeLamportsEnv === ''
      ? DEFAULT_MINT_FEE_LAMPORTS
      : Number(mintFeeLamportsEnv);
    if (!Number.isFinite(mintFeeLamports) || mintFeeLamports < 0) {
      throw new Error(`MINT_FEE_LAMPORTS must be a non-negative number (got "${mintFeeLamportsEnv}")`);
    }
    pumpPayments = createPumpPaymentService({
      agentMintAddress: agentMintEnv,
      currencyMintAddress: currencyMintEnv,
      amountSmallestUnit: amount,
      rpcUrl: solanaRpcUrl,
      mintFeeLamports,
      mintFeeRecipient: nftMinter?.treasury,
    });
    if (nftMinter && mintFeeLamports > 0) {
      console.log(`[pokemon-tcg] pump.fun payments ready (mint=${pumpPayments.agentMint.toBase58()}, amount=${pumpPayments.amount}, mintFee=${mintFeeLamports} lamports -> ${nftMinter.treasury})`);
    } else {
      console.log(`[pokemon-tcg] pump.fun payments ready (mint=${pumpPayments.agentMint.toBase58()}, amount=${pumpPayments.amount}; mint-fee reimbursement disabled)`);
    }
  } else {
    console.log('[pokemon-tcg] pump.fun payments disabled (AGENT_TOKEN_MINT_ADDRESS / CURRENCY_MINT / PAYMENT_AMOUNT missing)');
  }
} catch (err) {
  console.error(`[pokemon-tcg] pump.fun payments init failed: ${err instanceof Error ? err.message : String(err)}`);
  pumpPayments = undefined;
}

// ----- Card library bootstrap -------------------------------------------
//
// Postgres is the source of truth for the card catalogue. On first ever boot
// `app_cards` is empty, so we fall back to the bundled slim manifest,
// populate CARD_LIBRARY, then upsert into Postgres. Subsequent boots load
// straight from Postgres and the manifest is dead bundle weight (kept for
// disaster recovery, eventually drop with a separate migration step).
async function bootstrapCardLibrary(): Promise<void> {
  await cardStorage.connect();
  const hasCards = await cardStorage.hasCards();
  if (hasCards) {
    const cards = await cardStorage.listCards();
    initCardLibrary(cards);
    console.log(`[pokemon-tcg] loaded ${cards.length} cards from ${cardStorageLabel}`);
  } else {
    const cards = loadBundledCards();
    initCardLibrary(cards);
    console.log(`[pokemon-tcg] bootstrapping ${cards.length} cards from bundled manifest...`);
    await cardStorage.bulkUpsert(cards);
    console.log(`[pokemon-tcg] persisted card library to ${cardStorageLabel}`);
  }
}

await bootstrapCardLibrary();
await lobbyChat.connect();

// Pre-serialise the catalogue once so /api/cards/library never re-walks the
// 20k+ entry Proxy on every request. ~8 MB string in memory.
const cardsJsonCache: string = JSON.stringify(Object.values(CARD_LIBRARY));

// Index sets by name / PTCGO code so the NFT import scanner can resolve
// "Base Set" / "Scarlet & Violet" / "SVI" etc. -> setId. Built once.
const setNameIndex = buildSetNameIndex(setsManifest as Array<{ id: string; name: string; ptcgoCode?: string }>);

const server = Server({
  games: [PokemonTCG],
  origins,
  apiOrigins: origins,
  db,
});
const distPath = fileURLToPath(new URL('../dist/', import.meta.url));
const indexPath = fileURLToPath(new URL('../dist/index.html', import.meta.url));

server.app.use(async (ctx: Context, next: Next) => {
  try {
    await next();
  } catch (err) {
    const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
    if (status >= 500) {
      console.error(`[api ${ctx.method} ${ctx.path}] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    ctx.status = status;
    ctx.type = 'application/json';
    ctx.body = { error: err instanceof Error ? err.message : String(err) };
  }
});

const jsonBody = koaBody({ jsonLimit: '256kb' });

server.router.get('/health', (ctx) => {
  ctx.body = { ok: true, storage: storageLabel, profileStorage: profileLabel, cardStorage: cardStorageLabel, cards: cardLibrarySize(), nftMinter: Boolean(nftMinter) };
});

server.router.get('/api/health', (ctx) => {
  ctx.body = { ok: true, storage: storageLabel, profileStorage: profileLabel, cardStorage: cardStorageLabel, cards: cardLibrarySize(), nftMinter: Boolean(nftMinter) };
});

server.router.get('/api/cards/library', (ctx) => {
  ctx.type = 'application/json';
  // The catalogue rarely changes between deploys. 1 hour browser cache; bump
  // higher once /api/cards/library?v=<hash> is wired up for cache busting.
  ctx.set('Cache-Control', 'public, max-age=3600');
  ctx.body = cardsJsonCache;
});

/**
 * Metaplex-standard NFT metadata for a single card. Used as the `uri` for
 * each Core asset minted in /api/boosters/mint. Phantom / Solflare fetch
 * this URL when displaying the NFT.
 *
 * Example: /api/cards/sv1-13/metadata
 */
server.router.get('/api/cards/:id/metadata', (ctx) => {
  const card = CARD_LIBRARY[ctx.params.id] as Card | undefined;
  if (!card) {
    ctx.throw(404, `Unknown card ${ctx.params.id}`);
    return;
  }
  const attributes: Array<{ trait_type: string; value: string | number }> = [];
  if (card.rarity) attributes.push({ trait_type: 'Rarity', value: card.rarity });
  attributes.push({ trait_type: 'Kind', value: card.kind });
  if (card.kind === 'pokemon') {
    attributes.push({ trait_type: 'Type', value: card.pokemonType });
    attributes.push({ trait_type: 'Stage', value: card.stage });
    attributes.push({ trait_type: 'HP', value: card.hp });
    if (card.ruleBox) attributes.push({ trait_type: 'Rule Box', value: card.ruleBox });
  } else if (card.kind === 'energy') {
    attributes.push({ trait_type: 'Energy Type', value: card.energyType });
  } else if (card.kind === 'trainer') {
    attributes.push({ trait_type: 'Trainer Type', value: card.trainerType });
  }
  const sourceId = card.sourceId ?? card.id;
  const setId = sourceId.includes('-') ? sourceId.split('-')[0] : sourceId;
  attributes.push({ trait_type: 'Set', value: setId });
  const image = card.images?.large ?? card.images?.small ?? '';
  const description = card.kind === 'pokemon'
    ? `${card.name} — ${card.stage} ${card.pokemonType} Pokemon, ${card.hp} HP. From ${setId.toUpperCase()}.`
    : `${card.name} — ${card.kind === 'energy' ? 'Energy' : 'Trainer'} card from ${setId.toUpperCase()}.`;
  ctx.type = 'application/json';
  ctx.set('Cache-Control', 'public, max-age=86400');
  ctx.body = {
    name: card.name,
    symbol: 'PTCG',
    description,
    image,
    external_url: publicOrigin || `https://images.pokemontcg.io/${setId}/`,
    attributes,
    properties: {
      category: 'image',
      files: image ? [{ uri: image, type: 'image/png' }] : [],
    },
  };
});

/**
 * Replaces /api/boosters/mint. Now a two-step flow gated by pump.fun:
 *   1) POST /api/boosters/invoice  -> server builds an unsigned base64
 *      Transaction targeting the agent token mint, returns invoice
 *      params + the tx for the client to sign.
 *   2) POST /api/boosters/redeem   -> client submits the signed signature
 *      back along with invoice params + pack choice; server verifies on
 *      chain via PumpAgent.validateInvoicePayment, then rolls the pack
 *      deterministically from (setId, memo) and mints NFTs.
 */
server.router.post('/api/boosters/invoice', jsonBody, async (ctx) => {
  if (!pumpPayments) {
    ctx.throw(503, 'Booster payments are not configured on this server (AGENT_TOKEN_MINT_ADDRESS missing).');
    return;
  }
  const body = ctx.request.body as { walletAddress?: string } | undefined;
  const walletAddress = body?.walletAddress?.trim();
  if (!walletAddress) {
    ctx.throw(400, 'walletAddress (base58 pubkey) is required.');
    return;
  }
  try {
    const invoice = await pumpPayments.buildInvoice(walletAddress);
    ctx.body = invoice;
  } catch (err) {
    console.error(`[invoice] build failed for ${walletAddress}: ${err instanceof Error ? err.message : String(err)}`);
    ctx.throw(502, `Failed to build invoice: ${err instanceof Error ? err.message : String(err)}`);
  }
});

server.router.post('/api/boosters/redeem', jsonBody, async (ctx) => {
  if (!pumpPayments) {
    ctx.throw(503, 'Booster payments are not configured on this server.');
    return;
  }
  if (!nftMinter) {
    ctx.throw(503, 'NFT minter is not configured on this server (SOLANA_TREASURY_SECRET_KEY missing).');
    return;
  }
  const body = ctx.request.body as {
    walletAddress?: string;
    memo?: string;
    startTime?: string;
    endTime?: string;
    setId?: string;
    paymentSignature?: string;
  } | undefined;
  const walletAddress = body?.walletAddress?.trim();
  const memo = body?.memo?.trim();
  const startTime = body?.startTime?.trim();
  const endTime = body?.endTime?.trim();
  const setId = body?.setId?.trim();
  const paymentSignature = body?.paymentSignature?.trim() || '';
  if (!walletAddress || !memo || !startTime || !endTime || !setId) {
    ctx.throw(400, 'walletAddress, memo, startTime, endTime, and setId are required.');
    return;
  }

  // Step 1: verify the on-chain payment for this exact invoice.
  const paid = await pumpPayments.verifyInvoice({ walletAddress, memo, startTime, endTime });
  if (!paid) {
    ctx.throw(402, 'Payment for this invoice has not been confirmed yet. Wait a few seconds and retry.');
    return;
  }

  // Step 2: roll the pack contents deterministically from (setId, memo).
  // Same invoice -> same cards on every redeem attempt, so the user can
  // safely retry without minting a different pack each time.
  const set = buildBoosterableSets().find((candidate) => candidate.id === setId);
  if (!set) {
    ctx.throw(400, `Unknown set: ${setId}`);
    return;
  }
  const pack = rollBoosterPack(set, memo);

  // Step 3: mint each card to the user's wallet as a Metaplex Core asset.
  const base = publicOrigin || `${ctx.protocol}://${ctx.host}`;
  const mints: Awaited<ReturnType<typeof nftMinter.mintCard>>[] = [];
  for (const pulled of pack) {
    const metadataUri = `${base}/api/cards/${encodeURIComponent(pulled.card.id)}/metadata`;
    try {
      mints.push(await nftMinter.mintCard(walletAddress, pulled.card, metadataUri));
    } catch (err) {
      console.error(`[mint] redeem mint failed for ${pulled.card.id} -> ${walletAddress}: ${err instanceof Error ? err.message : String(err)}`);
      ctx.status = 502;
      ctx.body = {
        error: `Payment confirmed but mint failed at ${pulled.card.id}: ${err instanceof Error ? err.message : String(err)}`,
        pack,
        mints,
      };
      return;
    }
  }

  ctx.body = {
    treasury: nftMinter.treasury,
    pack,
    mints,
    invoice: { memo, startTime, endTime, walletAddress, setId, paymentSignature },
  };
});

server.router.post('/api/login', jsonBody, async (ctx) => {
  const body = ctx.request.body as { profile?: ProfileState } | undefined;
  const profile = body?.profile;
  if (!profile?.name) {
    ctx.throw(400, 'profile.name is required');
    return;
  }
  ctx.body = await profileStorage.login(profile);
});

server.router.put('/api/profiles/:userId', jsonBody, async (ctx) => {
  const body = ctx.request.body as { profile?: ProfileState } | undefined;
  const profile = body?.profile;
  if (!profile) {
    ctx.throw(400, 'profile is required');
    return;
  }
  ctx.body = await profileStorage.saveProfile(ctx.params.userId, profile);
});

server.router.post('/api/profiles/:userId/packs', jsonBody, async (ctx) => {
  const body = ctx.request.body as { profile?: ProfileState; purchase?: PackPurchase } | undefined;
  const profile = body?.profile;
  const purchase = body?.purchase;
  if (!profile || !purchase?.signature || !Array.isArray(purchase.cardIds)) {
    ctx.throw(400, 'profile and purchase with signature/cardIds are required');
    return;
  }
  ctx.body = await profileStorage.recordPack(ctx.params.userId, purchase, profile);
});

server.router.post('/api/profiles/:userId/matches', jsonBody, async (ctx) => {
  const body = ctx.request.body as { record?: MatchRecord } | undefined;
  const record = body?.record;
  if (!record?.matchID || !record.playerID) {
    ctx.throw(400, 'record.matchID and record.playerID are required');
    return;
  }
  ctx.body = await profileStorage.recordMatch(ctx.params.userId, record);
});

server.router.get('/api/leaderboard', async (ctx) => {
  ctx.body = await profileStorage.listLeaderboard();
});

/**
 * Lobby trollbox — public chat shown on the matchmaking page. Plain HTTP
 * polling (every few seconds from the client) so we don't need to spin
 * up a separate WebSocket channel. Messages are rate-limited per
 * (userId, IP), capped at 280 chars, and trimmed to the last 200
 * messages.
 */
server.router.get('/api/lobby/chat', async (ctx) => {
  const since = typeof ctx.query.since === 'string' ? ctx.query.since : undefined;
  const limitParam = typeof ctx.query.limit === 'string' ? Number(ctx.query.limit) : NaN;
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
  const messages = await lobbyChat.recent(since, limit);
  ctx.body = { messages, limits: LOBBY_CHAT_LIMITS };
});

server.router.post('/api/lobby/chat', jsonBody, async (ctx) => {
  const body = ctx.request.body as { userId?: string; name?: string; text?: string } | undefined;
  if (!body) {
    ctx.throw(400, 'JSON body required');
    return;
  }
  const ip = (ctx.request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim())
    || ctx.request.ip
    || undefined;
  try {
    const message = await lobbyChat.post({
      userId: body.userId ?? '',
      name: body.name ?? '',
      text: body.text ?? '',
      postedFromIp: ip,
    });
    ctx.body = { message, limits: LOBBY_CHAT_LIMITS };
  } catch (err) {
    if (err instanceof RateLimitError) {
      ctx.status = 429;
      ctx.set('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
      ctx.body = { error: 'Rate limited', retryAfterMs: err.retryAfterMs };
      return;
    }
    if (err instanceof ValidationError) {
      ctx.throw(400, err.message);
      return;
    }
    throw err;
  }
});

/**
 * Free prize card for the winner of a multiplayer match. Idempotent per
 * (winner profile, match, player slot) — the prize_claimed flag on
 * app_match_records prevents a second roll. Mints the card as a Metaplex
 * Core NFT to the wallet, falling back to a no-mint claim if the
 * treasury minter isn't configured (still records the prize so the user
 * gets it in their collection).
 */
server.router.post('/api/matches/:matchID/prize', jsonBody, async (ctx) => {
  if (typeof profileStorage.findProfileByWallet !== 'function'
      || typeof profileStorage.reservePrizeClaim !== 'function'
      || typeof profileStorage.recordPrizeClaim !== 'function') {
    ctx.throw(503, 'Prize claiming requires Postgres-backed profile storage.');
    return;
  }
  const matchID = ctx.params.matchID;
  const body = ctx.request.body as { walletAddress?: string; playerID?: string } | undefined;
  const walletAddress = body?.walletAddress?.trim();
  const playerID = body?.playerID?.trim();
  if (!matchID || !walletAddress || !playerID) {
    ctx.throw(400, 'matchID, walletAddress, and playerID are required.');
    return;
  }
  if (playerID !== '0' && playerID !== '1') {
    ctx.throw(400, 'playerID must be "0" or "1".');
    return;
  }

  const profile = await profileStorage.findProfileByWallet(walletAddress);
  if (!profile) {
    ctx.throw(404, 'No profile found for that wallet. Sign in first.');
    return;
  }

  const reservation = await profileStorage.reservePrizeClaim(profile.userId, matchID, playerID);
  if (!reservation.eligible) {
    if (reservation.reason === 'already_claimed' && reservation.alreadyClaimed) {
      const cachedCard = CARD_LIBRARY[reservation.alreadyClaimed.cardId];
      ctx.status = 200;
      ctx.body = {
        alreadyClaimed: true,
        card: cachedCard ?? null,
        mint: reservation.alreadyClaimed.mintAddress ? {
          mintAddress: reservation.alreadyClaimed.mintAddress,
          signature: reservation.alreadyClaimed.signature ?? '',
        } : null,
      };
      return;
    }
    if (reservation.reason === 'no_match_record') {
      ctx.throw(404, 'Match record not found. Make sure the match was completed and recorded.');
      return;
    }
    if (reservation.reason === 'not_a_win') {
      ctx.throw(403, 'Prize cards are only awarded for wins.');
      return;
    }
    ctx.throw(409, `Prize claim rejected: ${reservation.reason ?? 'unknown'}.`);
    return;
  }

  const { card } = rollPrizeCard();
  let mint: { mintAddress: string; signature: string } | undefined;
  if (nftMinter) {
    const base = publicOrigin || `${ctx.protocol}://${ctx.host}`;
    const metadataUri = `${base}/api/cards/${encodeURIComponent(card.id)}/metadata`;
    try {
      const result = await nftMinter.mintCard(walletAddress, card, metadataUri);
      mint = { mintAddress: result.mintAddress, signature: result.signature };
    } catch (err) {
      console.error(`[prize] mint failed for ${card.id} -> ${walletAddress}: ${err instanceof Error ? err.message : String(err)}`);
      // Record the claim without mint info — the user still gets the
      // card added to their collection client-side. We do NOT release
      // the reservation because rolling a different card on retry would
      // be surprising; the prize is the card, the NFT is the bonus.
    }
  }

  await profileStorage.recordPrizeClaim(profile.userId, matchID, playerID, {
    cardId: card.id,
    mintAddress: mint?.mintAddress,
    signature: mint?.signature,
  });

  ctx.body = {
    alreadyClaimed: false,
    card,
    mint: mint ?? null,
  };
});

/**
 * Scan a Solana wallet for phygital / Collector Crypt Pokemon NFTs and
 * propose matches against the local card library. The client uses the
 * returned candidates to populate the Import page.
 */
server.router.post('/api/imports/scan', jsonBody, async (ctx) => {
  const body = ctx.request.body as { ownerAddress?: string } | undefined;
  const ownerAddress = body?.ownerAddress?.trim();
  if (!ownerAddress) {
    ctx.throw(400, 'ownerAddress (base58 Solana pubkey) is required.');
    return;
  }
  try {
    const candidates = await scanWalletForPokemonNfts({
      rpcUrl: solanaRpcUrl,
      ownerAddress,
      publicOrigin,
      cardLibrary: CARD_LIBRARY as unknown as Record<string, Card>,
      setIdByName: setNameIndex,
    });
    ctx.body = { ownerAddress, candidates };
  } catch (err) {
    console.error(`[imports] scan failed for ${ownerAddress}: ${err instanceof Error ? err.message : String(err)}`);
    ctx.throw(502, `Wallet scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// Serve hashed asset files with long-lived caching, but keep index.html
// fresh on every load. Without this, a browser can hold onto an old
// index.html that references vite hashed chunks (e.g. walletPayment-XXXX.js)
// which no longer exist after a redeploy, producing a "Failed to fetch
// dynamically imported module" error the moment the user triggers a
// lazy import. The /assets/ chunks are content-hashed so they're safe to
// cache forever; only the entry HTML needs no-store.
server.app.use(serve(distPath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.includes(`${pathSep}assets${pathSep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));
server.app.use(async (ctx, next) => {
  await next();
  const acceptsHtml = ctx.accepts('html');
  if (ctx.status === 404 && ctx.method === 'GET' && acceptsHtml && existsSync(indexPath)) {
    ctx.status = 200;
    ctx.type = 'html';
    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    ctx.body = readFileSync(indexPath, 'utf8');
  }
});

await profileStorage.connect();
await server.run(port, () => {
  console.log(`[pokemon-tcg] listening on http://localhost:${port}`);
  console.log(`[pokemon-tcg] match storage: ${storageLabel} | profile storage: ${profileLabel} | card storage: ${cardStorageLabel}`);
  if (allowedOrigins.length > 0) {
    console.log(`[pokemon-tcg] additional CORS origins: ${allowedOrigins.join(', ')}`);
  }
});
