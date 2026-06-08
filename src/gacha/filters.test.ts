import { describe, expect, it } from 'vitest';
import { isPokemonMachine } from './filters';

describe('isPokemonMachine', () => {
  it('keeps machines whose name contains "Pokemon"', () => {
    expect(isPokemonMachine({ code: 'pokemon_25', name: 'Starter Pokémon Gacha Pack' })).toBe(true);
    expect(isPokemonMachine({ code: 'pokemon_50', name: 'Elite Pokémon Gacha Pack' })).toBe(true);
    expect(isPokemonMachine({ code: 'pokemon_1000', name: 'Grail Pokémon Gacha Pack' })).toBe(true);
    expect(isPokemonMachine({ code: 'pokemon_5000', name: 'Celestial Pokémon Gacha Pack' })).toBe(true);
  });

  it('handles non-accented "Pokemon" too', () => {
    expect(isPokemonMachine({ code: 'pkm_test', name: 'Random Pokemon Pack' })).toBe(true);
    expect(isPokemonMachine({ code: 'something', name: 'POKEMON LEGENDS' })).toBe(true);
  });

  it('catches Pokémon-themed machines whose code prefix does not say pokemon', () => {
    // Real codes from gacha.collectorcrypt.com (Jun 2026): the name
    // says Pokémon even though the code is `sf_*`.
    expect(isPokemonMachine({ code: 'sf_2500', name: 'Mythic Pokémon Gacha Pack' })).toBe(true);
  });

  it('keeps known Pokemon character packs even when name omits "Pokemon"', () => {
    expect(isPokemonMachine({ code: 'charizard_50', name: 'Charizard Gacha Pack' })).toBe(true);
    expect(isPokemonMachine({ code: 'pikachu_50', name: 'Pikachu Gacha Pack' })).toBe(true);
    expect(isPokemonMachine({ code: 'gengar_50', name: 'Gengar Gacha Pack' })).toBe(true);
    expect(isPokemonMachine({ code: 'mew_250', name: 'Mew + Friends' })).toBe(true);
    expect(isPokemonMachine({ code: 'dragonite_100', name: 'Dragonite + Friends' })).toBe(true);
  });

  it('keeps Pokémon energy-type packs', () => {
    expect(isPokemonMachine({ code: 'water_100', name: 'Water Pack' })).toBe(true);
    expect(isPokemonMachine({ code: 'firegrass_100', name: 'Fire & Grass Pack' })).toBe(true);
    expect(isPokemonMachine({ code: 'sealed_80', name: 'Sealed Gacha Pack' })).toBe(true);
  });

  it('filters OUT non-Pokemon machines from the Collector Crypt catalog', () => {
    expect(isPokemonMachine({ code: 'onepiece_50', name: 'One Piece Ocean Blue Pack' })).toBe(false);
    expect(isPokemonMachine({ code: 'onepiece_250', name: 'One Piece Gacha Pack' })).toBe(false);
    expect(isPokemonMachine({ code: 'football_50', name: 'Football Gacha Pack' })).toBe(false);
    expect(isPokemonMachine({ code: 'basketball_100', name: 'Basketball 100 Gacha Pack' })).toBe(false);
    expect(isPokemonMachine({ code: 'baseball_50', name: 'Baseball Gacha Pack' })).toBe(false);
    expect(isPokemonMachine({ code: 'sports_100', name: 'Sports Gacha Pack' })).toBe(false);
    expect(isPokemonMachine({ code: 'comic_50', name: 'Comic 50' })).toBe(false);
    expect(isPokemonMachine({ code: 'comic_250', name: 'Comic 250' })).toBe(false);
    expect(isPokemonMachine({ code: 'anime_75', name: 'Anime Pop Culture Gacha' })).toBe(false);
    expect(isPokemonMachine({ code: 'gachopia_50', name: 'Elite Gachopia Pack' })).toBe(false);
    expect(isPokemonMachine({ code: 'sns_25', name: 'Sns 25' })).toBe(false);
  });

  it('handles missing or empty fields safely', () => {
    expect(isPokemonMachine({})).toBe(false);
    expect(isPokemonMachine({ code: '', name: '' })).toBe(false);
    expect(isPokemonMachine({ code: 'unknown_50' })).toBe(false);
    expect(isPokemonMachine({ name: 'Unknown Pack' })).toBe(false);
  });
});
