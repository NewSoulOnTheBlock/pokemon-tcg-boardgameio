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
import { createNftMinter, type NftMinter } from './server/nftMinter';
import { buildSetNameIndex, scanWalletForPokemonNfts } from './server/nftScanner';
import { PostgresStorage, postgresSslFromEnv } from './server/postgresStorage';
import { MemoryProfileStorage, PostgresProfileStorage, DailyPackCooldownError, type ProfileStorage } from './server/profileStorage';
import { rollPrizeCard } from './server/prizes';
import { rollDailyPack } from './server/packRoller';
import { POKETCG_PACK_PRICE_RAW, PoketcgBurnError, verifyPoketcgBurn } from './server/tokenBurn';
import { createPumpPaymentService, type PumpPaymentService } from './server/pumpPayments';
import { LOBBY_CHAT_LIMITS, MemoryLobbyChatStore, PostgresLobbyChatStore, RateLimitError, ValidationError, type LobbyChatStore } from './server/lobbyChat';
import { createPhygitalsBuyer, PhygitalsBuyerError, type PhygitalsBuyerService } from './server/phygitalsBuyer';
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
const phygitalsBuyer: PhygitalsBuyerService = createPhygitalsBuyer();
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

// All in-app booster routes have been removed. The Boosters page is
// now Phygitals-only. The buy flow is two-step: user pays USDC into
// our treasury (user signs), then the server uses the API-key-bound
// wallet to actually purchase from Phygitals via the route below.

server.router.get('/api/phygitals-buyer/status', (ctx) => {
  ctx.body = { enabled: phygitalsBuyer.enabled, treasuryPubkey: phygitalsBuyer.treasuryPubkey };
});

/**
 * Preflight: verify Phygitals is reachable + the pack is in stock
 * BEFORE asking the user to sign a payment. If this fails the user
 * has not paid anything and we can return the error cleanly.
 */
server.router.post('/api/phygitals-buyer/preflight', jsonBody, async (ctx) => {
  const body = ctx.request.body as {
    packId?: string;
    amount?: number;
    currency?: 'usdc' | 'usdt';
  } | undefined;
  if (!body?.packId || !Number.isFinite(body.amount) || (body.amount ?? 0) < 1) {
    ctx.throw(400, 'packId and amount are required');
    return;
  }
  try {
    const result = await phygitalsBuyer.preflight({
      packId: body.packId,
      amount: body.amount!,
      currency: body.currency,
    });
    ctx.body = result;
  } catch (err) {
    if (err instanceof PhygitalsBuyerError) {
      ctx.status = err.status >= 400 && err.status < 600 ? err.status : 502;
      ctx.type = 'application/json';
      ctx.body = err.body && typeof err.body === 'object' ? err.body : { error: err.message };
      return;
    }
    throw err;
  }
});

/**
 * Top up credits. User signs a USDC transfer to the treasury wallet,
 * sends us the signature. Server verifies the payment landed on-chain
 * and credits the user's profile balance with the verified USD amount.
 * Idempotent per-(userId, signature): repeating the call with the
 * same signature returns the current balance without double-crediting.
 */
const creditedTopUps = new Set<string>(); // in-memory dedup key: `${userId}:${signature}`
server.router.post('/api/phygitals-credits/topup', jsonBody, async (ctx) => {
  const body = ctx.request.body as {
    userId?: string;
    buyerWallet?: string;
    paymentSignature?: string;
    currency?: 'usdc' | 'usdt';
  } | undefined;
  if (!body?.userId || !body.buyerWallet || !body.paymentSignature) {
    ctx.throw(400, 'userId, buyerWallet, and paymentSignature are required');
    return;
  }
  if (typeof profileStorage.addPhygitalsCredits !== 'function') {
    ctx.throw(503, 'Profile storage does not support Phygitals credits.');
    return;
  }
  const dedupKey = `${body.userId}:${body.paymentSignature}`;
  if (creditedTopUps.has(dedupKey)) {
    ctx.body = { alreadyCredited: true };
    return;
  }
  try {
    const { amountUsd } = await phygitalsBuyer.verifyTopUp({
      buyerWallet: body.buyerWallet,
      paymentSignature: body.paymentSignature,
      currency: body.currency,
    });
    if (amountUsd <= 0) {
      ctx.throw(400, 'No USDC transfer to treasury found in that signature.');
      return;
    }
    creditedTopUps.add(dedupKey);
    const newBalance = await profileStorage.addPhygitalsCredits(body.userId, amountUsd);
    ctx.body = { creditedUsd: amountUsd, balanceUsd: newBalance };
  } catch (err) {
    if (err instanceof PhygitalsBuyerError) {
      ctx.status = err.status >= 400 && err.status < 600 ? err.status : 502;
      ctx.type = 'application/json';
      const errBody = err.body && typeof err.body === 'object' ? err.body : {};
      ctx.body = { error: err.message, ...errBody };
      return;
    }
    throw err;
  }
});

