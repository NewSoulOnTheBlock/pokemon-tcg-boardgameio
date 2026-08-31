import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // contracts/ is a separate Hardhat/Mocha project — its tests require
    // the `hardhat` runtime and are run with `npm test` inside that folder.
    exclude: ['node_modules/**', 'dist/**', 'dist-server/**', 'contracts/**'],
  },
});
