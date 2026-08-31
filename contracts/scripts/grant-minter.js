// Authorise (or revoke) a minter on an already-deployed PokemonCardNFT.
//
//   MINTER=0xServerKeyAddress CARD_NFT_ADDRESS=0xContract npm run grant-minter
//   MINTER=0xOldKey ALLOWED=false CARD_NFT_ADDRESS=0xContract npm run grant-minter
//
// Run this whenever the game server's treasury key is rotated: mint access
// moves without transferring contract ownership.

const hre = require("hardhat");

async function main() {
  const contractAddress = process.env.CARD_NFT_ADDRESS;
  const minter = process.env.MINTER;
  const allowed = (process.env.ALLOWED ?? "true").toLowerCase() !== "false";

  if (!contractAddress) throw new Error("CARD_NFT_ADDRESS is required.");
  if (!minter) throw new Error("MINTER is required.");

  const contract = await hre.ethers.getContractAt("PokemonCardNFT", contractAddress);
  const tx = await contract.setMinter(minter, allowed);
  console.log(`setMinter(${minter}, ${allowed}) -> ${tx.hash}`);
  await tx.wait();
  console.log(`✅ ${minter} is ${allowed ? "now" : "no longer"} a minter.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
