import type { CampaignOpponent, CampaignProgress } from './data';
import { getChampion, getEliteFour, getGymLeaders, isOpponentUnlocked, recommendedNext } from './data';

export function CampaignHero({ progress, recommended }: { progress: CampaignProgress; recommended?: CampaignOpponent }) {
  const totalOpponents = 13;
  const cleared = progress.defeatedOpponents.length;
  const pct = (cleared / totalOpponents) * 100;
  return (
    <section className="campaign-hero">
      <div className="campaign-hero-body">
        <p className="eyebrow">Single Player Campaign</p>
        <h1>⚔ Gym Challenge</h1>
        <p>Battle 8 Gym Leaders, the Elite Four, and the Champion. Earn badges, unlock the next tier, and prove yourself as the Pokémon League Champion.</p>
        <div className="campaign-progress-bar">
          <div className="campaign-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <p className="campaign-progress-text">{cleared} / {totalOpponents} opponents defeated{progress.championDefeated ? ' · 👑 League Champion!' : ''}</p>
      </div>
      {recommended ? (
        <div className="campaign-hero-recommended">
          <p className="eyebrow">Next challenge</p>
          <div className="campaign-hero-portrait" style={{ background: `radial-gradient(circle, ${recommended.badge.color}55, transparent 70%)` }}>
            <span aria-hidden="true">{recommended.portrait}</span>
          </div>
          <strong>{recommended.name}</strong>
          <span>{recommended.title}</span>
        </div>
      ) : (
        <div className="campaign-hero-recommended">
          <p className="eyebrow">Status</p>
          <strong>{progress.championDefeated ? 'Campaign complete!' : 'All caught up'}</strong>
        </div>
      )}
    </section>
  );
}

