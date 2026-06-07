// Gym Challenge campaign data + per-profile progression persistence.
//
// Persistence strategy: localStorage keyed by wallet address (or
// "anon" if no wallet). Cross-device sync would need a Postgres
// column on app_profiles — left as a follow-up.

import type { StarterEnergyType } from '../game/cards';

export type OpponentTier = 'gym' | 'elite-four' | 'champion';

export interface CampaignOpponent {
  id: string;
  tier: OpponentTier;
  name: string;
  title: string;
  type: StarterEnergyType;
  /** Display label for the type/theme (may differ from the deck type). */
  themeLabel: string;
  /** Which starter deck the CPU plays. */
  deckType: StarterEnergyType;
  badge: { name: string; emoji: string; color: string };
  /** 1-5 stars; cosmetic since RandomBot drives every CPU. */
  difficulty: number;
  /** Emoji portrait fallback. */
  portrait: string;
  reward: string;
  introDialogue: string;
  victoryDialogue: string;
  defeatDialogue: string;
  /** Ordered campaign index — used to determine "current recommended" and unlock gating. */
  order: number;
}

const GYMS: CampaignOpponent[] = [
  {
    id: 'gym-brock', tier: 'gym', order: 0,
    name: 'Brock', title: 'Pewter City Gym Leader',
    type: 'Fighting', themeLabel: 'Rock', deckType: 'Fighting',
    badge: { name: 'Boulder Badge', emoji: '🪨', color: '#a16207' },
    difficulty: 1, portrait: '🧱',
    reward: '1 Booster Pack · Boulder Badge',
    introDialogue: "I'm Brock! I'm Pewter's Gym Leader! My rock-hard willpower is evident even in my Pokémon!",
    victoryDialogue: 'Hmm! Excellent! I took you for granted. Take the Boulder Badge.',
    defeatDialogue: 'Hah! As expected, no challenge for the rock-solid defense of my Pokémon.',
  },
  {
    id: 'gym-misty', tier: 'gym', order: 1,
    name: 'Misty', title: 'Cerulean City Gym Leader',
    type: 'Water', themeLabel: 'Water', deckType: 'Water',
    badge: { name: 'Cascade Badge', emoji: '💧', color: '#38bdf8' },
    difficulty: 2, portrait: '🌊',
    reward: '1 Booster Pack · Cascade Badge',
    introDialogue: "Hi, you're a new face! Trainers who want to challenge me must prove their worth.",
    victoryDialogue: 'You really are something else. OK, you can have the Cascade Badge!',
    defeatDialogue: 'My water Pokémon are tougher than they look. Come back when you train harder.',
  },
  {
    id: 'gym-surge', tier: 'gym', order: 2,
    name: 'Lt. Surge', title: 'Vermilion City Gym Leader',
    type: 'Lightning', themeLabel: 'Electric', deckType: 'Lightning',
    badge: { name: 'Thunder Badge', emoji: '⚡', color: '#facc15' },
    difficulty: 2, portrait: '⚔',
    reward: '1 Booster Pack · Thunder Badge',
    introDialogue: 'Hey, kid! My Electric Pokémon will fry you in seconds. Bring it!',
    victoryDialogue: 'Lightning-fast moves! Take the Thunder Badge — you earned it.',
    defeatDialogue: 'Hah! No power surge today, kid. Come back when you charge up.',
  },
  {
    id: 'gym-erika', tier: 'gym', order: 3,
    name: 'Erika', title: 'Celadon City Gym Leader',
    type: 'Grass', themeLabel: 'Grass', deckType: 'Grass',
    badge: { name: 'Rainbow Badge', emoji: '🌈', color: '#22c55e' },
    difficulty: 3, portrait: '🌸',
    reward: '1 Booster Pack · Rainbow Badge',
    introDialogue: 'Oh… I must have dozed off. Welcome. My name is Erika — I teach the art of flowers.',
    victoryDialogue: 'Oh! I concede defeat. You are remarkably strong. Please accept the Rainbow Badge.',
    defeatDialogue: 'Oh, dear… my flowers wilt only in the harshest soil. Return when you bloom.',
  },
  {
    id: 'gym-koga', tier: 'gym', order: 4,
    name: 'Koga', title: 'Fuchsia City Gym Leader',
    type: 'Darkness', themeLabel: 'Poison', deckType: 'Darkness',
    badge: { name: 'Soul Badge', emoji: '🟣', color: '#7c3aed' },
    difficulty: 3, portrait: '🥷',
    reward: '1 Booster Pack · Soul Badge',
    introDialogue: 'Fwahahaha! A mere child like you dares to challenge me?',
    victoryDialogue: 'Humph! You have proven your worth. Here is the Soul Badge.',
    defeatDialogue: 'A worthy attempt, but my poison runs deep. Train, then return.',
  },
  {
    id: 'gym-sabrina', tier: 'gym', order: 5,
    name: 'Sabrina', title: 'Saffron City Gym Leader',
    type: 'Psychic', themeLabel: 'Psychic', deckType: 'Psychic',
    badge: { name: 'Marsh Badge', emoji: '🌀', color: '#c084fc' },
    difficulty: 4, portrait: '🔮',
    reward: '1 Booster Pack · Marsh Badge',
    introDialogue: 'I had a vision of your arrival… and your defeat.',
    victoryDialogue: 'I see — your future is bright. Take the Marsh Badge.',
    defeatDialogue: 'My visions were correct. You are not yet ready.',
  },
  {
    id: 'gym-blaine', tier: 'gym', order: 6,
    name: 'Blaine', title: 'Cinnabar Island Gym Leader',
    type: 'Fire', themeLabel: 'Fire', deckType: 'Fire',
    badge: { name: 'Volcano Badge', emoji: '🌋', color: '#ef4444' },
    difficulty: 4, portrait: '🔥',
    reward: '1 Booster Pack · Volcano Badge',
    introDialogue: 'Hah! I am Blaine, the Hot-Headed Quizmaster! My fiery Pokémon will burn you down!',
    victoryDialogue: 'I have burned down to nothing! Not even ashes remain! Take the Volcano Badge!',
    defeatDialogue: 'My fire still burns bright! Try again when you can withstand the heat.',
  },
  {
    id: 'gym-giovanni', tier: 'gym', order: 7,
    name: 'Giovanni', title: 'Viridian City Gym Leader',
    type: 'Fighting', themeLabel: 'Ground / Dark', deckType: 'Fighting',
    badge: { name: 'Earth Badge', emoji: '🌍', color: '#78350f' },
    difficulty: 5, portrait: '🎩',
    reward: '2 Booster Packs · Earth Badge',
    introDialogue: 'So! I must say, I am impressed you got this far. Prepare yourself for defeat!',
    victoryDialogue: 'Ha! You are strong. Take the Earth Badge — and head to the Pokémon League.',
    defeatDialogue: 'Bah! Try again, child. Power respects only power.',
  },
];

