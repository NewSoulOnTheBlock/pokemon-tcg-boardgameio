import type { Game, Move } from 'boardgame.io';
import { INVALID_MOVE, Stage, TurnOrder } from 'boardgame.io/dist/cjs/core.js';
import { chooseRandomPlaymatId } from '../playmats';
import { DEFAULT_DECK_0, DEFAULT_DECK_1, makeDeck } from './cards';
import type { Card, PlayerID, PokemonTCGSetupData, PokemonTCGState } from './types';
import {
  addCondition,
  appendLog,
  applyDamage,
  applyMulliganBonus,
  beginPlayerTurn,
  canPayEnergyCost,
  checkAllKnockOuts,
  clearSpecialConditions,
  createPokemonInPlay,
  drawCards,
  ensurePlayer,
  getTarget,
  heal,
  isBasicPokemon,
  isEnergy,
  isFirstTurnAttackBlocked,
  isPokemon,
  isTrainer,
  opponentOf,
  publicViewForPlayer,
  removeFromHand,
  resetTurnFlags,
  resolveAttackEffect,
  resolvePokemonCheckup,
  validateEvolution,
} from './rules';

function makePlayer(deck: Card[]): PokemonTCGState['players'][PlayerID] {
  return {
    deck,
    hand: [],
    discard: [],
    lostZone: [],
    prizeCards: [],
    bench: [],
    ready: false,
    mulligans: 0,
    energyAttachedThisTurn: false,
    supporterPlayedThisTurn: false,
    stadiumPlayedThisTurn: false,
    retreatedThisTurn: false,
    vstarUsed: false,
    gxUsed: false,
  };
}

function drawOpeningHandWithMulligans(player: ReturnType<typeof makePlayer>, shuffle: (deck: Card[]) => Card[]): void {
  while (true) {
    drawCards(player, 7);
    if (player.hand.some(isBasicPokemon)) {
      return;
    }

    player.deck.push(...player.hand);
    player.deck = shuffle(player.deck);
    player.hand = [];
    player.mulligans += 1;
  }
}

function playerHasSelectedDeck(player: ReturnType<typeof makePlayer>): boolean {
  return player.ready
    || player.deck.length > 0
    || player.hand.length > 0
    || player.discard.length > 0
    || player.prizeCards.length > 0
    || player.bench.length > 0
    || Boolean(player.active);
}

const setPlayerDeck: Move<PokemonTCGState> = ({ G, random, playerID }, cardIds: string[], label: string, walletAddress?: string) => {
  const pid = ensurePlayer(playerID);
  if (!pid || !Array.isArray(cardIds) || cardIds.length === 0) return INVALID_MOVE;

  const player = G.players[pid];
  if (playerHasSelectedDeck(player)) return INVALID_MOVE;

  const deck = makeDeck(cardIds);
  if (!deck.some(isBasicPokemon)) return INVALID_MOVE;

  player.deck = random.Shuffle(deck);
  drawOpeningHandWithMulligans(player, random.Shuffle);
  G.deckLabels[pid] = label.trim() || `Player ${pid} deck`;
  if (walletAddress) {
    G.walletAddresses[pid] = walletAddress;
  }
  appendLog(G, `Player ${pid} selected ${G.deckLabels[pid]}.`);
};

const chooseOpeningPokemon: Move<PokemonTCGState> = ({ G, ctx, playerID }, activeHandIndex: number, benchHandIndexes: number[] = []) => {
  const pid = ensurePlayer(playerID);
  if (!pid) return INVALID_MOVE;

  const player = G.players[pid];
  if (player.ready) return INVALID_MOVE;

  const uniqueBenchIndexes = [...new Set(benchHandIndexes)].sort((a, b) => b - a);
  if (uniqueBenchIndexes.length > 5) return INVALID_MOVE;
  if (uniqueBenchIndexes.includes(activeHandIndex)) return INVALID_MOVE;

  const activeCard = player.hand[activeHandIndex];
  if (!isBasicPokemon(activeCard)) return INVALID_MOVE;

  const benchCards = uniqueBenchIndexes.map((index) => player.hand[index]);
  for (const index of uniqueBenchIndexes) {
    if (!isBasicPokemon(player.hand[index])) return INVALID_MOVE;
  }

  player.active = createPokemonInPlay(G, activeCard, ctx.turn);

  const indexesToRemove = [activeHandIndex, ...uniqueBenchIndexes].sort((a, b) => b - a);
  for (const index of indexesToRemove) {
    player.hand.splice(index, 1);
  }

  for (const card of benchCards) {
    if (isBasicPokemon(card)) {
      player.bench.push(createPokemonInPlay(G, card, ctx.turn));
    }
  }

  for (let i = 0; i < 6; i += 1) {
    const prize = player.deck.shift();
    if (prize) {
      player.prizeCards.push(prize);
    }
  }

  player.ready = true;
  appendLog(G, `Player ${pid} chose ${player.active.card.name} as their Active Pokemon.`);
};

