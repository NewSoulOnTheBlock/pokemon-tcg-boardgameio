// Scan a Solana wallet for phygital / Collector Crypt Pokemon NFTs and
// propose matches against the local CARD_LIBRARY so the user can import
// them into their in-game collection.
//
// Uses Helius's Digital Asset Standard (DAS) JSON-RPC method
// `getAssetsByOwner`, which works against the same URL we use for regular
// RPC. The matcher tries three strategies, in order:
//
//   1. Recognise NFTs minted by THIS app via metadata URI pointing back at
//      /api/cards/<id>/metadata. Highest confidence.
//   2. Match against `setId-number` attributes (Collector Crypt + similar
//      phygital platforms expose set + card-number traits).
//   3. Fuzzy match on Pokemon name + set name (last resort, lower
//      confidence — UI marks these so user can verify before importing).
//
// Per-card returns a `confidence` score the client can sort/filter by.

import type { Card } from '../game/types';

export interface ImportCandidate {
  mintAddress: string;
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
  ownerAddress: string;
  publicOrigin?: string;
  cardLibrary: Record<string, Card>;
  setIdByName: Map<string, string>;
}

interface DasAttribute {
  trait_type?: string;
  value?: string | number;
}

interface DasAsset {
  id: string;
  interface?: string;
  content?: {
    json_uri?: string;
    metadata?: {
      name?: string;
      symbol?: string;
      description?: string;
      attributes?: DasAttribute[];
    };
    links?: { image?: string };
    files?: Array<{ uri?: string; cdn_uri?: string }>;
  };
  ownership?: { owner?: string };
}

interface DasResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: { total: number; items: DasAsset[] };
  error?: { code: number; message: string };
}

const POKEMON_KEYWORDS = ['pokemon', 'pokémon', 'pokeball', 'pikachu', 'charizard', 'trading card'];