export function BadgeCase({ progress }: { progress: CampaignProgress }) {
  const gyms = getGymLeaders();
  return (
    <section className="panel badge-case-panel">
      <p className="eyebrow">Badge Case</p>
      <div className="badge-case">
        {gyms.map((opponent) => {
          const earned = progress.earnedBadges.includes(opponent.badge.name);
          return (
            <div key={opponent.id} className={`badge-slot${earned ? ' badge-slot-earned' : ' badge-slot-locked'}`} title={`${opponent.badge.name} · ${opponent.name}`}>
              <span className="badge-emoji" style={earned ? { textShadow: `0 0 12px ${opponent.badge.color}` } : undefined} aria-hidden="true">
                {earned ? opponent.badge.emoji : '🔒'}
              </span>
              <span className="badge-name">{earned ? opponent.badge.name : '???'}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function OpponentCard({
  opponent,
  progress,
  onBattle,
}: {
  opponent: CampaignOpponent;
  progress: CampaignProgress;
  onBattle: (opponent: CampaignOpponent) => void;
}) {
  const defeated = progress.defeatedOpponents.includes(opponent.id);
  const unlocked = isOpponentUnlocked(progress, opponent);
  const isCurrent = recommendedNext(progress)?.id === opponent.id;
  return (
    <article
      className={`opponent-card opponent-card-${opponent.tier}${defeated ? ' opponent-card-defeated' : ''}${unlocked ? '' : ' opponent-card-locked'}${isCurrent ? ' opponent-card-current' : ''}`}
      style={{ borderColor: defeated || unlocked ? opponent.badge.color : undefined }}
    >
      <div className="opponent-portrait" style={{ background: `radial-gradient(circle, ${opponent.badge.color}33, transparent 70%)` }}>
        <span aria-hidden="true">{opponent.portrait}</span>
      </div>
      <div className="opponent-body">
        <div className="opponent-name-row">
          <strong>{opponent.name}</strong>
          {defeated && <span className="opponent-check" title="Defeated">✓</span>}
          {isCurrent && !defeated && <span className="opponent-current-pill">CURRENT</span>}
        </div>
        <span className="opponent-title">{opponent.title}</span>
        <div className="opponent-meta">
          <span className="opponent-type" style={{ color: opponent.badge.color }}>{opponent.themeLabel}</span>
          <span className="opponent-difficulty" title={`Difficulty ${opponent.difficulty}/5`}>{'★'.repeat(opponent.difficulty)}{'☆'.repeat(5 - opponent.difficulty)}</span>
        </div>
        <div className="opponent-reward">🎁 {opponent.reward}</div>
        <button
          type="button"
          className={`primary-cta opponent-battle-btn${defeated ? ' opponent-battle-btn-rematch' : ''}`}
          disabled={!unlocked}
          onClick={() => onBattle(opponent)}
        >
          {!unlocked ? '🔒 Locked' : defeated ? '🔁 Rematch' : '⚔ Battle'}
        </button>
      </div>
    </article>
  );
}

export function GymRow({ progress, onBattle }: { progress: CampaignProgress; onBattle: (o: CampaignOpponent) => void }) {
  return (
    <section className="panel">
      <p className="eyebrow">Kanto Gym Leaders</p>
      <h2>Eight badges to collect</h2>
      <div className="opponent-grid">
        {getGymLeaders().map((opponent) => (
          <OpponentCard key={opponent.id} opponent={opponent} progress={progress} onBattle={onBattle} />
        ))}
      </div>
    </section>
  );
}

export function EliteFourPanel({ progress, onBattle }: { progress: CampaignProgress; onBattle: (o: CampaignOpponent) => void }) {
  const locked = !progress.unlockedEliteFour;
  return (
    <section className={`panel elite-four-panel${locked ? ' elite-four-panel-locked' : ''}`}>
      <p className="eyebrow">Indigo Plateau · Elite Four</p>
      <h2>{locked ? '🔒 Earn all 8 badges to unlock' : 'The final tier before the Champion'}</h2>
      <div className="opponent-grid">
        {getEliteFour().map((opponent) => (
          <OpponentCard key={opponent.id} opponent={opponent} progress={progress} onBattle={onBattle} />
        ))}
      </div>
    </section>
  );
}

export function ChampionPanel({ progress, onBattle }: { progress: CampaignProgress; onBattle: (o: CampaignOpponent) => void }) {
  const champ = getChampion();
  const unlocked = isOpponentUnlocked(progress, champ);
  return (
    <section className={`panel champion-panel${unlocked ? ' champion-panel-unlocked' : ' champion-panel-locked'}`}>
      <p className="eyebrow">Pokémon League · Champion</p>
      <h2>{unlocked ? '👑 The final challenge' : '🔒 Defeat the Elite Four to challenge the Champion'}</h2>
      <div className="opponent-grid opponent-grid-champion">
        <OpponentCard opponent={champ} progress={progress} onBattle={onBattle} />
      </div>
    </section>
  );
}

export function CampaignRewardsPanel({ progress }: { progress: CampaignProgress }) {
  return (
    <section className="panel campaign-rewards-panel">
      <p className="eyebrow">Rewards earned</p>
      <div className="campaign-rewards-grid">
        <div className="campaign-reward">
          <strong>{progress.earnedBadges.length}</strong>
          <span>Badges</span>
        </div>
        <div className="campaign-reward">
          <strong>{progress.defeatedOpponents.length}</strong>
          <span>Opponents defeated</span>
        </div>
        <div className="campaign-reward">
          <strong>{progress.championDefeated ? 'Yes 👑' : 'Not yet'}</strong>
          <span>League Champion</span>
        </div>
      </div>
    </section>
  );
}

export function VictoryRewardModal({
  opponent,
  onDismiss,
}: {
  opponent: CampaignOpponent;
  onDismiss: () => void;
}) {
  return (
    <div className="wager-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Defeated ${opponent.name}`}>
      <div className="wager-modal victory-reward-modal">
        <p className="eyebrow">Victory!</p>
        <h2>You defeated {opponent.name}!</h2>
        <p className="wager-modal-sub">{opponent.victoryDialogue}</p>
        <div className="victory-badge-showcase" style={{ color: opponent.badge.color }}>
          <span className="victory-badge-emoji" style={{ textShadow: `0 0 20px ${opponent.badge.color}` }}>{opponent.badge.emoji}</span>
          <strong>{opponent.badge.name}</strong>
        </div>
        <p className="wager-modal-sub">🎁 Reward: {opponent.reward}</p>
        <div className="wager-modal-actions">
          <button className="primary-cta" onClick={onDismiss}>Continue</button>
        </div>
      </div>
    </div>
  );
}
