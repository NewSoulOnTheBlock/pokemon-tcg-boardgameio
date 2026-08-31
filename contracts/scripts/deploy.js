// Deploy PokemonCardNFT to Robinhood Chain.
//
//   cd contracts
//   cp .env.example .env      # fill in DEPLOYER_PRIVATE_KEY + PUBLIC_ORIGIN
//   npm run deploy
//
// Prints the CARD_NFT_ADDRESS to paste into the game server's environment.

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY in contracts/.env.");
  }

  const publicOrigin = (process.env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
  if (!publicOrigin) {
    throw new Error(
      "PUBLIC_ORIGIN is required so tokenURI points at your API " +
        '(e.g. PUBLIC_ORIGIN="https://your-app.onrender.com").',
    );
  }
  // tokenURI is `<baseURI><cardId>/metadata`, and the API route is
  // /api/cards/:id/metadata — so the base has to end in /api/cards/.
  const baseURI = `${publicOrigin}/api/cards/`;

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Balance:   ${hre.ethers.formatEther(balance)} ETH`);
  console.log(`Network:   ${hre.network.name} (chainId ${hre.network.config.chainId})`);
  console.log(`Base URI:  ${baseURI}`);
  if (balance === 0n) {
    throw new Error("Deployer has no ETH on this chain — fund it before deploying.");
  }

  const factory = await hre.ethers.getContractFactory("PokemonCardNFT");
  const contract = await factory.deploy(deployer.address, baseURI);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("\n✅ PokemonCardNFT deployed");
  console.log(`   ${address}`);
  console.log("\nSet these on the game server:");
  console.log(`   CARD_NFT_ADDRESS=${address}`);
  console.log(`   RHC_TREASURY_PRIVATE_KEY=<the key for ${deployer.address}>`);
  console.log(
    "\nIf the server uses a DIFFERENT key from the deployer, authorise it:\n" +
      `   MINTER=<server address> CARD_NFT_ADDRESS=${address} npm run grant-minter`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
