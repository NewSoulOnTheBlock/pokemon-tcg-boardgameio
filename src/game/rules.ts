import type { Ctx, FnContext } from 'boardgame.io';
import type {
  Attack,
  Card,
  EnergyCard,
  PlayerID,
  PlayerState,
  PokemonCard,
  PokemonInPlay,
  PokemonTCGState,
  PokemonType,
  SpecialCondition,
  TrainerCard,
} from './types';

const PLAYER_IDS: PlayerID[] = ['0', '1'];

export function opponentOf(playerID: PlayerID): PlayerID {
  return playerID === '0' ? '1' : '0';
}

export function isPlayerID(playerID: string | null | undefined): playerID is PlayerID {
  return playerID === '0' || playerID === '1';
}

export function isPokemon(card: Card | undefined): card is PokemonCard {
  return card?.kind === 'pokemon';
}

export function isBasicPokemon(card: Card | undefined): card is PokemonCard {
  return isPokemon(card) && card.stage === 'Basic';
}

export function isEnergy(card: Card | undefined): card is EnergyCard {
  return card?.kind === 'energy';
}

export function isTrainer(card: Card | undefined): card is TrainerCard {
  return card?.kind === 'trainer';
}

export function appendLog(G: PokemonTCGState, message: string): void {
  G.log.unshift(message);
  G.log = G.log.slice(0, 40);
}

export function createPokemonInPlay(
  G: PokemonTCGState,
  card: PokemonCard,
  turn: number,
): PokemonInPlay {
  const pokemon: PokemonInPlay = {
    instanceId: `pokemon-${G.nextInstanceId}`,
    card,
    evolution: [card],
    attachedEnergy: [],
    damage: 0,
    conditions: [],
    enteredTurn: turn,
  };

  G.nextInstanceId += 1;
  return pokemon;
}

export function drawCards(player: PlayerState, count: number): Card[] {
  const drawn: Card[] = [];
  for (let i = 0; i < count && player.deck.length > 0; i += 1) {
    const card = player.deck.shift();
    if (card) {
      player.hand.push(card);
      drawn.push(card);
    }
  }
  return drawn;
}

export function resetTurnFlags(player: PlayerState): void {
  player.energyAttachedThisTurn = false;
  player.supporterPlayedThisTurn = false;
  player.stadiumPlayedThisTurn = false;
  player.retreatedThisTurn = false;
}

export function canPayEnergyCost(attachedEnergy: EnergyCard[], cost: PokemonType[]): boolean {
  // Expand each attached card into its individual energy symbols.
  // Special Energy (Double Colorless etc.) contributes multiple symbols
  // via `providesEnergy`; basic energy contributes one of its energyType.
  const available: PokemonType[] = attachedEnergy.flatMap((energy) =>
    energy.providesEnergy && energy.providesEnergy.length > 0
      ? [...energy.providesEnergy]
      : [energy.energyType],
  );

  for (const symbol of cost) {
    if (symbol === 'Colorless') {
      if (available.length === 0) {
        return false;
      }
      available.pop();
      continue;
    }

    const exactIndex = available.indexOf(symbol);
    if (exactIndex === -1) {
      return false;
    }
    available.splice(exactIndex, 1);
  }
  return true;
}

export function getTarget(player: PlayerState, zone: 'active' | 'bench', benchIndex?: number): PokemonInPlay | undefined {
  if (zone === 'active') {
    return player.active;
  }

  if (benchIndex === undefined) {
    return undefined;
  }

  return player.bench[benchIndex];
}

export function removeFromHand(player: PlayerState, handIndex: number): Card | undefined {
  if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= player.hand.length) {
    return undefined;
  }

  const [card] = player.hand.splice(handIndex, 1);
  return card;
}

export function heal(pokemon: PokemonInPlay, amount: number): void {
  pokemon.damage = Math.max(0, pokemon.damage - amount);
}

export function addCondition(pokemon: PokemonInPlay, condition: SpecialCondition): void {
  const rotationConditions: SpecialCondition[] = ['asleep', 'confused', 'paralyzed'];
  let next = pokemon.conditions.filter((existing) => existing !== condition);

  if (rotationConditions.includes(condition)) {
    next = next.filter((existing) => !rotationConditions.includes(existing));
  }

  next.push(condition);
  pokemon.conditions = next;
}

