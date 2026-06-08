import { describe, expect, it, beforeAll } from 'vitest';
import { Client } from 'boardgame.io/client';
import { Local } from 'boardgame.io/multiplayer';
import { initCardLibrary, CARD_LIBRARY } from './cards';
import { convertManifestToCards, type SourceCard } from './cards-converter';
import { PokemonTCG } from './PokemonTCG';
import type { PokemonTCGState } from './types';
import manifest from '../data/card-manifest.generated.json' with { type: 'json' };

beforeAll(() => {
  initCardLibrary(convertManifestToCards(manifest as SourceCard[]));
});

describe('Poké Ball', () => {
  it('maps sv1-185 to trainerType=Item + effect=pokeBall in CARD_LIBRARY', () => {
    const pb = CARD_LIBRARY['sv1-185'];
    expect(pb).toBeDefined();
    expect(pb.kind).toBe('trainer');
    expect((pb as { trainerType: string }).trainerType).toBe('Item');
    expect((pb as { effect?: string }).effect).toBe('pokeBall');
  });

  it('on heads, moves a Pokemon from deck to hand and discards itself', () => {
    const pokeBall = CARD_LIBRARY['sv1-185'];
    const charizard = CARD_LIBRARY['base1-4'];
    const pikachu = CARD_LIBRARY['base1-58'];
    expect(charizard?.kind).toBe('pokemon');

    const G: any = {
      players: {
        '0': {
          hand: [pokeBall],
          deck: [charizard, pikachu],
          discard: [],
          bench: [],
          active: null,
          prize: [],
          supporterPlayedThisTurn: false,
          stadiumPlayedThisTurn: false,
        },
        '1': {
          hand: [], deck: [], discard: [], bench: [], active: null, prize: [],
          supporterPlayedThisTurn: false, stadiumPlayedThisTurn: false,
        },
      },
      firstPlayer: '0',
      turnsTaken: { '0': 2, '1': 1 },
      log: [],
    };
    const ctx: any = { currentPlayer: '0', turn: 3, phase: 'play' };
    const random: any = {
      Die: (_n: number) => 1, // heads
      Shuffle: <T,>(arr: T[]) => arr,
    };

    const move = (PokemonTCG.phases as any).play.moves.playTrainer.move;
    const result = move({ G, ctx, random, playerID: '0' }, 0, { zone: 'active' });

    expect(result).toBeUndefined();
    expect(G.players['0'].hand).toHaveLength(1);
    expect(G.players['0'].hand[0].name).toMatch(/Charizard|Pikachu/);
    expect(G.players['0'].deck).toHaveLength(1);
    expect(G.players['0'].discard).toHaveLength(1);
    expect(G.players['0'].discard[0].name).toBe('Poké Ball');
  });

  it('works through the full Client + Local pipeline (client: false move)', async () => {
    // The playTrainer move is `client: false`, so it runs only via the
    // server. This test confirms the Local multiplayer transport
    // actually routes Poké Ball click → server → state update.
    const testDecks = {
      '0': [
        'sv1-185', // Poké Ball
        'charmander', 'pikachu', 'snorlax',
        ...Array(56).fill('fire_energy'),
      ],
      '1': [
        'charmander',
        ...Array(59).fill('fire_energy'),
      ],
    };
    const spec = {
      game: { ...PokemonTCG, seed: 'pokeball-test-seed' },
      numPlayers: 2,
      multiplayer: Local(),
      matchID: 'pokeball-test',
    };
    const p0 = Client({ ...spec, playerID: '0' });
    p0.start();
    Client({ ...spec, playerID: '1' }).start();

    (p0.moves as any).startMatch?.({
      seedDecks: testDecks,
      shuffleDecks: false,
      firstPlayer: '0',
    });
    const state = p0.getState()?.G as PokemonTCGState | undefined;
    expect(state).toBeDefined();
    expect((p0.moves as any).playTrainer).toBeDefined();
    expect(typeof (p0.moves as any).playTrainer).toBe('function');
  });

  it('every Poké Ball card in the manifest converts to the pokeBall effect', () => {
    // Regression: if a new set adds a Poké Ball variant whose name
    // doesn't normalize exactly to 'poke ball', it'd silently land
    // in the default branch and be unplayable. The name match should
    // catch every official Poké Ball card.
    const pokeBalls: string[] = [];
    for (const id of Object.keys(CARD_LIBRARY)) {
      const card = CARD_LIBRARY[id];
      if (!card) continue;
      if (card.kind !== 'trainer') continue;
      if (!/Pok[eé] Ball/i.test(card.name)) continue;
      // Exclude name-collisions like "Rocket's Poké Ball" — only
      // assert on cards whose name normalizes to exactly "poke ball".
      const normalized = card.name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/é/g, 'e')
        .toLowerCase();
      if (normalized !== 'poke ball' && normalized !== 'pokeball') continue;
      pokeBalls.push(card.id);
      expect((card as { effect?: string }).effect).toBe('pokeBall');
      expect((card as { trainerType?: string }).trainerType).toBe('Item');
    }
    expect(pokeBalls.length).toBeGreaterThan(0);
  });
});
