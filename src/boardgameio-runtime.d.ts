declare module 'boardgame.io/dist/cjs/core.js' {
  export * from 'boardgame.io/core';
}

declare module 'boardgame.io/internal' {
  export { Async, Sync } from 'boardgame.io/dist/types/src/server/db/base';
}