export function clearSpecialConditions(pokemon: PokemonInPlay): void {
  pokemon.conditions = [];
}

export function applyDamage(
  G: PokemonTCGState,
  attacker: PokemonInPlay,
  defender: PokemonInPlay,
  baseDamage: number,
  options?: { ignoreDefenderEffects?: boolean },
): number {
  let damage = baseDamage;

  if (G.stadium?.card.effect === 'stadiumPlus10') {
    damage += 10;
  }

  if (defender.card.weakness === attacker.card.pokemonType) {
    damage *= 2;
  }

  if (defender.card.resistance === attacker.card.pokemonType) {
    damage -= 30;
  }

  // Shred-style attacks ignore Tools / damage-reduction effects on the
  // defender. Stadium bonus + weakness/resistance are NOT defender-side
  // effects per official rules, so they're applied above regardless.
  if (!options?.ignoreDefenderEffects && defender.tool?.effect === 'toolMinus10') {
    damage -= 10;
  }

  const finalDamage = Math.max(0, damage);
  defender.damage += finalDamage;
  return finalDamage;
}

export function takePrizeCards(G: PokemonTCGState, playerID: PlayerID, count: number): void {
  const player = G.players[playerID];
  for (let i = 0; i < count && player.prizeCards.length > 0; i += 1) {
    const prize = player.prizeCards.shift();
    if (prize) {
      player.hand.push(prize);
    }
  }

  if (player.prizeCards.length === 0 && !G.winner) {
    G.winner = playerID;
    G.winReason = `Player ${playerID} took their last Prize card.`;
  }
}

export function discardPokemon(player: PlayerState, pokemon: PokemonInPlay): void {
  player.discard.push(...pokemon.evolution);
  player.discard.push(...pokemon.attachedEnergy);
  if (pokemon.tool) {
    player.discard.push(pokemon.tool);
  }
}

export function promoteFirstBenchedIfNeeded(G: PokemonTCGState, playerID: PlayerID): void {
  const player = G.players[playerID];
  if (player.active || player.bench.length === 0) {
    return;
  }

  const [promoted] = player.bench.splice(0, 1);
  player.active = promoted;
  clearSpecialConditions(promoted);
  appendLog(G, `Player ${playerID} promoted ${promoted.card.name}.`);
}

export function checkActiveKnockOut(G: PokemonTCGState, ownerID: PlayerID): void {
  const owner = G.players[ownerID];
  const active = owner.active;
  if (!active || active.damage < active.card.hp) {
    return;
  }

  const opponentID = opponentOf(ownerID);
  const prizeValue = active.card.prizeValue ?? prizeValueFor(active.card);
  appendLog(G, `${active.card.name} was Knocked Out. Player ${opponentID} took ${prizeValue} Prize card(s).`);
  discardPokemon(owner, active);
  owner.active = undefined;
  takePrizeCards(G, opponentID, prizeValue);

  if (!G.winner && owner.bench.length === 0) {
    G.winner = opponentID;
    G.winReason = `Player ${ownerID} has no Pokemon left in play.`;
    return;
  }

  promoteFirstBenchedIfNeeded(G, ownerID);
}

export function checkAllKnockOuts(G: PokemonTCGState): void {
  for (const playerID of PLAYER_IDS) {
    checkActiveKnockOut(G, playerID);
  }
}

function prizeValueFor(card: PokemonCard): number {
  switch (card.ruleBox) {
    case 'VMAX':
    case 'V-UNION':
    case 'TAG TEAM':
      return 3;
    case 'ex':
    case 'V':
    case 'VSTAR':
    case 'GX':
    case 'EX':
      return 2;
    default:
      return 1;
  }
}

