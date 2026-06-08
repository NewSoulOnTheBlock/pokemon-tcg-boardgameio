import { describe, expect, it, beforeAll } from 'vitest';
import { Client } from 'boardgame.io/client';
import { Local } from 'boardgame.io/multiplayer';
import { initCardLibrary } from './cards';
import { convertManifestToCards, type SourceCard } from './cards-converter';
import { PokemonTCG } from './PokemonTCG';
import type { Card, PokemonTCGState } from './types';
import manifest from '../data/card-manifest.generated.json' with { type: 'json' };

beforeAll(() => {
  initCardLibrary(convertManifestToCards(manifest as SourceCard[]));
});

function makeClients(matchID: string, seed: string) {
  const spec = {
    game: { ...PokemonTCG, seed },
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

function stateOf(c: ReturnType<typeof makeClients>['p0']): PokemonTCGState {
  return c.getState()!.G as PokemonTCGState;
}

function makeClientsWithTrainerInHand(
  trainerNamePattern: RegExp,
): { p0: ReturnType<typeof makeClients>['p0']; p1: ReturnType<typeof makeClients>['p1']; basicIdx: number; seedUsed: string } {
  for (let i = 0; i < 100; i += 1) {
    const seed = `trainer-test-${i}`;
    const { p0, p1 } = makeClients(`trainer-test-${i}`, seed);
    const hand = stateOf(p0).players['0'].hand;
    const basicIdx = hand.findIndex((c) => c.kind === 'pokemon' && c.stage === 'Basic');
    const trainerIdx = hand.findIndex((c) => c.kind === 'trainer' && trainerNamePattern.test(c.name));
    if (basicIdx !== -1 && trainerIdx !== -1) {
      return { p0, p1, basicIdx, seedUsed: seed };
    }
  }
  throw new Error(`No seed in 100 attempts gave us a hand containing ${trainerNamePattern}`);
}

describe('Poké Ball / Great Ball — full Client+Local integration', () => {
  it('Poké Ball: clicking play discards itself AND logs a flip', () => {
    const { p0, p1, basicIdx } = makeClientsWithTrainerInHand(/Pok[eé] Ball/);
    (p0.moves as any).chooseOpeningPokemon(basicIdx, []);
    const p1Basic = stateOf(p1).players['1'].hand.findIndex((c) => c.kind === 'pokemon' && c.stage === 'Basic');
    (p1.moves as any).chooseOpeningPokemon(p1Basic, []);

    expect(p0.getState()!.ctx.phase).toBe('play');
    // First player is randomly determined. We need to act as the active
    // player. If P0 is current, fire from p0. Otherwise pass + repeat.
    let attempts = 0;
    while (p0.getState()!.ctx.currentPlayer !== '0' && attempts < 3) {
      // Have P1 pass their turn so we get to P0.
      try { (p1.moves as any).pass(); } catch { /* ignore */ }
      attempts += 1;
    }
    expect(p0.getState()!.ctx.currentPlayer).toBe('0');

    const handBefore: Card[] = stateOf(p0).players['0'].hand;
    const pokeBallIdx = handBefore.findIndex((c) => c.kind === 'trainer' && /Pok[eé] Ball/.test(c.name));
    expect(pokeBallIdx).toBeGreaterThanOrEqual(0);
    const handSizeBefore = handBefore.length;
    const discardSizeBefore = stateOf(p0).players['0'].discard.length;
    const logSizeBefore = stateOf(p0).log.length;

    (p0.moves as any).playTrainer(pokeBallIdx, { zone: 'active' });

    const stateAfter = stateOf(p0);
    const discardAfter = stateAfter.players['0'].discard;
    const logAfter = stateAfter.log;

    expect(discardAfter.length).toBe(discardSizeBefore + 1);
    expect(discardAfter[discardAfter.length - 1]!.name).toMatch(/Pok[eé] Ball/);
    expect(logAfter.length).toBeGreaterThan(logSizeBefore);
    // appendLog prepends, so new entries appear at the start.
    const newLines = logAfter.slice(0, logAfter.length - logSizeBefore);
    expect(newLines.some((line) => /flipped (heads|tails)/i.test(line) && /Pok[eé] Ball/i.test(line))).toBe(true);
    expect([handSizeBefore - 1, handSizeBefore]).toContain(stateAfter.players['0'].hand.length);
  });

  it('Great Ball: clicking play discards itself AND logs the search', () => {
    const { p0, p1, basicIdx } = makeClientsWithTrainerInHand(/Great Ball/);
    (p0.moves as any).chooseOpeningPokemon(basicIdx, []);
    const p1Basic = stateOf(p1).players['1'].hand.findIndex((c) => c.kind === 'pokemon' && c.stage === 'Basic');
    (p1.moves as any).chooseOpeningPokemon(p1Basic, []);

    expect(p0.getState()!.ctx.phase).toBe('play');
    let attempts = 0;
    while (p0.getState()!.ctx.currentPlayer !== '0' && attempts < 3) {
      try { (p1.moves as any).pass(); } catch { /* ignore */ }
      attempts += 1;
    }
    expect(p0.getState()!.ctx.currentPlayer).toBe('0');

    const handBefore: Card[] = stateOf(p0).players['0'].hand;
    const gbIdx = handBefore.findIndex((c) => c.kind === 'trainer' && /Great Ball/.test(c.name));
    expect(gbIdx).toBeGreaterThanOrEqual(0);
    const discardSizeBefore = stateOf(p0).players['0'].discard.length;
    const logSizeBefore = stateOf(p0).log.length;

    (p0.moves as any).playTrainer(gbIdx, { zone: 'active' });

    const stateAfter = stateOf(p0);
    const discardAfter = stateAfter.players['0'].discard;
    expect(discardAfter.length).toBe(discardSizeBefore + 1);
    expect(discardAfter[discardAfter.length - 1]!.name).toMatch(/Great Ball/);
    expect(stateAfter.log.length).toBeGreaterThan(logSizeBefore);
    // appendLog prepends, so new entries appear at the start.
    const newLines = stateAfter.log.slice(0, stateAfter.log.length - logSizeBefore);
    expect(newLines.some((line) => /Great Ball/i.test(line))).toBe(true);
  });
});