const benchBasic: Move<PokemonTCGState> = ({ G, ctx, playerID }, handIndex: number) => {
  const pid = ensurePlayer(playerID);
  if (!pid || ctx.currentPlayer !== pid) return INVALID_MOVE;

  const player = G.players[pid];
  if (player.bench.length >= 5) return INVALID_MOVE;

  const card = removeFromHand(player, handIndex);
  if (!isBasicPokemon(card)) return INVALID_MOVE;

  player.bench.push(createPokemonInPlay(G, card, ctx.turn));
  appendLog(G, `Player ${pid} benched ${card.name}.`);
};

const evolvePokemon: Move<PokemonTCGState> = ({ G, ctx, playerID }, handIndex: number, zone: 'active' | 'bench', benchIndex?: number) => {
  const pid = ensurePlayer(playerID);
  if (!pid || ctx.currentPlayer !== pid) return INVALID_MOVE;

  const player = G.players[pid];
  const card = removeFromHand(player, handIndex);
  const target = getTarget(player, zone, benchIndex);

  if (!isPokemon(card) || !target) return INVALID_MOVE;
  const invalidReason = validateEvolution(target, card, ctx, G.turnsTaken[pid]);
  if (invalidReason) return INVALID_MOVE;

  target.evolution.push(card);
  target.card = card;
  target.evolvedTurn = ctx.turn;
  clearSpecialConditions(target);
  appendLog(G, `Player ${pid} evolved into ${card.name}.`);
};

const attachEnergy: Move<PokemonTCGState> = ({ G, ctx, playerID }, handIndex: number, zone: 'active' | 'bench', benchIndex?: number) => {
  const pid = ensurePlayer(playerID);
  if (!pid || ctx.currentPlayer !== pid) return INVALID_MOVE;

  const player = G.players[pid];
  if (player.energyAttachedThisTurn) return INVALID_MOVE;

  const card = removeFromHand(player, handIndex);
  const target = getTarget(player, zone, benchIndex);
  if (!isEnergy(card) || !target) return INVALID_MOVE;

  target.attachedEnergy.push(card);
  player.energyAttachedThisTurn = true;
  appendLog(G, `Player ${pid} attached ${card.name} to ${target.card.name}.`);
};