export function resolveAttackEffect(
  G: PokemonTCGState,
  attack: Attack,
  attacker: PokemonInPlay,
  defender: PokemonInPlay,
  player: PlayerState,
  random: { Die: (spotValue: number) => number; Shuffle?: <T>(arr: T[]) => T[] },
  opponent?: PlayerState,
): void {
  const effect = attack.effect;
  if (!effect) {
    return;
  }

  switch (effect.type) {
    case 'condition':
      addCondition(defender, effect.condition);
      appendLog(G, `${defender.card.name} is now ${effect.condition}.`);
      break;
    case 'conditionSelf':
      addCondition(attacker, effect.condition);
      appendLog(G, `${attacker.card.name} is now ${effect.condition}.`);
      break;
    case 'coinFlipCondition': {
      const heads = random.Die(2) === 1;
      if (heads) {
        addCondition(defender, effect.condition);
        appendLog(G, `Coin flip: heads. ${defender.card.name} is now ${effect.condition}.`);
      } else {
        appendLog(G, `Coin flip: tails. ${defender.card.name} avoided ${effect.condition}.`);
      }
      break;
    }
    case 'healSelf':
      heal(attacker, effect.amount);
      appendLog(G, `${attacker.card.name} healed ${effect.amount} damage.`);
      break;
    case 'healAllOwn': {
      let healed = 0;
      const heroes = [player.active, ...player.bench].filter((p): p is PokemonInPlay => Boolean(p));
      for (const pokemon of heroes) {
        if (pokemon.damage > 0) {
          heal(pokemon, effect.amount);
          healed += 1;
        }
      }
      appendLog(G, `Healed ${effect.amount} damage from ${healed} of your Pokémon.`);
      break;
    }
    case 'clearOwnConditions':
      if (attacker.conditions.length > 0) {
        attacker.conditions = [];
        appendLog(G, `${attacker.card.name} cleared all Special Conditions.`);
      }
      break;
    case 'selfDamage':
      attacker.damage += effect.amount;
      appendLog(G, `${attacker.card.name} took ${effect.amount} recoil damage.`);
      break;
    case 'selfBenchSplash':
      for (const benched of player.bench) {
        benched.damage += effect.amount;
      }
      if (player.bench.length > 0) {
        appendLog(G, `${attack.name} splashed ${effect.amount} damage onto ${player.bench.length} of your Benched Pokémon.`);
      }
      break;
    case 'draw':
      drawCards(player, effect.count);
      appendLog(G, `Player drew ${effect.count} card(s).`);
      break;
    case 'coinBonusDamage': {
      const heads = random.Die(2) === 1;
      if (heads) {
        defender.damage += effect.amount;
        appendLog(G, `${attack.name} hit the bonus coin flip for ${effect.amount} more damage.`);
      } else {
        appendLog(G, `${attack.name} missed the bonus coin flip.`);
      }
      break;
    }
    case 'coinMultiHeadsDamage': {
      let heads = 0;
      for (let i = 0; i < effect.numCoins; i += 1) {
        if (random.Die(2) === 1) heads += 1;
      }
      const total = heads * effect.perHead;
      if (total > 0) {
        defender.damage += total;
      }
      appendLog(G, `${attack.name}: flipped ${effect.numCoins} coins, ${heads} heads -> ${total} damage.`);
      break;
    }
    case 'coinFlipsAllHeadsOrFail': {
      let allHeads = true;
      for (let i = 0; i < effect.numCoins; i += 1) {
        if (random.Die(2) !== 1) { allHeads = false; break; }
      }
      // If any tail, the printed damage (already applied in `attack`) was
      // also wasted. We undo it here so the attack truly "does nothing".
      if (!allHeads && attack.damage !== undefined) {
        defender.damage = Math.max(0, defender.damage - attack.damage);
        appendLog(G, `${attack.name} fizzled (tails on the coin flip).`);
      } else if (allHeads) {
        appendLog(G, `${attack.name} landed all heads.`);
      }
      break;
    }
    case 'coinFlipDiscardOppEnergy': {
      if (random.Die(2) === 1 && defender.attachedEnergy.length > 0 && opponent) {
        const [discarded] = defender.attachedEnergy.splice(0, 1);
        opponent.discard.push(discarded);
        appendLog(G, `${attack.name}: heads. Discarded ${discarded.name} from ${defender.card.name}.`);
      } else {
        appendLog(G, `${attack.name}: no energy discarded.`);
      }
      break;
    }
    case 'coinUntilTailsDiscardOppEnergy': {
      let discardedCount = 0;
      while (random.Die(2) === 1 && defender.attachedEnergy.length > 0 && opponent) {
        const [discarded] = defender.attachedEnergy.splice(0, 1);
        opponent.discard.push(discarded);
        discardedCount += 1;
      }
      appendLog(G, `${attack.name}: flipped until tails, discarded ${discardedCount} energy from ${defender.card.name}.`);
      break;
    }
    case 'damagePerOwnDamageCounter': {
      const counters = Math.floor(attacker.damage / 10);
      const bonus = counters * effect.perCounter;
      if (bonus > 0) {
        defender.damage += bonus;
        appendLog(G, `${attack.name}: +${bonus} damage from ${counters} damage counter(s) on self.`);
      }
      break;
    }
    case 'damagePerOpponentEnergy': {
      const bonus = defender.attachedEnergy.length * effect.perEnergy;
      if (bonus > 0) {
        defender.damage += bonus;
        appendLog(G, `${attack.name}: +${bonus} damage from ${defender.attachedEnergy.length} opponent energy.`);
      }
      break;
    }
    case 'damagePerOpponentRetreatColorless': {
      const bonus = defender.card.retreatCost * effect.perColorless;
      if (bonus > 0) {
        defender.damage += bonus;
        appendLog(G, `${attack.name}: +${bonus} damage from defender's retreat cost.`);
      }
      break;
    }
    case 'damageIfHasTool': {
      if (attacker.tool) {
        defender.damage += effect.bonus;
        appendLog(G, `${attack.name}: +${effect.bonus} damage from attached Tool.`);
      }
      break;
    }
    case 'damageIgnoreDefenderEffects':
      // Handled at applyDamage call site via options; this branch is a
      // no-op marker so the switch is exhaustive.
      break;
    case 'discardOwnEnergy': {
      let removed = 0;
      for (let i = 0; i < attacker.attachedEnergy.length && removed < effect.count; ) {
        const energy = attacker.attachedEnergy[i];
        const matches = effect.energyType
          ? energy.energyType === effect.energyType ||
            (energy.providesEnergy?.includes(effect.energyType) ?? false)
          : true;
        if (matches) {
          attacker.attachedEnergy.splice(i, 1);
          player.discard.push(energy);
          removed += 1;
        } else {
          i += 1;
        }
      }
      appendLog(G, `${attack.name}: discarded ${removed} energy from ${attacker.card.name}.`);
      break;
    }
    case 'discardAllOwnEnergy': {
      const removed = attacker.attachedEnergy.length;
      player.discard.push(...attacker.attachedEnergy);
      attacker.attachedEnergy = [];
      appendLog(G, `${attack.name}: discarded all ${removed} energy from ${attacker.card.name}.`);
      break;
    }
    case 'discardStadium': {
      if (G.stadium) {
        G.players[G.stadium.owner].discard.push(G.stadium.card);
        appendLog(G, `${attack.name}: discarded Stadium ${G.stadium.card.name}.`);
        G.stadium = undefined;
      }
      break;
    }
    case 'searchAndAttachEnergy': {
      let attached = 0;
      for (let i = 0; i < player.deck.length && attached < effect.count; ) {
        const card = player.deck[i];
        if (card.kind === 'energy' && card.energyType === effect.energyType) {
          player.deck.splice(i, 1);
          attacker.attachedEnergy.push(card);
          attached += 1;
        } else {
          i += 1;
        }
      }
      if (attached > 0 && random.Shuffle) {
        player.deck = random.Shuffle(player.deck);
      }
      appendLog(G, `${attack.name}: attached ${attached} ${effect.energyType} energy from deck.`);
      break;
    }
    case 'selfMillDeck': {
      const milled = player.deck.splice(0, effect.count);
      player.discard.push(...milled);
      appendLog(G, `${attack.name}: discarded the top ${milled.length} cards of your deck.`);
      break;
    }
  }
}

