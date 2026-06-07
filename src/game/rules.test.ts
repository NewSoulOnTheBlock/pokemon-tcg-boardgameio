import { describe, expect, it } from 'vitest';
import {
  applyDamage,
  applyMulliganBonus,
  canPayEnergyCost,
  createPokemonInPlay,
  drawCards,
  isBasicPokemon,
  opponentOf,
  publicViewForPlayer,
  resolveAttackEffect,
  resolvePokemonCheckup,
} from './rules';
import { CARD_LIBRARY, cloneCard, makeDeck, STARTER_DECKS } from './cards';
import type { Attack, EnergyCard, PokemonCard, PokemonTCGState } from './types';

function makeEmptyState(): PokemonTCGState {
  return {
    players: {
      '0': {
        deck: [], hand: [], discard: [], lostZone: [], prizeCards: [], bench: [],
        ready: false, mulligans: 0,
        energyAttachedThisTurn: false, supporterPlayedThisTurn: false,
        stadiumPlayedThisTurn: false, retreatedThisTurn: false,
        vstarUsed: false, gxUsed: false,
      },
      '1': {
        deck: [], hand: [], discard: [], lostZone: [], prizeCards: [], bench: [],
        ready: false, mulligans: 0,
        energyAttachedThisTurn: false, supporterPlayedThisTurn: false,
        stadiumPlayedThisTurn: false, retreatedThisTurn: false,
        vstarUsed: false, gxUsed: false,
      },
    },
    deckLabels: {},
    walletAddresses: {},
    matchName: 'test',
    matchType: 'Casual',
    wagerAmount: 0,
    wagerCurrency: 'SOL',
    playmatId: 'green',
    playOrder: ['0', '1'],
    firstPlayer: '0',
    turnsTaken: { '0': 0, '1': 0 },
    nextInstanceId: 1,
    log: [],
  };
}

