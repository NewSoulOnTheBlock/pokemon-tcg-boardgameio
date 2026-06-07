// Trainer XP + Daily Quest system.
//
// State model (all persisted in localStorage per wallet — same fallback
// pattern as campaign progress):
//   * `TrainerProgress` — base XP earned outside of quest claims
//     (matches, packs, gym wins) + the XP awarded by claimed quests.
//   * `DailyQuestState` — today's 3 quests (seeded by date+wallet so
//     they're deterministic across reloads), per-quest claimed flag,
//     and the daily-completion-chest claimed flag.
//
// Quest progress for each quest is COMPUTED LIVE from the existing
// profile state (matchRecords, packPurchases, campaign localStorage)
// rather than tracked via a real-time event bus. That keeps the system
// stateless on the event side and impossible to corrupt by missed
// listeners. The trade-off: a quest "Win 1 match" is satisfied by any
// of your existing wins, so newly-rolled quests can be "auto-progressed"
// from prior history — that's by design (counts what you've actually
// done since the last reset).

import type { ProfileState } from '../shared/profile';
import { loadCampaignProgress } from '../campaign/data';

// ---------- XP curve ----------

export const MAX_LEVEL = 100;

/** XP required to advance FROM `level` TO the next level. Spec:
 *  ``requiredXP = 100 + level * 50``. So Level 1 needs 100, Level 2 needs
 *  200, etc. Capped at MAX_LEVEL (no further progression). */
export function getXPForLevel(level: number): number {
  if (level >= MAX_LEVEL) return Infinity;
  return 100 + level * 50;
}

/** Convert a "total XP earned" into level + progress-into-current. */
export function getLevelAndProgress(totalXP: number): {
  level: number;
  current: number;
  required: number;
  percentage: number;
  totalXP: number;
} {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXP));
  while (level < MAX_LEVEL) {
    const cost = getXPForLevel(level);
    if (remaining < cost) break;
    remaining -= cost;
    level += 1;
  }
  const required = getXPForLevel(level);
  const percentage = required === Infinity ? 100 : Math.min(100, (remaining / required) * 100);
  return { level, current: remaining, required, percentage, totalXP };
}

export interface LevelReward {
  description: string;
  emoji: string;
  /** Cosmetic-only — we don't have an in-game currency wallet. */
  coins?: number;
  /** Placeholder: free booster pack drop would need server economy. */
  boosters?: number;
}

/** Per-level rewards spec. Every level grants placeholder coins; every
 *  5th, 10th, and 25th level layer in extra cosmetic placeholders. */
export function getLevelRewards(level: number): LevelReward[] {
  const rewards: LevelReward[] = [
    { description: `+100 Coins`, emoji: '🪙', coins: 100 },
  ];
  if (level % 25 === 0) {
    rewards.push({ description: 'Exclusive Card Back', emoji: '🎴' });
  }
  if (level % 10 === 0) {
    rewards.push({ description: 'Exclusive Avatar Frame', emoji: '🖼' });
  }
  if (level % 5 === 0) {
    rewards.push({ description: '+1 Booster Pack (placeholder)', emoji: '📦', boosters: 1 });
  }
  return rewards;
}

// ---------- Trainer progress ----------

export interface TrainerProgress {
  /** Total XP earned over the account's lifetime. */
  totalXP: number;
  /** XP awarded by quests the user has claimed (subset of totalXP). */
  questXP: number;
  /** Last seen level — used so the level-up modal only fires once per
   *  threshold even across page reloads. */
  lastSeenLevel: number;
  version: 1;
}

const EMPTY_PROGRESS: TrainerProgress = {
  totalXP: 0,
  questXP: 0,
  lastSeenLevel: 1,
  version: 1,
};

function progressKey(walletAddress?: string): string {
  return `trainer_progress_${walletAddress ?? 'anon'}`;
}

export function loadTrainerProgress(walletAddress?: string): TrainerProgress {
  if (typeof window === 'undefined') return { ...EMPTY_PROGRESS };
  try {
    const raw = window.localStorage.getItem(progressKey(walletAddress));
    if (!raw) return { ...EMPTY_PROGRESS };
    const parsed = JSON.parse(raw) as Partial<TrainerProgress>;
    return {
      totalXP: Number(parsed.totalXP) || 0,
      questXP: Number(parsed.questXP) || 0,
      lastSeenLevel: Number(parsed.lastSeenLevel) || 1,
      version: 1,
    };
  } catch {
    return { ...EMPTY_PROGRESS };
  }
}

