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
  | { type: 'conditionSelf'; condition: SpecialCondition }
  | { type: 'coinFlipCondition'; condition: SpecialCondition }
  | { type: 'healSelf'; amount: number }
  | { type: 'healAllOwn'; amount: number }
  | { type: 'clearOwnConditions' }
  | { type: 'selfDamage'; amount: number }
  | { type: 'selfBenchSplash'; amount: number }
  | { type: 'draw'; count: number }
  | { type: 'coinBonusDamage'; amount: number }
  | { type: 'coinMultiHeadsDamage'; perHead: number; numCoins: number }
  | { type: 'coinFlipsAllHeadsOrFail'; numCoins: number }
  | { type: 'coinFlipDiscardOppEnergy' }
  | { type: 'coinUntilTailsDiscardOppEnergy' }
  | { type: 'coinUntilTailsBaseDamage'; perHead: number }
  // "Flip a number of coins equal to the number of [Type ]Energy attached
  // to <attacker>. This attack does X damage (× heads | + Y for each heads)."
  // Big Eggsplosion, Erika's Exeggcute, Poliwrath's Hydro Punch, Houndoom,
  // etc. `baseDamage === undefined` ⇒ "× heads" form (the printed damage IS
  // the per-head value, no base). `baseDamage !== undefined` ⇒ "+ Y for each
  // heads" form. `energyType` filters which energy on the attacker counts.
  | { type: 'coinPerSelfEnergyHeadsDamage'; perHead: number; baseDamage?: number; energyType?: PokemonType }
  | { type: 'damagePerOwnDamageCounter'; perCounter: number }
  | { type: 'damagePerOpponentEnergy'; perEnergy: number }
  | { type: 'damagePerOpponentRetreatColorless'; perColorless: number }
  | { type: 'damageIfHasTool'; bonus: number }
  | { type: 'damageIgnoreDefenderEffects' }
  | { type: 'damageOppBench'; amount: number }
  | { type: 'discardOppEnergy'; count: number }
  | { type: 'discardOwnEnergy'; count: number; energyType?: PokemonType }
  | { type: 'discardAllOwnEnergy' }
  | { type: 'discardStadium' }
  | { type: 'searchAndAttachEnergy'; count: number; energyType: PokemonType }
  | { type: 'searchNamedBasicToBench' }
  | { type: 'selfSwitch' }
  | { type: 'opponentChoosesSwitch' }
  | { type: 'selfMillDeck'; count: number };

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
  /** Special Energy cards (Double Colorless, etc.) provide multiple
   *  symbols when attached. One entry per symbol. Omitted on basic
   *  energy — those provide a single `energyType` symbol. */
  providesEnergy?: PokemonType[];
}

export interface TrainerCard extends BaseCard {
  kind: 'trainer';
  trainerType: TrainerType;
  effect?:
    | 'heal30'
    | 'draw3'
    | 'shuffleHandDraw5'
    | 'research'
    | 'switch'
    | 'searchBasicToBench'
    | 'stadiumPlus10'
    | 'toolMinus10'
    | 'pokeBall'           // Coin flip: heads, search deck for any Pokemon
    | 'greatBall'          // Look at top 7, take 1 Pokemon, shuffle rest
    | 'energyRetrieval'    // Discard 1 card from hand, retrieve up to 2 basic energy from discard
    | 'rareCandy'          // Evolve Basic → Stage 2 directly (skip Stage 1)
    | 'bossOrders';        // Switch in opponent's benched Pokemon
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
  wagerCurrency: WagerCurrency;
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

export type MatchType = 'Casual' | 'Ranked' | 'Wager' | 'Theme Deck' | 'Unlimited' | 'Tournament Practice';

// MatchTypes that count toward the public leaderboard. Casual/Theme/etc
// stay personal-history-only so practice play doesn't impact rank.
export const RANKED_MATCH_TYPES: MatchType[] = ['Ranked', 'Wager'];

// Currencies the in-game wager popup knows how to display. The app never
// escrows funds — it just shows the winner's wallet + amount/currency so
// the loser can settle off-app. Adding a new currency only needs an entry
// here, a mint address (if SPL), and a formatter case in formatWager.
export type WagerCurrency = 'SOL' | 'POKETCG';

// Pump.fun tokenized agent mint for $POKETCG. Used both as the booster
// payment currency (separately, via PAYMENT_AMOUNT/CURRENCY_MINT env vars)
// and as the SPL token the loser sends when wagering in $POKETCG.
export const POKETCG_TOKEN_MINT = 'N9Curnf2ZQWBZWrjBkzP6xBe6n5WRhBhouRfiSqpump';

export interface PokemonTCGSetupData {
  deckLabels?: Partial<Record<PlayerID, string>>;
  walletAddresses?: Partial<Record<PlayerID, string>>;
  matchName?: string;
  matchType?: MatchType;
  wagerAmount?: number;
  wagerCurrency?: WagerCurrency;
  seedDecks?: Partial<Record<PlayerID, string[]>>;
  shuffleDecks?: boolean;
  firstPlayer?: PlayerID;
  playmatId?: PlaymatID;
}

export function formatWager(amount: number, currency: WagerCurrency): string {
  if (currency === 'POKETCG') {
    // $POKETCG amounts can be large — format with thousands separators and
    // no fixed decimals (users type whole-token amounts).
    return `${amount.toLocaleString('en-US')} $POKETCG`;
  }
  return `${amount} SOL`;
}