describe('rules', () => {
  it('opponentOf swaps player ids', () => {
    expect(opponentOf('0')).toBe('1');
    expect(opponentOf('1')).toBe('0');
  });

  it('isBasicPokemon recognises Basic stage Pokemon', () => {
    const sprigatito = cloneCard('sprigatito') as PokemonCard;
    expect(isBasicPokemon(sprigatito)).toBe(true);
    const charmeleon = cloneCard('charmeleon') as PokemonCard;
    expect(isBasicPokemon(charmeleon)).toBe(false);
  });

  it('canPayEnergyCost handles exact and colorless costs', () => {
    const fire = cloneCard('fire_energy') as EnergyCard;
    const water = cloneCard('water_energy') as EnergyCard;
    expect(canPayEnergyCost([fire, fire], ['Fire', 'Fire'])).toBe(true);
    expect(canPayEnergyCost([fire, water], ['Fire', 'Colorless'])).toBe(true);
    expect(canPayEnergyCost([water], ['Fire'])).toBe(false);
    expect(canPayEnergyCost([], ['Colorless'])).toBe(false);
  });

  it('drawCards moves the top of the deck into the hand', () => {
    const state = makeEmptyState();
    state.players['0'].deck = makeDeck(STARTER_DECKS.Grass).slice(0, 3);
    drawCards(state.players['0'], 2);
    expect(state.players['0'].hand).toHaveLength(2);
    expect(state.players['0'].deck).toHaveLength(1);
  });

  it('applyDamage doubles damage on weakness and never goes below zero', () => {
    const state = makeEmptyState();
    const attackerCard = cloneCard('charmander') as PokemonCard;
    const defenderCard = cloneCard('sprigatito') as PokemonCard;
    const attacker = createPokemonInPlay(state, attackerCard, 1);
    const defender = createPokemonInPlay(state, defenderCard, 1);

    expect(defenderCard.weakness).toBe('Fire');
    const dealt = applyDamage(state, attacker, defender, 30);
    expect(dealt).toBe(60);
    expect(defender.damage).toBe(60);

    const noOp = applyDamage(state, attacker, defender, -5);
    expect(noOp).toBe(0);
    expect(defender.damage).toBe(60);
  });

  it('publicViewForPlayer hides opponent hands, decks and prize contents', () => {
    const state = makeEmptyState();
    state.players['0'].deck = makeDeck(STARTER_DECKS.Grass).slice(0, 10);
    state.players['0'].hand = makeDeck(STARTER_DECKS.Grass).slice(10, 17);
    state.players['0'].prizeCards = makeDeck(STARTER_DECKS.Grass).slice(17, 23);
    state.players['1'].deck = makeDeck(STARTER_DECKS.Fire).slice(0, 10);
    state.players['1'].hand = makeDeck(STARTER_DECKS.Fire).slice(10, 17);

    const viewForP0 = publicViewForPlayer(state, '0');
    expect(viewForP0.players['0'].hand).toHaveLength(7);
    expect(viewForP0.players['0'].handCount).toBe(7);
    expect(viewForP0.players['0'].deck).toHaveLength(0);
    expect(viewForP0.players['0'].deckCount).toBe(10);
    expect(viewForP0.players['0'].prizeCards).toHaveLength(0);
    expect(viewForP0.players['0'].prizeCount).toBe(6);
    expect(viewForP0.players['1'].hand).toHaveLength(0);
    expect(viewForP0.players['1'].handCount).toBe(7);
  });

  it('paralysis only recovers in the checkup after the OWNER\'s turn (Pokemon TCG rule)', () => {
    // Per official rules: a Paralyzed Pokemon recovers during the Pokemon
    // Checkup that follows its OWNER'S next turn. The checkup at the end
    // of the opponent's turn (when paralysis was applied) must NOT recover.
    const state = makeEmptyState();
    const pokemonCard = cloneCard('charmander') as PokemonCard;
    const active = createPokemonInPlay(state, pokemonCard, 1);
    active.conditions = ['paralyzed'];
    state.players['1'].active = active;

    // Checkup at the end of player 0's turn (opponent of paralyzed pokemon)
    // should NOT recover.
    resolvePokemonCheckup(state, { Die: () => 1 }, '0');
    expect(state.players['1'].active?.conditions).toContain('paralyzed');

    // Checkup at the end of player 1's own turn SHOULD recover.
    resolvePokemonCheckup(state, { Die: () => 1 }, '1');
    expect(state.players['1'].active?.conditions).not.toContain('paralyzed');
  });

  it('applyMulliganBonus gives extra cards to the lower-mulligan player', () => {
    const state = makeEmptyState();
    state.players['0'].mulligans = 3;
    state.players['1'].mulligans = 1;
    state.players['1'].deck = makeDeck(STARTER_DECKS.Fire).slice(0, 5);
    const before = state.players['1'].hand.length;

    applyMulliganBonus(state);

    expect(state.players['1'].hand.length - before).toBe(2);
    expect(state.players['1'].deck.length).toBe(3);
  });

  it('applyMulliganBonus is a no-op when mulligan counts match', () => {
    const state = makeEmptyState();
    state.players['0'].mulligans = 2;
    state.players['1'].mulligans = 2;
    state.players['0'].deck = makeDeck(STARTER_DECKS.Grass).slice(0, 5);
    state.players['1'].deck = makeDeck(STARTER_DECKS.Fire).slice(0, 5);

    applyMulliganBonus(state);

    expect(state.players['0'].hand).toHaveLength(0);
    expect(state.players['1'].hand).toHaveLength(0);
  });

  it('canPayEnergyCost honours Special Energy providesEnergy', () => {
    const doubleColorless = cloneCard('base1-96') as EnergyCard;
    expect(doubleColorless.providesEnergy).toEqual(['Colorless', 'Colorless']);
    expect(canPayEnergyCost([doubleColorless], ['Colorless', 'Colorless'])).toBe(true);
    // 1 DCE alone shouldn't pay a coloured cost.
    expect(canPayEnergyCost([doubleColorless], ['Fire'])).toBe(false);
  });

  it('Shred-style applyDamage ignores defender tool effect', () => {
    const state = makeEmptyState();
    const attacker = createPokemonInPlay(
      state,
      cloneCard('sv1-3') as PokemonCard,
      0,
    );
    const defender = createPokemonInPlay(
      state,
      cloneCard('sv1-31') as PokemonCard,
      0,
    );
    defender.tool = { id: 't', kind: 'trainer', name: 'Bravery Charm', trainerType: 'Pokemon Tool', effect: 'toolMinus10' };

    const normal = applyDamage(state, attacker, defender, 60);
    defender.damage = 0;
    const shred = applyDamage(state, attacker, defender, 60, { ignoreDefenderEffects: true });
    expect(normal).toBe(50);
    expect(shred).toBe(60);
  });

  it('starter-deck attacks parse into real opcodes (not raw text)', () => {
    // Sample a handful of distinctive attacks and confirm the converter
    // produced the expected AttackEffect shape — these were silently
    // dropping to undefined before the starter-deck pass.
    const expectations: Record<string, { name: string; type: string }> = {
      'sv1-3': { name: 'Absorb', type: 'healSelf' },
      'pgo-8': { name: 'Tail on Fire', type: 'searchAndAttachEnergy' },
      'sv3pt5-4': { name: 'Blazing Destruction', type: 'discardStadium' },
      'sv1-32': { name: 'Bright Flame', type: 'discardOwnEnergy' },
      'sv1-70': { name: 'Thunder Shock', type: 'coinFlipCondition' },
      'sv1-85': { name: 'Psychic', type: 'damagePerOpponentEnergy' },
      'det1-14': { name: 'Healing Melody', type: 'healAllOwn' },
      'g1-RC19': { name: 'Lick Away', type: 'clearOwnConditions' },
      'pgo-55': { name: 'Collapse', type: 'conditionSelf' },
      'bw11-93': { name: 'Dragon Pulse', type: 'selfMillDeck' },
      'base1-48': { name: 'Fury Attack', type: 'coinMultiHeadsDamage' },
      'sv1-117': { name: 'Earthquake', type: 'selfBenchSplash' },
      'sv1-152': { name: 'Enhanced Fang', type: 'damageIfHasTool' },
      'sv1-2': { name: 'Superpowered Throw', type: 'damagePerOpponentRetreatColorless' },
    };
    for (const [id, expected] of Object.entries(expectations)) {
      const card = CARD_LIBRARY[id] as PokemonCard | undefined;
      expect(card, `${id} missing in library`).toBeDefined();
      const attack = card!.attacks.find((a) => a.name === expected.name);
      expect(attack, `${id} missing attack ${expected.name}`).toBeDefined();
      expect(attack!.effect?.type, `${id} ${expected.name}`).toBe(expected.type);
    }
  });

  it('Healing Melody heals every benched + active Pokemon', () => {
    const state = makeEmptyState();
    state.players['0'].active = createPokemonInPlay(state, cloneCard('sv1-3') as PokemonCard, 0);
    state.players['0'].bench = [
      createPokemonInPlay(state, cloneCard('sv1-3') as PokemonCard, 0),
      createPokemonInPlay(state, cloneCard('sv1-3') as PokemonCard, 0),
    ];
    state.players['0'].active!.damage = 30;
    state.players['0'].bench[0].damage = 20;
    state.players['0'].bench[1].damage = 0;

    const opponent = state.players['1'];
    opponent.active = createPokemonInPlay(state, cloneCard('sv1-31') as PokemonCard, 0);

    const jiggly = CARD_LIBRARY['det1-14'] as PokemonCard;
    const healingMelody = jiggly.attacks.find((a) => a.name === 'Healing Melody') as Attack;

    resolveAttackEffect(
      state,
      healingMelody,
      state.players['0'].active!,
      opponent.active!,
      state.players['0'],
      { Die: () => 1, Shuffle: <T,>(arr: T[]) => arr },
      opponent,
    );

    expect(state.players['0'].active!.damage).toBe(20);
    expect(state.players['0'].bench[0].damage).toBe(10);
    expect(state.players['0'].bench[1].damage).toBe(0);
  });
});

