import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { BoardProps } from 'boardgame.io/react';
import { CardImage as SharedCardImage } from './components/CardImage';
import { MatchChatPanel } from './components/MatchChatPanel';
import { PLAYMAT_IMAGE_BY_ID } from './playmats';
import type { Card, PlayerID, PlayerState, PokemonInPlay, PokemonTCGState } from './game/types';
import { POKETCG_TOKEN_MINT, formatWager } from './game/types';

interface PokemonBoardProps extends BoardProps<PokemonTCGState> {
  onMatchComplete?: (payload: { reason?: string; winner?: PlayerID; winnerWallet?: string }) => void | Promise<void>;
  playerID: string | null;
  playerName?: string;
  playerWallet?: string;
  prizeClaim?: {
    alreadyClaimed: boolean;
    card: { id: string; name: string; rarity?: string; images?: { small?: string; large?: string } } | null;
    mint: { mintAddress: string; signature: string } | null;
  } | null;
  selectedDeck?: {
    cardIds: string[];
    label: string;
  };
}

const PLAYER_IDS: PlayerID[] = ['0', '1'];
const HAND_CARD_DRAG_TYPE = 'application/x-pokemon-hand-card';

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

function CardImage({
  card,
  frameClassName,
  imageClassName,
}: {
  card: Card;
  frameClassName: string;
  imageClassName: string;
}) {
  return <SharedCardImage card={card} className={frameClassName} imageClassName={imageClassName} />;
}

function CardArt({ card }: { card: Card }) {
  return <CardImage card={card} frameClassName="card-art-frame" imageClassName="card-art" />;
}