export function resolvePokemonCheckup(
  G: PokemonTCGState,
  random: { Die: (spotValue: number) => number },
  endedTurnPlayer?: PlayerID,
): void {
  for (const playerID of PLAYER_IDS) {
    const active = G.players[playerID].active;
    if (!active) {
      continue;
    }

    if (active.conditions.includes('poisoned')) {
      active.damage += 10;
      appendLog(G, `${active.card.name} took 10 Poison damage.`);
    }

    if (active.conditions.includes('burned')) {
      active.damage += 20;
      const recovers = random.Die(2) === 1;
      if (recovers) {
        active.conditions = active.conditions.filter((condition) => condition !== 'burned');
        appendLog(G, `${active.card.name} recovered from Burn.`);
      } else {
        appendLog(G, `${active.card.name} stayed Burned.`);
      }
    }

    if (active.conditions.includes('asleep')) {
      const wakesUp = random.Die(2) === 1;
      if (wakesUp) {
        active.conditions = active.conditions.filter((condition) => condition !== 'asleep');
        appendLog(G, `${active.card.name} woke up.`);
      } else {
        appendLog(G, `${active.card.name} stayed Asleep.`);
      }
    }

    if (active.conditions.includes('paralyzed')) {
      // Per official rules: Paralysis recovers during the Pokemon Checkup
      // that follows the OWNER'S next turn. If the checkup happens at the
      // end of the opponent's turn (i.e. the turn the paralysis was applied
      // on, or any subsequent opponent turn before our own), the Pokemon
      // stays Paralyzed.
      if (endedTurnPlayer === playerID) {
        active.conditions = active.conditions.filter((condition) => condition !== 'paralyzed');
        appendLog(G, `${active.card.name} recovered from Paralysis.`);
      }
    }
  }

  checkAllKnockOuts(G);
}

