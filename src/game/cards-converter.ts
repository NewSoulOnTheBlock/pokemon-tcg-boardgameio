// Convert raw Pokemon TCG JSON cards (slim manifest shape) into the runtime
// Card objects the engine and UI use. Server-only — the client never imports
// this file, so the manifest and its converter never end up in the Vite
// client bundle. esbuild bundles it into dist-server/server.mjs for the
// one-time Postgres migration on first boot.

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

export interface SourceAttack {
  name?: string;
  cost?: string[];
  damage?: string;
  text?: string;
}

export interface SourceCard {
  id: string;
  name: string;
  supertype: string;
  subtypes?: string[];
  hp?: string;
  types?: string[];
  evolvesFrom?: string;
  attacks?: SourceAttack[];
  weaknesses?: Array<{ type?: string }>;
  resistances?: Array<{ type?: string }>;
  retreatCost?: string[];
  convertedRetreatCost?: number;
  rarity?: string;
  rules?: string[];
  text?: string;
  images?: {
    small?: string;
    large?: string;
  };
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

/**
 * Convert the slim manifest into the runtime Card[] used by CARD_LIBRARY.
 * Aliases (sprigatito, charmander, ...) are appended last so the canonical
 * `sv1-13` is converted first and the alias is structurally cloned from it.
 */
export function convertManifestToCards(sources: SourceCard[]): Card[] {
  const byId: Record<string, Card> = {};
  for (const source of sources) {
    const card = convertCard(source);
    if (card) byId[card.id] = card;
  }
  const out = Object.values(byId);
  for (const [alias, targetId] of Object.entries(CARD_ID_ALIASES)) {
    const target = byId[targetId];
    if (target) {
      out.push({ ...structuredClone(target), id: alias, sourceId: targetId });
    }
  }
  return out;
}
