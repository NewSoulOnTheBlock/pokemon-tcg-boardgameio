import { describe, expect, it } from 'vitest';
import {
  applyDamage,
  canPayEnergyCost,
  createPokemonInPlay,
  drawCards,
  isBasicPokemon,
  opponentOf,
  publicViewForPlayer,
} from './rules';
import { cloneCard, makeDeck, STARTER_DECKS } from './cards';
import type { EnergyCard, PokemonCard, PokemonTCGState } from './types';

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
    matchName: 'test',
    matchType: 'Casual',
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
});
