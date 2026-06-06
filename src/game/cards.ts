import type {
  Attack,
  AttackEffect,
  Card,
  EnergyCard,
  PokemonCard,
  PokemonType,
  Stage,
  SpecialCondition,
  TrainerCard,
  TrainerType,
} from './types';
import slimCardManifest from '../data/card-manifest.generated.json' with { type: 'json' };

interface SourceAttack {
  name?: string;
  cost?: string[];
  damage?: string;
  text?: string;
}

interface SourceAbility {
  name: string;
  text?: string;
  type?: string;
}

interface SourceCard {
  id: string;
  name: string;
  supertype: string;
  subtypes?: string[];
  hp?: string;
  types?: string[];
  evolvesFrom?: string;
  abilities?: SourceAbility[];
  attacks?: SourceAttack[];
  weaknesses?: Array<{ type?: string }>;
  resistances?: Array<{ type?: string }>;
  retreatCost?: string[];
  convertedRetreatCost?: number;
  number?: string;
  artist?: string;
  rarity?: string;
  legalities?: Record<string, string>;
  regulationMark?: string;
  images?: {
    small?: string;
    large?: string;
  };
  rules?: string[];
  text?: string;
}

const POKEMON_IMAGE_BASE = 'https://images.pokemontcg.io';

function deriveImagesForId(id: string, overrides?: { small?: string; large?: string }): { small?: string; large?: string } | undefined {
  const dashIndex = id.indexOf('-');
  if (dashIndex < 0) return overrides;
  const setId = id.slice(0, dashIndex);
  const number = id.slice(dashIndex + 1);
  return {
    small: overrides?.small ?? `${POKEMON_IMAGE_BASE}/${setId}/${number}.png`,
    large: overrides?.large ?? `${POKEMON_IMAGE_BASE}/${setId}/${number}_hires.png`,
  };
}

// NOTE: we hold the raw manifest array (kept alive by the module cache as
// `slimCardManifest`'s default export) but DO NOT eagerly map over it. The
// previous `.map(rehydrate)` doubled the manifest's footprint on the server.
// Image URL derivation happens lazily inside `convertCard` so the converted
// Card object is the only persistent representation.

const POKEMON_TYPES = [
  'Grass',
  'Fire',
  'Water',
  'Lightning',
  'Psychic',
  'Fighting',
  'Darkness',
  'Metal',
  'Dragon',
  'Fairy',
  'Colorless',
] as const satisfies readonly PokemonType[];

const RULE_BOX_SUBTYPES: PokemonCard['ruleBox'][] = ['ex', 'V', 'VSTAR', 'VMAX', 'V-UNION', 'Radiant', 'GX', 'EX', 'TAG TEAM'];
const SPECIAL_CONDITIONS = ['asleep', 'burned', 'confused', 'paralyzed', 'poisoned'] as const satisfies readonly SpecialCondition[];

const CARD_ID_ALIASES: Record<string, string> = {
  sprigatito: 'sv1-13',
  floragato: 'sv1-14',
  meowscaradaex: 'sv2-15',
  charmander: 'sv3pt5-4',
  charmeleon: 'sv3pt5-5',
  charizardex: 'sv3pt5-6',
  quaxly: 'sv1-52',
  quaxwell: 'sv1-53',
  miraidonex: 'sv1-81',
  snorlax: 'pgo-55',
  grass_energy: 'sve-1',
  fire_energy: 'sve-2',
  water_energy: 'sve-3',
  lightning_energy: 'sve-4',
  psychic_energy: 'sve-5',
  fighting_energy: 'sve-6',
  darkness_energy: 'sve-7',
  metal_energy: 'sve-8',
  fairy_energy: 'xy1-140',
  dragon_energy: 'xy6-97',
  colorless_energy: 'base1-96',
  potion: 'sv1-188',
  youngster: 'sv1-198',
  professor_research: 'sv4pt5-87',
  switch: 'sv1-194',
  nest_ball: 'sv1-181',
  training_court: 'swsh2-169',
  sturdy_charm: 'sv2-173',
};

function normalize(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/é/g, 'e')
    .toLowerCase();
}

function baseCardFields(source: SourceCard): Pick<Card, 'id' | 'name' | 'rarity' | 'images' | 'sourceId'> {
  return {
    id: source.id,
    name: source.name,
    rarity: source.rarity,
    images: deriveImagesForId(source.id, source.images),
    sourceId: source.id,
  };
}

function toPokemonType(value: string | undefined): PokemonType | undefined {
  return POKEMON_TYPES.find((type) => normalize(type) === normalize(value));
}

