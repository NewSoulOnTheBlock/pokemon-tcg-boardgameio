const { expect } = require("chai");
const { ethers } = require("hardhat");

const BASE_URI = "https://arena.example/api/cards/";

describe("PokemonCardNFT", function () {
  async function deploy() {
    const [owner, server, player, stranger] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("PokemonCardNFT");
    const nft = await factory.deploy(owner.address, BASE_URI);
    await nft.waitForDeployment();
    return { nft, owner, server, player, stranger };
  }

  it("makes the deployer a minter so a fresh deploy is usable", async function () {
    const { nft, owner } = await deploy();
    expect(await nft.isMinter(owner.address)).to.equal(true);
  });

  it("mints a card and records its card id", async function () {
    const { nft, player } = await deploy();
    await nft.mintCard(player.address, "sv1-13");

    expect(await nft.ownerOf(1)).to.equal(player.address);
    expect(await nft.cardIdOf(1)).to.equal("sv1-13");
    expect(await nft.totalMinted()).to.equal(1n);
  });

  it("derives tokenURI from the card id and base URI", async function () {
    const { nft, player } = await deploy();
    await nft.mintCard(player.address, "base1-4");
    expect(await nft.tokenURI(1)).to.equal(`${BASE_URI}base1-4/metadata`);
  });

  it("emits CardMinted with the assigned token id", async function () {
    const { nft, player } = await deploy();
    await expect(nft.mintCard(player.address, "swsh1-25"))
      .to.emit(nft, "CardMinted")
      .withArgs(player.address, 1, "swsh1-25");
  });

  it("rejects minting from a non-minter", async function () {
    const { nft, player, stranger } = await deploy();
    await expect(nft.connect(stranger).mintCard(player.address, "sv1-13"))
      .to.be.revertedWithCustomError(nft, "NotMinter")
      .withArgs(stranger.address);
  });

  it("rejects an empty card id", async function () {
    const { nft, player } = await deploy();
    await expect(nft.mintCard(player.address, "")).to.be.revertedWithCustomError(nft, "EmptyCardId");
  });

  it("lets the owner grant and revoke minters without transferring ownership", async function () {
    const { nft, server, player } = await deploy();

    await nft.setMinter(server.address, true);
    await nft.connect(server).mintCard(player.address, "sv1-13");
    expect(await nft.ownerOf(1)).to.equal(player.address);

    await nft.setMinter(server.address, false);
    await expect(nft.connect(server).mintCard(player.address, "sv1-14"))
      .to.be.revertedWithCustomError(nft, "NotMinter");
  });

  it("mints a whole pack in one transaction with sequential ids", async function () {
    const { nft, player } = await deploy();
    const cards = ["base1-1", "base1-2", "base1-3", "base1-4", "base1-5"];
    await nft.mintPack(player.address, cards);

    expect(await nft.balanceOf(player.address)).to.equal(BigInt(cards.length));
    for (let i = 0; i < cards.length; i++) {
      expect(await nft.cardIdOf(i + 1)).to.equal(cards[i]);
    }
  });

  // This is the exact call sequence src/server/nftScanner.ts makes; if
  // enumeration ever breaks, the game's Import page silently shows nothing.
  it("enumerates a wallet's tokens the way the import scanner does", async function () {
    const { nft, player, stranger } = await deploy();
    await nft.mintPack(player.address, ["sv1-13", "sv1-14"]);
    await nft.mintCard(stranger.address, "sv1-15");

    const balance = Number(await nft.balanceOf(player.address));
    expect(balance).to.equal(2);

    const owned = [];
    for (let i = 0; i < balance; i++) {
      const tokenId = await nft.tokenOfOwnerByIndex(player.address, i);
      owned.push(await nft.cardIdOf(tokenId));
    }
    expect(owned).to.deep.equal(["sv1-13", "sv1-14"]);
  });

  it("follows transfers in the enumeration", async function () {
    const { nft, player, stranger } = await deploy();
    await nft.mintCard(player.address, "sv1-13");
    await nft.connect(player).transferFrom(player.address, stranger.address, 1);

    expect(await nft.balanceOf(player.address)).to.equal(0n);
    expect(await nft.tokenOfOwnerByIndex(stranger.address, 0)).to.equal(1n);
  });

  it("lets the owner repoint the base URI after a domain change", async function () {
    const { nft, player } = await deploy();
    await nft.mintCard(player.address, "sv1-13");
    await nft.setBaseURI("https://new.example/api/cards/");
    expect(await nft.tokenURI(1)).to.equal("https://new.example/api/cards/sv1-13/metadata");
  });

  it("blocks a stranger from changing the base URI or minters", async function () {
    const { nft, stranger } = await deploy();
    await expect(nft.connect(stranger).setBaseURI("https://evil.example/")).to.be.reverted;
    await expect(nft.connect(stranger).setMinter(stranger.address, true)).to.be.reverted;
  });
});
