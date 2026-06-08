import { describe, expect, it, beforeAll } from 'vitest';
import { initCardLibrary, CARD_LIBRARY } from './cards';
import { convertManifestToCards, type SourceCard } from './cards-converter';
import { resolveAttackEffect } from './rules';
import type { Attack, PokemonInPlay, PokemonTCGState } from './types';
import manifest from '../data/card-manifest.generated.json' with { type: 'json' };

beforeAll(() => {
  initCardLibrary(convertManifestToCards(manifest as SourceCard[]));
});

function makePokemon(cardId: string): PokemonInPlay {
  const card = CARD_LIBRARY[cardId];
  if (!card || card.kind !== 'pokemon') throw new Error(`${cardId} not pokemon`);
  return {
    instanceId: `pip-${cardId}`,
    card,
    attachedEnergy: [],
    damage: 0,
    conditions: [],
    evolution: [card],
    enteredTurn: 0,
  };
}

describe('Oddish Sprout (searchNamedBasicToBench)', () => {
  it('parses base2-58 Sprout to type=searchNamedBasicToBench', () => {
    const oddish = CARD_LIBRARY['base2-58'];
    expect(oddish?.kind).toBe('pokemon');
    const sprout = (oddish as { attacks: Array<{ name: string; effect?: { type: string } }> }).attacks
      .find((a) => a.name === 'Sprout');
    expect(sprout?.effect?.type).toBe('searchNamedBasicToBench');
  });

  it('pulls a 2nd Oddish from deck onto the bench', () => {
    const attacker = makePokemon('base2-58');
    const defender = makePokemon('base1-58');
    const otherOddish = CARD_LIBRARY['base2-58'];
    const G = {
      players: {
        '0': {
          active: attacker,
          deck: [{ ...otherOddish }, CARD_LIBRARY['base1-58']],
          bench: [],
          discard: [],
        } as never,
        '1': { active: defender } as never,
      },
      nextInstanceId: 100,
      log: [],
    } as unknown as PokemonTCGState;
    const sprout = (attacker.card as { attacks: Attack[] }).attacks.find((a) => a.name === 'Sprout')!;
    const random = { Die: (_n: number) => 1, Shuffle: <T,>(arr: T[]) => arr };
    resolveAttackEffect(G, sprout, attacker, defender, G.players['0'], random as never, G.players['1']);
    expect(G.players['0'].bench).toHaveLength(1);
    expect(G.players['0'].bench[0]!.card.name).toBe('Oddish');
    expect(G.log[0]).toMatch(/pulled Oddish onto the Bench/);
  });

  it('logs a clear message when no matching Oddish is in the deck', () => {
    const attacker = makePokemon('base2-58');
    const defender = makePokemon('base1-58');
    const G = {
      players: {
        '0': {
          active: attacker,
          deck: [CARD_LIBRARY['base1-58']],
          bench: [],
          discard: [],
        } as never,
        '1': { active: defender } as never,
      },
      nextInstanceId: 100,
      log: [],
    } as unknown as PokemonTCGState;
    const sprout = (attacker.card as { attacks: Attack[] }).attacks.find((a) => a.name === 'Sprout')!;
    const random = { Die: (_n: number) => 1, Shuffle: <T,>(arr: T[]) => arr };
    resolveAttackEffect(G, sprout, attacker, defender, G.players['0'], random as never, G.players['1']);
    expect(G.players['0'].bench).toHaveLength(0);
    expect(G.log[0]).toMatch(/no Oddish found in deck/);
  });

  it('logs a clear message when the bench is full', () => {
    const attacker = makePokemon('base2-58');
    const defender = makePokemon('base1-58');
    const G = {
      players: {
        '0': {
          active: attacker,
          deck: [CARD_LIBRARY['base2-58']],
          bench: [
            makePokemon('base1-58'), makePokemon('base1-58'), makePokemon('base1-58'),
            makePokemon('base1-58'), makePokemon('base1-58'),
          ],
          discard: [],
        } as never,
        '1': { active: defender } as never,
      },
      nextInstanceId: 100,
      log: [],
    } as unknown as PokemonTCGState;
    const sprout = (attacker.card as { attacks: Attack[] }).attacks.find((a) => a.name === 'Sprout')!;
    const random = { Die: (_n: number) => 1, Shuffle: <T,>(arr: T[]) => arr };
    resolveAttackEffect(G, sprout, attacker, defender, G.players['0'], random as never, G.players['1']);
    expect(G.log[0]).toMatch(/bench is full/);
  });
});
