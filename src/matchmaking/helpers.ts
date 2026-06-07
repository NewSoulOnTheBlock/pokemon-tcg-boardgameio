// Helpers + constants used by the matchmaking page. Pure functions, no
// React or network — kept in a separate module so they can be unit-tested
// and so the App.tsx component file doesn't grow another 200 lines of
// derived-stat logic.

import type { MatchType } from '../game/types';
import type { MatchRecord, ProfileState } from '../shared/profile';

export interface TrainerRank {
  id: 'pokeball' | 'greatball' | 'ultraball' | 'masterball';
  name: string;
  icon: string;
  color: string;
}

const RANK_TIERS: Array<TrainerRank & { minWins: number }> = [
  { minWins: 0, id: 'pokeball', name: 'Poké Ball', icon: '⚪', color: '#ef4444' },
  { minWins: 5, id: 'greatball', name: 'Great Ball', icon: '🔵', color: '#3b82f6' },
  { minWins: 15, id: 'ultraball', name: 'Ultra Ball', icon: '🟡', color: '#facc15' },
  { minWins: 30, id: 'masterball', name: 'Master Ball', icon: '🟣', color: '#c084fc' },
];

export function getTrainerRank(rankedWins: number): TrainerRank {
  let current: TrainerRank = RANK_TIERS[0];
  for (const tier of RANK_TIERS) {
    if (rankedWins >= tier.minWins) {
      current = { id: tier.id, name: tier.name, icon: tier.icon, color: tier.color };
    }
  }
  return current;
}

/** Light-weight trainer level based on activity: 1 level per 50 XP, where
 *  XP comes from wins (10), losses (3), pack opens (5), and unique cards
 *  collected (1 each). Mock — replace with server-side XP if that lands. */
export function getTrainerLevel(profile: ProfileState): { level: number; xp: number; nextLevelXp: number } {
  const records = profile.matchRecords ?? [];
  const wins = records.filter((r) => r.result === 'win').length;
  const losses = records.filter((r) => r.result === 'loss').length;
  const xp = wins * 10 + losses * 3 + profile.packsOpened * 5 + Object.keys(profile.ownedCards).length;
  const level = Math.max(1, Math.floor(xp / 50) + 1);
  const nextLevelXp = level * 50;
  return { level, xp, nextLevelXp };
}

export interface TrainerStats {
  level: number;
  xp: number;
  nextLevelXp: number;
  rank: TrainerRank;
  rankedWins: number;
  rankedLosses: number;
  rankedDraws: number;
  rankedTotal: number;
  casualMatches: number;
  totalMatches: number;
  winRate: number;
}

export function getTrainerStats(profile: ProfileState): TrainerStats {
  const records = profile.matchRecords ?? [];
  // Every completed match counts toward the W/L record, regardless of
  // matchType (Casual, Ranked, Wager) and regardless of whether the
  // opponent was a human or a CPU/gym leader.
  const completed = records.filter((r) => r.result !== 'in_progress');
  const rankedWins = completed.filter((r) => r.result === 'win').length;
  const rankedLosses = completed.filter((r) => r.result === 'loss').length;
  const rankedDraws = completed.filter((r) => r.result === 'draw').length;
  const casualMatches = 0; // legacy field; matchType no longer affects W/L
  const totalMatches = completed.length;
  const winRate = completed.length > 0 ? Math.round((rankedWins / completed.length) * 100) : 0;
  const { level, xp, nextLevelXp } = getTrainerLevel(profile);
  const rank = getTrainerRank(rankedWins);
  return { level, xp, nextLevelXp, rank, rankedWins, rankedLosses, rankedDraws, rankedTotal: completed.length, casualMatches, totalMatches, winRate };
}

export function rankFromLeaderboard(wins: number): TrainerRank {
  return getTrainerRank(wins);
}

/** All MatchType values the create-match UI exposes. Wager keeps its
 *  existing escrow flow; the others are practice formats that don't
 *  affect leaderboard or trigger wallet flows. */
export const MATCH_TYPE_OPTIONS: Array<{ value: MatchType; label: string; description: string }> = [
  { value: 'Casual', label: 'Casual', description: 'Counts toward W/L record. Just for fun.' },
  { value: 'Ranked', label: 'Ranked', description: 'Counts toward W/L record. Same as Casual.' },
  { value: 'Wager', label: 'Wager', description: 'SOL or $POKETCG payout — settle off-app.' },
  { value: 'Theme Deck', label: 'Theme Deck', description: 'Practice format with thematic decks.' },
  { value: 'Unlimited', label: 'Unlimited', description: 'Anything-goes practice.' },
  { value: 'Tournament Practice', label: 'Tournament Practice', description: 'Tournament-style warm-up.' },
];

export function isLeaderboardImpactingMatchType(matchType: MatchType): boolean {
  return matchType === 'Ranked' || matchType === 'Wager';
}

/** Format a queue wait time as "12s" or "1m 24s". */
export function formatWaitTime(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, '0')}s`;
}

export interface SeasonalEvent {
  id: string;
  title: string;
  emoji: string;
  endsAt: number;
  rewards: string[];
  /** Mock data flag — once a real events backend lands, set to false. */
  isMock: boolean;
}

/** Current seasonal event. Mock data — replace with an API fetch when
 *  the events backend lands. Renders a banner at the top of matchmaking. */
export function getCurrentSeasonalEvent(): SeasonalEvent {
  return {
    id: 'kanto-cup',
    title: 'Kanto Cup Live',
    emoji: '⚔️',
    endsAt: Date.now() + 2 * 24 * 60 * 60 * 1000,
    rewards: ['3 Booster Packs', 'Rare Holo Card', '500 Gold'],
    isMock: true,
  };
}

export function formatCountdown(targetMs: number): string {
  const diff = targetMs - Date.now();
  if (diff <= 0) return 'Ended';
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export const QUEUE_AUTO_CREATE_AFTER_MS = 25_000;
export const QUEUE_POLL_INTERVAL_MS = 3_000;

export function summariseRecentForm(records: MatchRecord[]): string {
  const last5 = records.slice(-5);
  return last5
    .map((r) => (r.result === 'win' ? 'W' : r.result === 'loss' ? 'L' : r.result === 'draw' ? 'D' : '·'))
    .join('');
}
