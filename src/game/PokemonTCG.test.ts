import { describe, expect, it, vi } from 'vitest';
import { Client } from 'boardgame.io/client';
import { Local } from 'boardgame.io/multiplayer';
import { PLAYMAT_IDS } from '../playmats';
import { CARD_LIBRARY, STARTER_DECKS, STARTER_ENERGY_TYPES, cloneCard, makeDeck } from './cards';
import { PokemonTCG } from './PokemonTCG';
import type { PokemonTCGSetupData, PokemonTCGState } from './types';

const testDecks = {
  '0': [
    'sprigatito',
    'floragato',
    'grass_energy',
    'grass_energy',
    'potion',
    'youngster',
    'switch',
    ...Array(53).fill('grass_energy'),
  ],
  '1': [
    'charmander',
    'fire_energy',
    'fire_energy',
    'potion',
    'youngster',
    'switch',
    'snorlax',
    ...Array(53).fill('fire_energy'),
  ],
};

function fullSetupDataForTests(setupData: Partial<PokemonTCGSetupData> = {}): PokemonTCGSetupData {
  return {
    seedDecks: testDecks,
    shuffleDecks: false,
    firstPlayer: '0',
    ...setupData,
  };
}

function makeClients(matchID: string) {
  const spec = {
    game: { ...PokemonTCG, seed: 'pokemon-test-seed' },
    numPlayers: 2,
    multiplayer: Local(),
    matchID,
  };
  const p0 = Client({ ...spec, playerID: '0' });
  const p1 = Client({ ...spec, playerID: '1' });
  p0.start();
  p1.start();
  return { p0, p1 };
}

function stateOf(client: ReturnType<typeof makeClients>['p0']) {
  return client.getState()!.G as PokemonTCGState;
}

function setupState(setupData: PokemonTCGSetupData): PokemonTCGState {
  const setup = PokemonTCG.setup;
  expect(setup).toBeDefined();

  return setup!(
    {
      random: {
        Die: () => 1,
        Shuffle: <T,>(cards: T[]) => [...cards],
      },
    } as Parameters<NonNullable<typeof setup>>[0],
    setupData,
  );
}

function validateStarterDeck(deck: string[]): string[] {
  const issues: string[] = [];
  if (deck.length !== 60) {
    issues.push(`size:${deck.length}`);
  }

  const counts: Record<string, number> = {};
  for (const cardId of deck) {
    const card = CARD_LIBRARY[cardId];
    if (!card) {
      issues.push(`unknown:${cardId}`);
      continue;
    }
    counts[cardId] = (counts[cardId] ?? 0) + 1;
  }

  for (const [cardId, count] of Object.entries(counts)) {
    const card = CARD_LIBRARY[cardId];
    if (card?.kind !== 'energy' && count > 4) {
      issues.push(`copies:${cardId}:${count}`);
    }
  }

  return issues;
}

function chooseOpeningForBoth(clients: ReturnType<typeof makeClients>) {
  const p0Basic = stateOf(clients.p0).players['0'].hand.findIndex((card) => card.kind === 'pokemon' && card.stage === 'Basic');
  const p1Basic = stateOf(clients.p1).players['1'].hand.findIndex((card) => card.kind === 'pokemon' && card.stage === 'Basic');
  clients.p0.moves.chooseOpeningPokemon(p0Basic, []);
  clients.p1.moves.chooseOpeningPokemon(p1Basic, []);
}