const ELITE_FOUR: CampaignOpponent[] = [
  {
    id: 'e4-lorelei', tier: 'elite-four', order: 8,
    name: 'Lorelei', title: 'Elite Four · Ice',
    type: 'Water', themeLabel: 'Ice', deckType: 'Water',
    badge: { name: 'Ice Seal', emoji: '❄️', color: '#bae6fd' },
    difficulty: 5, portrait: '❄',
    reward: '2 Booster Packs · Ice Seal',
    introDialogue: 'Welcome to the Elite Four. I am Lorelei. My icy Pokémon will freeze you solid.',
    victoryDialogue: 'How can this be? You broke my icy resolve. Move on to the next challenger.',
    defeatDialogue: 'Frozen out. Train harder and return.',
  },
  {
    id: 'e4-bruno', tier: 'elite-four', order: 9,
    name: 'Bruno', title: 'Elite Four · Fighting',
    type: 'Fighting', themeLabel: 'Fighting', deckType: 'Fighting',
    badge: { name: 'Fist Seal', emoji: '👊', color: '#b45309' },
    difficulty: 5, portrait: '🥋',
    reward: '2 Booster Packs · Fist Seal',
    introDialogue: 'I am Bruno of the Elite Four. We will grapple with my Pokémon!',
    victoryDialogue: 'Why? How could I lose? Your strength is admirable.',
    defeatDialogue: 'You lack the fighting spirit. Train. Train. Train.',
  },
  {
    id: 'e4-agatha', tier: 'elite-four', order: 10,
    name: 'Agatha', title: 'Elite Four · Ghost',
    type: 'Psychic', themeLabel: 'Ghost', deckType: 'Psychic',
    badge: { name: 'Soul Seal', emoji: '👻', color: '#a855f7' },
    difficulty: 5, portrait: '🕸',
    reward: '2 Booster Packs · Soul Seal',
    introDialogue: 'Oh, ho ho ho! You must be the trainer Oak speaks of. We will see what a brat can do.',
    victoryDialogue: 'You whippersnapper! You have spirit. Go beat the rest.',
    defeatDialogue: 'Hah! Just as I suspected. Run back to Oak.',
  },
  {
    id: 'e4-lance', tier: 'elite-four', order: 11,
    name: 'Lance', title: 'Elite Four · Dragon',
    type: 'Dragon', themeLabel: 'Dragon', deckType: 'Dragon',
    badge: { name: 'Dragon Seal', emoji: '🐉', color: '#f97316' },
    difficulty: 5, portrait: '🐲',
    reward: '3 Booster Packs · Dragon Seal',
    introDialogue: "I am Lance, the Dragon Master. You are about to learn the meaning of strength.",
    victoryDialogue: 'You have what it takes to be a Champion. Take wing and challenge Blue!',
    defeatDialogue: 'My dragons are too much for you. Come back when you have grown.',
  },
];

