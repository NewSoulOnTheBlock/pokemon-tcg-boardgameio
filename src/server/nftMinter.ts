// Server-side NFT minter for Robinhood Chain.
//
// Each pulled booster card becomes an ERC-721 token from the
// PokemonCardNFT contract in `contracts/`, minted to the player's wallet.
// The contract stores the card id per token and derives `tokenURI` from
// it, so metadata still comes from our own API at
// /api/cards/:id/metadata — no IPFS pinning, no per-mint URI argument.
//
// The treasury key (RHC_TREASURY_PRIVATE_KEY) is the contract's minter and
// pays gas for every mint. It is also the address that receives booster
// pack payments, so funds come in one side and pay for mints on the other.
//
// Mints are serialised through a one-at-a-time queue. Opening a pack fires
// nine mints back to back from a single key, and letting them race means
// two transactions claim the same nonce and one silently replaces the
// other — the player would pay for nine cards and receive eight.

import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import type { Card } from '../game/types';

export interface NftMintResult {
  cardId: string;
  /** Decimal token id as a string — ERC-721 ids are uint256. */
  tokenId: string;
  txHash: string;
}

export interface NftMinter {
  treasury: string;
  contractAddress: string;
  mintCard(recipient: string, card: Card): Promise<NftMintResult>;
  /**
   * Mint a batch of card ids in as few transactions as possible. Used by
   * the burn-to-buy shop, where one purchase is 9 cards per pack and up to
   * 7 packs. Returns one result per successfully minted card, in order.
   */
  mintCards(recipient: string, cardIds: string[]): Promise<NftMintResult[]>;
}

/** Cards per mintPack transaction. One booster is 9 cards, and batching a
 *  whole 7-pack tier into a single call would push 63 _safeMint calls into
 *  one transaction — well past a comfortable gas budget. One pack per
 *  transaction keeps each send small and bounds the damage if one fails. */
const MINT_BATCH_SIZE = 9;

export interface NftMinterOptions {
  rpcUrl: string;
  privateKey: string;
  contractAddress: string;
}

/** Only the pieces of PokemonCardNFT the server calls. */
const CARD_NFT_ABI = [
  'function mintCard(address to, string cardId) returns (uint256)',
  'function mintPack(address to, string[] cardIds) returns (uint256[])',
  'event CardMinted(address indexed to, uint256 indexed tokenId, string cardId)',
] as const;

export function createNftMinter({ rpcUrl, privateKey, contractAddress }: NftMinterOptions): NftMinter {
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('RHC_TREASURY_PRIVATE_KEY must be a 32-byte hex private key (64 hex chars, 0x prefix optional).');
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(key, provider);
  const contract = new Contract(contractAddress, CARD_NFT_ABI, wallet);

  // Serialises mints. Each new mint chains onto the tail of the previous
  // one, so ethers resolves a fresh nonce only after the prior send.
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    // Swallow rejections on the chaining branch only; `run` still rejects
    // for the caller. Without this an early failure poisons every
    // subsequent mint in the process.
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    treasury: wallet.address,
    contractAddress,
    mintCard(recipient: string, card: Card): Promise<NftMintResult> {
      return enqueue(async () => {
        const tx = await contract.mintCard(recipient, card.id);
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error(`Mint of ${card.id} to ${recipient} reverted (tx ${tx.hash}).`);
        }

        // Read the id back out of the CardMinted event rather than
        // trusting a local counter — the authoritative id is whatever
        // the contract assigned.
        let tokenId = '';
        for (const log of receipt.logs ?? []) {
          try {
            const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === 'CardMinted') {
              tokenId = String(parsed.args.tokenId);
              break;
            }
          } catch {
            // Log from another contract in the same tx; skip it.
          }
        }

        return { cardId: card.id, tokenId, txHash: tx.hash };
      });
    },

    async mintCards(recipient: string, cardIds: string[]): Promise<NftMintResult[]> {
      const minted: NftMintResult[] = [];
      for (let i = 0; i < cardIds.length; i += MINT_BATCH_SIZE) {
        const batch = cardIds.slice(i, i + MINT_BATCH_SIZE);
        // Each batch goes through the same queue as mintCard so a pack
        // purchase and a concurrent prize claim can't collide on a nonce.
        const results = await enqueue(async () => {
          const tx = await contract.mintPack(recipient, batch);
          const receipt = await tx.wait();
          if (!receipt || receipt.status !== 1) {
            throw new Error(`mintPack of ${batch.length} cards to ${recipient} reverted (tx ${tx.hash}).`);
          }

          // Pair each CardMinted event with its token id. The contract
          // emits them in the order it was given, but we read the ids off
          // the events rather than assuming a contiguous range.
          const out: NftMintResult[] = [];
          for (const log of receipt.logs ?? []) {
            try {
              const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
              if (parsed?.name === 'CardMinted') {
                out.push({ cardId: String(parsed.args.cardId), tokenId: String(parsed.args.tokenId), txHash: tx.hash });
              }
            } catch {
              // Log from another contract in the same tx; skip it.
            }
          }
          return out;
        });
        minted.push(...results);
      }
      return minted;
    },
  };
}
