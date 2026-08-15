// lib/games/mpgr-run/run-score.ts
//
// Deterministic scoring: the same tracked inputs always produce the same
// score. No randomness anywhere in this file.

import {
  SCORE_PER_COIN,
  SCORE_PER_METER,
  SCORE_PER_OBSTACLE_PASSED,
  SCORE_PER_SECOND_SURVIVED,
} from "./run-config";

/** Raw tracked stats for a single MPGR Run — the inputs to scoring and validation. */
export interface RunStats {
  distanceMeters: number;
  durationMs: number;
  coinsCollected: number;
  obstaclesPassed: number;
  collided: boolean;
  maxSpeedTierReached: number; // 0-indexed tier the run reached before ending
}

export interface RunResult extends RunStats {
  score: number;
}

export function computeRunScore(stats: RunStats): number {
  const distancePoints = Math.floor(stats.distanceMeters) * SCORE_PER_METER;
  const coinPoints = stats.coinsCollected * SCORE_PER_COIN;
  const obstaclePoints = stats.obstaclesPassed * SCORE_PER_OBSTACLE_PASSED;
  const survivalPoints =
    Math.floor(stats.durationMs / 1000) * SCORE_PER_SECOND_SURVIVED;

  return (
    distancePoints +
    coinPoints +
    obstaclePoints +
    survivalPoints
  );
}

export function finalizeRun(stats: RunStats): RunResult {
  return { ...stats, score: computeRunScore(stats) };
}
