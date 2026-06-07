import type { PlayerID, PlayerState } from '../game/types';
import { shortAddr } from '../wallet';

/**
 * Trainer-style HUD card replacing the developer-style "Player 0"
 * labels. Renders the trainer name (or shortened wallet address),
 * an emoji avatar placeholder, deck/hand/prize/discard counters,
 * active Pokemon name + HP, and a turn indicator. Drives off
 * existing PlayerState — no schema changes.
 */
export function PlayerHUD({
  id,
  player,
  trainerName,
  walletAddress,
  isCurrentTurn,
  isSelf,
  position,
}: {
  id: PlayerID;
  player: PlayerState;
  trainerName?: string;
  walletAddress?: string;
  isCurrentTurn: boolean;
  isSelf: boolean;
  position: 'top' | 'bottom';
}) {
  const displayName = trainerName?.trim() || (walletAddress ? shortAddr(walletAddress) : `Trainer ${id}`);
  const active = player.active;
  const hpPct = active ? Math.max(0, Math.min(100, ((active.card.hp - active.damage) / active.card.hp) * 100)) : 0;
  const hpColor = hpPct > 60 ? '#22c55e' : hpPct > 30 ? '#facc15' : '#ef4444';
  const conditions = active?.conditions ?? [];
  const handCount = player.handCount ?? player.hand.length;
  const deckCount = player.deckCount ?? player.deck.length;
  const prizeCount = player.prizeCount ?? player.prizeCards.length;

  return (
    <div className={`player-hud player-hud-${position}${isCurrentTurn ? ' player-hud-active-turn' : ''}${isSelf ? ' player-hud-self' : ''}`}>
      <div className="player-hud-avatar" aria-hidden="true">
        {isSelf ? '🧢' : '👤'}
      </div>
      <div className="player-hud-body">
        <div className="player-hud-name-row">
          <strong className="player-hud-name">{displayName}{isSelf ? ' (you)' : ''}</strong>
          {isCurrentTurn && <span className="player-hud-turn-pill">● YOUR TURN</span>}
        </div>
        <div className="player-hud-active">
          {active ? (
            <>
              <span className="player-hud-active-name">{active.card.name}</span>
              <div className="player-hud-hp">
                <div className="player-hud-hp-bar">
                  <div className="player-hud-hp-fill" style={{ width: `${hpPct}%`, background: hpColor }} />
                </div>
                <span className="player-hud-hp-text">{Math.max(0, active.card.hp - active.damage)} / {active.card.hp} HP</span>
              </div>
              {conditions.length > 0 && (
                <div className="player-hud-conditions">
                  {conditions.map((c) => (
                    <span key={c} className={`hud-condition hud-condition-${c}`} title={c}>
                      {c === 'asleep' ? '💤' : c === 'burned' ? '🔥' : c === 'confused' ? '❓' : c === 'paralyzed' ? '⚡' : '☠'}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <span className="player-hud-active-name player-hud-active-empty">No Active Pokémon</span>
          )}
        </div>
        <div className="player-hud-counters">
          <span title="Hand">🃏 {handCount}</span>
          <span title="Deck">📚 {deckCount}</span>
          <span title="Prize cards remaining">🎁 {prizeCount}</span>
          <span title="Discard pile">🗑 {player.discard.length}</span>
        </div>
      </div>
    </div>
  );
}
