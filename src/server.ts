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
import { scanWalletForPokemonNfts } from './server/nftScanner';
import { PostgresStorage, postgresSslFromEnv } from './server/postgresStorage';
import { MemoryProfileStorage, PostgresProfileStorage, DailyPackCooldownError, type ProfileStorage } from './server/profileStorage';
import { rollPrizeCard } from './server/prizes';
import { rollDailyPack } from './server/packRoller';
import { PoketcgBurnError, findPoketcgTier, rawCostForTier, verifyPoketcgBurn } from './server/tokenBurn';
import { isAddress, isTxHash } from './server/evmRpc';
import { CARD_NFT_ADDRESS, POKETCG_TOKEN_ADDRESS, RHC_CHAIN_ID, RHC_RPC_URL, hasCardNft, hasPoketcgToken } from './chain/config';
import { LOBBY_CHAT_LIMITS, MemoryLobbyChatStore, PostgresLobbyChatStore, RateLimitError, ValidationError, type LobbyChatStore } from './server/lobbyChat';
import { championsRowDateKey, describeChampionsRowEligibility, rollChampionsRow } from './server/championsRow';
import type { MatchRecord, PackPurchase, ProfileState } from './shared/profile';

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

// ----- Robinhood Chain / NFT minter --------------------------------------
//
// Server-side mints happen with a treasury key so players don't sign N
// transactions per pack — they sign one burn, we mint the nine cards.
// The treasury pays gas for every mint, so keep it funded with ETH on
// chain 4663. Without RHC_TREASURY_PRIVATE_KEY + CARD_NFT_ADDRESS the
// server still records pack purchases and grants the cards in-game, it
// just skips minting; nothing else degrades.
const treasuryKey = process.env.RHC_TREASURY_PRIVATE_KEY?.trim();
const publicOrigin = process.env.PUBLIC_ORIGIN ?? allowedOrigins[0] ?? '';

let nftMinter: NftMinter | undefined;
try {
  if (treasuryKey && hasCardNft()) {
    nftMinter = createNftMinter({
      rpcUrl: RHC_RPC_URL,
      privateKey: treasuryKey,
      contractAddress: CARD_NFT_ADDRESS,
    });
    console.log(`[pokemon-tcg] NFT minter ready (treasury=${nftMinter.treasury}, contract=${CARD_NFT_ADDRESS})`);
  } else {
    const missing = [
      treasuryKey ? null : 'RHC_TREASURY_PRIVATE_KEY',
      hasCardNft() ? null : 'CARD_NFT_ADDRESS',
    ].filter(Boolean).join(' + ');
    console.log(`[pokemon-tcg] NFT minter disabled (${missing} not set)`);
  }
} catch (err) {
  console.error(`[pokemon-tcg] NFT minter init failed: ${err instanceof Error ? err.message : String(err)}`);
  nftMinter = undefined;
}

console.log(
  hasPoketcgToken()
    ? `[pokemon-tcg] $POKE burn shop ready (token=${POKETCG_TOKEN_ADDRESS})`
    : '[pokemon-tcg] $POKE burn shop disabled (POKETCG_TOKEN_ADDRESS not set)',
);

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
  ctx.body = { ok: true, storage: storageLabel, profileStorage: profileLabel, cardStorage: cardStorageLabel, cards: cardLibrarySize(), chainId: RHC_CHAIN_ID, nftMinter: Boolean(nftMinter), poketcg: hasPoketcgToken(), cardNft: hasCardNft() };
});

server.router.get('/api/health', (ctx) => {
  ctx.body = { ok: true, storage: storageLabel, profileStorage: profileLabel, cardStorage: cardStorageLabel, cards: cardLibrarySize(), chainId: RHC_CHAIN_ID, nftMinter: Boolean(nftMinter), poketcg: hasPoketcgToken(), cardNft: hasCardNft() };
});

server.router.get('/api/cards/library', (ctx) => {
  ctx.type = 'application/json';
  // The catalogue rarely changes between deploys. 1 hour browser cache; bump
  // higher once /api/cards/library?v=<hash> is wired up for cache busting.
  ctx.set('Cache-Control', 'public, max-age=3600');
  ctx.body = cardsJsonCache;
});