export function saveTrainerProgress(walletAddress: string | undefined, progress: TrainerProgress): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(progressKey(walletAddress), JSON.stringify(progress));
  } catch {
    // ignore — private mode, quota, etc.
  }
}

/** Award XP and return the updated progress. Caller is responsible for
 *  persisting the result and triggering any level-up modal. */
export function awardXP(progress: TrainerProgress, amount: number, source: 'quest' | 'gameplay' = 'gameplay'): TrainerProgress {
  if (!(amount > 0)) return progress;
  return {
    ...progress,
    totalXP: progress.totalXP + amount,
    questXP: source === 'quest' ? progress.questXP + amount : progress.questXP,
    version: 1,
  };
}

// ---------- Quest catalogue ----------

export type QuestDifficulty = 'easy' | 'medium' | 'hard';

export type QuestMetricSource =
  | 'matches-played'        // total completed matches
  | 'matches-won'           // total wins (all match types)
  | 'ranked-wins'           // wins in Ranked or Wager
  | 'packs-opened'          // total packs opened
  | 'badges-earned'         // campaign badges
  | 'elite-four-wins'       // distinct E4 opponents defeated
  | 'champion-wins'         // champion defeated (0/1)
  | 'decks-saved'           // count of customDeck library entries
  | 'no-concede-match';     // wins with reason not containing 'forfeit'

export interface QuestTemplate {
  id: string;
  title: string;
  description: string;
  metric: QuestMetricSource;
  goal: number;
  difficulty: QuestDifficulty;
  rewardXP: number;
  rewardCoins: number;
}

const QUEST_POOL: QuestTemplate[] = [
  { id: 'play-1', title: 'Play 1 Match', description: 'Start and finish 1 match (any type).', metric: 'matches-played', goal: 1, difficulty: 'easy', rewardXP: 50, rewardCoins: 100 },
  { id: 'play-3', title: 'Play 3 Matches', description: 'Start and finish 3 matches today.', metric: 'matches-played', goal: 3, difficulty: 'medium', rewardXP: 100, rewardCoins: 250 },
  { id: 'win-1', title: 'Win 1 Match', description: 'Win any 1 match.', metric: 'matches-won', goal: 1, difficulty: 'easy', rewardXP: 50, rewardCoins: 100 },
  { id: 'win-3', title: 'Win 3 Matches', description: 'Win 3 matches in a single day.', metric: 'matches-won', goal: 3, difficulty: 'hard', rewardXP: 150, rewardCoins: 500 },
  { id: 'ranked-win-1', title: 'Climb the Ladder', description: 'Win 1 Ranked or Wager match.', metric: 'ranked-wins', goal: 1, difficulty: 'medium', rewardXP: 100, rewardCoins: 250 },
  { id: 'open-1-pack', title: 'Open 1 Booster Pack', description: 'Open 1 booster pack from the Shop.', metric: 'packs-opened', goal: 1, difficulty: 'easy', rewardXP: 50, rewardCoins: 100 },
  { id: 'open-3-packs', title: 'Open 3 Booster Packs', description: 'Open 3 booster packs.', metric: 'packs-opened', goal: 3, difficulty: 'hard', rewardXP: 150, rewardCoins: 500 },
  { id: 'badge-1', title: 'Earn a Gym Badge', description: 'Defeat a Gym Leader to earn their badge.', metric: 'badges-earned', goal: 1, difficulty: 'medium', rewardXP: 100, rewardCoins: 250 },
  { id: 'deckbuilder', title: 'Save a Custom Deck', description: 'Build and save 1 custom deck in the deckbuilder.', metric: 'decks-saved', goal: 1, difficulty: 'easy', rewardXP: 50, rewardCoins: 100 },
  { id: 'no-concede-win', title: 'Honourable Victory', description: 'Win a match without your opponent forfeiting.', metric: 'no-concede-match', goal: 1, difficulty: 'medium', rewardXP: 100, rewardCoins: 250 },
  { id: 'elite-four-touch', title: 'Take an Elite Four Seat', description: 'Defeat any Elite Four member.', metric: 'elite-four-wins', goal: 1, difficulty: 'hard', rewardXP: 150, rewardCoins: 500 },
  { id: 'champion-aspirant', title: 'League Aspirant', description: 'Defeat the League Champion.', metric: 'champion-wins', goal: 1, difficulty: 'hard', rewardXP: 150, rewardCoins: 500 },
];

