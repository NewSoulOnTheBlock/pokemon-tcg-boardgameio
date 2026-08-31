// Scan a Robinhood Chain wallet for this app's card NFTs and propose
// matches against the local CARD_LIBRARY so the player can import them
// into their in-game collection.
//
// On Solana this module had to fuzzy-match arbitrary third-party NFTs
// through Helius's DAS index. Robinhood Chain has no equivalent indexer,
// and — now that the only Pokemon NFTs in play are the ones this app
// mints — it needs none: PokemonCardNFT is ERC721Enumerable, so the
// contract itself answers "what does this wallet own" in one call per
// token. Every candidate is therefore an exact `app-mint` match, and the
// attribute/fuzzy matching tiers are gone along with the guesswork.

import { Contract, JsonRpcProvider } from 'ethers';
import type { Card } from '../game/types';

export interface ImportCandidate {
  /** Decimal ERC-721 token id. */
  tokenId: string;
  nftName: string;
  nftImage?: string;
  cardId?: string;
  cardName?: string;
  setName?: string;
  cardImage?: string;
  confidence: 'app-mint' | 'attribute-match' | 'fuzzy-match' | 'none';
  metadataUri?: string;
}

export interface ScanWalletOptions {
  rpcUrl: string;
  contractAddress: string;
  ownerAddress: string;
  publicOrigin?: string;
  cardLibrary: Record<string, Card>;
  /** Hard cap so one whale wallet can't stall the request. */
  maxTokens?: number;
}

const CARD_NFT_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function cardIdOf(uint256 tokenId) view returns (string)',
] as const;

const DEFAULT_MAX_TOKENS = 500;

export async function scanWalletForPokemonNfts({
  rpcUrl,
  contractAddress,
  ownerAddress,
  publicOrigin,
  cardLibrary,
  maxTokens = DEFAULT_MAX_TOKENS,
}: ScanWalletOptions): Promise<ImportCandidate[]> {
  const provider = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(contractAddress, CARD_NFT_ABI, provider);

  const balance = Number(await contract.balanceOf(ownerAddress));
  if (!Number.isFinite(balance) || balance <= 0) return [];
  const count = Math.min(balance, maxTokens);

  // Enumerate in parallel batches — one round trip per token is the
  // ERC721Enumerable contract, and a 50-card collection would otherwise
  // take 100 sequential RPC calls.
  const BATCH = 25;
  const candidates: ImportCandidate[] = [];
  for (let start = 0; start < count; start += BATCH) {
    const indices = Array.from({ length: Math.min(BATCH, count - start) }, (_, i) => start + i);
    const batch = await Promise.all(
      indices.map(async (index) => {
        const tokenId = String(await contract.tokenOfOwnerByIndex(ownerAddress, index));
        const cardId = String(await contract.cardIdOf(tokenId));
        return { tokenId, cardId };
      }),
    );

    for (const { tokenId, cardId } of batch) {
      const card = cardLibrary[cardId];
      candidates.push({
        tokenId,
        nftName: card?.name ?? `Card #${tokenId}`,
        nftImage: card?.images?.small,
        cardId: card ? card.id : undefined,
        cardName: card?.name,
        setName: card?.id.split('-')[0],
        cardImage: card?.images?.large ?? card?.images?.small,
        // An id the contract minted but the library no longer knows is
        // still a real NFT — surface it as unmatched rather than lying
        // about a match the deckbuilder can't honour.
        confidence: card ? 'app-mint' : 'none',
        metadataUri: publicOrigin && card ? `${publicOrigin}/api/cards/${encodeURIComponent(card.id)}/metadata` : undefined,
      });
    }
  }

  return candidates.sort((a, b) => Number(a.tokenId) - Number(b.tokenId));
}