/**
 * Buy a pack using stored credits. Server:
 *   1. Computes pack cost from /api/vm/available
 *   2. Atomically deducts credits from the user's balance
 *      (fails if insufficient)
 *   3. Calls Phygitals' buy/crypto with the treasury wallet
 *   4. On Phygitals failure, REFUNDS THE CREDITS to the user
 */
server.router.post('/api/phygitals-credits/buy', jsonBody, async (ctx) => {
  const body = ctx.request.body as {
    userId?: string;
    packId?: string;
    amount?: number;
    currency?: 'usdc' | 'usdt';
  } | undefined;
  if (!body?.userId || !body.packId || !Number.isFinite(body.amount) || (body.amount ?? 0) < 1) {
    ctx.throw(400, 'userId, packId, and amount are required');
    return;
  }
  if (typeof profileStorage.spendPhygitalsCredits !== 'function' || typeof profileStorage.addPhygitalsCredits !== 'function') {
    ctx.throw(503, 'Profile storage does not support Phygitals credits.');
    return;
  }
  let priceUsd = 0;
  try {
    const preflight = await phygitalsBuyer.preflight({
      packId: body.packId,
      amount: body.amount!,
      currency: body.currency,
    });
    priceUsd = preflight.expectedAmount / 1e6;

    // Deduct credits BEFORE calling Phygitals — atomic conditional
    // update fails with 'Insufficient Phygitals credits' if the user
    // doesn't have enough.
    let newBalance: number;
    try {
      newBalance = await profileStorage.spendPhygitalsCredits(body.userId, priceUsd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.status = 402;
      ctx.body = { error: msg, priceUsd };
      return;
    }

    // Credits are gone. Any Phygitals failure must re-credit them.
    try {
      const result = await phygitalsBuyer.buyWithBalance({
        packId: body.packId,
        amount: body.amount!,
        currency: body.currency,
      });
      ctx.body = { ...result, balanceUsd: newBalance };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[phygitals-credits] buy failed, refunding ${priceUsd} credits to ${body.userId}: ${reason}`);
      const refundedBalance = await profileStorage.addPhygitalsCredits!(body.userId, priceUsd);
      if (err instanceof PhygitalsBuyerError) {
        ctx.status = err.status >= 400 && err.status < 600 ? err.status : 502;
        ctx.type = 'application/json';
        ctx.body = {
          error: `${err.message} — your $${priceUsd.toFixed(2)} in credits has been refunded.`,
          refundedUsd: priceUsd,
          balanceUsd: refundedBalance,
        };
        return;
      }
      ctx.status = 502;
      ctx.body = {
        error: `Phygitals buy failed (${reason}) — your $${priceUsd.toFixed(2)} in credits has been refunded.`,
        refundedUsd: priceUsd,
        balanceUsd: refundedBalance,
      };
    }
  } catch (err) {
    if (err instanceof PhygitalsBuyerError) {
      ctx.status = err.status >= 400 && err.status < 600 ? err.status : 502;
      ctx.type = 'application/json';
      const errBody = err.body && typeof err.body === 'object' ? err.body : {};
      ctx.body = { error: err.message, ...errBody };
      return;
    }
    throw err;
  }
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

// ---------------------------------------------------------------------------
// Free-pack rewards
//
// `/api/rewards/daily-pack/status` — cheap cooldown check for the home widget.
// `/api/rewards/daily-pack/claim`  — atomic claim. Server rolls the cards (5C
//   + 3U + 1 rare-or-better), inserts a pack-purchase row keyed on a synthetic
//   signature, and bumps ownedCards. Returns the new profile + the rolled
//   cardIds so the client can show a reveal animation immediately.
//
// 22h cooldown (slightly under 24h so users can claim "every day" without
// having to wait for the exact wall-clock time they claimed yesterday).
// ---------------------------------------------------------------------------

const DAILY_PACK_COOLDOWN_MS = 22 * 60 * 60 * 1000;

function nextDailyPackAt(lastIso?: string): string | null {
  if (!lastIso) return null;
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) return null;
  return new Date(last + DAILY_PACK_COOLDOWN_MS).toISOString();
}

server.router.get('/api/rewards/daily-pack/status/:userId', async (ctx) => {
  if (!profileStorage.findProfileByUserId) {
    ctx.throw(501, 'findProfileByUserId not supported by this storage backend');
    return;
  }
  const profile = await profileStorage.findProfileByUserId(ctx.params.userId);
  const last = profile?.lastDailyPackAt;
  const nextAt = nextDailyPackAt(last);
  const canClaim = !last || (nextAt !== null && Date.parse(nextAt) <= Date.now());
  ctx.body = {
    lastClaimAt: last ?? null,
    nextClaimAt: nextAt,
    canClaim,
    cooldownMs: DAILY_PACK_COOLDOWN_MS,
  };
});

server.router.post('/api/rewards/daily-pack/claim/:userId', async (ctx) => {
  if (!profileStorage.claimDailyPack) {
    ctx.throw(501, 'claimDailyPack not supported by this storage backend');
    return;
  }
  if (cardLibrarySize() === 0) {
    ctx.throw(503, 'Card library not initialized');
    return;
  }
  const cardIds = rollDailyPack();
  try {
    const { profile, purchase } = await profileStorage.claimDailyPack(
      ctx.params.userId,
      cardIds,
      DAILY_PACK_COOLDOWN_MS,
    );
    ctx.body = {
      profile,
      purchase,
      nextClaimAt: nextDailyPackAt(profile.lastDailyPackAt),
    };
  } catch (err) {
    if (err instanceof DailyPackCooldownError) {
      ctx.status = 429;
      ctx.body = { error: 'Daily pack on cooldown', nextClaimAt: err.nextClaimAt };
      return;
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// $POKETCG burn-to-buy-pack
//
// User signs an SPL-token burn ix that destroys 250,000 $POKETCG (per pack)
// from their own associated token account. Submits the resulting signature
// + claimed buyer wallet to this endpoint. We:
//   1. Verify the burn is on-chain, finalized, owned by the buyer, targets
//      $POKETCG, and is at least N * 250,000 tokens (N = packs claimed).
//   2. Roll N independent packs.
//   3. Idempotently record + persist via storage.redeemBurnPack().
// Replays of the same signature get the same cards back (no double-grant).
// ---------------------------------------------------------------------------

server.router.post('/api/rewards/burn-pack/:userId', jsonBody, async (ctx) => {
  if (!profileStorage.redeemBurnPack) {
    ctx.throw(501, 'redeemBurnPack not supported by this storage backend');
    return;
  }
  if (cardLibrarySize() === 0) {
    ctx.throw(503, 'Card library not initialized');
    return;
  }
  const body = ctx.request.body as {
    signature?: string;
    buyerWallet?: string;
    packs?: number;
  } | undefined;
  const signature = body?.signature?.trim();
  const buyerWallet = body?.buyerWallet?.trim();
  const packs = Math.max(1, Math.min(10, Number.isFinite(body?.packs) ? Math.floor(body!.packs!) : 1));
  if (!signature) {
    ctx.throw(400, 'signature is required');
    return;
  }
  if (!buyerWallet) {
    ctx.throw(400, 'buyerWallet is required');
    return;
  }
  try {
    await verifyPoketcgBurn({
      signature,
      buyerWallet,
      minRawAmount: POKETCG_PACK_PRICE_RAW * packs,
    });
  } catch (err) {
    if (err instanceof PoketcgBurnError) {
      ctx.status = err.status;
      ctx.body = { error: err.message };
      return;
    }
    throw err;
  }
  const cardIds: string[] = [];
  for (let i = 0; i < packs; i += 1) cardIds.push(...rollDailyPack());
  const { profile, purchase, alreadyRedeemed } = await profileStorage.redeemBurnPack(
    ctx.params.userId,
    signature,
    cardIds,
  );
  ctx.body = { profile, purchase, alreadyRedeemed, packs };
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

// Phygitals storefront now calls api.phygitals.com directly from the
// browser — see src/api/phygitals.ts. Their Cloudflare WAF blocks
// Render's outbound IPs, so server-side proxying isn't viable. The
// VITE_PHYGITALS_API_KEY env var holds the (read+sell scoped) key.

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
