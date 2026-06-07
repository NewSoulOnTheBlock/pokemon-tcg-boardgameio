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
 *  end states — true ones get their weight added to the branch score. */
function objectivesFor(playerID: string) {
  return (G: PokemonTCGState) => {
    const opponentId = playerID === '0' ? '1' : '0';
    return {
      // Big win signal: drove opponent's prize count down or wiped them out.
      wonMatch: {
        weight: 100,
        checker: () => G.winner === (playerID as '0' | '1'),
      },
      // Mid signal: damage on opponent's active.
      damagingOpponent: {
        weight: 0.05,
        checker: () => Boolean(G.players[opponentId as '0' | '1']?.active?.damage),
      },
      // Mid signal: opponent's active is knocked out (forced promotion).
      knockedOutActive: {
        weight: 20,
        checker: () => !G.players[opponentId as '0' | '1']?.active,
      },
      // Small signal: opponent has fewer prizes than us.
      prizeLead: {
        weight: 5,
        checker: () => {
          const self = G.players[playerID as '0' | '1'];
          const opp = G.players[opponentId as '0' | '1'];
          if (!self || !opp) return false;
          return (self.prizeCards?.length ?? 6) < (opp.prizeCards?.length ?? 6);
        },
      },
    };
  };
}

const DIFFICULTY_BY_TIER: Record<CampaignOpponent['tier'], { iterations: number; playoutDepth: number }> = {
  // Gym leaders: still beatable for a new player. ~150 MCTS rollouts
  // with 30-depth playouts ≈ < 1s thinking time on modern hardware.
  gym: { iterations: 150, playoutDepth: 30 },
  // Elite Four: meaningfully harder. ~400 rollouts, 40 depth.
  'elite-four': { iterations: 400, playoutDepth: 40 },
  // Champion: the wall. ~800 rollouts, 50 depth (≈ 2-4s/turn).
  champion: { iterations: 800, playoutDepth: 50 },
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
