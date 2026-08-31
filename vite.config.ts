import { defineConfig, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend (boardgame.io server + REST API) defaults to :8000 when running
// `npm run dev:server`. Override with VITE_API_TARGET when the API lives
// somewhere else.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:8000';

const config: UserConfig = {
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/games': { target: API_TARGET, changeOrigin: true },
      '/socket.io': { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
  build: {
    // The card manifest is a 10 MB JSON parsed as a static array, so we lift
    // it (and a few heavy vendor deps) into separate chunks. That keeps the
    // app shell small and lets browsers cache the data across deploys.
    // NOTE: there is deliberately no web3 vendor chunk. The Robinhood Chain
    // client in src/chain/ talks raw JSON-RPC over fetch and hand-encodes the
    // two ERC-20 calls it needs, so no chain SDK reaches the browser bundle
    // at all — ethers is server-only.
    chunkSizeWarningLimit: 12_000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('card-manifest.generated')) return 'card-manifest';
          if (id.includes('node_modules')) {
            if (id.includes('react-dom') || id.includes('/react/')) return 'vendor-react';
            if (id.includes('boardgame.io')) return 'vendor-bgio';
          }
          return undefined;
        },
      },
    },
  },
};

export default defineConfig(config);

