import type { Game, Move } from 'boardgame.io';
import { INVALID_MOVE, Stage, TurnOrder } from 'boardgame.io/dist/cjs/core.js';
import { chooseRandomPlaymatId } from '../playmats';
import { DEFAULT_DECK_0, DEFAULT_DECK_1, makeDeck } from './cards';
import type { Card, PlayerID, PokemonTCGSetupData, PokemonTCGState } from './types';
import {
  addCondition,
  appendLog,
  applyDamage,
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

const playTrainer: Move<PokemonTCGState> = ({ G, ctx, playerID }, handIndex: number, target?: { zone: 'active' | 'bench'; benchIndex?: number; switchBenchIndex?: number }) => {
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
    if (player.stadiumPlayedThisTurn || G.stadium?.name === card.name) return INVALID_MOVE;
    if (G.stadium) {
      G.players[opponentOf(pid)].discard.push(G.stadium);
    }
    G.stadium = card;
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
      resolvePokemonCheckup(G, random);
      events.endTurn();
      return;
    }
  }

  if (selectedAttack.damage !== undefined) {
    const damage = applyDamage(G, attacker, defender, selectedAttack.damage);
    appendLog(G, `${attacker.card.name} used ${selectedAttack.name} for ${damage} damage.`);
  } else {
    appendLog(G, `${attacker.card.name} used ${selectedAttack.name}.`);
  }

  resolveAttackEffect(G, selectedAttack, attacker, defender, player, random);
  checkAllKnockOuts(G);
  resolvePokemonCheckup(G, random);
  events.endTurn();
};

const pass: Move<PokemonTCGState> = ({ G, events, random, playerID }) => {
  const pid = ensurePlayer(playerID);
  if (!pid) return INVALID_MOVE;

  appendLog(G, `Player ${pid} passed.`);
  resolvePokemonCheckup(G, random);
  events.endTurn();
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
      },
      turn: {
        activePlayers: { all: Stage.NULL },
      },
      endIf: ({ G }) => G.players['0'].ready && G.players['1'].ready,
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
      },
      turn: {
        order: TurnOrder.CUSTOM_FROM('playOrder'),
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

      // ----- Setup phase: pick an Active Basic + optionally bench more ---
      if (ctx.phase === 'setup') {
        if (player.ready) return [];
        const basicIndexes: number[] = [];
        player.hand.forEach((card, index) => {
          if (isBasicPokemon(card)) basicIndexes.push(index);
        });
        if (basicIndexes.length === 0) return [];
        const [activeIndex, ...benchCandidates] = basicIndexes;
        const benchIndexes = benchCandidates.slice(0, 2);
        return [{ move: 'chooseOpeningPokemon', args: [activeIndex, benchIndexes] }];
      }

      // ----- Not our turn during play -----
      if (ctx.phase !== 'play' || ctx.currentPlayer !== pid) {
        return [];
      }

      const moves: Array<{ move: string; args?: unknown[] }> = [];

      // Bench any Basics we're still holding so we have backups.
      if (player.bench.length < 5) {
        player.hand.forEach((card, index) => {
          if (isBasicPokemon(card)) {
            moves.push({ move: 'benchBasic', args: [index] });
          }
        });
      }

      // Attach one Energy to the Active Pokemon if we have one and haven't yet.
      if (player.active && !player.energyAttachedThisTurn) {
        const energyIndex = player.hand.findIndex(isEnergy);
        if (energyIndex >= 0) {
          moves.push({ move: 'attachEnergy', args: [energyIndex, 'active'] });
        }
      }

      // Attack with any attack we can afford.
      if (player.active) {
        player.active.card.attacks.forEach((candidate, index) => {
          if (canPayEnergyCost(player.active!.attachedEnergy, candidate.cost)) {
            moves.push({ move: 'attack', args: [index] });
          }
        });
      }

      // Always allow a pass as a fallback.
      moves.push({ move: 'pass' });

      return moves;
    },
  },
};
