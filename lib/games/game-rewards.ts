// lib/games/game-rewards.ts
//
// Shared reward-granting helper. Every game's own reward module (e.g.
// lib/games/mpgr-run/run-rewards.ts) calls this instead of reimplementing
// daily-cap bookkeeping — it's the one place "don't let restart-spam farm
// unlimited XP" is enforced.
//
// IMPORTANT: this module never distributes MPGR tokens and never touches
// MPGRStaking. It only ever calls lib/xp-engine.ts's awardXP with a fixed,
// pre-defined XPAction. Season Points are NOT granted here — they are
// derived automatically from XP history by getSeasonPoints() in
// lib/xp-engine.ts, so awarding XP is sufficient.
//
// Future MPGR game-reward payouts: a dedicated GameRewardDistributor
// contract + a registered "game" RewardProvider (see
// lib/rewards/reward-types.ts — RewardCategoryKey already reserves "game"
// as a category; lib/rewards/providers/index.ts is the plug-in point) are
// the intended future extension. Neither is wired up yet — see repo audit
// notes for why that's deliberately out of scope for Games 1.0.

import { awardXP, type AwardResult, type XPAction } from "@/lib/xp-engine";
import { getGameStats, saveGameStats, todayKey } from "./game-storage";
import type { GameId } from "./game-types";

export interface CappedXPResult {
  awarded: boolean;
  xpGained: number;
  dailyCapReached: boolean;
  awardResult: AwardResult | null;
}

/**
 * Awards fixed XP for a completed, already-validated run — up to
 * `dailyCap` times per UTC calendar day, per wallet, per game. Mutates and
 * persists that game's GameStatsRecord.xpAwardedRunsByDate counter.
 */
export function awardCappedRunXP(
  gameId: GameId,
  address: string,
  xpAction: XPAction,
  dailyCap: number
): CappedXPResult {
  const stats = getGameStats(gameId, address);
  const today = todayKey();
  const awardedToday = stats.xpAwardedRunsByDate[today] ?? 0;

  if (awardedToday >= dailyCap) {
    return {
      awarded: false,
      xpGained: 0,
      dailyCapReached: true,
      awardResult: null,
    };
  }

  const result = awardXP(address, xpAction);

  stats.xpAwardedRunsByDate = {
    ...stats.xpAwardedRunsByDate,
    [today]: awardedToday + 1,
  };

  saveGameStats(stats);

  return {
    awarded: result.xpGained > 0,
    xpGained: result.xpGained,
    dailyCapReached: false,
    awardResult: result,
  };
}
