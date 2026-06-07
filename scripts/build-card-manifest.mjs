// Build a slim, single-file card manifest from the raw Pokemon TCG JSON.
//
// The raw dataset under src/data/pokemon-tcg-data/cards/en is ~25 MB across 168
// files and balloons the client bundle. The bundle only ever reads a handful
// of fields per card and image URLs follow a predictable pattern, so this
// script strips everything else and emits ONE pre-minified manifest at
// src/data/card-manifest.generated.json that cards.ts imports directly.
//
// **Card-set scope:** We ship every card from sets released in the last
// 4 years (the "modern" pool that the daily free pack rolls from), PLUS
// every card that's explicitly referenced from starter decks, campaign
// decks, the CARD_ID_ALIASES table, or the unit tests — those cover
// classic Base / Jungle / Fossil cards that the curated starter decks
// rely on even though they're outside the date window.
//
// Run via the `prebuild` npm script. Re-running is idempotent.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CARDS_DIR = join(REPO_ROOT, 'src', 'data', 'pokemon-tcg-data', 'cards', 'en');
const SETS_FILE = join(REPO_ROOT, 'src', 'data', 'pokemon-tcg-data', 'sets', 'en.json');
const OUTPUT = join(REPO_ROOT, 'src', 'data', 'card-manifest.generated.json');

// Date-window cutoff. Cards from sets released on or after this date are
// included even if no curated deck references them — they form the
// "modern" pool that daily free packs and the deckbuilder pull from.
// Sets older than this only appear if their cards are explicitly named
// in a starter or campaign deck.
const MODERN_WINDOW_YEARS = 4;
const MODERN_CUTOFF_DATE = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - MODERN_WINDOW_YEARS);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
})();

// Files we scan for card-ID literals. Anything quoted that matches the
// `setid-cardnumber` pattern is added to the explicit-allow list — those
// cards land in the manifest even if their parent set is outside the
// modern date window.
const SCAN_SOURCES = [
  join(REPO_ROOT, 'src', 'game', 'cards.ts'),
  join(REPO_ROOT, 'src', 'campaign', 'decks.ts'),
  // cards-converter.ts holds the CARD_ID_ALIASES table mapping
  // human-readable names (`sprigatito`, `charmander`) onto real card
  // IDs. The aliases themselves don't match the card-ID regex, but
  // the target IDs they point at do — scanning this file ensures
  // those targets land in the manifest.
  join(REPO_ROOT, 'src', 'game', 'cards-converter.ts'),
  join(REPO_ROOT, 'src', 'game', 'rules.test.ts'),
  join(REPO_ROOT, 'src', 'game', 'PokemonTCG.test.ts'),
];

