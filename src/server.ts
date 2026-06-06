import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context, Next } from 'koa';
import { koaBody } from 'koa-body';
import serve from 'koa-static';
import { CARD_LIBRARY, cardLibrarySize, initCardLibrary } from './game/cards';
import { loadBundledCards } from './game/cards-server-bootstrap';
import { PokemonTCG } from './game/PokemonTCG';
import { MemoryCardStorage, PostgresCardStorage, type CardStorage } from './server/cardStorage';
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
  ctx.body = { ok: true, storage: storageLabel, profileStorage: profileLabel, cardStorage: cardStorageLabel, cards: cardLibrarySize() };
});

server.router.get('/api/health', (ctx) => {
  ctx.body = { ok: true, storage: storageLabel, profileStorage: profileLabel, cardStorage: cardStorageLabel, cards: cardLibrarySize() };
});

server.router.get('/api/cards/library', (ctx) => {
  ctx.type = 'application/json';
  // The catalogue rarely changes between deploys. 1 hour browser cache; bump
  // higher once /api/cards/library?v=<hash> is wired up for cache busting.
  ctx.set('Cache-Control', 'public, max-age=3600');
  ctx.body = cardsJsonCache;
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
