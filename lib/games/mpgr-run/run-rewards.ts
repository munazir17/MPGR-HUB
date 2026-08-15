// lib/games/mpgr-run/run-rewards.ts
//
// Orchestrates what happens after a run ends: validate → update this
// wallet's MPGR Run stats → grant capped XP via the existing XP engine →
// report which achievements newly unlocked. Season Points are NOT granted
// directly (see lib/games/game-rewards.ts) — they fall out of the XP
// award automatically via lib/xp-engine.ts's getSeasonPoints().

import { getAchievements, getUserRecord, type GameAchievementStats } from "@/lib/xp-engine";
import { getGameStats, saveGameStats } from "../game-storage";
import { awardCappedRunXP } from "../game-rewards";
import type { GameRewardOutcome, GameStatsRecord } from "../game-types";
import { validateRunResult } from "./run-validation";
import type { RunResult } from "./run-score";
import {
  DAILY_XP_RUN_CAP,
  MPGR_RUN_GAME_ID,
  NO_COLLISION_ACHIEVEMENT_MIN_DISTANCE,
  SPEED_TIERS,
} from "./run-config";

export function toGameAchievementStats(stats: GameStatsRecord): GameAchievementStats {
  return {
    totalRuns: stats.totalRuns,
    bestDistance: stats.bestDistance,
    noCollisionRuns: stats.noCollisionRuns,
    totalCoinsCollected: stats.totalCoinsCollected,
  };
}

export interface ProcessRunResultOutcome extends GameRewardOutcome {
  valid: boolean;
  validationReasons: string[];
  updatedStats: GameStatsRecord;
  isNewPersonalBest: boolean;
}

export function processRunResult(
  address: string,
  sessionId: string,
  result: RunResult
): ProcessRunResultOutcome {
  const stats = getGameStats(MPGR_RUN_GAME_ID, address);
  const validation = validateRunResult(result, sessionId, stats.processedSessionIds);

  const statsBefore = toGameAchievementStats(stats);
  const xpRecord = getUserRecord(address);
  const achievementsBefore = new Set(
    getAchievements(xpRecord, statsBefore)
      .filter((a) => a.unlocked)
      .map((a) => a.id)
  );

  stats.totalRuns += 1;
  stats.lastPlayedAt = new Date().toISOString();
  stats.processedSessionIds = [...stats.processedSessionIds, sessionId];

  const isNewPersonalBest = validation.valid && result.score > stats.bestScore;

  if (validation.valid) {
    stats.totalValidRuns += 1;
    stats.bestScore = Math.max(stats.bestScore, result.score);
    stats.bestDistance = Math.max(stats.bestDistance, result.distanceMeters);
    stats.bestCoins = Math.max(stats.bestCoins, result.coinsCollected);
    stats.bestDurationMs = Math.max(stats.bestDurationMs, result.durationMs);
    stats.totalCoinsCollected += result.coinsCollected;
    stats.maxSpeedTierReached = Math.max(
      stats.maxSpeedTierReached,
      Math.min(result.maxSpeedTierReached, SPEED_TIERS)
    );
    if (!result.collided && result.distanceMeters >= NO_COLLISION_ACHIEVEMENT_MIN_DISTANCE) {
      stats.noCollisionRuns += 1;
    }
  }

  saveGameStats(stats);

  let xpAwarded = 0;
  let xpAwardedReason: string | null = null;
  let dailyCapReached = false;

  if (validation.valid) {
    const xpResult = awardCappedRunXP(
      MPGR_RUN_GAME_ID,
      address,
      "GAME_MPGR_RUN_COMPLETE",
      DAILY_XP_RUN_CAP
    );
    xpAwarded = xpResult.xpGained;
    dailyCapReached = xpResult.dailyCapReached;
    xpAwardedReason = xpResult.awarded
      ? "Completed run"
      : xpResult.dailyCapReached
      ? "Daily XP cap reached for MPGR Run"
      : null;
  } else {
    xpAwardedReason = "Run did not pass validation";
  }

  const statsAfter = toGameAchievementStats(stats);
  const xpRecordAfter = getUserRecord(address);
  const achievementsAfter = getAchievements(xpRecordAfter, statsAfter).filter((a) => a.unlocked);
  const newlyUnlockedAchievementIds = achievementsAfter
    .filter((a) => !achievementsBefore.has(a.id))
    .map((a) => a.id);

  return {
    valid: validation.valid,
    validationReasons: validation.reasons,
    updatedStats: stats,
    isNewPersonalBest,
    xpAwarded,
    xpAwardedReason,
    seasonPointsContribution: xpAwarded,
    dailyCapReached,
    newlyUnlockedAchievementIds,
  };
}
