require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Secrets come from the environment, never from source control.
// Copy .env.example to .env and fill it in before deploying.
const RHC_RPC_URL =
  process.env.RHC_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const RHC_CHAIN_ID = Number(process.env.RHC_CHAIN_ID || 4663);
const DEPLOYER_PRIVATE_KEY =
  process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Robinhood Chain is Shanghai-era. Compiling for cancun would emit
      // MCOPY/TSTORE, which the chain may not implement. This is also why
      // @openzeppelin/contracts is pinned below 5.2 in package.json.
      evmVersion: "shanghai",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    robinhood: {
      url: RHC_RPC_URL,
      chainId: RHC_CHAIN_ID,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: { robinhood: process.env.BLOCKSCOUT_API_KEY || "unused" },
    customChains: [
      {
        network: "robinhood",
        chainId: RHC_CHAIN_ID,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
    ],
  },
  mocha: { timeout: 120000 },
};
