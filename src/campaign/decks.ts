// Per-opponent 60-card decks for the Gym Challenge campaign.
// Each deck is built from real pokemontcg.io card IDs (mostly Base / Jungle /
// Fossil for the Kanto-era thematic look) plus the shared trainer baseline
// and 20 energy of the appropriate type. Decks are referenced by
// CampaignOpponent.id; falls back to the energy-type starter deck if an
// opponent has no custom deck yet.

import { STARTER_DECKS } from '../game/cards';

type CardCount = readonly [string, number];

function expand(counts: ReadonlyArray<CardCount>): string[] {
  return counts.flatMap(([id, n]) => Array(n).fill(id));
}

/** Shared 20-card trainer package every campaign deck uses. Mirrors the
 *  player's "baseline" starter trainer mix (Professor's Research, Poké Ball,
 *  Great Ball, Switch, Potion, Energy Retrieval, Rare Candy). */
const CAMPAIGN_TRAINERS: ReadonlyArray<CardCount> = [
  ['sv4pt5-87', 4], // Professor's Research
  ['base2-64', 4],  // Poké Ball
  ['bw2-93', 3],    // Great Ball
  ['sv1-194', 3],   // Switch
  ['sv1-188', 2],   // Potion
  ['base1-81', 2],  // Energy Retrieval
  ['bw10-85', 2],   // Rare Candy
];

/** Harder 22-card trainer package used by Elite Four + Champion. Drops
 *  Potion (defensive), adds Boss's Orders ×2 (forced gust) and an
 *  extra Great Ball + Rare Candy + Energy Retrieval for tempo. The
 *  bot loves Boss's Orders because it lets MCTS line up KOs on
 *  any benched threat — the difference between gym and E4 difficulty
 *  is largely this trainer engine. */
const CAMPAIGN_TRAINERS_HARD: ReadonlyArray<CardCount> = [
  ['sv4pt5-87', 4], // Professor's Research
  ['base2-64', 4],  // Poké Ball
  ['bw2-93', 4],    // Great Ball
  ['sv1-194', 3],   // Switch
  ['me1-114', 2],   // Boss's Orders
  ['base1-81', 3],  // Energy Retrieval
  ['bw10-85', 2],   // Rare Candy
];

const ENERGY_BY_TYPE = {
  Grass: 'sve-1',
  Fire: 'sve-2',
  Water: 'sve-3',
  Lightning: 'sve-4',
  Psychic: 'sve-5',
  Fighting: 'sve-6',
  Darkness: 'sve-7',
  Metal: 'sve-8',
  Fairy: 'xy1-140',
  Colorless: 'base1-96', // DCE — used as a 2-Colorless wildcard
} as const;

function build(pokemon: ReadonlyArray<CardCount>, energy: ReadonlyArray<CardCount>): string[] {
  return [...expand(pokemon), ...expand(CAMPAIGN_TRAINERS), ...expand(energy)].slice(0, 60);
}

/** Same as `build` but uses the hardened CAMPAIGN_TRAINERS_HARD trainer
 *  engine (Boss's Orders + extra search). Use for Elite Four + Champion. */
function buildHard(pokemon: ReadonlyArray<CardCount>, energy: ReadonlyArray<CardCount>): string[] {
  return [...expand(pokemon), ...expand(CAMPAIGN_TRAINERS_HARD), ...expand(energy)].slice(0, 60);
}

// ---------- Gym Leaders ----------

const BROCK_DECK = build(
  [
    // Brock: Pewter Rock. Onix anchor + Geodude/Graveler/Golem line +
    // Rhyhorn/Rhydon + Kabuto/Omanyte fossil flavour.
    ['base1-56', 3], // Onix
    ['base3-47', 4], // Geodude
    ['base3-37', 3], // Graveler
    ['base3-36', 1], // Golem
    ['base2-61', 4], // Rhyhorn
    ['base2-45', 2], // Rhydon
    ['base3-50', 2], // Kabuto
    ['base3-52', 1], // Omanyte
  ],
  [['sve-6', 20]],
);

const MISTY_DECK = build(
  [
    // Misty: Cerulean Water. Staryu/Starmie + Goldeen/Seaking + Horsea/Seadra
    // + a singleton Vaporeon.
    ['base1-65', 4], // Staryu
    ['base1-64', 2], // Starmie
    ['base2-53', 4], // Goldeen
    ['base2-46', 2], // Seaking
    ['base3-49', 3], // Horsea
    ['base3-42', 2], // Seadra
    ['base3-55', 2], // Slowpoke
    ['base2-12', 1], // Vaporeon
  ],
  [['sve-3', 20]],
);

