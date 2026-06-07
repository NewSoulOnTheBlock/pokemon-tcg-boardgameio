import { useState } from 'react';

/**
 * Collapsible right-side battle log. Groups log lines into rough
 * "events" using simple keyword heuristics so important happenings
 * (knockouts, prize claims, attacks) get colour-coded styling. Pulls
 * directly from G.log[]; no new state needed.
 */
const HIGHLIGHT_RULES: Array<{ test: RegExp; className: string; icon: string }> = [
  { test: /knock(ed)? out|fainted/i, className: 'log-line-knockout', icon: '💥' },
  { test: /prize card/i, className: 'log-line-prize', icon: '🎁' },
  { test: /attack|used /i, className: 'log-line-attack', icon: '⚔' },
  { test: /attached|attach /i, className: 'log-line-energy', icon: '⚡' },
  { test: /evolved/i, className: 'log-line-evolve', icon: '✨' },
  { test: /drew for turn|drew \d+ card/i, className: 'log-line-draw', icon: '📥' },
  { test: /supporter|youngster|professor/i, className: 'log-line-supporter', icon: '🎓' },
  { test: /forfeit|left the match/i, className: 'log-line-forfeit', icon: '🏳' },
  { test: /retreated/i, className: 'log-line-retreat', icon: '↩' },
];

function classifyLine(line: string): { className: string; icon: string } {
  for (const rule of HIGHLIGHT_RULES) {
    if (rule.test.test(line)) return { className: rule.className, icon: rule.icon };
  }
  return { className: 'log-line-default', icon: '•' };
}

export function BattleLogSidebar({
  log,
  turn,
  currentPlayer,
  phase,
}: {
  log: string[];
  turn: number;
  currentPlayer: string;
  phase: string;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`battle-log-sidebar${collapsed ? ' battle-log-sidebar-collapsed' : ''}`}>
      <button
        type="button"
        className="battle-log-toggle"
        aria-label={collapsed ? 'Open battle log' : 'Collapse battle log'}
        onClick={() => setCollapsed((c) => !c)}
      >
        {collapsed ? '◀ Log' : '▶ Hide'}
      </button>
      {!collapsed && (
        <>
          <div className="battle-log-header">
            <p className="eyebrow">Battle log</p>
            <div className="battle-log-meta">
              <span>Phase: <strong>{phase}</strong></span>
              <span>Turn: <strong>{turn}</strong></span>
              <span>Acting: <strong>P{currentPlayer}</strong></span>
            </div>
          </div>
          <ol className="battle-log-list">
            {log.length === 0 ? (
              <li className="battle-log-empty">Match just started.</li>
            ) : (
              log.map((line, index) => {
                const { className, icon } = classifyLine(line);
                return (
                  <li key={`${line}-${index}`} className={`battle-log-line ${className}`}>
                    <span className="battle-log-icon" aria-hidden="true">{icon}</span>
                    <span>{line}</span>
                  </li>
                );
              })
            )}
          </ol>
        </>
      )}
    </aside>
  );
}