// Pokemon TCG card IDs look like `base1-46`, `sv4pt5-87`, `bw11-RC10`, etc.
const CARD_ID_RE = /['"`]([a-z][a-z0-9]*\d*(?:pt\d+)?-[A-Za-z0-9]+)['"`]/g;

function buildExplicitAllowList() {
  const allow = new Set();
  for (const file of SCAN_SOURCES) {
    const text = readFileSync(file, 'utf8');
    let match;
    while ((match = CARD_ID_RE.exec(text)) !== null) {
      const candidate = match[1];
      if (looksLikeRealCardId(candidate)) {
        allow.add(candidate);
      }
    }
  }
  return allow;
}

function buildModernSetAllowList() {
  const setsRaw = JSON.parse(readFileSync(SETS_FILE, 'utf8'));
  if (!Array.isArray(setsRaw)) {
    throw new Error(`Expected ${SETS_FILE} to be a JSON array.`);
  }
  const modern = new Set();
  for (const set of setsRaw) {
    if (!set?.id) continue;
    const releaseDate = set.releaseDate ?? '0000/00/00';
    if (releaseDate >= MODERN_CUTOFF_DATE) {
      modern.add(set.id);
    }
  }
  return modern;
}

function looksLikeRealCardId(id) {
  const [setPrefix, cardNum] = id.split('-', 2);
  if (!setPrefix || !cardNum) return false;
  if (setPrefix.length < 2 || setPrefix.length > 12) return false;
  if (!/[a-z]/.test(setPrefix)) return false;
  if (!/\d/.test(cardNum)) return false;
  if (id.includes('--')) return false;
  return true;
}

function setIdOf(card) {
  if (!card?.id) return '';
  const dash = card.id.indexOf('-');
  return dash > 0 ? card.id.slice(0, dash) : card.id;
}

const IMAGE_BASE = 'https://images.pokemontcg.io';

function standardSmallUrl(id) {
  const [setId, ...rest] = id.split('-');
  return `${IMAGE_BASE}/${setId}/${rest.join('-')}.png`;
}

function standardLargeUrl(id) {
  const [setId, ...rest] = id.split('-');
  return `${IMAGE_BASE}/${setId}/${rest.join('-')}_hires.png`;
}

function slimAttack(attack) {
  if (!attack || typeof attack !== 'object') return undefined;
  const slim = {};
  if (attack.name) slim.name = attack.name;
  if (Array.isArray(attack.cost) && attack.cost.length > 0) slim.cost = attack.cost;
  if (attack.damage) slim.damage = attack.damage;
  // text is required for inferAttackEffect (special conditions, draws, etc.)
  if (attack.text) slim.text = attack.text;
  return slim;
}

function slimAbility() {
  // Abilities are dropped from the manifest entirely — convertPokemon no
  // longer stores them on the resulting Card object. Keep the helper around
  // (unused) to make the regenerate script easy to grep if we ever want them
  // back.
  return undefined;
}
void slimAbility;

function slimWeaknessOrResistance(entry) {
  if (!entry || typeof entry !== 'object' || !entry.type) return undefined;
  return { type: entry.type };
}

function slimCard(card) {
  if (!card || !card.id) return undefined;
  const slim = {
    id: card.id,
    name: card.name,
    supertype: card.supertype,
  };
  // Subtypes drive stage / ruleBox / trainerType / "basic" energy detection
  // at conversion time. We keep them here so the runtime converter can do its
  // work, then drop them from the resulting Card object (see src/game/types.ts).
  if (Array.isArray(card.subtypes) && card.subtypes.length > 0) slim.subtypes = card.subtypes;
  if (card.hp) slim.hp = card.hp;
  if (Array.isArray(card.types) && card.types.length > 0) slim.types = card.types;
  if (card.evolvesFrom) slim.evolvesFrom = card.evolvesFrom;
  if (Array.isArray(card.attacks) && card.attacks.length > 0) {
    const attacks = card.attacks.map(slimAttack).filter(Boolean);
    if (attacks.length > 0) slim.attacks = attacks;
  }
  if (Array.isArray(card.weaknesses) && card.weaknesses.length > 0) {
    const weaknesses = card.weaknesses.map(slimWeaknessOrResistance).filter(Boolean);
    if (weaknesses.length > 0) slim.weaknesses = weaknesses;
  }
  if (Array.isArray(card.resistances) && card.resistances.length > 0) {
    const resistances = card.resistances.map(slimWeaknessOrResistance).filter(Boolean);
    if (resistances.length > 0) slim.resistances = resistances;
  }
  if (typeof card.convertedRetreatCost === 'number') {
    slim.convertedRetreatCost = card.convertedRetreatCost;
  } else if (Array.isArray(card.retreatCost)) {
    slim.convertedRetreatCost = card.retreatCost.length;
  }
  if (card.rarity) slim.rarity = card.rarity;
  // Trainer effect detection reads `rules` and `text`. Energy and Pokemon
  // cards don't need them at conversion time, so we only keep them for
  // trainers. Saves several MB across the manifest.
  const supertype = String(card.supertype || '').toLowerCase();
  if (supertype === 'trainer') {
    if (Array.isArray(card.rules) && card.rules.length > 0) slim.rules = card.rules;
    if (card.text) slim.text = card.text;
  }
  if (card.images) {
    const images = {};
    if (card.images.small && card.images.small !== standardSmallUrl(card.id)) {
      images.small = card.images.small;
    }
    if (card.images.large && card.images.large !== standardLargeUrl(card.id)) {
      images.large = card.images.large;
    }
    if (Object.keys(images).length > 0) slim.images = images;
  }
  return slim;
}

function main() {
  const files = readdirSync(CARDS_DIR).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) {
    throw new Error(`No card JSON files found in ${CARDS_DIR}`);
  }

  const explicitAllow = buildExplicitAllowList();
  const modernSets = buildModernSetAllowList();
  if (explicitAllow.size === 0) {
    throw new Error('Card-ID allow-list is empty — check SCAN_SOURCES paths and the CARD_ID_RE regex.');
  }
  if (modernSets.size === 0) {
    throw new Error('Modern-set allow-list is empty — check SETS_FILE path and MODERN_CUTOFF_DATE.');
  }

  const cards = [];
  let droppedFields = 0;
  let skippedOldAndUnreferenced = 0;
  let fromModernSets = 0;
  let fromExplicitAllow = 0;
  for (const fileName of files) {
    const raw = JSON.parse(readFileSync(join(CARDS_DIR, fileName), 'utf8'));
    if (!Array.isArray(raw)) continue;
    for (const card of raw) {
      if (!card?.id) continue;
      const inExplicit = explicitAllow.has(card.id);
      const inModernSet = modernSets.has(setIdOf(card));
      if (!inExplicit && !inModernSet) {
        skippedOldAndUnreferenced += 1;
        continue;
      }
      const slim = slimCard(card);
      if (slim) {
        cards.push(slim);
        droppedFields += Object.keys(card).length - Object.keys(slim).length;
        if (inExplicit) fromExplicitAllow += 1;
        if (inModernSet && !inExplicit) fromModernSets += 1;
      }
    }
  }

  // Sanity check: every entry the explicit allow-list expects must have
  // been found. Modern-set cards are best-effort — if a set in the date
  // window is missing from the JSON dump for some reason, we silently
  // skip it. Explicit references are different: they're hand-coded into
  // decks / tests and a missing match is a real bug.
  const foundIds = new Set(cards.map((card) => card.id));
  const missing = [...explicitAllow].filter((id) => !foundIds.has(id)).sort();

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(cards));

  const sizeKb = (JSON.stringify(cards).length / 1024).toFixed(1);
  process.stdout.write(
    `[card-manifest] wrote ${cards.length} cards to ${OUTPUT} (${sizeKb} KB, ` +
      `~${droppedFields} fields trimmed)\n` +
      `  modern-set window: ${modernSets.size} sets since ${MODERN_CUTOFF_DATE} (${fromModernSets} cards)\n` +
      `  explicit-allow IDs: ${explicitAllow.size} (${fromExplicitAllow} cards)\n` +
      `  skipped (old + unreferenced): ${skippedOldAndUnreferenced}\n`,
  );

  if (missing.length > 0) {
    process.stderr.write(
      `[card-manifest] WARNING: ${missing.length} card IDs from cards.ts / decks.ts have no JSON match:\n  ${missing.join('\n  ')}\n`,
    );
    process.exitCode = 1;
  }
}

main();