const SURGE_DECK = build(
  [
    // Lt. Surge: Vermilion Electric. Pikachu/Raichu + Voltorb/Electrode +
    // Magnemite/Magneton + Electabuzz + Zapdos legendary.
    ['base1-58', 4], // Pikachu
    ['base1-14', 2], // Raichu
    ['base1-67', 3], // Voltorb
    ['base1-21', 2], // Electrode
    ['base1-53', 3], // Magnemite
    ['base1-9', 2],  // Magneton
    ['base1-20', 3], // Electabuzz
    ['base1-16', 1], // Zapdos
  ],
  [['sve-4', 20]],
);

const ERIKA_DECK = build(
  [
    // Erika: Celadon Grass. Bellsprout/Weepinbell/Victreebel +
    // Oddish/Gloom/Vileplume + Tangela.
    ['base2-49', 4], // Bellsprout
    ['base2-48', 3], // Weepinbell
    ['base2-14', 1], // Victreebel
    ['base2-58', 4], // Oddish
    ['base2-37', 2], // Gloom
    ['base2-15', 1], // Vileplume
    ['base1-66', 3], // Tangela
    ['base2-52', 2], // Exeggcute
  ],
  [['sve-1', 20]],
);

const KOGA_DECK = build(
  [
    // Koga: Fuchsia Poison. Ekans/Arbok + Grimer/Muk + Koffing/Weezing
    // + Zubat/Golbat. Maps to Darkness energy in our system.
    ['base3-46', 4], // Ekans
    ['base3-31', 2], // Arbok
    ['base3-48', 3], // Grimer
    ['base3-13', 2], // Muk
    ['base1-51', 4], // Koffing
    ['base3-45', 2], // Weezing
    ['base3-57', 2], // Zubat
    ['base3-34', 1], // Golbat
  ],
  [['sve-7', 20]],
);

const SABRINA_DECK = build(
  [
    // Sabrina: Saffron Psychic. Abra/Kadabra/Alakazam + Drowzee/Hypno +
    // Mr. Mime + Mewtwo singleton.
    ['base1-43', 4], // Abra
    ['base1-32', 3], // Kadabra
    ['base1-1', 2],  // Alakazam
    ['base1-49', 3], // Drowzee
    ['base3-8', 2],  // Hypno
    ['base2-6', 3],  // Mr. Mime
    ['base1-10', 2], // Mewtwo
    ['base1-31', 1], // Jynx
  ],
  [['sve-5', 20]],
);

const BLAINE_DECK = build(
  [
    // Blaine: Cinnabar Fire. Vulpix/Ninetales + Growlithe/Arcanine +
    // Ponyta/Rapidash + Magmar + Moltres.
    ['base1-68', 4], // Vulpix
    ['base1-12', 2], // Ninetales
    ['base1-28', 3], // Growlithe
    ['base1-23', 2], // Arcanine
    ['base1-60', 3], // Ponyta
    ['base2-44', 2], // Rapidash
    ['base1-36', 3], // Magmar
    ['base3-12', 1], // Moltres
  ],
  [['sve-2', 20]],
);

const GIOVANNI_DECK = build(
  [
    // Giovanni: Viridian Boss. Ground/Dark thug squad — Rhyhorn/Rhydon +
    // Nidoking line + Sandshrew/Sandslash + Persian + Kangaskhan.
    ['base2-61', 4], // Rhyhorn
    ['base2-45', 2], // Rhydon
    ['base1-37', 2], // Nidorino
    ['base1-11', 1], // Nidoking
    ['base1-62', 3], // Sandshrew
    ['base3-41', 2], // Sandslash
    ['base2-56', 3], // Meowth
    ['base2-42', 2], // Persian
    ['base2-5', 1],  // Kangaskhan
  ],
  [['sve-6', 20]],
);

// ---------- Elite Four ----------

const LORELEI_DECK = buildHard(
  [
    // Lorelei: Ice. Shellder/Cloyster + Slowpoke/Slowbro + Dewgong +
    // Jynx + Lapras + Articuno.
    ['base3-54', 4], // Shellder
    ['base3-32', 2], // Cloyster
    ['base3-55', 3], // Slowpoke
    ['base3-43', 2], // Slowbro
    ['base1-25', 2], // Dewgong
    ['base1-31', 3], // Jynx
    ['base3-10', 2], // Lapras
    ['base3-2', 1],  // Articuno
  ],
  [['sve-3', 20]],
);