function firstPokemonType(values: Array<string | undefined> | undefined, fallback: PokemonType = 'Colorless'): PokemonType {
  return values?.map(toPokemonType).find((type): type is PokemonType => Boolean(type)) ?? fallback;
}

function firstPokemonTypeOrUndefined(values: Array<string | undefined> | undefined): PokemonType | undefined {
  if (!values) return undefined;
  for (const value of values) {
    const matched = toPokemonType(value);
    if (matched) return matched;
  }
  return undefined;
}

function attackCost(cost: string[] | undefined): PokemonType[] {
  return (cost ?? []).map(toPokemonType).filter((type): type is PokemonType => Boolean(type));
}

function parseDamage(damage: string | undefined): number | undefined {
  const match = damage?.match(/\d+/);
  return match ? Number(match[0]) : undefined;
}

function inferAttackEffect(attack: SourceAttack): AttackEffect | undefined {
  const text = normalize(attack.text);
  const damage = parseDamage(attack.damage);

  const condition = SPECIAL_CONDITIONS.find((candidate) => text.includes(candidate));
  if (condition) {
    return { type: 'condition', condition };
  }

  const healMatch = text.match(/heal (\d+) damage from this pokemon/);
  if (healMatch) {
    return { type: 'healSelf', amount: Number(healMatch[1]) };
  }

  const selfDamageMatch = text.match(/does (\d+) damage to (itself|this pokemon)/);
  if (selfDamageMatch) {
    return { type: 'selfDamage', amount: Number(selfDamageMatch[1]) };
  }

  const drawMatch = text.match(/draw (\d+) card/);
  if (drawMatch) {
    return { type: 'draw', count: Number(drawMatch[1]) };
  }

  if (text.includes('flip a coin') && text.includes('more damage') && damage !== undefined) {
    return { type: 'coinBonusDamage', amount: damage };
  }

  return undefined;
}

function convertAttack(source: SourceAttack): Attack {
  return {
    name: source.name ?? 'Attack',
    cost: attackCost(source.cost),
    damage: parseDamage(source.damage),
    effect: inferAttackEffect(source),
  };
}

function pokemonStage(subtypes: string[] | undefined, evolvesFrom: string | undefined): Stage {
  const normalized = (subtypes ?? []).map(normalize);
  if (normalized.includes('basic')) return 'Basic';
  if (normalized.includes('stage 1')) return 'Stage 1';
  if (normalized.includes('stage 2')) return 'Stage 2';
  if (normalized.includes('vstar')) return 'VSTAR';
  if (normalized.includes('vmax')) return 'VMAX';
  if (normalized.includes('break')) return 'BREAK';
  if (normalized.includes('restored')) return 'Restored';
  if (normalized.includes('mega')) return 'MEGA';
  if (normalized.includes('level-up')) return 'Level-Up';
  if (normalized.includes('legend')) return 'LEGEND';
  if (normalized.includes('v-union')) return 'V-UNION';
  return evolvesFrom ? 'Stage 1' : 'Basic';
}

function ruleBoxFor(subtypes: string[] | undefined): PokemonCard['ruleBox'] | undefined {
  return RULE_BOX_SUBTYPES.find((ruleBox) => subtypes?.some((subtype) => normalize(subtype) === normalize(ruleBox)));
}

function prizeValueForRuleBox(ruleBox: PokemonCard['ruleBox'] | undefined): number | undefined {
  switch (ruleBox) {
    case 'VMAX':
    case 'V-UNION':
    case 'TAG TEAM':
      return 3;
    case 'ex':
    case 'V':
    case 'VSTAR':
    case 'GX':
    case 'EX':
      return 2;
    default:
      return undefined;
  }
}

function convertPokemon(source: SourceCard): PokemonCard {
  const ruleBox = ruleBoxFor(source.subtypes);
  return {
    ...baseCardFields(source),
    kind: 'pokemon',
    stage: pokemonStage(source.subtypes, source.evolvesFrom),
    pokemonType: firstPokemonType(source.types),
    hp: Number(source.hp ?? 0),
    attacks: (source.attacks ?? []).map(convertAttack),
    retreatCost: source.convertedRetreatCost ?? source.retreatCost?.length ?? 0,
    evolvesFrom: source.evolvesFrom,
    weakness: firstPokemonTypeOrUndefined(source.weaknesses?.map((weakness) => weakness.type)),
    resistance: firstPokemonTypeOrUndefined(source.resistances?.map((resistance) => resistance.type)),
    prizeValue: prizeValueForRuleBox(ruleBox),
    ruleBox,
  };
}

