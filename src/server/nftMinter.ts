// Server-side NFT minter using Metaplex Core.
//
// Each pulled booster card becomes a Metaplex Core asset minted to the
// connected Solana wallet. Core is the cheapest standard NFT primitive on
// Solana (~0.0012 SOL per mint) and shows up natively in Phantom / Solflare.
//
// The treasury keypair (SOLANA_TREASURY_SECRET_KEY) is the authority + payer
// for every mint. It's the same wallet that receives the user's 0.1 SOL
// pack payment, so funds flow in one side and pay for mints on the other.
//
// Metadata for each NFT is served by our own API at /api/cards/:id/metadata —
// a Metaplex-standard JSON file with the existing pokemontcg.io image URL
// and the card's stats as attributes.

import bs58 from 'bs58';
import { create, mplCore } from '@metaplex-foundation/mpl-core';
import {
  createSignerFromKeypair,
  generateSigner,
  keypairIdentity,
  publicKey,
  type Umi,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import type { Card } from '../game/types';

export interface NftMintResult {
  cardId: string;
  mintAddress: string;
  signature: string;
}

export interface NftMinter {
  treasury: string;
  mintCard(recipient: string, card: Card, metadataUri: string): Promise<NftMintResult>;
}

export interface NftMinterOptions {
  rpcUrl: string;
  treasurySecretKeyBase58: string;
}

function safeName(name: string): string {
  return name.length > 32 ? `${name.slice(0, 29)}...` : name;
}

export function createNftMinter({ rpcUrl, treasurySecretKeyBase58 }: NftMinterOptions): NftMinter {
  const umi: Umi = createUmi(rpcUrl).use(mplCore());
  const secret = bs58.decode(treasurySecretKeyBase58);
  if (secret.length !== 64) {
    throw new Error(`SOLANA_TREASURY_SECRET_KEY must decode to 64 bytes (got ${secret.length}). Use a Solana secret key in base58.`);
  }
  const keypair = umi.eddsa.createKeypairFromSecretKey(secret);
  const signer = createSignerFromKeypair(umi, keypair);
  umi.use(keypairIdentity(signer));

  return {
    treasury: keypair.publicKey.toString(),
    async mintCard(recipient: string, card: Card, metadataUri: string): Promise<NftMintResult> {
      const asset = generateSigner(umi);
      const result = await create(umi, {
        asset,
        name: safeName(card.name),
        uri: metadataUri,
        owner: publicKey(recipient),
      }).sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } });

      return {
        cardId: card.id,
        mintAddress: asset.publicKey.toString(),
        signature: bs58.encode(result.signature),
      };
    },
  };
}
