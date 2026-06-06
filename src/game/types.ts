import type { PlaymatID } from '../playmats';

export type PlayerID = '0' | '1';
export type PokemonType =
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

export type CardKind = 'pokemon' | 'energy' | 'trainer';
export type Stage =
  | 'Basic'
  | 'Stage 1'
  | 'Stage 2'
  | 'VSTAR'
  | 'VMAX'
  | 'BREAK'
  | 'Restored'
  | 'MEGA'
  | 'Level-Up'
  | 'LEGEND'
  | 'V-UNION';
export type TrainerType = 'Item' | 'Supporter' | 'Stadium' | 'Pokemon Tool';
export type SpecialCondition = 'asleep' | 'burned' | 'confused' | 'paralyzed' | 'poisoned';

export interface Attack {
  name: string;
  cost: PokemonType[];
  damage?: number;
  effect?: AttackEffect;
}

export type AttackEffect =
  | { type: 'condition'; condition: SpecialCondition }
  | { type: 'healSelf'; amount: number }
  | { type: 'selfDamage'; amount: number }
  | { type: 'draw'; count: number }
  | { type: 'coinBonusDamage'; amount: number };

/** Card metadata held in CARD_LIBRARY. Only fields that are actually read at
 *  runtime live here; anything used only during the source -> Card conversion
 *  step (artist, legalities, rules, subtypes, abilities text, ...) is dropped
 *  so the 20 000+ entry library fits in well under 100 MB on Render. */
export interface BaseCard {
  id: string;
  name: string;
  kind: CardKind;
  rarity?: string;
  sourceId?: string;
  images?: {
    small?: string;
    large?: string;
  };
}

export interface PokemonCard extends BaseCard {
  kind: 'pokemon';
  stage: Stage;
  pokemonType: PokemonType;
  hp: number;
  attacks: Attack[];
  retreatCost: number;
  evolvesFrom?: string;
  weakness?: PokemonType;
  resistance?: PokemonType;
  prizeValue?: number;
  ruleBox?: 'ex' | 'V' | 'VSTAR' | 'VMAX' | 'V-UNION' | 'Radiant' | 'GX' | 'EX' | 'TAG TEAM';
}

export interface EnergyCard extends BaseCard {
  kind: 'energy';
  energyType: PokemonType;
  basic?: boolean;
}

export interface TrainerCard extends BaseCard {
  kind: 'trainer';
  trainerType: TrainerType;
  effect?:
    | 'heal30'
    | 'draw3'
    | 'research'
    | 'switch'
    | 'searchBasicToBench'
    | 'stadiumPlus10'
    | 'toolMinus10';
}

export type Card = PokemonCard | EnergyCard | TrainerCard;

export interface PokemonInPlay {
  instanceId: string;
  card: PokemonCard;
  evolution: PokemonCard[];
  attachedEnergy: EnergyCard[];
  tool?: TrainerCard;
  damage: number;
  conditions: SpecialCondition[];
  enteredTurn: number;
  evolvedTurn?: number;
}

export interface PlayerState {
  deck: Card[];
  hand: Card[];
  discard: Card[];
  lostZone: Card[];
  prizeCards: Card[];
  deckCount?: number;
  handCount?: number;
  prizeCount?: number;
  active?: PokemonInPlay;
  bench: PokemonInPlay[];
  ready: boolean;
  mulligans: number;
  energyAttachedThisTurn: boolean;
  supporterPlayedThisTurn: boolean;
  stadiumPlayedThisTurn: boolean;
  retreatedThisTurn: boolean;
  vstarUsed: boolean;
  gxUsed: boolean;
}

export interface PublicPlayerState extends Omit<PlayerState, 'deck' | 'hand' | 'prizeCards'> {
  deckCount: number;
  handCount: number;
  prizeCount: number;
  hand: Card[];
  prizeCards: Card[];
}

export interface PokemonTCGState {
  players: Record<PlayerID, PlayerState>;
  deckLabels: Partial<Record<PlayerID, string>>;
  walletAddresses: Partial<Record<PlayerID, string>>;
  matchName: string;
  matchType: MatchType;
  wagerAmount: number;
  playmatId: PlaymatID;
  playOrder: PlayerID[];
  firstPlayer: PlayerID;
  turnsTaken: Record<PlayerID, number>;
  stadium?: { card: TrainerCard; owner: PlayerID };
  nextInstanceId: number;
  winner?: PlayerID;
  winReason?: string;
  log: string[];
}

export type MatchType = 'Casual' | 'Ranked' | 'Wager';

export interface PokemonTCGSetupData {
  deckLabels?: Partial<Record<PlayerID, string>>;
  walletAddresses?: Partial<Record<PlayerID, string>>;
  matchName?: string;
  matchType?: MatchType;
  wagerAmount?: number;
  seedDecks?: Partial<Record<PlayerID, string[]>>;
  shuffleDecks?: boolean;
  firstPlayer?: PlayerID;
  playmatId?: PlaymatID;
}