/**
 * Mulligan bonus: when one player had more mulligans than the other during
 * opening-hand setup, the opponent draws (diff) extra cards after both
 * players have placed Active + Bench. Per official rules they may bench
 * any Basic Pokemon drawn this way; for simplicity we leave them in hand
 * and let the player bench on turn 1.
 */
export function applyMulliganBonus(G: PokemonTCGState): void {
  const p0Mulls = G.players['0'].mulligans;
  const p1Mulls = G.players['1'].mulligans;
  if (p0Mulls === p1Mulls) return;
  const bonusPlayer: PlayerID = p0Mulls > p1Mulls ? '1' : '0';
  const otherPlayer: PlayerID = bonusPlayer === '0' ? '1' : '0';
  const diff = Math.abs(p0Mulls - p1Mulls);
  const drawn = drawCards(G.players[bonusPlayer], diff);
  if (drawn.length > 0) {
    appendLog(
      G,
      `Player ${bonusPlayer} draws ${drawn.length} bonus card(s) ` +
      `for Player ${otherPlayer}'s ${p0Mulls > p1Mulls ? p0Mulls : p1Mulls} mulligan(s).`,
    );
  }
}

export function beginPlayerTurn(
  G: PokemonTCGState,
  ctx: Ctx,
): void {
  const playerID = ctx.currentPlayer as PlayerID;
  const player = G.players[playerID];
  resetTurnFlags(player);

  if (player.deck.length === 0) {
    const winner = opponentOf(playerID);
    G.winner = winner;
    G.winReason = `Player ${playerID} could not draw at the beginning of their turn.`;
    return;
  }

  drawCards(player, 1);
  G.turnsTaken[playerID] += 1;
  appendLog(G, `Player ${playerID} drew for turn.`);
}

export function isFirstTurnAttackBlocked(G: PokemonTCGState, ctx: Ctx): boolean {
  const playerID = ctx.currentPlayer as PlayerID;
  return playerID === G.firstPlayer && G.turnsTaken[playerID] === 1;
}

export function validateEvolution(target: PokemonInPlay, card: PokemonCard, ctx: Ctx, turnsTaken: number): string | undefined {
  if (card.evolvesFrom !== target.card.name) {
    return `${card.name} does not evolve from ${target.card.name}.`;
  }

  if (target.enteredTurn === ctx.turn) {
    return 'A Pokemon cannot evolve on its first turn in play.';
  }

  if (target.evolvedTurn === ctx.turn) {
    return 'A Pokemon cannot evolve twice in the same turn.';
  }

  if (turnsTaken <= 1) {
    return 'Players cannot evolve Pokemon on their first turn unless a card says so.';
  }

  return undefined;
}

export function publicViewForPlayer(G: PokemonTCGState, playerID: string | null): PokemonTCGState {
  const clone = structuredClone(G);

  for (const pid of PLAYER_IDS) {
    const player = clone.players[pid];
    const canSeeHand = playerID === pid;
    player.deckCount = player.deck.length;
    player.handCount = player.hand.length;
    player.prizeCount = player.prizeCards.length;
    player.deck = [];
    player.hand = canSeeHand ? player.hand : [];
    player.prizeCards = [];
  }

  return clone;
}

export function ensurePlayer(playerID: string | null | undefined): PlayerID | undefined {
  return isPlayerID(playerID) ? playerID : undefined;
}

export type MoveContext = FnContext<PokemonTCGState> & { playerID?: string };
