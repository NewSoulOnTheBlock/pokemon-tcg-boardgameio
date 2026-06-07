// Reusable building blocks for the redesigned Profile dashboard.
// Pure presentation — they take props derived from the existing
// ProfileState/leaderboard so the existing data is the source of truth.

import type { ReactNode } from 'react';
import type { MatchLeaderboardEntry, MatchRecord, ProfileState } from '../shared/profile';
import { CARD_LIBRARY } from '../game/cards';
import { shortAddr } from '../wallet';
import type { TrainerRank, TrainerStats } from '../matchmaking/helpers';
import { rankFromLeaderboard } from '../matchmaking/helpers';
import type { Achievement, RegionProgressResult, TypeBreakdownEntry } from './data';

// ===== Tabs ===========================================================

export type ProfileTabId = 'profile' | 'collection' | 'decks' | 'match-history' | 'achievements' | 'leaderboard' | 'quests';

export const PROFILE_TABS: Array<{ id: ProfileTabId; label: string; icon: string }> = [
  { id: 'profile', label: 'Profile', icon: '🎮' },
  { id: 'quests', label: 'Quests', icon: '🎯' },
  { id: 'collection', label: 'Collection', icon: '🃏' },
  { id: 'decks', label: 'Decks', icon: '📚' },
  { id: 'match-history', label: 'Match History', icon: '⚔' },
  { id: 'achievements', label: 'Achievements', icon: '🏆' },
  { id: 'leaderboard', label: 'Leaderboard', icon: '🥇' },
];

