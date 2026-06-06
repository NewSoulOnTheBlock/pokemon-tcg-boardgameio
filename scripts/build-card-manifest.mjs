// Build a slim, single-file card manifest from the raw Pokemon TCG JSON.
//
// The raw dataset under src/data/pokemon-tcg-data/cards/en is ~25 MB across 168
// files and balloons the client bundle (~18 MB JS). The bundle only ever reads
// a handful of fields per card and image URLs follow a predictable pattern, so
// this script strips everything else and emits ONE pre-minified manifest at
// src/data/card-manifest.generated.json that cards.ts imports directly.
//
// Run via the `prebuild` npm script. Re-running is idempotent.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CARDS_DIR = join(REPO_ROOT, 'src', 'data', 'pokemon-tcg-data', 'cards', 'en');
const OUTPUT = join(REPO_ROOT, 'src', 'data', 'card-manifest.generated.json');

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
  if (attack.text) slim.text = attack.text;
  return slim;
}

function slimAbility(ability) {
  if (!ability || typeof ability !== 'object') return undefined;
  const slim = {};
  if (ability.name) slim.name = ability.name;
  if (ability.text) slim.text = ability.text;
  if (ability.type) slim.type = ability.type;
  return slim;
}

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
  if (Array.isArray(card.subtypes) && card.subtypes.length > 0) slim.subtypes = card.subtypes;
  if (card.hp) slim.hp = card.hp;
  if (Array.isArray(card.types) && card.types.length > 0) slim.types = card.types;
  if (card.evolvesFrom) slim.evolvesFrom = card.evolvesFrom;
  if (Array.isArray(card.abilities) && card.abilities.length > 0) {
    const abilities = card.abilities.map(slimAbility).filter(Boolean);
    if (abilities.length > 0) slim.abilities = abilities;
  }
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
  if (card.number) slim.number = card.number;
  if (card.artist) slim.artist = card.artist;
  if (card.rarity) slim.rarity = card.rarity;
  if (Array.isArray(card.rules) && card.rules.length > 0) slim.rules = card.rules;
  if (card.text) slim.text = card.text;
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

  const cards = [];
  let droppedFields = 0;
  for (const fileName of files) {
    const raw = JSON.parse(readFileSync(join(CARDS_DIR, fileName), 'utf8'));
    if (!Array.isArray(raw)) continue;
    for (const card of raw) {
      const slim = slimCard(card);
      if (slim) {
        cards.push(slim);
        droppedFields += Object.keys(card).length - Object.keys(slim).length;
      }
    }
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(cards));

  const sizeKb = (JSON.stringify(cards).length / 1024).toFixed(1);
  process.stdout.write(
    `[card-manifest] wrote ${cards.length} cards to ${OUTPUT} (${sizeKb} KB, ` +
      `~${droppedFields} fields trimmed)\n`,
  );
}

main();