const CHAMPION: CampaignOpponent[] = [
  {
    id: 'champion-blue', tier: 'champion', order: 12,
    name: 'Blue', title: 'Pokémon League Champion',
    type: 'Colorless', themeLabel: 'Mixed', deckType: 'Colorless',
    badge: { name: 'Champion Crown', emoji: '👑', color: '#fbbf24' },
    difficulty: 5, portrait: '👑',
    reward: '5 Booster Packs · Champion Crown',
    introDialogue: 'Well well well! Took you long enough. I have been waiting for our rematch.',
    victoryDialogue: '… So you beat me. You are the new Champion. Cherish this moment.',
    defeatDialogue: 'Hah! As expected. You will never be Champion at this rate.',
  },
];

export const CAMPAIGN_OPPONENTS: CampaignOpponent[] = [...GYMS, ...ELITE_FOUR, ...CHAMPION];

export function getGymLeaders(): CampaignOpponent[] { return GYMS; }
export function getEliteFour(): CampaignOpponent[] { return ELITE_FOUR; }
export function getChampion(): CampaignOpponent { return CHAMPION[0]; }
export function findOpponent(id: string): CampaignOpponent | undefined {
  return CAMPAIGN_OPPONENTS.find((o) => o.id === id);
}

// ---------- Progress ----------

export interface CampaignProgress {
  defeatedOpponents: string[]; // opponent ids
  earnedBadges: string[]; // badge names
  unlockedEliteFour: boolean;
  championDefeated: boolean;
  campaignCompletedAt?: string;
  /** localStorage save schema version — bump if we ever change shape. */
  version: 1;
}

const EMPTY_PROGRESS: CampaignProgress = {
  defeatedOpponents: [],
  earnedBadges: [],
  unlockedEliteFour: false,
  championDefeated: false,
  version: 1,
};

