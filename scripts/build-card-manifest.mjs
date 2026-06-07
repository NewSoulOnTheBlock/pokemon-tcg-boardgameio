// Build a slim, single-file card manifest from the raw Pokemon TCG JSON.
//
// The raw dataset under src/data/pokemon-tcg-data/cards/en is ~25 MB across 168
// files and balloons the client bundle (~18 MB JS). The bundle only ever reads
// a handful of fields per card and image URLs follow a predictable pattern, so
// this script strips everything else and emits ONE pre-minified manifest at
// src/data/card-manifest.generated.json that cards.ts imports directly.
//
// **Card-set scope:** We now ship only the cards actually used by playable
// decks — starter decks + campaign opponent decks — rather than the full
// ~20k Pokemon TCG catalogue. The allow-list is derived at build time by
// scanning src/game/cards.ts + src/campaign/decks.ts for card-ID literals.
//
// Run via the `prebuild` npm script. Re-running is idempotent.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CARDS_DIR = join(REPO_ROOT, 'src', 'data', 'pokemon-tcg-data', 'cards', 'en');
const OUTPUT = join(REPO_ROOT, 'src', 'data', 'card-manifest.generated.json');

// Files we scan for card-ID literals. Anything quoted that matches the
// `setid-cardnumber` pattern (alphanumerics + hyphens) inside these files
// is added to the allow-list. Add new files here if a future feature
// pulls in cards from outside of starter/campaign decks.
//
// Test files are scanned too so the unit tests keep working with the
// trimmed manifest — they sometimes pin assertions to specific card
// effects that don't appear in playable decks. Including them adds
// only a handful of cards to the manifest.
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
// A set prefix of 2+ alnum chars, a hyphen, then a card number that may
// itself include letters (RC10, TG12, GG56, SWSH123, etc.).
const CARD_ID_RE = /['"`]([a-z][a-z0-9]*\d*(?:pt\d+)?-[A-Za-z0-9]+)['"`]/g;

function buildAllowList() {
  const allow = new Set();
  for (const file of SCAN_SOURCES) {
    const text = readFileSync(file, 'utf8');
    let match;
    while ((match = CARD_ID_RE.exec(text)) !== null) {
      const candidate = match[1];
      // Guard against false positives. Real card IDs have a known set prefix.
      // The list of allowed prefixes is conservative — extend as needed.
      if (looksLikeRealCardId(candidate)) {
        allow.add(candidate);
      }
    }
  }
  return allow;
}

function looksLikeRealCardId(id) {
  // Set prefix must contain at least one letter, and may include a `pt`
  // version suffix (e.g. sv4pt5). Card number must contain at least one
  // digit (RC10, 87, TG12).
  const [setPrefix, cardNum] = id.split('-', 2);
  if (!setPrefix || !cardNum) return false;
  if (setPrefix.length < 2 || setPrefix.length > 12) return false;
  if (!/[a-z]/.test(setPrefix)) return false;
  if (!/\d/.test(cardNum)) return false;
  // Reject obvious non-card matches (`some-other-thing`)
  if (id.includes('--')) return false;
  return true;
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

  const allowList = buildAllowList();
  if (allowList.size === 0) {
    throw new Error('Card-ID allow-list is empty — check SCAN_SOURCES paths and the CARD_ID_RE regex.');
  }

  const cards = [];
  let droppedFields = 0;
  let skippedNotInAllowList = 0;
  for (const fileName of files) {
    const raw = JSON.parse(readFileSync(join(CARDS_DIR, fileName), 'utf8'));
    if (!Array.isArray(raw)) continue;
    for (const card of raw) {
      if (!card?.id || !allowList.has(card.id)) {
        skippedNotInAllowList += 1;
        continue;
      }
      const slim = slimCard(card);
      if (slim) {
        cards.push(slim);
        droppedFields += Object.keys(card).length - Object.keys(slim).length;
      }
    }
  }

  // Sanity check: every entry the allow-list expects must have been found
  // in the underlying JSON dataset. Anything missing is a typo in
  // cards.ts / decks.ts or a card that simply doesn't exist in the set
  // dump we ship. Fail loudly so we can fix it instead of silently
  // shipping a deck that references nonexistent cards.
  const foundIds = new Set(cards.map((card) => card.id));
  const missing = [...allowList].filter((id) => !foundIds.has(id)).sort();

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(cards));

  const sizeKb = (JSON.stringify(cards).length / 1024).toFixed(1);
  process.stdout.write(
    `[card-manifest] wrote ${cards.length} cards (allow-list: ${allowList.size}, ` +
      `skipped ${skippedNotInAllowList} not in starter+campaign decks) to ${OUTPUT} ` +
      `(${sizeKb} KB, ~${droppedFields} fields trimmed)\n`,
  );

  if (missing.length > 0) {
    process.stderr.write(
      `[card-manifest] WARNING: ${missing.length} card IDs from cards.ts / decks.ts have no JSON match:\n  ${missing.join('\n  ')}\n`,
    );
    process.exitCode = 1;
  }
}

main();