function normaliseTrait(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function findAttribute(attrs: DasAttribute[] | undefined, names: string[]): string | undefined {
  if (!attrs) return undefined;
  const lookup = new Set(names.map(normaliseTrait));
  for (const attr of attrs) {
    if (lookup.has(normaliseTrait(attr.trait_type)) && attr.value !== undefined && attr.value !== null) {
      return String(attr.value);
    }
  }
  return undefined;
}

function imageFor(asset: DasAsset): string | undefined {
  return asset.content?.links?.image
    ?? asset.content?.files?.find((file) => file.cdn_uri || file.uri)?.cdn_uri
    ?? asset.content?.files?.find((file) => file.uri)?.uri;
}

function looksPokemon(asset: DasAsset): boolean {
  const haystack = [
    asset.content?.metadata?.name,
    asset.content?.metadata?.symbol,
    asset.content?.metadata?.description,
    ...(asset.content?.metadata?.attributes ?? []).flatMap((a) => [a.trait_type, String(a.value ?? '')]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return POKEMON_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function extractAppMintCardId(asset: DasAsset, publicOrigin?: string): string | undefined {
  const uri = asset.content?.json_uri;
  if (!uri) return undefined;
  // Booster pack mints from this app point at /api/cards/<id>/metadata.
  const match = uri.match(/\/api\/cards\/([^/?#]+)\/metadata/);
  if (!match) return undefined;
  if (publicOrigin && !uri.startsWith(publicOrigin)) return undefined;
  return decodeURIComponent(match[1]);
}

function matchByAttributes(
  asset: DasAsset,
  cardLibrary: Record<string, Card>,
  setIdByName: Map<string, string>,
): string | undefined {
  const attrs = asset.content?.metadata?.attributes;
  if (!attrs) return undefined;

  // 1) explicit id attribute
  const explicitId = findAttribute(attrs, ['card id', 'cardid', 'card_id', 'tcg id', 'tcg_id']);
  if (explicitId && cardLibrary[explicitId]) return explicitId;

  // 2) setId + number
  const setHint = findAttribute(attrs, ['set id', 'set_id', 'setid', 'set']);
  const number = findAttribute(attrs, ['number', 'card number', 'card #', '#', 'card_number']);
  if (number) {
    const normalisedNumber = number.replace(/^0+/, '');
    const setId = setHint ? (setIdByName.get(normaliseTrait(setHint)) ?? setHint.toLowerCase()) : undefined;
    if (setId) {
      const direct = `${setId}-${number}`;
      if (cardLibrary[direct]) return direct;
      const trimmed = `${setId}-${normalisedNumber}`;
      if (cardLibrary[trimmed]) return trimmed;
    }
  }
  return undefined;
}

function matchByName(
  asset: DasAsset,
  cardLibrary: Record<string, Card>,
  setIdByName: Map<string, string>,
): string | undefined {
  const attrs = asset.content?.metadata?.attributes;
  const setHint = findAttribute(attrs, ['set name', 'set', 'series']);
  const nameHint = findAttribute(attrs, ['pokemon', 'pokémon', 'card name', 'name'])
    ?? asset.content?.metadata?.name;
  if (!nameHint) return undefined;
  const setId = setHint ? setIdByName.get(normaliseTrait(setHint)) : undefined;
  const target = normaliseTrait(nameHint.split(/[-–—:|(]/)[0]);
  if (!target) return undefined;
  const candidates = Object.values(cardLibrary).filter((card) => {
    if (setId && !card.id.startsWith(`${setId}-`)) return false;
    return normaliseTrait(card.name) === target || normaliseTrait(card.name).includes(target);
  });
  if (candidates.length === 0) return undefined;
  // Prefer Basic Pokemon (lower number), exact-name match, then first hit.
  candidates.sort((a, b) => {
    const ax = normaliseTrait(a.name) === target ? 0 : 1;
    const bx = normaliseTrait(b.name) === target ? 0 : 1;
    return ax - bx;
  });
  return candidates[0].id;
}

function classifyCandidate(
  asset: DasAsset,
  cardLibrary: Record<string, Card>,
  setIdByName: Map<string, string>,
  publicOrigin: string | undefined,
): ImportCandidate {
  const appMintId = extractAppMintCardId(asset, publicOrigin);
  const attributeId = appMintId ? undefined : matchByAttributes(asset, cardLibrary, setIdByName);
  const nameId = !appMintId && !attributeId ? matchByName(asset, cardLibrary, setIdByName) : undefined;
  const chosen = appMintId ?? attributeId ?? nameId;
  const matched = chosen ? cardLibrary[chosen] : undefined;
  const confidence: ImportCandidate['confidence'] = appMintId
    ? 'app-mint'
    : attributeId
      ? 'attribute-match'
      : nameId
        ? 'fuzzy-match'
        : 'none';
  const setName = matched?.id.split('-')[0];
  return {
    mintAddress: asset.id,
    nftName: asset.content?.metadata?.name ?? asset.id,
    nftImage: imageFor(asset),
    cardId: matched?.id,
    cardName: matched?.name,
    setName,
    cardImage: matched?.images?.large ?? matched?.images?.small,
    confidence,
    metadataUri: asset.content?.json_uri,
  };
}

export async function scanWalletForPokemonNfts({
  rpcUrl,
  ownerAddress,
  publicOrigin,
  cardLibrary,
  setIdByName,
}: ScanWalletOptions): Promise<ImportCandidate[]> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'import-scan',
      method: 'getAssetsByOwner',
      params: {
        ownerAddress,
        page: 1,
        limit: 1000,
        displayOptions: { showUnverifiedCollections: false, showCollectionMetadata: true },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Helius DAS request failed: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as DasResponse;
  if (json.error) {
    throw new Error(`Helius DAS error: ${json.error.message}`);
  }
  const assets = json.result?.items ?? [];
  return assets
    .map((asset) => classifyCandidate(asset, cardLibrary, setIdByName, publicOrigin))
    // Keep matched-card hits + likely-Pokemon NFTs even if unmatched, drop the rest.
    .filter((c) => c.confidence !== 'none' || looksPokemon({ ...assets[0], ...{ id: c.mintAddress } } as DasAsset))
    .sort((a, b) => {
      const order: Record<ImportCandidate['confidence'], number> = {
        'app-mint': 0,
        'attribute-match': 1,
        'fuzzy-match': 2,
        'none': 3,
      };
      return order[a.confidence] - order[b.confidence];
    });
}

/** Build a name -> setId lookup once at boot from the bundled set manifest. */
export function buildSetNameIndex(sets: Array<{ id: string; name: string; ptcgoCode?: string }>): Map<string, string> {
  const index = new Map<string, string>();
  for (const set of sets) {
    index.set(normaliseTrait(set.name), set.id);
    if (set.ptcgoCode) index.set(normaliseTrait(set.ptcgoCode), set.id);
    index.set(normaliseTrait(set.id), set.id);
  }
  return index;
}
