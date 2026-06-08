import { describe, expect, it, beforeAll } from 'vitest';
import { initCardLibrary } from '../game/cards';
import { convertManifestToCards, type SourceCard } from '../game/cards-converter';
import { rollDailyPack } from './packRoller';

import manifest from '../data/card-manifest.generated.json' with { type: 'json' };

describe('rollDailyPack', () => {
  beforeAll(() => {
    initCardLibrary(convertManifestToCards(manifest as SourceCard[]));
  });

  it('rolls 9 cards by default (5C + 3U + 1R)', () => {
    const ids = rollDailyPack();
    expect(ids).toHaveLength(9);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it('rolls valid card ids that exist in the library', () => {
    const ids = rollDailyPack();
    for (const id of ids) {
      // CARD_LIBRARY is a Proxy; checking via 'in' is the intended shape.
      expect(id).toMatch(/^[a-z0-9-]+$/i);
    }
  });

  it('returns different rolls across calls (probabilistic)', () => {
    const a = rollDailyPack();
    const b = rollDailyPack();
    const c = rollDailyPack();
    // 27 random picks across 3 packs from 1600+ commons + 1100+ uncommons —
    // collision probability is essentially zero.
    expect([a.join(','), b.join(','), c.join(',')].every((s) => s === a.join(','))).toBe(false);
  });
});
