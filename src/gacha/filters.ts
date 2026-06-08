// Storefront predicate — keeps the storefront Pokémon-only.
// Collector Crypt's catalog (Jun 2026) mixes Pokémon machines with
// sports, anime, comic, and One Piece packs. We only sell Pokémon
// here so we filter the upstream /api/machines response client-side.
//
// Strategy:
//   1. If the machine's name contains "Pokemon"/"Pokémon" (case- and
//      accent-insensitive) it's in. This catches every machine whose
//      product copy says Pokémon, including the ones whose `code`
//      prefix doesn't (e.g. `sf_2500` -> "Mythic Pokémon Gacha Pack").
//   2. Otherwise the machine's `code` prefix must be in an allowlist of
//      known Pokémon characters / energy-type packs that Collector
//      Crypt has shipped without the word "Pokemon" in the name
//      (Charizard / Pikachu / Mew / Water / Fire & Grass / Sealed etc.).

const POKEMON_CHARACTER_PREFIXES = new Set([
  'charizard', 'pikachu', 'gengar', 'mew', 'mewtwo', 'eevee',
  'dragonite', 'lugia', 'rayquaza', 'lucario', 'umbreon', 'espeon',
  'sylveon', 'gyarados', 'snorlax', 'blastoise', 'venusaur',
  'arceus', 'giratina', 'darkrai', 'reshiram', 'zekrom',
]);

const POKEMON_TYPE_PREFIXES = new Set([
  'water', 'fire', 'grass', 'firegrass', 'psychic', 'electric',
  'dragon', 'fighting', 'darkness', 'metal', 'colorless', 'lightning',
  'fairy', 'sealed',
]);

export function isPokemonMachine(machine: { code?: string; name?: string }): boolean {
  const name = (machine.name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // strip diacritics so "Pokémon" matches
  if (name.includes('pokemon')) return true;

  const code = (machine.code ?? '').toLowerCase();
  const prefix = code.split('_')[0] ?? '';
  return POKEMON_CHARACTER_PREFIXES.has(prefix) || POKEMON_TYPE_PREFIXES.has(prefix);
}

// The Collector Crypt Gacha API returns relative URLs for machine
// art (e.g. `/pokemon_50.png`) — when the browser loads those it
// hits OUR origin and 404s. Resolve them against the upstream host
// so the storefront renders the actual pack art. Already-absolute
// URLs (https://, ipfs://, data:, blob:) are returned unchanged.
const GACHA_ASSET_ORIGIN = 'https://gacha.collectorcrypt.com';

export function resolveGachaAssetUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^(?:https?:|ipfs:|data:|blob:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('/')) return `${GACHA_ASSET_ORIGIN}${trimmed}`;
  // Bare filename — also assume it's on the gacha host.
  return `${GACHA_ASSET_ORIGIN}/${trimmed}`;
}