// ---------- Daily quest generation ----------

export interface DailyQuestState {
  /** YYYY-MM-DD in user local time, used to detect day rollover. */
  dateKey: string;
  questIds: string[];
  claimedIds: string[];
  /** Daily completion chest claimed for this day. */
  chestClaimed: boolean;
  /** Snapshot of metric counts taken when the quests were generated.
   *  Quest progress is computed as `current - baseline` so previously-
   *  earned wins don't auto-complete today's quests. */
  baseline: Partial<Record<QuestMetricSource, number>>;
  version: 1;
}

export function todayDateKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Deterministic per-(wallet, date) PRNG so the same wallet on the same
 *  day always rolls the same 3 daily quests across reloads. */
function seededRng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function () {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickQuests(pool: QuestTemplate[], rng: () => number, count: number): QuestTemplate[] {
  // Try to mix one of each difficulty; fall back to random.
  const byDiff: Record<QuestDifficulty, QuestTemplate[]> = {
    easy: pool.filter((q) => q.difficulty === 'easy'),
    medium: pool.filter((q) => q.difficulty === 'medium'),
    hard: pool.filter((q) => q.difficulty === 'hard'),
  };
  const picked: QuestTemplate[] = [];
  const order: QuestDifficulty[] = ['easy', 'medium', 'hard'];
  for (const diff of order) {
    if (picked.length >= count) break;
    const bucket = byDiff[diff];
    if (bucket.length > 0) {
      picked.push(bucket[Math.floor(rng() * bucket.length)]);
    }
  }
  // Fill remaining from any bucket without duplicates.
  while (picked.length < count) {
    const candidate = pool[Math.floor(rng() * pool.length)];
    if (!picked.some((p) => p.id === candidate.id)) picked.push(candidate);
  }
  return picked;
}

export function computeMetricCurrent(profile: ProfileState, metric: QuestMetricSource, walletAddress?: string): number {
  const records = profile.matchRecords ?? [];
  const completed = records.filter((r) => r.result !== 'in_progress');
  const campaign = loadCampaignProgress(walletAddress);
  switch (metric) {
    case 'matches-played':
      return completed.length;
    case 'matches-won':
      return completed.filter((r) => r.result === 'win').length;
    case 'ranked-wins':
      return completed.filter((r) => r.result === 'win' && (r.matchType === 'Ranked' || r.matchType === 'Wager')).length;
    case 'packs-opened':
      return profile.packsOpened;
    case 'badges-earned':
      return campaign.earnedBadges.length;
    case 'elite-four-wins':
      return campaign.defeatedOpponents.filter((id) => id.startsWith('e4-')).length;
    case 'champion-wins':
      return campaign.championDefeated ? 1 : 0;
    case 'decks-saved':
      return profile.deckLibrary.length;
    case 'no-concede-match':
      return completed.filter((r) => r.result === 'win' && !/(forfeit|left the match)/i.test(r.reason ?? '')).length;
  }
}

export function snapshotMetrics(profile: ProfileState, walletAddress: string | undefined, metrics: QuestMetricSource[]): Partial<Record<QuestMetricSource, number>> {
  const snap: Partial<Record<QuestMetricSource, number>> = {};
  for (const m of metrics) snap[m] = computeMetricCurrent(profile, m, walletAddress);
  return snap;
}

function dailyKey(walletAddress?: string): string {
  return `daily_quests_${walletAddress ?? 'anon'}`;
}

export function generateDailyQuests(walletAddress: string | undefined, profile: ProfileState): DailyQuestState {
  const dateKey = todayDateKey();
  const rng = seededRng(`${walletAddress ?? 'anon'}:${dateKey}`);
  const picked = pickQuests(QUEST_POOL, rng, 3);
  return {
    dateKey,
    questIds: picked.map((q) => q.id),
    claimedIds: [],
    chestClaimed: false,
    baseline: snapshotMetrics(profile, walletAddress, picked.map((q) => q.metric)),
    version: 1,
  };
}

export function loadDailyQuestState(walletAddress: string | undefined, profile: ProfileState): DailyQuestState {
  if (typeof window === 'undefined') return generateDailyQuests(walletAddress, profile);
  const today = todayDateKey();
  try {
    const raw = window.localStorage.getItem(dailyKey(walletAddress));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DailyQuestState>;
      if (parsed.dateKey === today && Array.isArray(parsed.questIds) && parsed.questIds.length > 0) {
        return {
          dateKey: today,
          questIds: parsed.questIds,
          claimedIds: Array.isArray(parsed.claimedIds) ? parsed.claimedIds : [],
          chestClaimed: Boolean(parsed.chestClaimed),
          baseline: parsed.baseline ?? {},
          version: 1,
        };
      }
    }
  } catch {
    // fall through to regeneration
  }
  const fresh = generateDailyQuests(walletAddress, profile);
  saveDailyQuestState(walletAddress, fresh);
  return fresh;
}

