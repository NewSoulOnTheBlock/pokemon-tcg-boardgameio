import { useEffect, useState } from 'react';
import type { ProfileState } from '../shared/profile';
import {
  DAILY_CHEST_XP,
  claimDailyChest,
  claimQuestReward,
  formatTimeUntilReset,
  getLevelAndProgress,
  getLevelRewards,
  getQuestRuntime,
  loadDailyQuestState,
  loadTrainerProgress,
  msUntilNextReset,
  questById,
  saveDailyQuestState,
  saveTrainerProgress,
  type DailyQuestState,
  type QuestRuntime,
  type TrainerProgress,
} from './data';

// ===== XP bar =========================================================

export function XPBar({ totalXP, compact }: { totalXP: number; compact?: boolean }) {
  const lvl = getLevelAndProgress(totalXP);
  return (
    <div className={`xp-bar${compact ? ' xp-bar-compact' : ''}`}>
      <div className="xp-bar-header">
        <span className="xp-bar-level">Lv. {lvl.level}</span>
        <span className="xp-bar-progress">{lvl.required === Infinity ? 'MAX' : `${lvl.current} / ${lvl.required} XP`}</span>
      </div>
      <div className="xp-bar-track">
        <div className="xp-bar-fill" style={{ width: `${lvl.percentage}%` }} />
      </div>
      {!compact && <span className="xp-bar-total">Lifetime XP: {lvl.totalXP.toLocaleString()}</span>}
    </div>
  );
}

// ===== Quest card =====================================================

export function QuestCard({
  runtime,
  onClaim,
}: {
  runtime: QuestRuntime;
  onClaim: () => void;
}) {
  const { template, current, done, claimed } = runtime;
  const pct = template.goal > 0 ? Math.min(100, (current / template.goal) * 100) : 0;
  const state = claimed ? 'claimed' : done ? 'claimable' : 'in-progress';
  return (
    <article className={`quest-card quest-card-${template.difficulty} quest-card-${state}`}>
      <div className="quest-card-header">
        <div>
          <strong>{template.title}</strong>
          <p className="quest-card-description">{template.description}</p>
        </div>
        <span className={`quest-difficulty-pill quest-difficulty-${template.difficulty}`}>
          {template.difficulty}
        </span>
      </div>
      <div className="quest-progress">
        <div className="quest-progress-bar">
          <div className="quest-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="quest-progress-text">{current} / {template.goal}</span>
      </div>
      <div className="quest-reward-row">
        <span className="quest-reward">+{template.rewardXP} XP</span>
        <button
          className={`quest-claim-button quest-claim-button-${state}`}
          disabled={!done || claimed}
          onClick={onClaim}
        >
          {claimed ? '✓ Claimed' : done ? 'Claim' : 'Locked'}
        </button>
      </div>
    </article>
  );
}

// ===== Daily completion chest =========================================

export function DailyCompletionChest({
  allDone,
  claimed,
  onClaim,
}: {
  allDone: boolean;
  claimed: boolean;
  onClaim: () => void;
}) {
  return (
    <article className={`daily-chest${claimed ? ' daily-chest-claimed' : allDone ? ' daily-chest-ready' : ' daily-chest-locked'}`}>
      <div className="daily-chest-icon" aria-hidden="true">{claimed ? '✅' : allDone ? '🎁' : '🔒'}</div>
      <div>
        <strong>Daily Completion Chest</strong>
        <p>Clear all 3 daily quests to unlock a +{DAILY_CHEST_XP} XP bonus.</p>
      </div>
      <button
        className="quest-claim-button"
        disabled={!allDone || claimed}
        onClick={onClaim}
      >
        {claimed ? '✓ Claimed' : allDone ? `Claim +${DAILY_CHEST_XP} XP` : 'Locked'}
      </button>
    </article>
  );
}

// ===== Level up modal =================================================

export function LevelUpModal({
  newLevel,
  onDismiss,
}: {
  newLevel: number;
  onDismiss: () => void;
}) {
  const rewards = getLevelRewards(newLevel);
  return (
    <div className="wager-modal-backdrop" role="dialog" aria-modal="true" aria-label="Level up">
      <div className="wager-modal level-up-modal">
        <p className="eyebrow">LEVEL UP!</p>
        <h2>Trainer Level <span className="level-up-arrow">→</span> {newLevel}</h2>
        <p className="wager-modal-sub">Your trainer grew stronger. New rewards unlocked:</p>
        <ul className="level-up-rewards">
          {rewards.map((reward, i) => (
            <li key={i}>
              <span aria-hidden="true">{reward.emoji}</span> {reward.description}
            </li>
          ))}
        </ul>
        <div className="wager-modal-actions">
          <button className="primary-cta" onClick={onDismiss}>Continue</button>
        </div>
      </div>
    </div>
  );
}

// ===== Quest Center page ==============================================