const playTrainer: Move<PokemonTCGState> = ({ G, ctx, random, playerID }, handIndex: number, target?: { zone: 'active' | 'bench'; benchIndex?: number; switchBenchIndex?: number }) => {
  const pid = ensurePlayer(playerID);
  if (!pid || ctx.currentPlayer !== pid) return INVALID_MOVE;

  const player = G.players[pid];
  const card = removeFromHand(player, handIndex);
  if (!isTrainer(card)) return INVALID_MOVE;

  if (card.trainerType === 'Supporter') {
    if (player.supporterPlayedThisTurn || (ctx.currentPlayer === G.firstPlayer && G.turnsTaken[pid] === 1)) return INVALID_MOVE;
    player.supporterPlayedThisTurn = true;
  }

  if (card.trainerType === 'Stadium') {
    if (player.stadiumPlayedThisTurn || G.stadium?.card.name === card.name) return INVALID_MOVE;
    if (G.stadium) {
      // Old Stadium goes to ITS OWNER'S discard, not the opponent's.
      G.players[G.stadium.owner].discard.push(G.stadium.card);
    }
    G.stadium = { card, owner: pid };
    player.stadiumPlayedThisTurn = true;
    appendLog(G, `Player ${pid} played Stadium ${card.name}.`);
    return;
  }

  if (card.trainerType === 'Pokemon Tool') {
    const pokemon = getTarget(player, target?.zone ?? 'active', target?.benchIndex);
    if (!pokemon || pokemon.tool) return INVALID_MOVE;
    pokemon.tool = card;
    appendLog(G, `Player ${pid} attached ${card.name} to ${pokemon.card.name}.`);
    return;
  }

  switch (card.effect) {
    case 'heal30': {
      const pokemon = getTarget(player, target?.zone ?? 'active', target?.benchIndex);
      if (!pokemon) return INVALID_MOVE;
      heal(pokemon, 30);
      player.discard.push(card);
      appendLog(G, `Player ${pid} healed ${pokemon.card.name}.`);
      break;
    }
    case 'draw3':
      drawCards(player, 3);
      player.discard.push(card);
      appendLog(G, `Player ${pid} drew 3 cards with ${card.name}.`);
      break;
    case 'shuffleHandDraw5':
      // Youngster: shuffle remaining hand back into deck, then draw 5.
      player.deck.push(...player.hand);
      player.hand = [];
      player.deck = random.Shuffle(player.deck);
      drawCards(player, 5);
      player.discard.push(card);
      appendLog(G, `Player ${pid} shuffled their hand into their deck and drew 5 with ${card.name}.`);
      break;
    case 'research':
      player.discard.push(...player.hand);
      player.hand = [];
      drawCards(player, 7);
      player.discard.push(card);
      appendLog(G, `Player ${pid} discarded their hand and drew 7 cards.`);
      break;
    case 'switch': {
      const benchIndex = target?.switchBenchIndex ?? target?.benchIndex;
      if (benchIndex === undefined || benchIndex < 0 || benchIndex >= player.bench.length || !player.active) return INVALID_MOVE;
      const oldActive = player.active;
      const [newActive] = player.bench.splice(benchIndex, 1, oldActive);
      clearSpecialConditions(oldActive);
      player.active = newActive;
      player.discard.push(card);
      appendLog(G, `Player ${pid} switched to ${newActive.card.name}.`);
      break;
    }
    case 'searchBasicToBench': {
      if (player.bench.length >= 5) return INVALID_MOVE;
      const deckIndex = player.deck.findIndex(isBasicPokemon);
      if (deckIndex === -1) return INVALID_MOVE;
      const [basic] = player.deck.splice(deckIndex, 1);
      if (!isBasicPokemon(basic)) return INVALID_MOVE;
      player.bench.push(createPokemonInPlay(G, basic, ctx.turn));
      player.discard.push(card);
      appendLog(G, `Player ${pid} searched ${basic.name} onto the Bench.`);
      break;
    }
    default:
      return INVALID_MOVE;
  }
};

const retreat: Move<PokemonTCGState> = ({ G, ctx, playerID }, benchIndex: number) => {
  const pid = ensurePlayer(playerID);
  if (!pid || ctx.currentPlayer !== pid) return INVALID_MOVE;

  const player = G.players[pid];
  const active = player.active;
  if (!active || player.retreatedThisTurn) return INVALID_MOVE;
  if (benchIndex < 0 || benchIndex >= player.bench.length) return INVALID_MOVE;
  if (active.conditions.includes('asleep') || active.conditions.includes('paralyzed')) return INVALID_MOVE;
  if (active.attachedEnergy.length < active.card.retreatCost) return INVALID_MOVE;

  const discardedEnergy = active.attachedEnergy.splice(0, active.card.retreatCost);
  player.discard.push(...discardedEnergy);

  const [newActive] = player.bench.splice(benchIndex, 1, active);
  clearSpecialConditions(active);
  player.active = newActive;
  player.retreatedThisTurn = true;
  appendLog(G, `Player ${pid} retreated to ${newActive.card.name}.`);
};

const attack: Move<PokemonTCGState> = ({ G, ctx, events, random, playerID }, attackIndex: number) => {
  const pid = ensurePlayer(playerID);
  if (!pid || ctx.currentPlayer !== pid) return INVALID_MOVE;
  if (isFirstTurnAttackBlocked(G, ctx)) return INVALID_MOVE;

  const player = G.players[pid];
  const opponent = G.players[opponentOf(pid)];
  const attacker = player.active;
  const defender = opponent.active;
  if (!attacker || !defender) return INVALID_MOVE;
  if (attacker.conditions.includes('asleep') || attacker.conditions.includes('paralyzed')) return INVALID_MOVE;

  const selectedAttack = attacker.card.attacks[attackIndex];
  if (!selectedAttack) return INVALID_MOVE;
  if (!canPayEnergyCost(attacker.attachedEnergy, selectedAttack.cost)) return INVALID_MOVE;

    if (attacker.conditions.includes('confused')) {
      const attacksNormally = random.Die(2) === 1;
      if (!attacksNormally) {
        attacker.damage += 30;
        appendLog(G, `${attacker.card.name} hurt itself in confusion.`);
        checkAllKnockOuts(G);
        resolvePokemonCheckup(G, random, pid);
        events.endTurn();
        return;
      }
    }

  if (selectedAttack.damage !== undefined) {
    const ignoreDefenderEffects = selectedAttack.effect?.type === 'damageIgnoreDefenderEffects';
    const damage = applyDamage(G, attacker, defender, selectedAttack.damage, { ignoreDefenderEffects });
    appendLog(G, `${attacker.card.name} used ${selectedAttack.name} for ${damage} damage.`);
  } else {
    appendLog(G, `${attacker.card.name} used ${selectedAttack.name}.`);
  }

  resolveAttackEffect(G, selectedAttack, attacker, defender, player, random, opponent);
  checkAllKnockOuts(G);
  resolvePokemonCheckup(G, random, pid);
  events.endTurn();
};

