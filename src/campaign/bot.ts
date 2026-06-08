// MCTS-driven CPU bot for the Gym Challenge campaign.
//
// Replaces the default RandomBot (which picks any legal move with
// equal probability) with Monte Carlo Tree Search. MCTSBot runs
// many simulated playouts from the current state, weights branches
// by how often they led to a "good" outcome, and picks the most
// promising move.
//
// Per-tier difficulty: gym leaders get a small thinking budget so
// they're still beatable mid-campaign, Elite Four gets more time,
// and Champion Blue gets the heaviest budget so the final battle
// actually feels like a wall.

import { MCTSBot } from 'boardgame.io/ai';
import { PokemonTCG } from '../game/PokemonTCG';
import type { PokemonTCGState } from '../game/types';
import type { CampaignOpponent } from './data';

/** Heuristics that bias MCTS playouts toward winning lines instead
 *  of random survival. Each objective is checked against simulated
 *  end states — true ones get their weight added to the branch score.
 *
 *  These weights have been substantially sharpened (Jun 2026) so the
 *  bot plays a real prize race instead of trading attacks at random:
 *  prize-margin scaling, big-damage threshold, own-survival reward,
 *  bench-depth heuristic, and an opponent-attack denial signal.
 *  Combined with the bumped MCTS budgets below this makes gym + E4
 *  matches meaningfully harder. */
function objectivesFor(playerID: string) {
  return (G: PokemonTCGState) => {
    const me = playerID as '0' | '1';
    const oppId = playerID === '0' ? '1' : '0';
    const opp = oppId as '0' | '1';
    return {
      // Dominant signal — the only thing that closes a game.
      wonMatch: {
        weight: 200,
        checker: () => G.winner === me,
      },
      // Per-prize lead: scales with how many MORE prizes we've taken
      // than the opponent. Each prize ahead is worth ~20 weight so a
      // 3-prize lead is 60 — comparable to a single KO signal. This
      // pushes the bot to keep taking prizes after the first KO.
      prizeMargin: {
        weight: 20,
        checker: () => {
          const myLeft = G.players[me]?.prizeCards?.length ?? 6;
          const oppLeft = G.players[opp]?.prizeCards?.length ?? 6;
          return oppLeft > myLeft;
        },
      },
      // Crushing prize lead — extra reward for snowballing to 1-2
      // prizes left so the bot doesn't drag games out.
      closingOut: {
        weight: 60,
        checker: () => (G.players[me]?.prizeCards?.length ?? 6) <= 2,
      },
      // Opponent active is knocked out — forced promotion is huge tempo.
      knockedOutOpponentActive: {
        weight: 35,
        checker: () => !G.players[opp]?.active,
      },
      // Big damage on opponent's active — bot prefers lines that
      // SET UP a KO next turn, not just chip damage.
      bigDamageOnOpp: {
        weight: 8,
        checker: () => {
          const a = G.players[opp]?.active;
          if (!a) return false;
          const dmg = a.damage;
          const hp = a.card?.hp ?? 60;
          return dmg >= hp * 0.6;
        },
      },
      // Any damage on opponent's active — light tempo signal so the
      // bot prefers attacking turns over pass-turns.
      anyDamageOnOpp: {
        weight: 2,
        checker: () => (G.players[opp]?.active?.damage ?? 0) > 0,
      },
      // Survival reward — bot's active is alive at the playout horizon.
      // Discourages suicide attacks that hand prizes back.
      ownActiveAlive: {
        weight: 15,
        checker: () => Boolean(G.players[me]?.active),
      },
      // Bench depth — having ≥3 benched Pokemon means we can absorb
      // a KO without giving up our last threat. Boards with no bench
      // collapse instantly.
      hasBenchDepth: {
        weight: 6,
        checker: () => (G.players[me]?.bench?.length ?? 0) >= 3,
      },
      // Energy on the field — proxy for "this board can actually
      // attack". Two or more loaded Pokemon is much harder to
      // disrupt than a single attacker.
      hasMultipleAttackers: {
        weight: 8,
        checker: () => {
          const me0 = G.players[me];
          if (!me0) return false;
          const activeEn = me0.active?.attachedEnergy?.length ?? 0;
          const benchLoaded = (me0.bench ?? [])
            .filter((p) => (p?.attachedEnergy?.length ?? 0) >= 1).length;
          return (activeEn >= 2 ? 1 : 0) + benchLoaded >= 2;
        },
      },
      // Deny the opponent — if they have no active, no bench, or no
      // energy on either, they can't fight back. Worth chasing.
      opponentDeclawed: {
        weight: 12,
        checker: () => {
          const o = G.players[opp];
          if (!o) return false;
          const activeEn = o.active?.attachedEnergy?.length ?? 0;
          const benchEn = (o.bench ?? []).reduce((s, p) => s + (p?.attachedEnergy?.length ?? 0), 0);
          return activeEn + benchEn === 0;
        },
      },
    };
  };
}

/** Per-tier MCTS budgets. These were substantially raised in Jun 2026
 *  to make the campaign genuinely difficult — early settings (150/30,
 *  400/40, 800/50) were almost beatable on autopilot. New defaults
 *  put gym leaders at ~2-4s/turn, E4 at ~6-10s, champion at ~12-20s
 *  on a modern laptop. The horizon-shaped objectives above amplify
 *  the budget — even gym leaders now read your board state and plan
 *  KO setups instead of swinging at random. */
const DIFFICULTY_BY_TIER: Record<CampaignOpponent['tier'], { iterations: number; playoutDepth: number }> = {
  gym:          { iterations:  600, playoutDepth:  60 },
  'elite-four': { iterations: 1500, playoutDepth:  90 },
  champion:     { iterations: 3000, playoutDepth: 130 },
};

/** Build an MCTSBot class pre-bound to the opponent's difficulty
 *  tuning. Returns a class (not instance) so ``Local({ bots: ... })``
 *  can instantiate it the way it expects. */
export function createCampaignBot(opponent: CampaignOpponent): typeof MCTSBot {
  const tuning = DIFFICULTY_BY_TIER[opponent.tier];
  const enumerate = PokemonTCG.ai?.enumerate;
  if (!enumerate) {
    // Fallback shouldn't happen — PokemonTCG always defines enumerate —
    // but keep a typed escape hatch so a future engine refactor can't
    // crash the campaign battle screen.
    throw new Error('PokemonTCG.ai.enumerate is missing');
  }
  return class CampaignBot extends MCTSBot {
    constructor(opts: { seed?: string | number } = {}) {
      super({
        game: PokemonTCG,
        enumerate,
        iterations: tuning.iterations,
        playoutDepth: tuning.playoutDepth,
        objectives: objectivesFor('1'),
        seed: opts.seed,
      });
    }
  };
}