function storageKey(walletAddress?: string): string {
  return `pokemon-tcg-campaign:${walletAddress ?? 'anon'}`;
}

export function loadCampaignProgress(walletAddress?: string): CampaignProgress {
  if (typeof window === 'undefined') return { ...EMPTY_PROGRESS };
  try {
    const raw = window.localStorage.getItem(storageKey(walletAddress));
    if (!raw) return { ...EMPTY_PROGRESS };
    const parsed = JSON.parse(raw) as Partial<CampaignProgress>;
    return {
      defeatedOpponents: Array.isArray(parsed.defeatedOpponents) ? parsed.defeatedOpponents : [],
      earnedBadges: Array.isArray(parsed.earnedBadges) ? parsed.earnedBadges : [],
      unlockedEliteFour: Boolean(parsed.unlockedEliteFour),
      championDefeated: Boolean(parsed.championDefeated),
      campaignCompletedAt: parsed.campaignCompletedAt,
      version: 1,
    };
  } catch {
    return { ...EMPTY_PROGRESS };
  }
}

export function saveCampaignProgress(walletAddress: string | undefined, progress: CampaignProgress): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(walletAddress), JSON.stringify(progress));
  } catch {
    // Storage may be unavailable in private mode — non-fatal.
  }
}

/** Apply a win against the given opponent. Returns the new progress
 *  state with derived fields (unlockedEliteFour, championDefeated) and
 *  campaignCompletedAt timestamp when applicable. */
export function applyWin(progress: CampaignProgress, opponent: CampaignOpponent): CampaignProgress {
  if (progress.defeatedOpponents.includes(opponent.id)) return progress;
  const next: CampaignProgress = {
    ...progress,
    defeatedOpponents: [...progress.defeatedOpponents, opponent.id],
    earnedBadges: progress.earnedBadges.includes(opponent.badge.name)
      ? progress.earnedBadges
      : [...progress.earnedBadges, opponent.badge.name],
    version: 1,
  };
  // Unlock Elite Four when all 8 gyms cleared.
  const allGymsCleared = GYMS.every((g) => next.defeatedOpponents.includes(g.id));
  if (allGymsCleared) next.unlockedEliteFour = true;
  // Champion conquered when champion in defeated list.
  if (opponent.tier === 'champion') {
    next.championDefeated = true;
    next.campaignCompletedAt = new Date().toISOString();
  }
  return next;
}

export function isOpponentUnlocked(progress: CampaignProgress, opponent: CampaignOpponent): boolean {
  if (opponent.tier === 'gym') {
    // Gyms unlock sequentially in `order` so the campaign has a
    // recommended path, but earlier gyms remain replayable.
    const gyms = GYMS;
    for (let i = 0; i < gyms.length; i += 1) {
      if (gyms[i].id === opponent.id) {
        if (i === 0) return true;
        return progress.defeatedOpponents.includes(gyms[i - 1].id);
      }
    }
    return false;
  }
  if (opponent.tier === 'elite-four') {
    if (!progress.unlockedEliteFour) return false;
    const e4 = ELITE_FOUR;
    for (let i = 0; i < e4.length; i += 1) {
      if (e4[i].id === opponent.id) {
        if (i === 0) return true;
        return progress.defeatedOpponents.includes(e4[i - 1].id);
      }
    }
    return false;
  }
  // Champion unlocks after all E4 cleared.
  return ELITE_FOUR.every((o) => progress.defeatedOpponents.includes(o.id));
}

/** Next opponent the player is recommended to challenge. */
export function recommendedNext(progress: CampaignProgress): CampaignOpponent | undefined {
  for (const opponent of CAMPAIGN_OPPONENTS) {
    if (!progress.defeatedOpponents.includes(opponent.id)
        && isOpponentUnlocked(progress, opponent)) {
      return opponent;
    }
  }
  return undefined;
}