const BRUNO_DECK = buildHard(
  [
    // Bruno: Fighting. Machop/Machoke/Machamp + Onix + Hitmonlee/Hitmonchan
    // + Geodude/Graveler.
    ['base1-52', 4], // Machop
    ['base1-34', 3], // Machoke
    ['base1-8', 2],  // Machamp
    ['base1-56', 2], // Onix
    ['base3-7', 3],  // Hitmonlee
    ['base1-7', 2],  // Hitmonchan
    ['base3-47', 3], // Geodude
    ['base3-37', 1], // Graveler
  ],
  [['sve-6', 20]],
);

const AGATHA_DECK = buildHard(
  [
    // Agatha: Ghost (Psychic in our model). Gastly/Haunter/Gengar +
    // Zubat/Golbat + Drowzee/Hypno + Arbok flavour.
    ['base1-50', 4], // Gastly
    ['base1-29', 3], // Haunter
    ['base3-5', 2],  // Gengar
    ['base3-57', 3], // Zubat
    ['base3-34', 2], // Golbat
    ['base1-49', 3], // Drowzee
    ['base3-8', 2],  // Hypno
    ['base3-31', 1], // Arbok
  ],
  [['sve-5', 20]],
);

const LANCE_DECK = buildHard(
  [
    // Lance: Dragon Master. Dratini/Dragonair/Dragonite + Magikarp/Gyarados
    // + Charizard + Aerodactyl. Mixed Fire+Water energy to power the
    // various retreat / attack costs.
    ['base1-26', 4], // Dratini
    ['base1-18', 3], // Dragonair
    ['base3-4', 2],  // Dragonite
    ['base1-35', 3], // Magikarp
    ['base1-6', 2],  // Gyarados
    ['base1-46', 2], // Charmander (cheap Fire support)
    ['base1-4', 1],  // Charizard
    ['base3-1', 1],  // Aerodactyl
    ['xy6-97', 2],   // Double Dragon Energy (extra dragon support)
  ],
  [['xy6-97', 8], ['sve-2', 6], ['sve-3', 6]],
);

// ---------- Champion ----------

const BLUE_DECK = buildHard(
  [
    // Champion Blue: Mixed signature roster — Pidgeot, Alakazam, Rhydon,
    // Gyarados, Exeggutor, Arcanine, Ninetales, Charizard. Colorless +
    // Double Colorless Energy keeps the attacks paying despite the
    // multi-type spread.
    ['base1-57', 4], // Pidgey
    ['base1-22', 2], // Pidgeotto
    ['base2-8', 1],  // Pidgeot
    ['base1-43', 2], // Abra
    ['base1-1', 1],  // Alakazam
    ['base1-46', 2], // Charmander
    ['base1-4', 1],  // Charizard
    ['base1-28', 2], // Growlithe
    ['base1-23', 1], // Arcanine
    ['base1-35', 2], // Magikarp
    ['base1-6', 1],  // Gyarados
    ['base2-52', 1], // Exeggcute
  ],
  [['base1-96', 6], ['sve-2', 4], ['sve-3', 4], ['sve-5', 3], ['sve-4', 3]],
);

// ---------- Lookup ----------

const DECKS_BY_OPPONENT: Record<string, string[]> = {
  'gym-brock': BROCK_DECK,
  'gym-misty': MISTY_DECK,
  'gym-surge': SURGE_DECK,
  'gym-erika': ERIKA_DECK,
  'gym-koga': KOGA_DECK,
  'gym-sabrina': SABRINA_DECK,
  'gym-blaine': BLAINE_DECK,
  'gym-giovanni': GIOVANNI_DECK,
  'e4-lorelei': LORELEI_DECK,
  'e4-bruno': BRUNO_DECK,
  'e4-agatha': AGATHA_DECK,
  'e4-lance': LANCE_DECK,
  'champion-blue': BLUE_DECK,
};

/** Returns the curated deck for a campaign opponent. Falls back to the
 *  energy-type starter deck if no curated deck is registered. */
export function deckForOpponent(opponentId: string, fallbackDeckType: keyof typeof STARTER_DECKS): string[] {
  return DECKS_BY_OPPONENT[opponentId] ?? STARTER_DECKS[fallbackDeckType];
}