describe('PokemonTCG', () => {
  it('deals opening hands with hidden setup state and mulligan-safe decks', () => {
    const { p0 } = makeClients('opening-hands');
    const G = stateOf(p0);

    expect(G.players['0'].hand).toHaveLength(7);
    expect(G.players['1'].hand).toHaveLength(0);
    expect(G.players['1'].handCount).toBe(7);
    expect(G.players['0'].hand.some((card) => card.kind === 'pokemon' && card.stage === 'Basic')).toBe(true);
  });

  it('assigns one playmat to the match', () => {
    const { p0 } = makeClients('random-playmat');
    expect(PLAYMAT_IDS).toContain(stateOf(p0).playmatId);

    expect(setupState({ ...fullSetupDataForTests(), playmatId: 'purple' }).playmatId).toBe('purple');
  });

  it('can create a named match while leaving the acceptor deck unselected', () => {
    const G = setupState({
      ...fullSetupDataForTests({
        deckLabels: { '0': 'Grass Starter' },
        matchName: 'Saturday ranked room',
        matchType: 'Ranked',
        seedDecks: { '0': testDecks['0'] },
      }),
    });

    expect(G.matchName).toBe('Saturday ranked room');
    expect(G.matchType).toBe('Ranked');
    expect(G.deckLabels).toEqual({ '0': 'Grass Starter' });
    expect(G.players['0'].hand).toHaveLength(7);
    expect(G.players['1'].hand).toHaveLength(0);
    expect(G.players['1'].deck).toHaveLength(0);
  });

  it('loads the vendored Pokemon TCG card database without API calls', () => {
    expect(Object.keys(CARD_LIBRARY).length).toBeGreaterThan(20000);
    expect(cloneCard('sv1-1').name).toBe('Pineco');
    expect(cloneCard('sprigatito').sourceId).toBe('sv1-13');
  });

  it('provides a playable 60-card starter deck for each energy type', () => {
    for (const type of STARTER_ENERGY_TYPES) {
      const deck = STARTER_DECKS[type];
      expect(deck).toHaveLength(60);
      const cards = makeDeck(deck);
      expect(cards.some((card) => card.kind === 'pokemon' && card.stage === 'Basic')).toBe(true);
      expect(cards.some((card) => card.kind === 'energy')).toBe(true);
      expect(validateStarterDeck(deck)).toHaveLength(0);
    }
  });

  it('sets an opening Active Pokemon and six Prize cards', () => {
    const clients = makeClients('opening-active');
    chooseOpeningForBoth(clients);
    const G = stateOf(clients.p0);

    expect(G.players['0'].active?.card.stage).toBe('Basic');
    expect(G.players['0'].prizeCount).toBe(6);
    expect(clients.p0.getState()?.ctx.phase).toBe('play');
  });

  it('enforces one manual Energy attachment each turn', () => {
    const clients = makeClients('energy-attach');
    chooseOpeningForBoth(clients);

    const current = stateOf(clients.p0).firstPlayer;
    const client = current === '0' ? clients.p0 : clients.p1;
    const before = stateOf(client).players[current].active?.attachedEnergy.length ?? 0;
    const energyIndex = stateOf(client).players[current].hand.findIndex((card) => card.kind === 'energy');
    expect(energyIndex).toBeGreaterThanOrEqual(0);

    client.moves.attachEnergy(energyIndex, 'active');
    const secondEnergyIndex = stateOf(client).players[current].hand.findIndex((card) => card.kind === 'energy');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    client.moves.attachEnergy(secondEnergyIndex, 'active');
    errorSpy.mockRestore();

    expect(stateOf(client).players[current].active?.attachedEnergy.length).toBe(before + 1);
  });

  it('lets the off-turn player concede so the player still in the match wins', () => {
    const clients = makeClients('forfeit-off-turn');
    chooseOpeningForBoth(clients);

    // firstPlayer goes first in the play phase. The OTHER player concedes
    // while it's not their turn — they're in the 'waiting' stage where
    // only concede is allowed.
    const current = stateOf(clients.p0).firstPlayer;
    const offTurnClient = current === '0' ? clients.p1 : clients.p0;
    const offTurnPlayer = current === '0' ? '1' : '0';

    offTurnClient.moves.concede();

    const G = stateOf(clients.p0);
    expect(G.winner).toBe(current);
    expect(G.winReason).toContain('forfeit');
    expect(clients.p0.getState()?.ctx.gameover).toEqual({ winner: current, reason: G.winReason });
    expect(clients.p1.getState()?.ctx.gameover).toEqual({ winner: current, reason: G.winReason });
    // The off-turn player should be marked as loser (current player wins).
    expect(G.winner).not.toBe(offTurnPlayer);
  });
});
