import type { Attack, PlayerState } from '../game/types';
import { canPayEnergyCost } from '../game/rules';

/**
 * Persistent bottom action bar. Surfaces the attack moves of the
 * current active Pokemon (greyed out when insufficient energy), the
 * retreat options against current bench, and the End Turn button.
 * Driven entirely from the existing game state + moves API; the
 * per-card action buttons in FanHand remain authoritative for playing
 * specific cards.
 */
export function ActionBar({
  player,
  isCurrent,
  isFirstTurnAttackBlocked,
  canRetreat,
  onAttack,
  onRetreat,
  onPass,
  onConcede,
}: {
  player: PlayerState;
  isCurrent: boolean;
  isFirstTurnAttackBlocked: boolean;
  canRetreat: boolean;
  onAttack: (attackIndex: number) => void;
  onRetreat: (benchIndex: number) => void;
  onPass: () => void;
  onConcede: () => void;
}) {
  const active = player.active;
  const attacks = active?.card.attacks ?? [];
  const blockedBecauseCondition = active?.conditions.includes('asleep') || active?.conditions.includes('paralyzed');

  return (
    <div className={`action-bar${isCurrent ? '' : ' action-bar-waiting'}`}>
      <div className="action-bar-section action-bar-attacks">
        <span className="action-bar-label">Attack</span>
        {attacks.length === 0 ? (
          <span className="action-bar-empty">No active Pokémon</span>
        ) : attacks.map((attack: Attack, index) => {
          const affordable = active ? canPayEnergyCost(active.attachedEnergy, attack.cost) : false;
          const disabled = !isCurrent || isFirstTurnAttackBlocked || blockedBecauseCondition || !affordable;
          return (
            <button
              key={attack.name}
              className="action-button action-button-attack"
              disabled={disabled}
              onClick={() => onAttack(index)}
              title={disabled
                ? (!isCurrent ? 'Not your turn' : isFirstTurnAttackBlocked ? "Can't attack on turn 1" : blockedBecauseCondition ? 'Active is Asleep / Paralyzed' : !affordable ? 'Not enough energy attached' : '')
                : `${attack.name}${attack.damage ? ` for ${attack.damage} damage` : ''}`}
            >
              ⚔ {attack.name}{attack.damage ? ` · ${attack.damage}` : ''}
            </button>
          );
        })}
      </div>
      <div className="action-bar-section action-bar-retreat">
        <span className="action-bar-label">Retreat</span>
        {!active || player.bench.length === 0 ? (
          <span className="action-bar-empty">No bench Pokémon</span>
        ) : player.bench.map((benched, index) => (
          <button
            key={benched.instanceId}
            className="action-button action-button-retreat"
            disabled={!isCurrent || !canRetreat || blockedBecauseCondition}
            onClick={() => onRetreat(index)}
            title={!isCurrent ? 'Not your turn' : !canRetreat ? 'Already retreated this turn or no energy' : blockedBecauseCondition ? 'Active is Asleep / Paralyzed' : `Switch to ${benched.card.name}`}
          >
            ↩ {benched.card.name}
          </button>
        ))}
      </div>
      <div className="action-bar-section action-bar-end">
        <button
          className="action-button action-button-end-turn"
          disabled={!isCurrent}
          onClick={onPass}
          title={isCurrent ? 'End your turn' : 'Not your turn'}
        >
          End Turn
        </button>
        <button
          className="action-button action-button-forfeit"
          onClick={() => {
            if (typeof window !== 'undefined' && window.confirm('Forfeit the match? Your opponent will win by walkover.')) {
              onConcede();
            }
          }}
        >
          🏳 Forfeit
        </button>
      </div>
    </div>
  );
}
