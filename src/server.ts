import { createRequire } from 'node:module';
import { PokemonTCG } from './game/PokemonTCG';

const require = createRequire(import.meta.url);
const { FlatFile, Origins, Server } = require('boardgame.io/server') as typeof import('boardgame.io/server');

const port = Number(process.env.PORT ?? 8000);
const storageDir = process.env.BGIO_STORAGE_DIR ?? './storage';
const clientOrigin = process.env.CLIENT_ORIGIN;
const origins = clientOrigin
  ? [Origins.LOCALHOST_IN_DEVELOPMENT, clientOrigin]
  : Origins.LOCALHOST_IN_DEVELOPMENT;

const server = Server({
  games: [PokemonTCG],
  origins,
  apiOrigins: origins,
  db: new FlatFile({ dir: storageDir, logging: false }),
});

server.router.get('/health', (ctx) => {
  ctx.body = 'ok';
});

await server.run(port, () => {
  console.log(`Pokemon TCG multiplayer server running at http://localhost:${port}`);
});