function inferEnergyType(source: SourceCard): PokemonType {
  for (const candidate of source.types ?? []) {
    const matched = toPokemonType(candidate);
    if (matched) return matched;
  }

  return POKEMON_TYPES.find((type) => normalize(source.name).includes(normalize(type))) ?? 'Colorless';
}

function convertEnergy(source: SourceCard): EnergyCard {
  return {
    ...baseCardFields(source),
    kind: 'energy',
    energyType: inferEnergyType(source),
    basic: source.subtypes?.some((subtype) => normalize(subtype) === 'basic') ?? false,
  };
}

function trainerTypeFor(subtypes: string[] | undefined): TrainerType {
  const normalized = (subtypes ?? []).map(normalize);
  if (normalized.some((subtype) => subtype.includes('supporter'))) return 'Supporter';
  if (normalized.some((subtype) => subtype.includes('stadium'))) return 'Stadium';
  if (normalized.some((subtype) => subtype.includes('tool'))) return 'Pokemon Tool';
  return 'Item';
}

function trainerText(source: SourceCard): string {
  return normalize([...(source.rules ?? []), source.text].filter(Boolean).join(' '));
}

function trainerEffectFor(source: SourceCard): TrainerCard['effect'] {
  const text = trainerText(source);
  const name = normalize(source.name);

  if (name === 'potion' || text.includes('heal 30 damage')) return 'heal30';
  if (name === 'professors research' || text.includes('discard your hand and draw 7')) return 'research';
  if (name === 'youngster' || text.includes('draw 3 card')) return 'draw3';
  if (name === 'switch') return 'switch';
  if (name === 'nest ball' || text.includes('search your deck for a basic pokemon')) return 'searchBasicToBench';
  if (name === 'training court') return 'stadiumPlus10';
  if (name === 'bravery charm' || name === 'sturdy charm') return 'toolMinus10';
  return undefined;
}

function convertTrainer(source: SourceCard): TrainerCard {
  return {
    ...baseCardFields(source),
    kind: 'trainer',
    trainerType: trainerTypeFor(source.subtypes),
    effect: trainerEffectFor(source),
  };
}

function convertCard(source: SourceCard): Card | undefined {
  const supertype = normalize(source.supertype);
  if (supertype === 'pokemon') return convertPokemon(source);
  if (supertype === 'energy') return convertEnergy(source);
  if (supertype === 'trainer') return convertTrainer(source);
  return undefined;
}

function buildCardLibrary(): Record<string, Card> {
  const library: Record<string, Card> = {};

  for (const source of slimCardManifest as SourceCard[]) {
    const card = convertCard(source);
    if (card) {
      library[card.id] = card;
    }
  }

  for (const [alias, targetId] of Object.entries(CARD_ID_ALIASES)) {
    const target = library[targetId];
    if (target) {
      library[alias] = { ...structuredClone(target), id: alias, sourceId: targetId };
    }
  }

  return library;
}

/**
 * Lazy-built card catalogue. On the server (Render starter = 512 MB total),
 * eagerly converting ~20k entries cost ~138 MB and pushed boot RSS over the
 * memory cap. By deferring construction until the first lookup, the boot path
 * (Koa + boardgame.io + Postgres pool + health probe) fits comfortably and the
 * cost is only paid when an actual match needs a card. The Proxy keeps the old
 * `CARD_LIBRARY[id]` / `Object.values(CARD_LIBRARY)` API working everywhere.
 */
let _library: Record<string, Card> | undefined;

function getCardLibrary(): Record<string, Card> {
  if (!_library) {
    _library = buildCardLibrary();
  }
  return _library;
}

export const CARD_LIBRARY: Record<string, Card> = new Proxy({} as Record<string, Card>, {
  get(_target, prop) {
    if (typeof prop === 'symbol') return undefined;
    return getCardLibrary()[prop];
  },
  has(_target, prop) {
    if (typeof prop === 'symbol') return false;
    return prop in getCardLibrary();
  },
  ownKeys() {
    return Reflect.ownKeys(getCardLibrary());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(getCardLibrary(), prop);
  },
});

export function cloneCard(cardId: string): Card {
  const card = CARD_LIBRARY[cardId];
  if (!card) {
    throw new Error(`Unknown card id: ${cardId}`);
  }

  return structuredClone(card);
}

export function makeDeck(cardIds: string[]): Card[] {
  return cardIds.map(cloneCard);
}

export type StarterEnergyType =
  | 'Grass'
  | 'Fire'
  | 'Water'
  | 'Lightning'
  | 'Psychic'
  | 'Fighting'
  | 'Darkness'
  | 'Metal'
  | 'Dragon'
  | 'Fairy'
  | 'Colorless';