function HandCard({
  card,
  children,
  draggable = false,
  index,
  onDragStart,
  selected = false,
}: {
  card: Card;
  children?: React.ReactNode;
  draggable?: boolean;
  index: number;
  onDragStart?: (event: React.DragEvent<HTMLElement>) => void;
  selected?: boolean;
}) {
  return (
    <article
      className={`hand-card hand-card-${card.kind}${draggable ? ' hand-card-draggable' : ''}${selected ? ' hand-card-selected' : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      tabIndex={0}
    >
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

type DropZone = 'active' | 'bench' | 'stadium';

function MatZone({
  canDrop = false,
  className = '',
  onDrop,
  placement,
  children,
}: {
  canDrop?: boolean;
  className?: string;
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
  placement: ZonePlacement;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`mat-zone ${placement.rotate ? 'mat-zone-rotated' : ''} ${canDrop ? 'mat-zone-droppable' : ''} ${className}`}
      onDragOver={canDrop ? (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      } : undefined}
      onDrop={onDrop}
      style={zoneStyle(placement)}
    >
      {children}
    </div>
  );
}

function MatPokemonCard({ pokemon, label, previewCard }: { label: string; pokemon?: PokemonInPlay; previewCard?: Card }) {
  if (!pokemon) {
    if (previewCard) {
      return (
        <div className="mat-card mat-pokemon-card mat-card-preview">
          <CardImage card={previewCard} frameClassName="mat-card-art-frame" imageClassName="mat-card-image" />
          <span className="mat-card-badge">Ready</span>
        </div>
      );
    }
    return <div className="mat-card mat-card-empty">{label}</div>;
  }

  return (
    <div className="mat-card mat-pokemon-card">
      <CardImage card={pokemon.card} frameClassName="mat-card-art-frame" imageClassName="mat-card-image" />
      <div className="mat-card-badges">
        <span>{pokemon.damage}/{pokemon.card.hp}</span>
        <span>{pokemon.attachedEnergy.length} Energy</span>
      </div>
      {pokemon.attachedEnergy.length > 0 && (
        <div className="mat-attached-energy">
          {pokemon.attachedEnergy.slice(0, 4).map((energy, index) => (
            <img
              alt={energy.name}
              key={`${energy.id}-${index}`}
              src={energy.images?.small ?? energy.images?.large}
            />
          ))}
          {pokemon.attachedEnergy.length > 4 && <span>+{pokemon.attachedEnergy.length - 4}</span>}
        </div>
      )}
      {pokemon.conditions.length > 0 && <span>{pokemon.conditions.join(', ')}</span>}
    </div>
  );
}

function MatStack({ count, label, topCard }: { count: number; label: string; topCard?: Card }) {
  if (topCard) {
    return (
      <div className="mat-card mat-stack mat-stack-with-card">
        <CardImage card={topCard} frameClassName="mat-card-art-frame" imageClassName="mat-card-image" />
        <span className="mat-card-badge">{label}: {count}</span>
      </div>
    );
  }

  return (
    <div className={`mat-card mat-stack ${count === 0 ? 'mat-card-empty' : ''}`}>
      <strong>{label}</strong>
      <span>{count}</span>
    </div>
  );
}

function PlayerMatZones({
  canDrop = false,
  id,
  onDropToZone,
  player,
  setupPreview,
}: {
  canDrop?: boolean;
  id: PlayerID;
  onDropToZone?: (event: React.DragEvent<HTMLDivElement>, zone: DropZone, benchIndex?: number) => void;
  player: PlayerState;
  setupPreview?: {
    active?: Card;
    bench: Array<Card | undefined>;
  };
}) {
  const placements = PLAYER_MAT_PLACEMENTS[id];
  const prizeCount = player.prizeCount ?? player.prizeCards.length;

  return (
    <>
      <MatZone canDrop={canDrop} className="mat-zone-active" onDrop={(event) => onDropToZone?.(event, 'active')} placement={placements.active}>
        <MatPokemonCard pokemon={player.active} previewCard={setupPreview?.active} label={`P${id} Active`} />
      </MatZone>
      {placements.bench.map((placement, index) => (
        <MatZone canDrop={canDrop} className="mat-zone-bench" key={`${id}-bench-${index}`} onDrop={(event) => onDropToZone?.(event, 'bench', index)} placement={placement}>
          <MatPokemonCard pokemon={player.bench[index]} previewCard={setupPreview?.bench[index]} label={`Bench ${index + 1}`} />
        </MatZone>
      ))}
      <MatZone placement={placements.deck}>
        <MatStack count={player.deckCount ?? player.deck.length} label="Deck" />
      </MatZone>
      <MatZone placement={placements.discard}>
        <MatStack count={player.discard.length} label="Trash" topCard={player.discard.at(-1)} />
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

export function PokemonBoard({ chatMessages, G, ctx, moves, onMatchComplete, playerID, playerName, playerWallet, prizeClaim, selectedDeck, sendChatMessage }: PokemonBoardProps) {
  const actingPlayer = (playerID === '1' ? '1' : '0') as PlayerID;
  const player = G.players[actingPlayer];
  const isCurrent = ctx.currentPlayer === actingPlayer;
  const isSetup = ctx.phase === 'setup';
  const gameover = ctx.gameover as { winner?: PlayerID; reason?: string } | undefined;
  const [openingActiveIndex, setOpeningActiveIndex] = useState<number | null>(null);
  const [openingBenchIndexes, setOpeningBenchIndexes] = useState<Array<number | undefined>>([]);
  const [boardHint, setBoardHint] = useState('');
  const [wagerCopied, setWagerCopied] = useState(false);
  const [wagerDismissed, setWagerDismissed] = useState(false);
  const [prizeDismissed, setPrizeDismissed] = useState(false);
  const playmatImage = PLAYMAT_IMAGE_BY_ID[G.playmatId];
  const visibleDeckCount = player.deckCount ?? player.deck.length;
  const isLoadingSelectedDeck = Boolean(selectedDeck && isSetup && !player.ready && player.hand.length === 0 && visibleDeckCount === 0);
  const winnerWallet = gameover?.winner ? G.walletAddresses?.[gameover.winner] : undefined;
  const isWager = G.matchType === 'Wager' && G.wagerAmount > 0;
  const youWon = gameover?.winner === actingPlayer;
  const showPrize = Boolean(gameover && youWon && prizeClaim?.card && !prizeDismissed);

  // Forfeit guard: if the player closes the tab, navigates away, or clicks
  // Exit (which unmounts MatchClient → PokemonClient → PokemonBoard), fire
  // the concede move so the opponent is declared the winner. The cleanup
  // runs while the bgio socket is still open (React tears down children
  // before parents), so the move flushes to the server before disconnect.
  // Best-effort only — a hard network drop or browser kill can't deliver
  // the message; the opponent's client will sit waiting in that case.
  const concededRef = useRef(false);
  useEffect(() => {
    function handleUnload() {
      if (gameover || concededRef.current) return;
      concededRef.current = true;
      try { moves.concede(); } catch { /* ignore — page is going away */ }
    }
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      if (!gameover && !concededRef.current) {
        concededRef.current = true;
        try { moves.concede(); } catch { /* socket may already be tearing down */ }
      }
    };
  }, [gameover, moves]);

  useEffect(() => {
    if (gameover) {
      void onMatchComplete?.({ reason: gameover.reason, winner: gameover.winner, winnerWallet });
    }
  }, [gameover?.reason, gameover?.winner, onMatchComplete, winnerWallet]);

  useEffect(() => {
    if (!selectedDeck || !isSetup || player.ready || player.hand.length > 0 || visibleDeckCount > 0 || player.active || player.bench.length > 0) {
      return;
    }
    moves.setPlayerDeck(selectedDeck.cardIds, selectedDeck.label, playerWallet);
  }, [isSetup, moves, player.active, player.bench.length, player.hand.length, player.ready, playerWallet, selectedDeck, visibleDeckCount]);

  const toggleOpeningBench = (index: number) => {
    setOpeningBenchIndexes((current) => {
      if (current.includes(index)) {
        return current.map((existing) => existing === index ? undefined : existing);
      }
      const next = [...current];
      const openSlot = next.findIndex((existing) => existing === undefined);
      if (openSlot === -1 && next.length >= 5) {
        return current;
      }
      if (openSlot === -1) {
        next.push(index);
      } else {
        next[openSlot] = index;
      }
      return next;
    });
  };

  const confirmOpeningPokemon = () => {
    if (openingActiveIndex === null) {
      return;
    }
    moves.chooseOpeningPokemon(
      openingActiveIndex,
      openingBenchIndexes.filter((index): index is number => typeof index === 'number' && index !== openingActiveIndex),
    );
    setOpeningActiveIndex(null);
    setOpeningBenchIndexes([]);
  };

  const startHandDrag = (event: React.DragEvent<HTMLElement>, handIndex: number, card: Card) => {
    event.dataTransfer.effectAllowed = 'move';
    const payload = JSON.stringify({ cardId: card.id, handIndex });
    event.dataTransfer.setData(HAND_CARD_DRAG_TYPE, payload);
    event.dataTransfer.setData('text/plain', payload);
  };

  const draggedHandIndex = (event: React.DragEvent<HTMLElement>): number | null => {
    const payload = event.dataTransfer.getData(HAND_CARD_DRAG_TYPE) || event.dataTransfer.getData('text/plain');
    if (!payload) return null;
    try {
      const parsed = JSON.parse(payload) as { handIndex?: unknown };
      return typeof parsed.handIndex === 'number' ? parsed.handIndex : null;
    } catch {
      return null;
    }
  };

  const dropSetupCard = (handIndex: number, zone: DropZone, benchIndex?: number) => {
    const card = player.hand[handIndex];
    if (!card || card.kind !== 'pokemon' || card.stage !== 'Basic') {
      setBoardHint('Opening setup only accepts Basic Pokemon from your hand.');
      return;
    }
    if (zone === 'active') {
      setOpeningActiveIndex(handIndex);
      setOpeningBenchIndexes((current) => current.map((index) => index === handIndex ? undefined : index));
      setBoardHint(`${card.name} selected as Active. Confirm opening Pokemon when ready.`);
      return;
    }
    if (zone !== 'bench' || benchIndex === undefined) {
      setBoardHint('Drop Basic Pokemon on your Active or Bench spaces during setup.');
      return;
    }

    setOpeningActiveIndex((current) => current === handIndex ? null : current);
    setOpeningBenchIndexes((current) => {
      const next = Array.from({ length: Math.max(5, current.length) }, (_, index) => current[index]).map((index) => index === handIndex ? undefined : index);
      if (benchIndex >= 5) {
        return next;
      }
      next[benchIndex] = handIndex;
      return next;
    });
    setBoardHint(`${card.name} selected for the Bench. Confirm opening Pokemon when ready.`);
  };

  const dropPlayCard = (handIndex: number, zone: DropZone, benchIndex?: number) => {
    const card = player.hand[handIndex];
    if (!card || !isCurrent) {
      setBoardHint(`Wait for Player ${ctx.currentPlayer}'s turn before playing cards.`);
      return;
    }

    if (zone === 'stadium') {
      if (card.kind === 'trainer' && card.trainerType === 'Stadium') {
        moves.playTrainer(handIndex);
        setBoardHint(`Played ${card.name}.`);
      } else {
        setBoardHint('Only Stadium Trainer cards can be dropped on the Stadium spot.');
      }
      return;
    }

    if (card.kind === 'pokemon' && card.stage === 'Basic') {
      if (zone !== 'bench') {
        setBoardHint('Basic Pokemon can be dropped onto your Bench.');
        return;
      }
      moves.benchBasic(handIndex);
      setBoardHint(`Benched ${card.name}.`);
      return;
    }

    if (card.kind === 'pokemon') {
      moves.evolvePokemon(handIndex, zone, benchIndex);
      setBoardHint(`Attempted to evolve with ${card.name}.`);
      return;
    }

    if (card.kind === 'energy') {
      moves.attachEnergy(handIndex, zone, benchIndex);
      setBoardHint(`Attempted to attach ${card.name}.`);
      return;
    }

    moves.playTrainer(handIndex, zone === 'bench'
      ? { zone, benchIndex, switchBenchIndex: benchIndex }
      : { zone: 'active' });
    setBoardHint(`Played ${card.name}.`);
  };

  const dropHandCardOnZone = (event: React.DragEvent<HTMLDivElement>, targetPlayer: PlayerID, zone: DropZone, benchIndex?: number) => {
    event.preventDefault();
    if (targetPlayer !== actingPlayer && zone !== 'stadium') {
      setBoardHint('Drop cards only on your side of the playmat.');
      return;
    }
    const handIndex = draggedHandIndex(event);
    if (handIndex === null) {
      setBoardHint('Drag a card from your hand onto the playmat.');
      return;
    }
    if (isSetup) {
      dropSetupCard(handIndex, zone, benchIndex);
      return;
    }
    dropPlayCard(handIndex, zone, benchIndex);
  };

  const setupPreview = isSetup && !player.ready
    ? {
      active: openingActiveIndex === null ? undefined : player.hand[openingActiveIndex],
      bench: openingBenchIndexes.map((index) => typeof index === 'number' ? player.hand[index] : undefined),
    }
    : undefined;

  const handPanel = isSetup ? (
    <section className="actions hand-below-playmat">
      <h2>Opening setup</h2>
      {player.ready ? (
        <p>Player {actingPlayer} is ready. Switch viewers so the other player can choose their opening Pokemon.</p>
      ) : isLoadingSelectedDeck ? (
        <p>Loading {selectedDeck?.label} into this match...</p>
      ) : (
        <>
          <p>Drag one Basic Pokemon onto your Active spot and up to five more onto your Bench, then confirm.</p>
          {boardHint && <p className="drop-hint">{boardHint}</p>}
          <div className="hand-grid setup-hand-grid">
            {player.hand.map((card, index) => {
              const isOpeningBasic = card.kind === 'pokemon' && card.stage === 'Basic';
              return (
                <HandCard
                  card={card}
                  draggable={isOpeningBasic}
                  index={index}
                  key={`${card.id}-${index}`}
                  onDragStart={(event) => startHandDrag(event, index, card)}
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
  ) : !gameover ? (
    <section className="actions hand-below-playmat">
      <h2>Player {actingPlayer} hand</h2>
      {!isCurrent && <p>Waiting for Player {ctx.currentPlayer}.</p>}
      <p className="action-hint">Drag cards from your hand onto your Active, Bench, or Stadium spaces. Hover or focus any card image to inspect it larger.</p>
      {boardHint && <p className="drop-hint">{boardHint}</p>}
      <div className="action-group action-group-hand">
        {player.hand.length === 0 ? (
          <p>Your hand is empty.</p>
        ) : (
          <div className="hand-grid">
            {player.hand.map((card, index) => (
              <HandCard
                card={card}
                draggable={isCurrent}
                index={index}
                key={`${card.id}-${index}`}
                onDragStart={(event) => startHandDrag(event, index, card)}
              >
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
                            Evolve Bench {benchIndex + 1}
                          </button>
                        ))}
                      </>
                    )}
                    {card.kind === 'energy' && (
                      <>
                        <button onClick={() => moves.attachEnergy(index, 'active')}>Attach to Active</button>
                        {player.bench.map((benchPokemon, benchIndex) => (
                          <button key={benchPokemon.instanceId} onClick={() => moves.attachEnergy(index, 'bench', benchIndex)}>
                            Attach to Bench {benchIndex + 1}
                          </button>
                        ))}
                      </>
                    )}
                    {card.kind === 'trainer' && (
                      <>
                        <button onClick={() => moves.playTrainer(index, { zone: 'active' })}>Play</button>
                        {player.bench.map((benchPokemon, benchIndex) => (
                          <button key={benchPokemon.instanceId} onClick={() => moves.playTrainer(index, { zone: 'bench', benchIndex, switchBenchIndex: benchIndex })}>
                            Play on Bench {benchIndex + 1}
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
        <div className="action-group">
          <h3>Attack / retreat</h3>
          {player.active?.card.attacks.map((attack, index) => (
            <button key={attack.name} onClick={() => moves.attack(index)}>
              Attack: {attack.name}
            </button>
          ))}
          {player.bench.map((pokemon, index) => (
            <button key={pokemon.instanceId} onClick={() => moves.retreat(index)}>
              Retreat to Bench {index + 1}
            </button>
          ))}
          <button className="danger" onClick={() => moves.pass()}>Pass turn</button>
        </div>
      )}
    </section>
  ) : null;

  return (
    <main>
      <MatchChatPanel
        chatMessages={chatMessages}
        sendChatMessage={sendChatMessage}
        selfPlayerID={actingPlayer}
        selfName={playerName}
        opponentName={G.deckLabels?.[actingPlayer === '0' ? '1' : '0']}
      />
      <header className="hero">
        <div>
          <h1>{G.matchName}</h1>
          <p>
            <span className={`match-type-badge match-type-badge-${G.matchType}`}>{G.matchType}</span>
            {' '}Phase <strong>{ctx.phase ?? 'play'}</strong>
            {' · '}Current turn <strong>P{ctx.currentPlayer}</strong>
            {' · '}Playmat <strong>{G.playmatId}</strong>
          </p>
          <p>Viewing as Player {actingPlayer}. Hidden hands, decks, and Prize cards are filtered by boardgame.io playerView.</p>
        </div>
        {G.stadium && <div className="stadium">Stadium: {G.stadium.card.name}</div>}
      </header>

      {gameover && (
        <section className="gameover">
          {gameover.winner !== undefined ? `Player ${gameover.winner} wins.` : 'Match ended in a draw.'} {gameover.reason}
        </section>
      )}

      {gameover && isWager && !wagerDismissed && (
        <div className="wager-modal-backdrop" role="dialog" aria-modal="true" aria-label="Wager settlement">
          <div className="wager-modal">
            <p className="eyebrow">Wager settlement</p>
            <h2>
              {gameover.winner === undefined
                ? 'Match drew — refund both sides.'
                : gameover.winner === actingPlayer
                  ? `You won ${formatWager(G.wagerAmount, G.wagerCurrency)}!`
                  : `You owe ${formatWager(G.wagerAmount, G.wagerCurrency)}.`}
            </h2>
            <p className="wager-modal-sub">
              The app does not escrow funds — settle the wager off-app by sending {G.wagerCurrency === 'POKETCG' ? '$POKETCG' : 'SOL'} to the winner's wallet below.
            </p>
            {G.wagerCurrency === 'POKETCG' && (
              <p className="wager-modal-sub">
                <strong>$POKETCG token mint:</strong> <code title={POKETCG_TOKEN_MINT}>{POKETCG_TOKEN_MINT}</code>
              </p>
            )}
            {winnerWallet ? (
              <div className="wager-modal-wallet">
                <span>Winner wallet</span>
                <code title={winnerWallet}>{winnerWallet}</code>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(winnerWallet);
                      setWagerCopied(true);
                      window.setTimeout(() => setWagerCopied(false), 2000);
                    } catch {
                      setWagerCopied(false);
                    }
                  }}
                >
                  {wagerCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            ) : (
              <p className="error">Winner did not register a wallet during setup. Coordinate the payout manually.</p>
            )}
            <div className="wager-modal-actions">
              {winnerWallet && (
                <a
                  className="primary-cta"
                  href={`https://solscan.io/account/${winnerWallet}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Solscan ↗
                </a>
              )}
              <button onClick={() => setWagerDismissed(true)}>Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {showPrize && prizeClaim?.card && (
        <div className="wager-modal-backdrop" role="dialog" aria-modal="true" aria-label="Prize card unlocked">
          <div className="wager-modal prize-modal">
            <p className="eyebrow">🎁 Prize card unlocked</p>
            <h2>You won {prizeClaim.card.name}!</h2>
            <p className="wager-modal-sub">
              One free card per match win — added straight to your collection{prizeClaim.mint ? ' and minted as an NFT to your wallet' : ''}.
              {prizeClaim.card.rarity ? ` Rarity: ${prizeClaim.card.rarity}.` : ''}
            </p>
            {prizeClaim.card.images?.large || prizeClaim.card.images?.small ? (
              <img
                alt={prizeClaim.card.name}
                className="prize-modal-card"
                src={prizeClaim.card.images.large || prizeClaim.card.images.small}
              />
            ) : null}
            <div className="wager-modal-actions">
              {prizeClaim.mint?.signature && (
                <a
                  className="primary-cta"
                  href={`https://solscan.io/tx/${prizeClaim.mint.signature}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View mint on Solscan ↗
                </a>
              )}
              <button onClick={() => setPrizeDismissed(true)}>Awesome</button>
            </div>
          </div>
        </div>
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
          <PlayerMatZones
            canDrop={id === actingPlayer && (isSetup ? !player.ready : isCurrent)}
            key={id}
            id={id}
            onDropToZone={(event, zone, benchIndex) => dropHandCardOnZone(event, id, zone, benchIndex)}
            player={G.players[id]}
            setupPreview={id === actingPlayer ? setupPreview : undefined}
          />
        ))}
        <MatZone
          canDrop={!isSetup && isCurrent}
          className="mat-zone-stadium"
          onDrop={(event) => dropHandCardOnZone(event, actingPlayer, 'stadium')}
          placement={STADIUM_PLACEMENT}
        >
          <MatStack count={G.stadium ? 1 : 0} label={G.stadium?.card.name ?? 'Stadium'} topCard={G.stadium?.card} />
        </MatZone>
      </section>

      {handPanel}

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
