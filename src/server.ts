import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context, Next } from 'koa';
import { koaBody } from 'koa-body';
import serve from 'koa-static';
import { CARD_LIBRARY, cardLibrarySize, initCardLibrary } from './game/cards';
import { loadBundledCards } from './game/cards-server-bootstrap';
import { PokemonTCG } from './game/PokemonTCG';
import type { Card } from './game/types';
import { MemoryCardStorage, PostgresCardStorage, type CardStorage } from './server/cardStorage';
import { createNftMinter, type NftMinter } from './server/nftMinter';
import { PostgresStorage, postgresSslFromEnv } from './server/postgresStorage';
import { MemoryProfileStorage, PostgresProfileStorage } from './server/profileStorage';
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
const profileStorage = databaseUrl
  ? new PostgresProfileStorage(databaseUrl, postgresSslFromEnv())
  : new MemoryProfileStorage();
const cardStorage: CardStorage = databaseUrl
  ? new PostgresCardStorage(databaseUrl, postgresSslFromEnv())
  : new MemoryCardStorage();
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
 * Mint one Metaplex Core NFT per pulled card to the user's wallet. Called
 * by the client after a successful 0.1 SOL pack payment. The treasury
 * keypair (server-side env var) pays for the mints out of its balance.
 */
server.router.post('/api/boosters/mint', jsonBody, async (ctx) => {
  if (!nftMinter) {
    ctx.throw(503, 'NFT minter is not configured on this server (SOLANA_TREASURY_SECRET_KEY missing).');
    return;
  }
  const body = ctx.request.body as { recipient?: string; cardIds?: string[] } | undefined;
  const recipient = body?.recipient?.trim();
  const cardIds = body?.cardIds;
  if (!recipient || !Array.isArray(cardIds) || cardIds.length === 0) {
    ctx.throw(400, 'recipient (base58 pubkey) and cardIds (non-empty array) are required.');
    return;
  }
  if (cardIds.length > 16) {
    ctx.throw(400, 'Cannot mint more than 16 cards in a single request.');
    return;
  }

  const base = publicOrigin || `${ctx.protocol}://${ctx.host}`;
  const mints: Awaited<ReturnType<typeof nftMinter.mintCard>>[] = [];
  for (const cardId of cardIds) {
    const card = CARD_LIBRARY[cardId] as Card | undefined;
    if (!card) {
      ctx.throw(400, `Unknown card id: ${cardId}`);
      return;
    }
    const metadataUri = `${base}/api/cards/${encodeURIComponent(cardId)}/metadata`;
    try {
      mints.push(await nftMinter.mintCard(recipient, card, metadataUri));
    } catch (err) {
      console.error(`[mint] failed for ${cardId} -> ${recipient}: ${err instanceof Error ? err.message : String(err)}`);
      ctx.status = 502;
      ctx.body = { error: `Mint failed at card ${cardId}: ${err instanceof Error ? err.message : String(err)}`, mints };
      return;
    }
  }
  ctx.body = { treasury: nftMinter.treasury, mints };
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

server.app.use(serve(distPath));
server.app.use(async (ctx, next) => {
  await next();
  const acceptsHtml = ctx.accepts('html');
  if (ctx.status === 404 && ctx.method === 'GET' && acceptsHtml && existsSync(indexPath)) {
    ctx.status = 200;
    ctx.type = 'html';
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