/**
 * ERC-721 metadata for a single card. PokemonCardNFT derives every
 * token's `tokenURI` from its card id, so this is the URL wallets and
 * explorers fetch when displaying a card NFT.
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
    description,
    image,
    external_url: publicOrigin || `https://images.pokemontcg.io/${setId}/`,
    attributes,
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
// $POKE burn-to-buy-pack
//
// User signs an ERC-20 transfer of the tier's cost to the burn address on
// Robinhood Chain, then posts the transaction hash + claimed buyer wallet
// to this endpoint. We:
//   1. Verify the transaction succeeded on chain, was sent by the buyer,
//      and burned at least the declared tier's cost of $POKE.
//   2. Roll N independent packs.
//   3. Idempotently record + persist via storage.redeemBurnPack().
// Replays of the same tx hash get the same cards back (no double-grant).
//
// `signature` is still the wire field name and the storage idempotency
// key: it holds a transaction hash for burns, but also synthetic keys
// like `daily-pack:<user>:<ts>` for the free-pack paths, so it stays
// chain-neutral on purpose.
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
  const requestedPacks = Number.isFinite(body?.packs) ? Math.floor(body!.packs!) : 1;
  const tier = findPoketcgTier(requestedPacks);
  if (!tier) {
    ctx.throw(400, `packs must be one of: ${[1, 3, 7].join(', ')} (got ${requestedPacks})`);
    return;
  }
  if (!isTxHash(signature)) {
    ctx.throw(400, 'signature must be a 32-byte transaction hash (0x + 64 hex chars)');
    return;
  }
  if (!isAddress(buyerWallet)) {
    ctx.throw(400, 'buyerWallet must be a 20-byte EVM address');
    return;
  }
  try {
    await verifyPoketcgBurn({
      txHash: signature,
      buyerWallet,
      minRawAmount: rawCostForTier(tier),
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
  for (let i = 0; i < tier.packs; i += 1) cardIds.push(...rollDailyPack());
  const { profile, purchase, alreadyRedeemed } = await profileStorage.redeemBurnPack(
    ctx.params.userId,
    signature,
    cardIds,
  );

  // Mint the pulled cards as ERC-721s to the buyer. Gated on
  // !alreadyRedeemed so a retry of the same burn signature — which
  // returns the previously stored cards — can't mint a second set.
  //
  // Failure here is deliberately non-fatal, matching the prize-claim
  // path: the cards are already in the player's collection, the NFT is
  // the bonus. Burning tokens and receiving nothing would be the worse
  // outcome, so a mint failure is logged and the purchase still stands.
  let mints: Array<{ cardId: string; tokenId: string; txHash: string }> | undefined;
  if (nftMinter && !alreadyRedeemed) {
    try {
      mints = await nftMinter.mintCards(buyerWallet!, purchase.cardIds);
      console.log(`[burn-pack] minted ${mints.length} card NFTs to ${buyerWallet} for ${signature}`);
    } catch (err) {
      console.error(
        `[burn-pack] mint failed for ${buyerWallet} (${signature}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  ctx.body = {
    profile,
    purchase: mints?.length ? { ...purchase, mints } : purchase,
    alreadyRedeemed,
    packs: tier.packs,
  };
});

// ---------------------------------------------------------------------------
// Champions Row daily lottery.
//
// Eligibility (server-validated):
//   1. Profile has earnedBadges.length >= 8 AND championDefeated === true
//      (synced from per-wallet localStorage via /api/profiles/:userId PUT).
//   2. Wallet has > 0 $POKE balance (live RPC check).
//
// GET /api/champions-row/status/:userId
//   Returns today's draw + per-user view (eligible, isWinner, claimed).
//   Idempotently rolls today's draw on first call of the day.
//
// POST /api/champions-row/claim/:userId
//   Winner-only. Credits the rolled pack to ownedCards exactly once.
// ---------------------------------------------------------------------------

server.router.get('/api/champions-row/status/:userId', async (ctx) => {
  if (!profileStorage.ensureChampionsRowDraw || !profileStorage.listCampaignCompleteProfiles || !profileStorage.findProfileByUserId) {
    ctx.throw(501, 'champions-row not supported by this storage backend');
    return;
  }
  const dateKey = championsRowDateKey();
  const [draw, profile, eligibility] = await Promise.all([
    rollChampionsRow(profileStorage, dateKey),
    profileStorage.findProfileByUserId(ctx.params.userId),
    describeChampionsRowEligibility(profileStorage),
  ]);
  const cp = profile?.campaignProgress;
  const campaignComplete = Boolean(
    cp && cp.championDefeated && Array.isArray(cp.earnedBadges) && cp.earnedBadges.length >= 8,
  );
  ctx.body = {
    dateKey,
    drawnAt: draw.drawnAt,
    eligibility: { totalEligible: draw.eligibleCount, campaignComplete: eligibility.campaignComplete, withPoketcg: eligibility.withPoketcg },
    youAreEligible: campaignComplete && Boolean(profile?.wallet?.address),
    youWon: profile ? draw.winnerUserId === profile.userId : false,
    youClaimed: Boolean(draw.claimedAt && profile && draw.winnerUserId === profile.userId),
    winnerWallet: draw.winnerWallet,
    nextDrawAt: nextChampionsRowDrawAt(),
  };
});

server.router.post('/api/champions-row/claim/:userId', async (ctx) => {
  if (!profileStorage.claimChampionsRowDraw || !profileStorage.ensureChampionsRowDraw) {
    ctx.throw(501, 'champions-row not supported by this storage backend');
    return;
  }
  const dateKey = championsRowDateKey();
  // Make sure today's draw exists before claim.
  await rollChampionsRow(profileStorage, dateKey);
  const result = await profileStorage.claimChampionsRowDraw(ctx.params.userId, dateKey);
  if ('notWinner' in result) {
    ctx.status = 403;
    ctx.body = { error: "You're not today's Champions Row winner." };
    return;
  }
  ctx.body = result;
});

function nextChampionsRowDrawAt(): string {
  // Next UTC midnight.
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.toISOString();
}

function dailyLeaderboardDateKey(now: Date = new Date()): string {
  // UTC YYYY-MM-DD. Same shape as Champions Row's date key but kept
  // separate so leaderboard windows can be rotated independently if
  // we ever want a non-UTC reset.
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function yesterdayDailyLeaderboardDateKey(now: Date = new Date()): string {
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return dailyLeaderboardDateKey(yesterday);
}

function nextDailyLeaderboardResetAt(): string {
  // Same as Champions Row — next UTC midnight. Keep both helpers so
  // the two systems stay independent.
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.toISOString();
}

server.router.get('/api/leaderboard', async (ctx) => {
  // Daily-reset leaderboard. The query param `dateKey=YYYY-MM-DD`
  // optionally lets the client pull a past day; default is today (UTC).
  // We also lazily settle YESTERDAY's top-3 rewards on first request
  // so the prize state is always up-to-date without needing a cron.
  const todayKey = dailyLeaderboardDateKey();
  const queryKey = typeof ctx.query.dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.dateKey)
    ? ctx.query.dateKey
    : todayKey;

  // Settle yesterday's pool (idempotent). Safe to call every request —
  // INSERT … ON CONFLICT DO NOTHING is the gate.
  const yesterdayKey = yesterdayDailyLeaderboardDateKey();
  let yesterdayRewards: Awaited<ReturnType<NonNullable<ProfileStorage['settleDailyLeaderboard']>>> = [];
  if (profileStorage.settleDailyLeaderboard) {
    try { yesterdayRewards = await profileStorage.settleDailyLeaderboard(yesterdayKey); }
    catch (err) { console.error('[leaderboard] failed to settle yesterday rewards:', err); }
  }

  // Daily window first, fall back to cumulative if backend doesn't
  // support the daily query (legacy memory storage in old tests).
  const entries = profileStorage.listDailyLeaderboard
    ? await profileStorage.listDailyLeaderboard(queryKey)
    : await profileStorage.listLeaderboard();

  ctx.body = {
    dateKey: queryKey,
    resetAt: nextDailyLeaderboardResetAt(),
    entries,
    yesterday: {
      dateKey: yesterdayKey,
      winners: yesterdayRewards.map((r) => ({
        rank: r.rank,
        userId: r.userId,
        name: r.name,
        wins: r.wins,
        losses: r.losses,
        draws: r.draws,
        matches: r.matches,
        claimed: r.claimedAt !== null,
      })),
    },
  };
});

server.router.get('/api/leaderboard/rewards/:userId', async (ctx) => {
  // Lists this user's currently-unclaimed daily-leaderboard rewards.
  // Used to render the "Claim trainer pack" banner on the leaderboard
  // tab. Returns [] if the storage backend doesn't support rewards.
  if (!profileStorage.listUnclaimedDailyRewards) {
    ctx.body = { rewards: [] };
    return;
  }
  // Make sure yesterday's pool is settled before reading.
  if (profileStorage.settleDailyLeaderboard) {
    try { await profileStorage.settleDailyLeaderboard(yesterdayDailyLeaderboardDateKey()); }
    catch (err) { console.error('[leaderboard] settle on rewards fetch failed:', err); }
  }
  const rewards = await profileStorage.listUnclaimedDailyRewards(ctx.params.userId);
  ctx.body = { rewards };
});

server.router.post('/api/leaderboard/rewards/:userId/claim', koaBody(), async (ctx) => {
  // Claim a specific (dateKey, rank) trainer-pack reward. Server
  // rolls the pack contents, atomically marks the row claimed +
  // adds cards to the user's collection, returns the rolled cardIds.
  if (!profileStorage.claimDailyLeaderboardReward || !profileStorage.settleDailyLeaderboard) {
    ctx.throw(501, 'daily-leaderboard rewards not supported by this storage backend');
    return;
  }
  const body = ctx.request.body as { dateKey?: unknown; rank?: unknown } | undefined;
  const dateKey = typeof body?.dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.dateKey)
    ? body.dateKey : null;
  const rank = Number(body?.rank);
  if (!dateKey || !Number.isInteger(rank) || rank < 1 || rank > 3) {
    ctx.status = 400;
    ctx.body = { error: 'dateKey (YYYY-MM-DD) and rank (1|2|3) required' };
    return;
  }
  await profileStorage.settleDailyLeaderboard(dateKey);
  const rolledIds = rollDailyPack();
  try {
    const result = await profileStorage.claimDailyLeaderboardReward(
      ctx.params.userId, dateKey, rank, rolledIds,
    );
    ctx.body = {
      dateKey,
      rank,
      profile: result.profile,
      purchase: result.purchase,
      alreadyClaimed: result.alreadyClaimed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("isn't yours")) { ctx.status = 403; ctx.body = { error: msg }; return; }
    if (msg.includes('No reward row')) { ctx.status = 404; ctx.body = { error: msg }; return; }
    console.error('[leaderboard] claim failed:', err);
    ctx.status = 500;
    ctx.body = { error: msg };
  }
});

server.router.get('/api/leaderboard/history', async (ctx) => {
  // Past Daily Champions — top-3 winners for each of the most recent
  // settled days. ?limit=N caps the number of past dates returned
  // (default 14, max 60). Settles yesterday first so the freshly-
  // resolved podium appears as soon as anyone visits the page.
  if (!profileStorage.listDailyLeaderboardHistory) {
    ctx.body = { days: [] };
    return;
  }
  if (profileStorage.settleDailyLeaderboard) {
    try { await profileStorage.settleDailyLeaderboard(yesterdayDailyLeaderboardDateKey()); }
    catch (err) { console.error('[leaderboard] settle on history fetch failed:', err); }
  }
  const limitParam = Number(ctx.query.limit);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 14;
  const rewards = await profileStorage.listDailyLeaderboardHistory(limit);
  // Group flat rows back into per-date podiums for the client.
  const byDate = new Map<string, { dateKey: string; winners: Array<{
    rank: number; userId: string; name: string;
    wins: number; losses: number; draws: number; matches: number;
    claimed: boolean;
  }> }>();
  for (const r of rewards) {
    let entry = byDate.get(r.dateKey);
    if (!entry) {
      entry = { dateKey: r.dateKey, winners: [] };
      byDate.set(r.dateKey, entry);
    }
    entry.winners.push({
      rank: r.rank,
      userId: r.userId,
      name: r.name,
      wins: r.wins,
      losses: r.losses,
      draws: r.draws,
      matches: r.matches,
      claimed: r.claimedAt !== null,
    });
  }
  ctx.body = { days: [...byDate.values()] };
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
 * app_match_records prevents a second roll. Mints the card as an ERC-721
 * on Robinhood Chain, falling back to a no-mint claim if the treasury
 * minter isn't configured (still records the prize so the user gets it in
 * their collection).
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
        mint: reservation.alreadyClaimed.tokenId ? {
          tokenId: reservation.alreadyClaimed.tokenId,
          txHash: reservation.alreadyClaimed.txHash ?? '',
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
  let mint: { tokenId: string; txHash: string } | undefined;
  if (nftMinter) {
    try {
      const result = await nftMinter.mintCard(walletAddress, card);
      mint = { tokenId: result.tokenId, txHash: result.txHash };
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
    tokenId: mint?.tokenId,
    txHash: mint?.txHash,
  });

  ctx.body = {
    alreadyClaimed: false,
    card,
    mint: mint ?? null,
  };
});

/**
 * List the card NFTs a Robinhood Chain wallet holds from this app's
 * ERC-721 and match them against the local card library. The client uses
 * the returned candidates to populate the Import page.
 */
server.router.post('/api/imports/scan', jsonBody, async (ctx) => {
  const body = ctx.request.body as { ownerAddress?: string } | undefined;
  const ownerAddress = body?.ownerAddress?.trim();
  if (!isAddress(ownerAddress)) {
    ctx.throw(400, 'ownerAddress must be a 20-byte EVM address.');
    return;
  }
  if (!hasCardNft()) {
    ctx.throw(503, 'Card NFT contract is not configured on this server (set CARD_NFT_ADDRESS).');
    return;
  }
  try {
    const candidates = await scanWalletForPokemonNfts({
      rpcUrl: RHC_RPC_URL,
      contractAddress: CARD_NFT_ADDRESS,
      ownerAddress,
      publicOrigin,
      cardLibrary: CARD_LIBRARY as unknown as Record<string, Card>,
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