export function saveDailyQuestState(walletAddress: string | undefined, state: DailyQuestState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(dailyKey(walletAddress), JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

/** Returns ms until the next local-midnight reset. */
export function msUntilNextReset(): number {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return tomorrow.getTime() - now.getTime();
}

export function formatTimeUntilReset(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function questById(id: string): QuestTemplate | undefined {
  return QUEST_POOL.find((q) => q.id === id);
}

export interface QuestRuntime {
  template: QuestTemplate;
  current: number;       // bounded 0..goal
  rawCurrent: number;    // metric current - baseline
  done: boolean;
  claimed: boolean;
}

export function getQuestRuntime(
  state: DailyQuestState,
  template: QuestTemplate,
  profile: ProfileState,
  walletAddress?: string,
): QuestRuntime {
  const baseline = state.baseline?.[template.metric] ?? 0;
  const current = computeMetricCurrent(profile, template.metric, walletAddress);
  const raw = Math.max(0, current - baseline);
  const bounded = Math.min(template.goal, raw);
  return {
    template,
    current: bounded,
    rawCurrent: raw,
    done: raw >= template.goal,
    claimed: state.claimedIds.includes(template.id),
  };
}

export interface ClaimResult {
  state: DailyQuestState;
  progress: TrainerProgress;
  xpAwarded: number;
  /** Set when the third quest claim unlocks the chest. */
  chestNowClaimable: boolean;
}

export function claimQuestReward(
  state: DailyQuestState,
  progress: TrainerProgress,
  template: QuestTemplate,
): ClaimResult {
  if (state.claimedIds.includes(template.id)) {
    return { state, progress, xpAwarded: 0, chestNowClaimable: false };
  }
  const nextState: DailyQuestState = {
    ...state,
    claimedIds: [...state.claimedIds, template.id],
    version: 1,
  };
  const nextProgress = awardXP(progress, template.rewardXP, 'quest');
  const allClaimed = state.questIds.every((id) => nextState.claimedIds.includes(id));
  return { state: nextState, progress: nextProgress, xpAwarded: template.rewardXP, chestNowClaimable: allClaimed && !state.chestClaimed };
}

/** The chest awards a flat +200 XP bonus (no real coins/packs). */
export const DAILY_CHEST_XP = 200;

export function claimDailyChest(state: DailyQuestState, progress: TrainerProgress): ClaimResult {
  if (state.chestClaimed) return { state, progress, xpAwarded: 0, chestNowClaimable: false };
  return {
    state: { ...state, chestClaimed: true },
    progress: awardXP(progress, DAILY_CHEST_XP, 'quest'),
    xpAwarded: DAILY_CHEST_XP,
    chestNowClaimable: false,
  };
}

// ---------- Auto XP awards for gameplay events ----------

export const XP_REWARDS = {
  matchPlayed: 25,
  matchWon: 50,
  rankedWin: 75,
  gymWin: 150,
  eliteFourWin: 250,
  championWin: 500,
  packOpened: 10,
} as const;

export function xpForMatchResult(matchType: string | undefined, result: 'win' | 'loss' | 'draw'): number {
  let xp = XP_REWARDS.matchPlayed;
  if (result === 'win') {
    xp += XP_REWARDS.matchWon;
    if (matchType === 'Ranked' || matchType === 'Wager') xp += XP_REWARDS.rankedWin;
  }
  return xp;
}

export function xpForCampaignWin(opponentTier: 'gym' | 'elite-four' | 'champion'): number {
  if (opponentTier === 'champion') return XP_REWARDS.championWin;
  if (opponentTier === 'elite-four') return XP_REWARDS.eliteFourWin;
  return XP_REWARDS.gymWin;
}
