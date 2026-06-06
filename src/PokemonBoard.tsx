import { type CSSProperties, useEffect, useState } from 'react';
import type { BoardProps } from 'boardgame.io/react';
import { PLAYMAT_IMAGE_BY_ID } from './playmats';
import type { Card, PlayerID, PlayerState, PokemonInPlay, PokemonTCGState } from './game/types';

interface PokemonBoardProps extends BoardProps<PokemonTCGState> {
  onMatchComplete?: (payload: { reason?: string; winner?: PlayerID }) => void | Promise<void>;
  playerID: string | null;
}

const PLAYER_IDS: PlayerID[] = ['0', '1'];

interface ZonePlacement {
  left: number;
  top: number;
  width: number;
  height: number;
  rotate?: number;
}

interface PlayerMatPlacements {
  active: ZonePlacement;
  bench: ZonePlacement[];
  deck: ZonePlacement;
  discard: ZonePlacement;
  prizes: ZonePlacement[];
}

const cardZone = (left: number, top: number, rotate = 0): ZonePlacement => ({
  left,
  top,
  width: 9.2,
  height: 12.4,
  rotate,
});

const PLAYER_MAT_PLACEMENTS: Record<PlayerID, PlayerMatPlacements> = {
  '0': {
    active: cardZone(45.4, 56),
    bench: [23.4, 34.4, 45.5, 56.4, 67.5].map((left) => cardZone(left, 76.1)),
    deck: cardZone(81.8, 59.6),
    discard: cardZone(81.8, 73.5),
    prizes: [49.8, 62.4, 74.7].map((top) => cardZone(11.4, top)),
  },
  '1': {
    active: cardZone(45.4, 31.4, 180),
    bench: [23.4, 34.4, 45.5, 56.4, 67.5].map((left) => cardZone(left, 11.3, 180)),
    deck: cardZone(9.4, 28.3, 180),
    discard: cardZone(9.4, 14.3, 180),
    prizes: [12.3, 24.8, 37.4].map((top) => cardZone(79.7, top, 180)),
  },
};

const STADIUM_PLACEMENT: ZonePlacement = {
  left: 66.8,
  top: 55.8,
  width: 10,
  height: 6.2,
};

function cardLabel(card: Card): string {
  if (card.kind === 'pokemon') {
    return `${card.name} (${card.stage}, ${card.hp} HP)`;
  }
  if (card.kind === 'energy') {
    return card.name;
  }
  return `${card.name} (${card.trainerType})`;
}

function cardDetail(card: Card): string {
  if (card.kind === 'pokemon') {
    return `${card.stage} ${card.pokemonType} / ${card.hp} HP`;
  }
  if (card.kind === 'energy') {
    return `${card.energyType} Energy`;
  }
  return card.trainerType;
}

function CardArt({ card }: { card: Card }) {
  const thumbnail = card.images?.small ?? card.images?.large;
  const preview = card.images?.large ?? card.images?.small;

  if (!thumbnail) {
    return (
      <div className="card-art-placeholder" aria-label={card.name}>
        <strong>{card.name}</strong>
        <span>{card.kind}</span>
      </div>
    );
  }

  return (
    <div className="card-art-frame">
      <img className="card-art" src={thumbnail} alt={card.name} loading="lazy" />
      {preview && (
        <div className="card-hover-preview" aria-hidden="true">
          <img src={preview} alt="" loading="lazy" />
        </div>
      )}
    </div>
  );
}

function HandCard({
  card,
  children,
  index,
  selected = false,
}: {
  card: Card;
  children?: React.ReactNode;
  index: number;
  selected?: boolean;
}) {
  return (
    <article className={`hand-card hand-card-${card.kind}${selected ? ' hand-card-selected' : ''}`} tabIndex={0}>
      <CardArt card={card} />
      <div className="hand-card-info">
        <span className="hand-card-index">Hand #{index + 1}</span>
        <strong title={cardLabel(card)}>{card.name}</strong>
        <span>{cardDetail(card)}</span>
      </div>
      {children && <div className="hand-card-actions">{children}</div>}
    </article>
  );
}

