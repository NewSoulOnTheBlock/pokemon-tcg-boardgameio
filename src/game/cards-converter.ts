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

  if (!text) return undefined;

  // ----- Self-targeting condition: "This Pokémon is now Asleep." -------
  // Must run BEFORE the generic condition matcher, which would otherwise
  // apply the condition to the defender.
  const selfConditionMatch = text.match(/this pok[eé]mon is now (asleep|burned|confused|paralyzed|poisoned)/);
  if (selfConditionMatch) {
    return { type: 'conditionSelf', condition: selfConditionMatch[1] as SpecialCondition };
  }

  // ----- Coin-flip-then-condition: Rotom Thunder Shock etc. -----------
  const coinConditionMatch = text.match(/flip a coin\.?\s*if heads,?[^.]*?(asleep|burned|confused|paralyzed|poisoned)/);
  if (coinConditionMatch) {
    return { type: 'coinFlipCondition', condition: coinConditionMatch[1] as SpecialCondition };
  }

  // ----- Heal all your Pokémon (Healing Melody) ------------------------
  const healAllMatch = text.match(/heal (\d+) damage from each of your pok[eé]mon/);
  if (healAllMatch) {
    return { type: 'healAllOwn', amount: Number(healAllMatch[1]) };
  }

  // ----- Clear own conditions (Lick Away) ------------------------------
  if (text.match(/remove all special conditions from this pok[eé]mon/)) {
    return { type: 'clearOwnConditions' };
  }

  // ----- Discard top N of own deck (Dragon Pulse) ---------------------
  const millMatch = text.match(/discard the top (\d+) cards? of your deck/);
  if (millMatch) {
    return { type: 'selfMillDeck', count: Number(millMatch[1]) };
  }

  // ----- Damage scales by counters on self (Raging Claws) -------------
  const perCounterMatch = text.match(/this attack does (\d+) more damage for each damage counter on this pok[eé]mon/);
  if (perCounterMatch) {
    return { type: 'damagePerOwnDamageCounter', perCounter: Number(perCounterMatch[1]) };
  }

  // ----- Damage scales by opponent's attached energy (Kirlia Psychic) -
  const perOppEnergyMatch = text.match(/this attack does (\d+) more damage for each energy attached to your opponent['']s active pok[eé]mon/);
  if (perOppEnergyMatch) {
    return { type: 'damagePerOpponentEnergy', perEnergy: Number(perOppEnergyMatch[1]) };
  }

  // ----- Damage per Colorless in opp retreat cost (Heracross) ---------
  const perColorlessMatch = text.match(/this attack does (\d+) more damage for each colorless in your opponent['']s active pok[eé]mon['']s retreat cost/);
  if (perColorlessMatch) {
    return { type: 'damagePerOpponentRetreatColorless', perColorless: Number(perColorlessMatch[1]) };
  }

  // ----- Tool bonus damage (Enhanced Fang) ----------------------------
  const toolBonusMatch = text.match(/if this pok[eé]mon has a pok[eé]mon tool attached, this attack does (\d+) more damage/);
  if (toolBonusMatch) {
    return { type: 'damageIfHasTool', bonus: Number(toolBonusMatch[1]) };
  }

  // ----- Ignore defender effects (Shred) ------------------------------
  if (text.match(/this attack['']?s damage isn['']?t affected by any effects on the defending pok[eé]mon/)) {
    return { type: 'damageIgnoreDefenderEffects' };
  }

  // ----- Splash bench damage (Earthquake) -----------------------------
  const splashMatch = text.match(/this attack also does (\d+) damage to each of your benched pok[eé]mon/);
  if (splashMatch) {
    return { type: 'selfBenchSplash', amount: Number(splashMatch[1]) };
  }

  // ----- Discard own energy (Bright Flame, Power Blast, Electro Paws) -
  if (text.match(/discard all energy from this pok[eé]mon/)) {
    return { type: 'discardAllOwnEnergy' };
  }
  const discardEnergyMatch = text.match(/discard (\d+) (\w+) energy from this pok[eé]mon/);
  if (discardEnergyMatch) {
    return {
      type: 'discardOwnEnergy',
      count: Number(discardEnergyMatch[1]),
      energyType: toPokemonType(discardEnergyMatch[2]) ?? undefined,
    };
  }
  if (text.match(/discard an energy from this pok[eé]mon/)) {
    return { type: 'discardOwnEnergy', count: 1 };
  }

  // ----- Discard a Stadium (Blazing Destruction) ----------------------
  if (text.match(/discard a stadium in play/)) {
    return { type: 'discardStadium' };
  }

  // ----- Search-and-attach (Tail on Fire, Stoke) ----------------------
  const searchEnergyMatch = text.match(/search your deck for (?:up to )?(\d+|a) basic (\w+) energy card/);
  if (searchEnergyMatch) {
    const countToken = searchEnergyMatch[1];
    const count = countToken === 'a' ? 1 : Number(countToken);
    const energyType = toPokemonType(searchEnergyMatch[2]);
    if (energyType) {
      return { type: 'searchAndAttachEnergy', count, energyType };
    }
  }
  const searchEnergyMatchBare = text.match(/search your deck for a (\w+) energy card and attach/);
  if (searchEnergyMatchBare) {
    const energyType = toPokemonType(searchEnergyMatchBare[1]);
    if (energyType) {
      return { type: 'searchAndAttachEnergy', count: 1, energyType };
    }
  }

  // ----- Coin-flip discard opp energy (Maschiff Crunch) ---------------
  if (text.match(/flip a coin\.?\s*if heads,?\s*discard an energy from your opponent['']s active pok[eé]mon/)) {
    return { type: 'coinFlipDiscardOppEnergy' };
  }

  // ----- Coin-until-tails discard opp energy (Krookodile) -------------
  if (text.match(/flip a coin until you get tails\.?\s*for each heads,?\s*discard an energy from your opponent['']s active pok[eé]mon/)) {
    return { type: 'coinUntilTailsDiscardOppEnergy' };
  }

  // ----- Coin-multi-heads damage (Doduo Fury Attack) -------------------
  const multiCoinDamageMatch = text.match(/flip (\d+) coins?\.?\s*this attack does (\d+) damage times the number of heads/);
  if (multiCoinDamageMatch) {
    return {
      type: 'coinMultiHeadsDamage',
      numCoins: Number(multiCoinDamageMatch[1]),
      perHead: Number(multiCoinDamageMatch[2]),
    };
  }

  // ----- All-heads-or-nothing coin (Druddigon Big Swing, Farfetch'd) -
  const allHeadsMatch = text.match(/flip (\d+|a) coins?\.?\s*if (?:either of them is tails|tails)/);
  if (allHeadsMatch) {
    const token = allHeadsMatch[1];
    const numCoins = token === 'a' ? 1 : Number(token);
    return { type: 'coinFlipsAllHeadsOrFail', numCoins };
  }

  // ----- Existing simple effects (keep last so specific patterns win) -
  const condition = SPECIAL_CONDITIONS.find((candidate) => text.includes(candidate));
  if (condition) {
    return { type: 'condition', condition };
  }

  const healMatch = text.match(/heal (\d+) damage from this pok[eé]mon/);
  if (healMatch) {
    return { type: 'healSelf', amount: Number(healMatch[1]) };
  }

  const selfDamageMatch = text.match(/does (\d+) damage to (itself|this pok[eé]mon)/);
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
  const isSpecial = source.subtypes?.some((subtype) => normalize(subtype) === 'special') ?? false;
  const name = normalize(source.name);
  const energyType = inferEnergyType(source);

  // Special Energy cards that we hand-recognise. Each entry in
  // providesEnergy counts as one symbol when paying an attack cost
  // (canPayEnergyCost flat-maps these). Double Dragon Energy officially
  // provides 2 of any type but only for Dragon Pokemon — approximate as
  // 2 Colorless so non-Dragon attacks still parse predictably.
  let providesEnergy: EnergyCard['providesEnergy'];
  if (isSpecial) {
    if (name.includes('double colorless')) providesEnergy = ['Colorless', 'Colorless'];
    else if (name.includes('double dragon')) providesEnergy = ['Colorless', 'Colorless'];
  }

  return {
    ...baseCardFields(source),
    kind: 'energy',
    energyType,
    basic: source.subtypes?.some((subtype) => normalize(subtype) === 'basic') ?? false,
    providesEnergy,
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
  // Youngster: "Shuffle your hand into your deck. Then, draw 5 cards." The
  // older converter mapped this to draw3 by name only, which silently
  // dropped two cards per play and ignored the shuffle. Use a dedicated
  // effect opcode so the runtime can do both steps.
  if (name === 'youngster' || text.includes('shuffle your hand into your deck. then, draw 5')) return 'shuffleHandDraw5';
  if (text.includes('draw 3 card')) return 'draw3';
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