export function ProfileTabs({
  active,
  onChange,
}: {
  active: ProfileTabId;
  onChange: (next: ProfileTabId) => void;
}) {
  return (
    <nav className="profile-tabs" role="tablist" aria-label="Profile sections">
      {PROFILE_TABS.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          tabIndex={active === tab.id ? 0 : -1}
          className={`profile-tab${active === tab.id ? ' profile-tab-active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          <span aria-hidden="true">{tab.icon}</span> {tab.label}
        </button>
      ))}
    </nav>
  );
}

// ===== Trainer Hero ====================================================

export function TrainerHeroBanner({
  profile,
  stats,
  collectionScore,
  cardsOwned,
  showcaseCardId,
  showcaseReason,
}: {
  profile: ProfileState;
  stats: TrainerStats;
  collectionScore: number;
  cardsOwned: number;
  showcaseCardId?: string;
  showcaseReason?: string;
}) {
  const xpPct = Math.min(100, (stats.xp / stats.nextLevelXp) * 100);
  const walletShort = profile.wallet ? shortAddr(profile.wallet.address) : null;
  const showcaseCard = showcaseCardId ? CARD_LIBRARY[showcaseCardId] : undefined;

  return (
    <section className="trainer-hero">
      <div className="trainer-hero-left">
        <TrainerAvatarCard profile={profile} rank={stats.rank} level={stats.level} xpPct={xpPct} xp={stats.xp} nextLevelXp={stats.nextLevelXp} />
      </div>
      <div className="trainer-hero-center">
        <p className="eyebrow">Trainer profile</p>
        <h1 className="trainer-hero-name">{profile.name || 'Trainer'}</h1>
        {walletShort && (
          <p className="trainer-hero-wallet">
            <span className="trainer-hero-wallet-chip">{profile.wallet!.chain.toUpperCase()}</span>
            <code>{walletShort}</code>
          </p>
        )}
        <div className="trainer-hero-stats">
          <HeroStat label="Cards owned" value={String(cardsOwned)} />
          <HeroStat label="Collection score" value={`${collectionScore}%`} />
          <HeroStat label="Record" value={`${stats.rankedWins}-${stats.rankedLosses}${stats.rankedDraws ? `-${stats.rankedDraws}` : ''}`} />
          <HeroStat label="Win rate" value={`${stats.winRate}%`} />
          <HeroStat label="Season rank" value={stats.rank.name} valueColor={stats.rank.color} />
        </div>
      </div>
      <div className="trainer-hero-right">
        <FavoriteShowcase showcaseCard={showcaseCard} reason={showcaseReason} />
      </div>
    </section>
  );
}

function HeroStat({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="hero-stat">
      <strong style={valueColor ? { color: valueColor, WebkitTextFillColor: valueColor, background: 'none' } : undefined}>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function TrainerAvatarCard({
  profile,
  rank,
  level,
  xpPct,
  xp,
  nextLevelXp,
}: {
  profile: ProfileState;
  rank: TrainerRank;
  level: number;
  xpPct: number;
  xp: number;
  nextLevelXp: number;
}) {
  // Avatar fallback: first letter of name on a colour seeded by name hash.
  const initial = (profile.name || '?').trim().slice(0, 1).toUpperCase();
  const hash = Array.from(profile.name || '?').reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
  const avatarStyle = { background: `conic-gradient(from 220deg at 50% 50%, hsl(${hash},70%,40%), hsl(${(hash + 80) % 360},70%,50%))` };

  return (
    <div className="trainer-avatar-card">
      <div className="trainer-avatar-image" style={avatarStyle} aria-hidden="true">
        <span>{initial}</span>
      </div>
      <button type="button" className="trainer-avatar-change" disabled title="Avatar customisation coming soon">
        Change Avatar
      </button>
      <div className="trainer-avatar-rank" style={{ color: rank.color, borderColor: rank.color }}>
        {rank.icon} {rank.name}
      </div>
      <div className="trainer-avatar-level">
        <span>Level <strong>{level}</strong></span>
        <div className="trainer-avatar-xp-bar">
          <div className="trainer-avatar-xp-fill" style={{ width: `${xpPct}%` }} />
        </div>
        <span className="trainer-avatar-xp-text">{xp} / {nextLevelXp} XP</span>
      </div>
    </div>
  );
}

export function FavoriteShowcase({ showcaseCard, reason }: { showcaseCard?: { name: string; images?: { small?: string; large?: string } }; reason?: string }) {
  if (!showcaseCard) {
    return (
      <div className="favorite-showcase favorite-showcase-empty">
        <p className="eyebrow">Showcase</p>
        <p>Open packs or import NFTs to unlock your showcase card.</p>
      </div>
    );
  }
  return (
    <div className="favorite-showcase">
      <p className="eyebrow">Showcase</p>
      <div className="favorite-showcase-card">
        {showcaseCard.images?.small ? (
          <img src={showcaseCard.images.small} alt={showcaseCard.name} loading="lazy" />
        ) : (
          <div className="favorite-showcase-fallback">{showcaseCard.name}</div>
        )}
      </div>
      <strong>{showcaseCard.name}</strong>
      {reason && <span className="favorite-showcase-reason">{reason}</span>}
    </div>
  );
}

// ===== Stat sections ==================================================

export function StatSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="stat-section">
      <h2 className="stat-section-title">{title}</h2>
      <div className="stat-section-grid">{children}</div>
    </section>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat-card">
      <strong>{value}</strong>
      <span>{label}</span>
      {hint && <em className="stat-card-hint">{hint}</em>}
    </div>
  );
}

// ===== Collection progress ===========================================

export function CollectionProgress({
  overallPct,
  regions,
  types,
}: {
  overallPct: number;
  regions: RegionProgressResult[];
  types: TypeBreakdownEntry[];
}) {
  return (
    <div className="collection-progress">
      <div className="collection-progress-overall">
        <strong>{overallPct.toFixed(2)}%</strong>
        <span>Overall collection complete</span>
        <div className="collection-progress-bar">
          <div className="collection-progress-fill" style={{ width: `${Math.min(100, overallPct)}%` }} />
        </div>
      </div>
      <div className="collection-progress-regions">
        <h3>Regions <span className="mock-tag">(set-prefix heuristic)</span></h3>
        {regions.filter((r) => r.total > 0).map((region) => {
          const pct = region.total > 0 ? (region.owned / region.total) * 100 : 0;
          return (
            <div className="region-progress-row" key={region.region}>
              <span className="region-progress-label">{region.emoji} {region.region}</span>
              <div className="region-progress-bar">
                <div className="region-progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="region-progress-count">{region.owned} / {region.total}</span>
            </div>
          );
        })}
      </div>
      <div className="collection-progress-types">
        <h3>Type breakdown</h3>
        {types.map((entry) => {
          const pct = entry.total > 0 ? (entry.owned / entry.total) * 100 : 0;
          return (
            <div className="type-progress-row" key={entry.type}>
              <span className="type-progress-label" style={{ color: entry.color }}>{entry.type}</span>
              <div className="type-progress-bar">
                <div className="type-progress-fill" style={{ width: `${pct}%`, background: entry.color }} />
              </div>
              <span className="type-progress-count">{entry.owned} / {entry.total}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===== Achievement grid ==============================================

export function AchievementBadgeGrid({ profile, achievements }: { profile: ProfileState; achievements: Achievement[] }) {
  return (
    <div className="achievement-grid">
      {achievements.map((ach) => {
        const unlocked = ach.unlocked(profile);
        const progress = !unlocked && ach.progress ? ach.progress(profile) : unlocked ? 100 : 0;
        return (
          <article key={ach.id} className={`achievement-badge${unlocked ? ' achievement-badge-unlocked' : ' achievement-badge-locked'}`}>
            <div className="achievement-badge-icon" aria-hidden="true">{ach.icon}</div>
            <div className="achievement-badge-body">
              <strong>{ach.name}</strong>
              <p>{ach.description}</p>
              {!unlocked && ach.progress && (
                <div className="achievement-badge-progress">
                  <div className="achievement-badge-progress-bar">
                    <div className="achievement-badge-progress-fill" style={{ width: `${progress}%` }} />
                  </div>
                  <span>{Math.round(progress)}%</span>
                </div>
              )}
              {unlocked && <span className="achievement-badge-state">Unlocked ✓</span>}
            </div>
          </article>
        );
      })}
    </div>
  );
}

// ===== Match history list ============================================

export function MatchHistory({ records }: { records: MatchRecord[] }) {
  if (records.length === 0) {
    return (
      <div className="match-history-empty">
        <p>No match history yet. Play your first match from Matchmaking or vs Bot.</p>
      </div>
    );
  }
  const reversed = [...records].reverse();
  return (
    <div className="match-history-list">
      {reversed.slice(0, 30).map((record) => (
        <article className={`match-history-row match-card-result-${record.result}`} key={`${record.matchID}-${record.playerID}`}>
          <div className="match-history-result">
            <span className={`match-result-pill match-result-pill-${record.result}`}>
              {record.result === 'in_progress' ? 'LIVE' : record.result.toUpperCase()}
            </span>
          </div>
          <div className="match-history-body">
            <div className="match-card-meta">
              <span className={`match-type-badge match-type-badge-${(record.matchType ?? 'Casual').replace(/\s+/g, '-')}`}>{record.matchType ?? 'Casual'}</span>
              <span className="match-id-chip">#{record.matchID.slice(0, 8)}</span>
              {record.wagerAmount && record.wagerAmount > 0 && (
                <span className="wager-chip">{record.wagerAmount} {record.wagerCurrency === 'POKETCG' ? '$POKETCG' : 'SOL'}</span>
              )}
            </div>
            <strong>{record.playerDeckLabel} <em style={{ opacity: 0.6 }}>vs</em> {record.opponentDeckLabel}</strong>
            <span>{record.completedAt ? `Completed ${new Date(record.completedAt).toLocaleString()}` : `Started ${new Date(record.startedAt).toLocaleString()}`}</span>
            {record.reason && <span className="match-card-reason">{record.reason}</span>}
          </div>
        </article>
      ))}
    </div>
  );
}

// ===== Leaderboard panel =============================================

export function LeaderboardPanel({ entries, selfUserId }: { entries: MatchLeaderboardEntry[]; selfUserId?: string }) {
  if (entries.length === 0) {
    return <p className="empty-state">No ranked records yet. Be the first.</p>;
  }
  return (
    <table className="leaderboard-table leaderboard-table-ranked">
      <thead>
        <tr>
          <th>Rank</th>
          <th>Trainer</th>
          <th>Wins</th>
          <th>Losses</th>
          <th>Win %</th>
          <th>Badge</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, index) => {
          const wr = entry.matches > 0 ? Math.round((entry.wins / entry.matches) * 100) : 0;
          const rank = rankFromLeaderboard(entry.wins);
          const isSelf = selfUserId && entry.userId === selfUserId;
          const topClass = index < 3 ? `leaderboard-row-top-${index + 1}` : '';
          return (
            <tr key={entry.userId} className={`${topClass}${isSelf ? ' leaderboard-row-self' : ''}`}>
              <td className="leaderboard-rank-cell">
                {index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`}
              </td>
              <td>{entry.name}{isSelf ? ' (you)' : ''}</td>
              <td>{entry.wins}</td>
              <td>{entry.losses}</td>
              <td>{wr}%</td>
              <td>
                <span className="rank-badge" style={{ color: rank.color }}>{rank.icon} {rank.name}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