export const STARTER_ENERGY_TYPES: StarterEnergyType[] = [
  'Grass',
  'Fire',
  'Water',
  'Lightning',
  'Psychic',
  'Fighting',
  'Darkness',
  'Metal',
  'Dragon',
  'Fairy',
  'Colorless',
];

export const ENERGY_TYPE_META: Record<StarterEnergyType, { hex: string; ink: string; description: string }> = {
  Grass: { hex: '#22c55e', ink: '#052e16', description: 'Healing pressure and efficient early attackers.' },
  Fire: { hex: '#ef4444', ink: '#fff7ed', description: 'High damage basics backed by aggressive Fire Energy.' },
  Water: { hex: '#38bdf8', ink: '#082f49', description: 'Reliable setup attackers with flexible Water costs.' },
  Lightning: { hex: '#facc15', ink: '#422006', description: 'Fast tempo Pokemon that punish slow starts.' },
  Psychic: { hex: '#c084fc', ink: '#2e1065', description: 'Tricky attackers with status and draw pressure.' },
  Fighting: { hex: '#b45309', ink: '#fff7ed', description: 'Durable Pokemon with direct, efficient attacks.' },
  Darkness: { hex: '#111827', ink: '#f9fafb', description: 'Disruptive basics and heavy Darkness hits.' },
  Metal: { hex: '#94a3b8', ink: '#0f172a', description: 'Resilient attackers with sturdy retreat lines.' },
  Dragon: { hex: '#f97316', ink: '#111827', description: 'Dragon Pokemon with special Dragon Energy support.' },
  Fairy: { hex: '#f9a8d4', ink: '#500724', description: 'Classic Fairy attackers from the expanded card pool.' },
  Colorless: { hex: '#e5e7eb', ink: '#111827', description: 'Flexible Colorless attackers and universal energy.' },
};

const STARTER_POKEMON: Record<StarterEnergyType, string[]> = {
  Grass: ['sv1-13', 'sv1-1', 'sv1-2', 'sv1-3'],
  Fire: ['sv3pt5-4', 'pgo-8', 'sv3-26', 'sv1-31'],
  Water: ['sv1-52', 'sv1-32', 'sv1-33', 'sv1-37'],
  Lightning: ['sv1-81', 'sv1-70', 'sv1-74', 'sv1-76'],
  Psychic: ['sv1-83', 'sv1-84', 'sv1-85', 'sv1-87'],
  Fighting: ['sv1-112', 'sv1-113', 'sv1-115', 'sv1-117'],
  Darkness: ['sv1-130', 'sv1-132', 'sv1-134', 'sv1-136'],
  Metal: ['sv1-150', 'sv1-152', 'sv1-153', 'sv1-155'],
  Dragon: ['bw10-62', 'bw10-67', 'bw10-70', 'bw11-93'],
  Fairy: ['det1-14', 'det1-15', 'g1-50', 'g1-RC19'],
  Colorless: ['pgo-55', 'base1-26', 'base1-27', 'base1-48'],
};

const STARTER_ENERGY: Record<StarterEnergyType, string> = {
  Grass: 'sve-1',
  Fire: 'sve-2',
  Water: 'sve-3',
  Lightning: 'sve-4',
  Psychic: 'sve-5',
  Fighting: 'sve-6',
  Darkness: 'sve-7',
  Metal: 'sve-8',
  Dragon: 'xy6-97',
  Fairy: 'xy1-140',
  Colorless: 'base1-96',
};

const STARTER_TRAINERS = ['sv1-188', 'sv1-198', 'sv4pt5-87', 'sv1-194', 'sv1-181'];

export function starterDeck(type: StarterEnergyType): string[] {
  const deck = [
    ...STARTER_POKEMON[type].flatMap((cardId) => Array(4).fill(cardId)),
    ...Array(24).fill(STARTER_ENERGY[type]),
    ...STARTER_TRAINERS.flatMap((cardId) => Array(4).fill(cardId)),
  ];

  return deck.slice(0, 60);
}

export const STARTER_DECKS: Record<StarterEnergyType, string[]> = Object.fromEntries(
  STARTER_ENERGY_TYPES.map((type) => [type, starterDeck(type)]),
) as Record<StarterEnergyType, string[]>;

export const DEFAULT_DECK_0: string[] = [
  ...STARTER_DECKS.Grass,
];

export const DEFAULT_DECK_1: string[] = [
  ...STARTER_DECKS.Fire,
];