const pass: Move<PokemonTCGState> = ({ G, events, random, playerID }) => {
  const pid = ensurePlayer(playerID);
  if (!pid) return INVALID_MOVE;

  appendLog(G, `Player ${pid} passed.`);
  resolvePokemonCheckup(G, random, pid);
  events.endTurn();
};

// Forfeit / quit-out move. Either player can call it at any time during
// either phase (handled via per-phase stages below). The opponent is
// declared the winner, which trips the top-level endIf and triggers the
// normal match-completion flow on the client (records win/loss, fires
// the wager-settlement modal, etc.). Idempotent — a second concede after
// G.winner is already set is a no-op so simultaneous exits don't crash.
const concede: Move<PokemonTCGState> = ({ G, playerID }) => {
  if (G.winner) return;
  const pid = ensurePlayer(playerID);
  if (!pid) return INVALID_MOVE;
  const winner = opponentOf(pid);
  G.winner = winner;
  G.winReason = `Player ${pid} left the match — Player ${winner} wins by forfeit.`;
  appendLog(G, G.winReason);
};

export const PokemonTCG: Game<PokemonTCGState> = {
  name: 'pokemon-tcg',
  minPlayers: 2,
  maxPlayers: 2,
  setup: ({ random }, setupData: PokemonTCGSetupData | undefined): PokemonTCGState => {
    const deck0Ids = setupData?.seedDecks ? setupData.seedDecks['0'] : DEFAULT_DECK_0;
    const deck1Ids = setupData?.seedDecks ? setupData.seedDecks['1'] : DEFAULT_DECK_1;
    const deck0 = deck0Ids ? makeDeck(deck0Ids) : [];
    const deck1 = deck1Ids ? makeDeck(deck1Ids) : [];
    const shouldShuffle = setupData?.shuffleDecks !== false;
    const shuffle = shouldShuffle ? random.Shuffle : <T,>(cards: T[]) => [...cards];
    const player0 = makePlayer(shuffle(deck0));
    const player1 = makePlayer(shuffle(deck1));
    if (deck0.length > 0) {
      drawOpeningHandWithMulligans(player0, shuffle);
    }
    if (deck1.length > 0) {
      drawOpeningHandWithMulligans(player1, shuffle);
    }

    const firstPlayer = setupData?.firstPlayer ?? (random.Die(2) === 1 ? '0' : '1');
    const playOrder: PlayerID[] = firstPlayer === '0' ? ['0', '1'] : ['1', '0'];
    const playmatId = setupData?.playmatId ?? chooseRandomPlaymatId((sides) => random.Die(sides));

    return {
      players: { '0': player0, '1': player1 },
      deckLabels: { ...setupData?.deckLabels },
      walletAddresses: { ...setupData?.walletAddresses },
      matchName: setupData?.matchName?.trim() || 'Pokemon Match',
      matchType: setupData?.matchType ?? 'Casual',
      wagerAmount: typeof setupData?.wagerAmount === 'number' && setupData.wagerAmount > 0
        ? setupData.wagerAmount
        : 0,
      wagerCurrency: setupData?.wagerCurrency === 'POKETCG' ? 'POKETCG' : 'SOL',
      playmatId,
      playOrder,
      firstPlayer,
      turnsTaken: { '0': 0, '1': 0 },
      nextInstanceId: 1,
      log: [`Coin flip: Player ${firstPlayer} goes first.`],
    };
  },
  phases: {
    setup: {
      start: true,
      moves: {
        setPlayerDeck: {
          move: setPlayerDeck,
          client: false,
        },
        chooseOpeningPokemon: {
          move: chooseOpeningPokemon,
          client: false,
        },
        concede,
      },
      turn: {
        activePlayers: { all: Stage.NULL },
      },
      endIf: ({ G }) => G.players['0'].ready && G.players['1'].ready,
      onEnd: ({ G }) => {
        // After both players have placed Active + Bench, the opponent of
        // whoever mulliganed more draws bonus cards (one per extra
        // mulligan), per official Pokemon TCG rules.
        applyMulliganBonus(G);
      },
      next: 'play',
    },
    play: {
      moves: {
        benchBasic,
        evolvePokemon,
        attachEnergy,
        playTrainer: {
          move: playTrainer,
          client: false,
        },
        retreat,
        attack,
        pass,
        concede,
      },
      turn: {
        order: TurnOrder.CUSTOM_FROM('playOrder'),
        // Keep the current player on Stage.NULL so they retain access to
        // every play-phase move. Put the off-turn player on the 'waiting'
        // stage which only allows concede — that's what lets them quit
        // mid-turn and award the win to the player still in the game.
        activePlayers: { currentPlayer: Stage.NULL, others: 'waiting' },
        stages: {
          waiting: {
            moves: { concede },
          },
        },
        onBegin: ({ G, ctx }) => {
          beginPlayerTurn(G, ctx);
        },
        onEnd: ({ G, ctx }) => {
          resetTurnFlags(G.players[ctx.currentPlayer as PlayerID]);
        },
      },
    },
  },
  endIf: ({ G }) => {
    if (G.winner) {
      return { winner: G.winner, reason: G.winReason };
    }
  },
  playerView: ({ G, playerID }) => publicViewForPlayer(G, playerID),
  ai: {
    enumerate: (G, ctx, playerID) => {
      const pid = ensurePlayer(playerID);
      if (!pid) return [];
      const player = G.players[pid];
      const opponent = G.players[opponentOf(pid)];

      // ----- Setup phase: pick an Active Basic + bench up to 5 more ------
      if (ctx.phase === 'setup') {
        if (player.ready) return [];
        const basicIndexes: number[] = [];
        player.hand.forEach((card, index) => {
          if (isBasicPokemon(card)) basicIndexes.push(index);
        });
        if (basicIndexes.length === 0) return [];
        const [activeIndex, ...benchCandidates] = basicIndexes;
        // Official rules allow up to 5 Bench Pokemon in setup. Bench all
        // available so the bot has backups when its Active is KO'd.
        const benchIndexes = benchCandidates.slice(0, 5);
        return [{ move: 'chooseOpeningPokemon', args: [activeIndex, benchIndexes] }];
      }

      // ----- Not our turn during play -----
      if (ctx.phase !== 'play' || ctx.currentPlayer !== pid) {
        return [];
      }

      const moves: Array<{ move: string; args?: unknown[] }> = [];
      const benchSlots: Array<{ zone: 'bench'; benchIndex: number; pokemon: typeof player.bench[number] }> =
        player.bench.map((pokemon, benchIndex) => ({ zone: 'bench' as const, benchIndex, pokemon }));
      const activeSlot = player.active ? { zone: 'active' as const, pokemon: player.active } : undefined;
      const allSlots: Array<{ zone: 'active' | 'bench'; benchIndex?: number; pokemon: typeof player.bench[number] }> = [];
      if (activeSlot) allSlots.push({ zone: 'active', pokemon: activeSlot.pokemon });
      benchSlots.forEach((slot) => allSlots.push(slot));

      // ----- Bench Basics --------------------------------------------------
      if (player.bench.length < 5) {
        player.hand.forEach((card, index) => {
          if (isBasicPokemon(card)) {
            moves.push({ move: 'benchBasic', args: [index] });
          }
        });
      }

      // ----- Evolve --------------------------------------------------------
      // Allowed only on the 2nd+ turn for this player, and only on a target
      // that has been in play since before this turn and hasn't evolved this
      // turn. The move handler re-validates so we just enumerate plausible
      // hand × target combinations.
      if (G.turnsTaken[pid] > 1) {
        player.hand.forEach((card, handIndex) => {
          if (!isPokemon(card) || !card.evolvesFrom) return;
          allSlots.forEach((slot) => {
            if (slot.pokemon.card.name !== card.evolvesFrom) return;
            if (slot.pokemon.enteredTurn === ctx.turn) return;
            if (slot.pokemon.evolvedTurn === ctx.turn) return;
            const args: unknown[] = slot.zone === 'active'
              ? [handIndex, 'active']
              : [handIndex, 'bench', slot.benchIndex];
            moves.push({ move: 'evolvePokemon', args });
          });
        });
      }

      // ----- Attach 1 Energy to any of our Pokemon -------------------------
      if (!player.energyAttachedThisTurn) {
        player.hand.forEach((card, index) => {
          if (!isEnergy(card)) return;
          if (player.active) {
            moves.push({ move: 'attachEnergy', args: [index, 'active'] });
          }
          player.bench.forEach((_, benchIndex) => {
            moves.push({ move: 'attachEnergy', args: [index, 'bench', benchIndex] });
          });
        });
      }

      // ----- Play Trainers -------------------------------------------------
      // Enumerate every Trainer in hand with a target plausible for its
      // effect. The playTrainer handler re-validates (supporter-per-turn,
      // first-turn supporter block, stadium duplicates, tool slot, etc.).
      const isFirstTurnForUs = ctx.currentPlayer === G.firstPlayer && G.turnsTaken[pid] === 1;
      player.hand.forEach((card, handIndex) => {
        if (!isTrainer(card)) return;

        if (card.trainerType === 'Supporter') {
          if (player.supporterPlayedThisTurn || isFirstTurnForUs) return;
        }

        if (card.trainerType === 'Stadium') {
          if (player.stadiumPlayedThisTurn) return;
          if (G.stadium?.card.name === card.name) return;
          moves.push({ move: 'playTrainer', args: [handIndex] });
          return;
        }

        if (card.trainerType === 'Pokemon Tool') {
          // Attach to any Pokemon that doesn't already have a tool.
          allSlots.forEach((slot) => {
            if (slot.pokemon.tool) return;
            const target = slot.zone === 'active'
              ? { zone: 'active' as const }
              : { zone: 'bench' as const, benchIndex: slot.benchIndex };
            moves.push({ move: 'playTrainer', args: [handIndex, target] });
          });
          return;
        }

        // Item / Supporter effects. Target depends on the effect.
        switch (card.effect) {
          case 'heal30': {
            allSlots.forEach((slot) => {
              if (slot.pokemon.damage <= 0) return;
              const target = slot.zone === 'active'
                ? { zone: 'active' as const }
                : { zone: 'bench' as const, benchIndex: slot.benchIndex };
              moves.push({ move: 'playTrainer', args: [handIndex, target] });
            });
            break;
          }
          case 'switch': {
            if (!player.active || player.bench.length === 0) break;
            player.bench.forEach((_, benchIndex) => {
              moves.push({ move: 'playTrainer', args: [handIndex, { zone: 'bench', benchIndex, switchBenchIndex: benchIndex }] });
            });
            break;
          }
          case 'searchBasicToBench': {
            if (player.bench.length >= 5) break;
            if (!player.deck.some(isBasicPokemon)) break;
            moves.push({ move: 'playTrainer', args: [handIndex] });
            break;
          }
          case 'draw3':
          case 'research':
            moves.push({ move: 'playTrainer', args: [handIndex] });
            break;
          default:
            // Unknown effect — skip so the bot doesn't waste it as INVALID.
            break;
        }
      });

      // ----- Retreat -------------------------------------------------------
      if (
        player.active
        && !player.retreatedThisTurn
        && !player.active.conditions.includes('asleep')
        && !player.active.conditions.includes('paralyzed')
        && player.active.attachedEnergy.length >= player.active.card.retreatCost
        && player.bench.length > 0
      ) {
        player.bench.forEach((_, benchIndex) => {
          moves.push({ move: 'retreat', args: [benchIndex] });
        });
      }

      // ----- Attack --------------------------------------------------------
      if (
        player.active
        && opponent.active
        && !isFirstTurnAttackBlocked(G, ctx)
        && !player.active.conditions.includes('asleep')
        && !player.active.conditions.includes('paralyzed')
      ) {
        player.active.card.attacks.forEach((candidate, index) => {
          if (canPayEnergyCost(player.active!.attachedEnergy, candidate.cost)) {
            moves.push({ move: 'attack', args: [index] });
          }
        });
      }

      // Pass is always available as a safety valve.
      moves.push({ move: 'pass' });

      return moves;
    },
  },
};
