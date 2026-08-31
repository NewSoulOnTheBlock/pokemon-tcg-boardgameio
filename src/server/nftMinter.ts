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
}

export interface NftMinterOptions {
  rpcUrl: string;
  privateKey: string;
  contractAddress: string;
}

/** Only the pieces of PokemonCardNFT the server calls. */
const CARD_NFT_ABI = [
  'function mintCard(address to, string cardId) returns (uint256)',
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
  };
}
