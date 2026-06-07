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
import { awaitPurchase as awaitPhygitalsPurchase, createPhygitalsClient, PhygitalsError, type PhygitalsClient } from './server/phygitalsClient';
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
const phygitals: PhygitalsClient = createPhygitalsClient();
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
 * Free in-game booster pack. Pokemon TCG cards (NOT Phygitals) are
 * issued by the server as a normal deck-eligible card collection — no
 * payment, no on-chain mint. Phygitals packs (the paid real-card flow)
 * live under /api/phygitals/* instead.
 *
 * Rate-limited per (userId | wallet) on a UTC-day basis so the daily
 * claim button can be the canonical entry point.
 *
 * Other free-pack issuance paths (quest claims, level-up rewards, etc.)
 * call this same endpoint with an optional `source` tag so we can keep
 * a single roller + audit log.
 */
const claimRateLimit = new Map<string, number>(); // key -> last claim epoch ms
const CLAIM_COOLDOWN_MS = 22 * 60 * 60 * 1000; // 22h so timezone slop doesn't lock a user out of "their" day

server.router.post('/api/boosters/claim-free', jsonBody, async (ctx) => {
  const body = ctx.request.body as { userId?: string; walletAddress?: string; setId?: string; source?: string } | undefined;
  const key = (body?.userId?.trim() || body?.walletAddress?.trim() || '').toLowerCase();
  if (!key) {
    ctx.throw(400, 'userId or walletAddress is required to claim the daily pack.');
    return;
  }
  const source = body?.source?.trim() || 'daily';

  // Quest-driven claims bypass the cooldown — they're already gated by
  // the quest-progress check on the client. The "daily" source is the
  // one we enforce.
  if (source === 'daily') {
    const lastClaimed = claimRateLimit.get(key);
    if (lastClaimed && Date.now() - lastClaimed < CLAIM_COOLDOWN_MS) {
      const retryMs = CLAIM_COOLDOWN_MS - (Date.now() - lastClaimed);
      ctx.status = 429;
      ctx.set('Retry-After', String(Math.ceil(retryMs / 1000)));
      ctx.body = { error: 'Daily free pack already claimed', retryAfterMs: retryMs };
      return;
    }
    claimRateLimit.set(key, Date.now());
  }

  // Pick the set: respect explicit setId if given, otherwise rotate
  // through the newest boosterable sets so the daily claim isn't always
  // the same theme.
  const sets = buildBoosterableSets();
  let set = body?.setId ? sets.find((candidate) => candidate.id === body.setId) : undefined;
  if (!set) {
    set = sets[Math.floor(Math.random() * Math.min(5, sets.length))];
  }
  if (!set) {
    ctx.throw(500, 'No boosterable sets configured.');
    return;
  }

  // Roll the pack with a non-deterministic seed; free packs don't get
  // an on-chain mint so we don't need the (paymentSignature, memo)
  // determinism the old pay-to-open flow relied on.
  const seed = `free-${source}-${key}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pack = rollBoosterPack(set, seed);

  ctx.body = {
    pack,
    set: { id: set.id, name: set.name, series: set.series },
    source,
    claimedAt: new Date().toISOString(),
  };
});

// Legacy: the pump.fun pay-to-open booster flow has been removed in
// favour of free in-game packs (claim-free above) + Phygitals (paid
// graded-card storefront, /api/phygitals/*). Keep a 410 here so any
// old client bundle still in someone's cache fails fast with a clear
// message instead of hanging on a deleted endpoint.
server.router.post('/api/boosters/redeem', (ctx) => {
  ctx.status = 410;
  ctx.body = { error: 'Booster purchases have moved. Use /api/boosters/claim-free for free in-game packs or /api/phygitals/* for the Phygitals shop.' };
});

server.router.post('/api/boosters/invoice', (ctx) => {
  ctx.status = 410;
  ctx.body = { error: 'Booster purchases have moved. Use /api/boosters/claim-free for free in-game packs or /api/phygitals/* for the Phygitals shop.' };
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
 * Phygitals Partner API proxy (Jun 2026 surface). The server holds the
 * phy_… X-API-Key and proxies / co-signs calls so the browser never
 * sees the key. The current Phygitals API is built around CLIENT-SIGNED
 * Solana transactions — the server builds the unsigned tx, the user
 * signs with Phantom, and we forward the signed bytes to Phygitals.
 *
 * Surface mapping:
 *   GET  /api/phygitals/status            -> {enabled, baseUrl}
 *   GET  /api/phygitals/packs             -> Phygitals GET /api/vm/available
 *   POST /api/phygitals/buy/prepare       -> build unsigned buy tx for client to sign
 *   POST /api/phygitals/buy/submit        -> forward signed tx to Phygitals POST /api/vm/buy/crypto
 *   POST /api/phygitals/buy/status        -> Phygitals POST /api/vm/buy/status
 *   POST /api/phygitals/sellback/init     -> Phygitals POST /api/marketplace/transaction/take-claw-bid-init
 *   POST /api/phygitals/sellback/finish   -> Phygitals POST /api/marketplace/transaction/take-claw-bid-finish
 *
 * Inventory, ship*, recent-pulls, chase, card-detail are NOT supported
 * by the current Phygitals surface; we no longer expose them.
 */
function handlePhygitalsError(ctx: Context, err: unknown): void {
  if (err instanceof PhygitalsError) {
    ctx.status = err.status >= 400 && err.status < 600 ? err.status : 502;
    ctx.type = 'application/json';
    ctx.body = err.body && typeof err.body === 'object' ? err.body : { error: err.message };
    return;
  }
  throw err;
}

server.router.get('/api/phygitals/status', (ctx) => {
  ctx.body = { enabled: phygitals.enabled, baseUrl: phygitals.baseUrl };
});

/**
 * Debug endpoint: makes the raw GET /api/vm/available call directly
 * from the server using global fetch, and returns the full response
 * status + first 600 chars of the body. Used to diagnose 403s where
 * the same request works locally but fails from Render.
 *
 * Safe to leave in production — does not reveal the API key.
 */
server.router.get('/api/phygitals/debug', async (ctx) => {
  const apiKey = process.env.PHYGITALS_API_KEY?.trim() ?? '';
  const baseUrl = process.env.PHYGITALS_BASE_URL?.trim() || 'https://api.phygitals.com';
  const browserHeaders: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    Referer: 'https://phygitals.com/',
    Origin: 'https://phygitals.com',
  };
  const probe = async (label: string, headers: Record<string, string>) => {
    try {
      const res = await fetch(`${baseUrl}/api/vm/available`, { headers });
      const text = await res.text();
      return {
        label,
        status: res.status,
        contentType: res.headers.get('content-type'),
        cfRay: res.headers.get('cf-ray'),
        bodyPreview: text.slice(0, 240),
      };
    } catch (err) {
      return { label, error: (err as Error).message };
    }
  };
  ctx.body = {
    apiKeyPresent: apiKey.length > 0,
    apiKeyPrefix: apiKey.slice(0, 8),
    apiKeyLength: apiKey.length,
    baseUrl,
    probes: await Promise.all([
      probe('bare', { Accept: 'application/json' }),
      probe('browser', browserHeaders),
      probe('browser+key', { ...browserHeaders, 'X-API-Key': apiKey }),
    ]),
  };
});

server.router.get('/api/phygitals/packs', async (ctx) => {
  try {
    ctx.body = { packs: await phygitals.listPacks() };
  } catch (err) {
    handlePhygitalsError(ctx, err);
  }
});

/**
 * Step 1 of the buy flow. Client sends {buyerWallet, packId, amount,
 * currency}; server builds the unsigned Solana tx (token transfer +
 * rewards-mint ATA creation + transfers) and returns it as base64.
 * Client deserializes, signs with Phantom, then calls /buy/submit.
 */
server.router.post('/api/phygitals/buy/prepare', jsonBody, async (ctx) => {
  const body = ctx.request.body as {
    buyerWallet?: string;
    packId?: string;
    amount?: number;
    currency?: 'usdc' | 'usdt';
  } | undefined;
  if (!body?.buyerWallet || !body.packId || !Number.isFinite(body.amount) || (body.amount ?? 0) < 1) {
    ctx.throw(400, 'buyerWallet, packId, and amount >= 1 are required');
    return;
  }
  try {
    const prepared = await phygitals.prepareBuy({
      buyerWallet: body.buyerWallet,
      packId: body.packId,
      amount: body.amount!,
      currency: body.currency ?? 'usdc',
    });
    ctx.body = prepared;
  } catch (err) {
    handlePhygitalsError(ctx, err);
  }
});

/**
 * Step 2 of the buy flow. Client posts the signed-tx bytes (number[])
 * back; we forward to Phygitals' /api/vm/buy/crypto and (if the
 * response doesn't already include the NFTs inline) poll
 * /api/vm/buy/status until fulfilled.
 */
server.router.post('/api/phygitals/buy/submit', jsonBody, async (ctx) => {
  const body = ctx.request.body as {
    packId?: string;
    amount?: number;
    currency?: 'usdc' | 'usdt';
    signedTxBytes?: number[];
  } | undefined;
  if (!body?.packId || !Number.isFinite(body.amount) || !Array.isArray(body.signedTxBytes)) {
    ctx.throw(400, 'packId, amount, and signedTxBytes are required');
    return;
  }
  try {
    const submitResult = await phygitals.submitBuy({
      packId: body.packId,
      amount: body.amount!,
      currency: body.currency ?? 'usdc',
      signedTxBytes: body.signedTxBytes,
    });
    // If Phygitals returned the NFTs immediately, hand them back.
    // Otherwise poll status to get the fulfilled envelope.
    if (submitResult.nfts && submitResult.nfts.length > 0) {
      ctx.body = { session_id: submitResult.session_id, nfts: submitResult.nfts };
      return;
    }
    if (!submitResult.session_id) {
      ctx.throw(502, 'Phygitals returned neither session_id nor inline NFTs');
      return;
    }
    const fulfilled = await awaitPhygitalsPurchase(phygitals, submitResult.session_id);
    ctx.body = { ...fulfilled, session_id: submitResult.session_id };
  } catch (err) {
    handlePhygitalsError(ctx, err);
  }
});

server.router.post('/api/phygitals/buy/status', jsonBody, async (ctx) => {
  const body = ctx.request.body as { session_id?: string } | undefined;
  if (!body?.session_id) {
    ctx.throw(400, 'session_id is required');
    return;
  }
  try {
    ctx.body = await phygitals.buyStatus({ session_id: body.session_id });
  } catch (err) {
    handlePhygitalsError(ctx, err);
  }
});

/**
 * Step 1 of the sellback flow. Client sends the mint_address of the
 * item to sell back; Phygitals returns a session_id + an array of
 * unsigned VersionedTransactions for the client to sign with Phantom.
 */
server.router.post('/api/phygitals/sellback/init', jsonBody, async (ctx) => {
  const body = ctx.request.body as { mint_address?: string } | undefined;
  if (!body?.mint_address) {
    ctx.throw(400, 'mint_address is required');
    return;
  }
  try {
    ctx.body = await phygitals.takeClawBidInit({ mint_address: body.mint_address });
  } catch (err) {
    handlePhygitalsError(ctx, err);
  }
});

/**
 * Step 2 of the sellback flow. Client posts back the session_id + the
 * array of signed-tx byte arrays. Phygitals submits them and returns
 * the marketplace result.
 */
server.router.post('/api/phygitals/sellback/finish', jsonBody, async (ctx) => {
  const body = ctx.request.body as { session_id?: string; signedTxBytes?: Array<number[]> } | undefined;
  if (!body?.session_id || !Array.isArray(body.signedTxBytes) || body.signedTxBytes.length === 0) {
    ctx.throw(400, 'session_id and signedTxBytes (non-empty array) are required');
    return;
  }
  try {
    ctx.body = await phygitals.takeClawBidFinish({
      session_id: body.session_id,
      signedTxBytes: body.signedTxBytes,
    });
  } catch (err) {
    handlePhygitalsError(ctx, err);
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