export function QuestCenter({
  profile,
  walletAddress,
  onProgressChange,
}: {
  profile: ProfileState;
  walletAddress?: string;
  onProgressChange?: () => void;
}) {
  const [progress, setProgress] = useState<TrainerProgress>(() => loadTrainerProgress(walletAddress));
  const [state, setState] = useState<DailyQuestState>(() => loadDailyQuestState(walletAddress, profile));
  const [resetIn, setResetIn] = useState<number>(() => msUntilNextReset());
  const [levelUpAt, setLevelUpAt] = useState<number | null>(null);

  // Reload when wallet changes.
  useEffect(() => {
    setProgress(loadTrainerProgress(walletAddress));
    setState(loadDailyQuestState(walletAddress, profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  // Live tick the time-until-reset display.
  useEffect(() => {
    const interval = window.setInterval(() => setResetIn(msUntilNextReset()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const runtimes = state.questIds.map((id) => {
    const tmpl = questById(id);
    if (!tmpl) return undefined;
    return getQuestRuntime(state, tmpl, profile, walletAddress);
  }).filter((r): r is QuestRuntime => Boolean(r));

  const allDone = runtimes.length > 0 && runtimes.every((r) => r.done);

  function handleClaim(runtime: QuestRuntime) {
    const before = getLevelAndProgress(progress.totalXP).level;
    const result = claimQuestReward(state, progress, runtime.template);
    setState(result.state);
    saveDailyQuestState(walletAddress, result.state);
    setProgress(result.progress);
    saveTrainerProgress(walletAddress, result.progress);
    const after = getLevelAndProgress(result.progress.totalXP).level;
    if (after > before) setLevelUpAt(after);
    onProgressChange?.();
  }

  function handleChestClaim() {
    const before = getLevelAndProgress(progress.totalXP).level;
    const result = claimDailyChest(state, progress);
    setState(result.state);
    saveDailyQuestState(walletAddress, result.state);
    setProgress(result.progress);
    saveTrainerProgress(walletAddress, result.progress);
    const after = getLevelAndProgress(result.progress.totalXP).level;
    if (after > before) setLevelUpAt(after);
    onProgressChange?.();
  }

  return (
    <section className="quest-center">
      <header className="quest-center-header">
        <div>
          <p className="eyebrow">Quest Center</p>
          <h2>Daily Quests</h2>
          <p className="section-subtitle">Resets in {formatTimeUntilReset(resetIn)} · Local midnight</p>
        </div>
        <div className="quest-center-xp">
          <XPBar totalXP={progress.totalXP} />
        </div>
      </header>
      <div className="quest-grid">
        {runtimes.map((rt) => (
          <QuestCard key={rt.template.id} runtime={rt} onClaim={() => handleClaim(rt)} />
        ))}
      </div>
      <DailyCompletionChest allDone={allDone} claimed={state.chestClaimed} onClaim={handleChestClaim} />
      {levelUpAt !== null && (
        <LevelUpModal newLevel={levelUpAt} onDismiss={() => setLevelUpAt(null)} />
      )}
    </section>
  );
}

// ===== Home page widget ===============================================

export function HomeQuestWidget({
  profile,
  walletAddress,
  onOpenQuests,
}: {
  profile: ProfileState;
  walletAddress?: string;
  onOpenQuests: () => void;
}) {
  const [progress, setProgress] = useState<TrainerProgress>(() => loadTrainerProgress(walletAddress));
  const [state, setState] = useState<DailyQuestState>(() => loadDailyQuestState(walletAddress, profile));
  const [resetIn, setResetIn] = useState<number>(() => msUntilNextReset());

  useEffect(() => {
    setProgress(loadTrainerProgress(walletAddress));
    setState(loadDailyQuestState(walletAddress, profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  useEffect(() => {
    const interval = window.setInterval(() => setResetIn(msUntilNextReset()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const runtimes = state.questIds.map((id) => {
    const tmpl = questById(id);
    if (!tmpl) return undefined;
    return getQuestRuntime(state, tmpl, profile, walletAddress);
  }).filter((r): r is QuestRuntime => Boolean(r));

  const claimableCount = runtimes.filter((r) => r.done && !r.claimed).length;
  const completedCount = runtimes.filter((r) => r.done).length;

  return (
    <button type="button" className="home-quest-widget" onClick={onOpenQuests}>
      <div className="home-quest-widget-header">
        <strong>🎯 Today's Quests</strong>
        <span>Resets in {formatTimeUntilReset(resetIn)}</span>
      </div>
      <XPBar totalXP={progress.totalXP} compact />
      <div className="home-quest-widget-status">
        <span>{completedCount} / {runtimes.length} complete</span>
        {claimableCount > 0 && <span className="home-quest-widget-claimable">{claimableCount} ready to claim!</span>}
      </div>
    </button>
  );
}

// ===== External award hook ============================================

/** Idempotent helper for App.tsx to call from match/pack/campaign
 *  completion handlers. Awards XP and returns the new level if the
 *  award triggered a level-up, undefined otherwise. */
export function awardXPAndPersist(
  walletAddress: string | undefined,
  amount: number,
): { newLevel?: number; progress: TrainerProgress } {
  const current = loadTrainerProgress(walletAddress);
  if (!(amount > 0)) return { progress: current };
  const before = getLevelAndProgress(current.totalXP).level;
  const next: TrainerProgress = {
    ...current,
    totalXP: current.totalXP + amount,
    version: 1,
  };
  saveTrainerProgress(walletAddress, next);
  const after = getLevelAndProgress(next.totalXP).level;
  return { newLevel: after > before ? after : undefined, progress: next };
}