function PokemonPanel({ pokemon }: { pokemon?: PokemonInPlay }) {
  if (!pokemon) {
    return <div className="pokemon empty">No Pokemon</div>;
  }

  return (
    <div className="pokemon">
      <strong>{pokemon.card.name}</strong>
      <span>{pokemon.card.stage} / {pokemon.card.pokemonType}</span>
      <span>{pokemon.damage}/{pokemon.card.hp} damage</span>
      <span>Energy: {pokemon.attachedEnergy.map((energy) => energy.energyType).join(', ') || 'none'}</span>
      <span>Retreat: {pokemon.card.retreatCost}</span>
      {pokemon.tool && <span>Tool: {pokemon.tool.name}</span>}
      {pokemon.conditions.length > 0 && <span>Conditions: {pokemon.conditions.join(', ')}</span>}
      <div className="attacks">
        {pokemon.card.attacks.map((attack) => (
          <span key={attack.name}>
            {attack.name}: {attack.cost.join('+') || 'free'} {attack.damage !== undefined ? `- ${attack.damage}` : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

function zoneStyle(zone: ZonePlacement): CSSProperties {
  return {
    left: `${zone.left}%`,
    top: `${zone.top}%`,
    width: `${zone.width}%`,
    height: `${zone.height}%`,
    transform: zone.rotate ? `rotate(${zone.rotate}deg)` : undefined,
  };
}

function prizeStackCount(totalPrizeCount: number, slotIndex: number): number {
  const baseCount = Math.floor(totalPrizeCount / 3);
  const extraCount = totalPrizeCount % 3;
  return baseCount + (slotIndex < extraCount ? 1 : 0);
}

function MatZone({ className = '', placement, children }: { className?: string; placement: ZonePlacement; children: React.ReactNode }) {
  return (
    <div className={`mat-zone ${className}`} style={zoneStyle(placement)}>
      {children}
    </div>
  );
}

function MatPokemonCard({ pokemon, label }: { pokemon?: PokemonInPlay; label: string }) {
  if (!pokemon) {
    return <div className="mat-card mat-card-empty">{label}</div>;
  }

  return (
    <div className="mat-card mat-pokemon-card">
      <strong>{pokemon.card.name}</strong>
      <span>{pokemon.damage}/{pokemon.card.hp} dmg</span>
      <span>Energy {pokemon.attachedEnergy.length}</span>
      {pokemon.conditions.length > 0 && <span>{pokemon.conditions.join(', ')}</span>}
    </div>
  );
}

function MatStack({ count, label }: { count: number; label: string }) {
  return (
    <div className={`mat-card mat-stack ${count === 0 ? 'mat-card-empty' : ''}`}>
      <strong>{label}</strong>
      <span>{count}</span>
    </div>
  );
}

function PlayerMatZones({ id, player }: { id: PlayerID; player: PlayerState }) {
  const placements = PLAYER_MAT_PLACEMENTS[id];
  const prizeCount = player.prizeCount ?? player.prizeCards.length;

  return (
    <>
      <MatZone className="mat-zone-active" placement={placements.active}>
        <MatPokemonCard pokemon={player.active} label={`P${id} Active`} />
      </MatZone>
      {placements.bench.map((placement, index) => (
        <MatZone className="mat-zone-bench" key={`${id}-bench-${index}`} placement={placement}>
          <MatPokemonCard pokemon={player.bench[index]} label={`Bench ${index + 1}`} />
        </MatZone>
      ))}
      <MatZone placement={placements.deck}>
        <MatStack count={player.deckCount ?? player.deck.length} label="Deck" />
      </MatZone>
      <MatZone placement={placements.discard}>
        <MatStack count={player.discard.length} label="Trash" />
      </MatZone>
      {placements.prizes.map((placement, index) => (
        <MatZone className="mat-zone-prize" key={`${id}-prize-${index}`} placement={placement}>
          <MatStack count={prizeStackCount(prizeCount, index)} label="Side" />
        </MatZone>
      ))}
    </>
  );
}

function PlayerSummary({ id, player }: { id: PlayerID; player: PlayerState }) {
  return (
    <section className="player-summary">
      <h3>Player {id}</h3>
      <div className="zone-stats">
        <span>Deck: {player.deckCount ?? player.deck.length}</span>
        <span>Hand: {player.handCount ?? player.hand.length}</span>
        <span>Prizes: {player.prizeCount ?? player.prizeCards.length}</span>
        <span>Discard: {player.discard.length}</span>
      </div>
    </section>
  );
}

export function PokemonBoard({ G, ctx, moves, onMatchComplete, playerID }: PokemonBoardProps) {
  const actingPlayer = (playerID === '1' ? '1' : '0') as PlayerID;
  const player = G.players[actingPlayer];
  const isCurrent = ctx.currentPlayer === actingPlayer;
  const isSetup = ctx.phase === 'setup';
  const gameover = ctx.gameover as { winner?: PlayerID; reason?: string } | undefined;
  const [openingActiveIndex, setOpeningActiveIndex] = useState<number | null>(null);
  const [openingBenchIndexes, setOpeningBenchIndexes] = useState<number[]>([]);
  const playmatImage = PLAYMAT_IMAGE_BY_ID[G.playmatId];

  useEffect(() => {
    if (gameover) {
      void onMatchComplete?.({ reason: gameover.reason, winner: gameover.winner });
    }
  }, [gameover?.reason, gameover?.winner, onMatchComplete]);

  const toggleOpeningBench = (index: number) => {
    setOpeningBenchIndexes((current) => {
      if (current.includes(index)) {
        return current.filter((existing) => existing !== index);
      }
      if (current.length >= 5) {
        return current;
      }
      return [...current, index];
    });
  };

  const confirmOpeningPokemon = () => {
    if (openingActiveIndex === null) {
      return;
    }
    moves.chooseOpeningPokemon(
      openingActiveIndex,
      openingBenchIndexes.filter((index) => index !== openingActiveIndex),
    );
    setOpeningActiveIndex(null);
    setOpeningBenchIndexes([]);
  };

  return (
    <main>
      <header className="hero">
        <div>
          <h1>Pokemon TCG Rules Engine</h1>
          <p>Phase: {ctx.phase ?? 'none'} | Current player: {ctx.currentPlayer} | Playmat: {G.playmatId}</p>
          <p>Viewing as Player {actingPlayer}. Hidden hands, decks, and Prize cards are filtered by boardgame.io playerView.</p>
        </div>
        {G.stadium && <div className="stadium">Stadium: {G.stadium.name}</div>}
      </header>

      {gameover && (
        <section className="gameover">
          Player {gameover.winner} wins. {gameover.reason}
        </section>
      )}

      {isSetup && (
        <section className="actions">
          <h2>Opening setup</h2>
          {player.ready ? (
            <p>Player {actingPlayer} is ready. Switch viewers so the other player can choose their opening Pokemon.</p>
          ) : (
            <>
              <p>Choose exactly one Basic Pokemon as Active and up to five more Basic Pokemon for the Bench.</p>
              <div className="hand-grid setup-hand-grid">
                {player.hand.map((card, index) => {
                  const isOpeningBasic = card.kind === 'pokemon' && card.stage === 'Basic';
                  return (
                    <HandCard
                      card={card}
                      index={index}
                      key={`${card.id}-${index}`}
                      selected={openingActiveIndex === index || openingBenchIndexes.includes(index)}
                    >
                      {isOpeningBasic ? (
                        <>
                          <button onClick={() => setOpeningActiveIndex(index)}>
                            {openingActiveIndex === index ? 'Active selected' : 'Set Active'}
                          </button>
                          <button onClick={() => toggleOpeningBench(index)} disabled={openingActiveIndex === index}>
                            {openingBenchIndexes.includes(index) ? 'Remove from Bench' : 'Bench'}
                          </button>
                        </>
                      ) : (
                        <span className="hand-card-note">Not a Basic Pokemon</span>
                      )}
                    </HandCard>
                  );
                })}
              </div>
              <button disabled={openingActiveIndex === null} onClick={confirmOpeningPokemon}>
                Confirm opening Pokemon
              </button>
            </>
          )}
        </section>
      )}

      {!isSetup && !gameover && (
        <section className="actions">
          <h2>Match hand and turn actions for Player {actingPlayer}</h2>
          {!isCurrent && <p>Waiting for Player {ctx.currentPlayer}.</p>}
          <div className="action-group action-group-hand">
            <h3>Your visible hand</h3>
            <p className="action-hint">Hover or focus a card image to inspect the larger card art.</p>
            {player.hand.length === 0 ? (
              <p>Your hand is empty.</p>
            ) : (
              <div className="hand-grid">
                {player.hand.map((card, index) => (
                  <HandCard card={card} index={index} key={`${card.id}-${index}`}>
                    {isCurrent && (
                      <>
                        {card.kind === 'pokemon' && card.stage === 'Basic' && (
                          <button onClick={() => moves.benchBasic(index)}>Bench Basic</button>
                        )}
                        {card.kind === 'pokemon' && card.stage !== 'Basic' && (
                          <>
                            <button onClick={() => moves.evolvePokemon(index, 'active')}>Evolve Active</button>
                            {player.bench.map((benchPokemon, benchIndex) => (
                              <button key={benchPokemon.instanceId} onClick={() => moves.evolvePokemon(index, 'bench', benchIndex)}>
                                Evolve Bench {benchIndex}
                              </button>
                            ))}
                          </>
                        )}
                        {card.kind === 'energy' && (
                          <>
                            <button onClick={() => moves.attachEnergy(index, 'active')}>Attach to Active</button>
                            {player.bench.map((benchPokemon, benchIndex) => (
                              <button key={benchPokemon.instanceId} onClick={() => moves.attachEnergy(index, 'bench', benchIndex)}>
                                Attach to Bench {benchIndex}
                              </button>
                            ))}
                          </>
                        )}
                        {card.kind === 'trainer' && (
                          <>
                            <button onClick={() => moves.playTrainer(index, { zone: 'active' })}>Play</button>
                            {player.bench.map((benchPokemon, benchIndex) => (
                              <button key={benchPokemon.instanceId} onClick={() => moves.playTrainer(index, { zone: 'bench', benchIndex, switchBenchIndex: benchIndex })}>
                                Play on Bench {benchIndex}
                              </button>
                            ))}
                          </>
                        )}
                      </>
                    )}
                  </HandCard>
                ))}
              </div>
            )}
          </div>

          {isCurrent && (
            <>
              <div className="action-group">
                <h3>Attack / retreat</h3>
                {player.active?.card.attacks.map((attack, index) => (
                  <button key={attack.name} onClick={() => moves.attack(index)}>
                    Attack: {attack.name}
                  </button>
                ))}
                {player.bench.map((pokemon, index) => (
                  <button key={pokemon.instanceId} onClick={() => moves.retreat(index)}>
                    Retreat to Bench {index}
                  </button>
                ))}
                <button className="danger" onClick={() => moves.pass()}>Pass turn</button>
              </div>
            </>
          )}
        </section>
      )}

      <div className="player-summaries">
        {PLAYER_IDS.map((id) => (
          <PlayerSummary key={id} id={id} player={G.players[id]} />
        ))}
      </div>

      <section
        aria-label={`Pokemon playmat: ${G.playmatId}`}
        className="match-playmat"
        style={{ backgroundImage: `url(${playmatImage})` }}
      >
        {PLAYER_IDS.map((id) => (
          <PlayerMatZones key={id} id={id} player={G.players[id]} />
        ))}
        <MatZone className="mat-zone-stadium" placement={STADIUM_PLACEMENT}>
          <MatStack count={G.stadium ? 1 : 0} label={G.stadium?.name ?? 'Stadium'} />
        </MatZone>
      </section>

      <section className="log">
        <h2>Game log</h2>
        <ol>
          {G.log.map((line, index) => (
            <li key={`${line}-${index}`}>{line}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}
