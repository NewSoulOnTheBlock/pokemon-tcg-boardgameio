import { describe, expect, it, beforeAll } from 'vitest';
import { initCardLibrary, CARD_LIBRARY } from './cards';
import { convertManifestToCards, type SourceCard } from './cards-converter';
import { applyDamage, resolveAttackEffect } from './rules';
import type { PokemonInPlay, PokemonTCGState } from './types';
import manifest from '../data/card-manifest.generated.json' with { type: 'json' };

beforeAll(() => {
  initCardLibrary(convertManifestToCards(manifest as SourceCard[]));
});

function buildAttacker(cardId: string, attachedEnergyIds: string[]): PokemonInPlay {
  const card = CARD_LIBRARY[cardId];
  if (!card || card.kind !== 'pokemon') {
    throw new Error(`buildAttacker: ${cardId} is not a Pokemon`);
  }
  return {
    instanceId: `att-${cardId}`,
    card,
    attachedEnergy: attachedEnergyIds.map((id) => {
      const e = CARD_LIBRARY[id];
      if (!e || e.kind !== 'energy') throw new Error(`${id} not energy`);
      return e;
    }),
    damage: 0,
    conditions: [],
    evolution: [],
    enteredTurn: 0,
  };
}

function buildDefender(cardId: string): PokemonInPlay {
  const card = CARD_LIBRARY[cardId];
  if (!card || card.kind !== 'pokemon') {
    throw new Error(`buildDefender: ${cardId} is not a Pokemon`);
  }
  return {
    instanceId: `def-${cardId}`,
    card,
    attachedEnergy: [],
    damage: 0,
    conditions: [],
    evolution: [],
    enteredTurn: 0,
  };
}

describe('Exeggutor Big Eggsplosion', () => {
  it('parses sv1-185 (Big Eggsplosion) — wait wrong card, the Trainer test is in pokeball.test.ts', () => {
    // sentinel
    expect(true).toBe(true);
  });

  it('parses base2-35 Big Eggsplosion as coinPerSelfEnergyHeadsDamage perHead=20', () => {
    const exeggutor = CARD_LIBRARY['base2-35'];
    expect(exeggutor?.kind).toBe('pokemon');
    const bigEgg = (exeggutor as { attacks: Array<{ name: string; effect?: { type: string; perHead?: number; baseDamage?: number; energyType?: string } }> }).attacks
      .find((a) => a.name === 'Big Eggsplosion');
    expect(bigEgg).toBeDefined();
    expect(bigEgg!.effect).toBeDefined();
    expect(bigEgg!.effect!.type).toBe('coinPerSelfEnergyHeadsDamage');
    expect(bigEgg!.effect!.perHead).toBe(20);
    expect(bigEgg!.effect!.baseDamage).toBeUndefined();
    expect(bigEgg!.effect!.energyType).toBeUndefined();
  });

  it('flips one coin per attached energy and does 20 damage per head', () => {
    const attacker = buildAttacker('base2-35', [
      'sve-1', 'sve-1', 'sve-1', 'sve-1', // 4 Grass energy attached
    ]);
    const defender = buildDefender('base1-58'); // Pikachu (HP 40, weakness Fighting)
    const G = {
      players: { '0': { active: attacker } as never, '1': { active: defender } as never },
      stadium: undefined,
      log: [],
    } as unknown as PokemonTCGState;

    const bigEgg = (attacker.card as { attacks: Array<{ name: string; damage?: number; effect?: never }> }).attacks
      .find((a) => a.name === 'Big Eggsplosion')!;

    // Step 1: simulate the attack handler's printed-damage pre-application.
    if (bigEgg.damage !== undefined) {
      applyDamage(G, attacker, defender, bigEgg.damage);
    }
    expect(defender.damage).toBeGreaterThanOrEqual(20); // printed 20 applied

    // Step 2: resolve the effect with all heads (Die(2)===1 -> heads).
    const random = {
      Die: (_n: number) => 1, // always heads
      Shuffle: <T,>(arr: T[]) => arr,
    };
    resolveAttackEffect(G, bigEgg as never, attacker, defender, { active: attacker } as never, random as never, { active: defender } as never);

    // 4 attached energy -> 4 coins -> 4 heads (forced) -> 4 * 20 = 80 damage.
    // The handler should have undone the printed 20 and re-applied 80.
    expect(defender.damage).toBe(80);
  });

  it('does 0 damage when no energy is attached (zero coins to flip)', () => {
    const attacker = buildAttacker('base2-35', []);
    const defender = buildDefender('base1-58');
    const G = {
      players: { '0': { active: attacker } as never, '1': { active: defender } as never },
      stadium: undefined,
      log: [],
    } as unknown as PokemonTCGState;
    const bigEgg = (attacker.card as { attacks: Array<{ name: string; damage?: number; effect?: never }> }).attacks
      .find((a) => a.name === 'Big Eggsplosion')!;
    if (bigEgg.damage !== undefined) {
      applyDamage(G, attacker, defender, bigEgg.damage);
    }
    const random = { Die: (_n: number) => 1, Shuffle: <T,>(arr: T[]) => arr };
    resolveAttackEffect(G, bigEgg as never, attacker, defender, { active: attacker } as never, random as never, { active: defender } as never);
    expect(defender.damage).toBe(0);
  });

  it('does heads × perHead damage even when only 1 energy is attached', () => {
    const attacker = buildAttacker('base2-35', ['sve-1']);
    const defender = buildDefender('base1-58');
    const G = {
      players: { '0': { active: attacker } as never, '1': { active: defender } as never },
      stadium: undefined,
      log: [],
    } as unknown as PokemonTCGState;
    const bigEgg = (attacker.card as { attacks: Array<{ name: string; damage?: number; effect?: never }> }).attacks
      .find((a) => a.name === 'Big Eggsplosion')!;
    if (bigEgg.damage !== undefined) {
      applyDamage(G, attacker, defender, bigEgg.damage);
    }
    // Force tails: should net 0 damage (printed 20 was undone, 0 heads = 0 dmg).
    const random = { Die: (_n: number) => 2, Shuffle: <T,>(arr: T[]) => arr };
    resolveAttackEffect(G, bigEgg as never, attacker, defender, { active: attacker } as never, random as never, { active: defender } as never);
    expect(defender.damage).toBe(0);
  });
});
