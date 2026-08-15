// lib/games/mpgr-run/run-score.ts
//
// Pure, deterministic scoring. Given the same RunStats, computeRunScore
// always returns the same number — no wall-clock reads, no randomness —
// so run-validation.ts can independently recompute a submitted score and
// reject anything that doesn't match.

import {
  SCORE_PER_METER,
  SCORE_PER_COIN,
  SCORE_PER_GEM,
  SCORE_PER_XP_ORB,
  SCORE_PER_KEY,
  SCORE_PER_CHEST,
  SCORE_PER_OBSTACLE_PASSED,
  SCORE_PER_SECOND_SURVIVED,
  SCORE_PER_CHECKPOINT,
} from "./run-config";

export interface RunStats {
  distanceMeters: number;
  durationMs: number;

  coinsCollected: number;
  gemsCollected: number;
  xpOrbsCollected: number;
  keysCollected: number;
  chestsCollected: number;
  powerupsCollected: number;

  obstaclesPassed: number;
  checkpointsReached: number;

  /**
   * Extra score earned from the score2x power-up. Kept separate from the
   * raw collectible counts above so achievements/stats always reflect real
   * pickups — 2x only ever inflates the *score* contribution, never a count.
   */
  bonusScore: number;

  /** How many times the player actually took damage (shield/invincibility/i-frame hits don't count). */
  hitsTaken: number;

  /** True if hitsTaken > 0 — kept as its own field for backward-compatible achievement semantics. */
  collided: boolean;

  maxSpeedTierReached: number;
}

export interface RunResult extends RunStats {
  score: number;
}

export function computeRunScore(stats: RunStats): number {
  const distancePoints = Math.floor(stats.distanceMeters) * SCORE_PER_METER;
  const coinPoints = stats.coinsCollected * SCORE_PER_COIN;
  const gemPoints = stats.gemsCollected * SCORE_PER_GEM;
  const xpOrbPoints = stats.xpOrbsCollected * SCORE_PER_XP_ORB;
  const keyPoints = stats.keysCollected * SCORE_PER_KEY;
  const chestPoints = stats.chestsCollected * SCORE_PER_CHEST;
  const obstaclePoints = stats.obstaclesPassed * SCORE_PER_OBSTACLE_PASSED;
  const survivalPoints = Math.floor(stats.durationMs / 1000) * SCORE_PER_SECOND_SURVIVED;
  const checkpointPoints = stats.checkpointsReached * SCORE_PER_CHECKPOINT;

  return (
    distancePoints +
    coinPoints +
    gemPoints +
    xpOrbPoints +
    keyPoints +
    chestPoints +
    obstaclePoints +
    survivalPoints +
    checkpointPoints +
    Math.max(0, stats.bonusScore)
  );
}

export function finalizeRun(stats: RunStats): RunResult {
  return { ...stats, score: computeRunScore(stats) };
}
