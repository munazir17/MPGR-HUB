// lib/games/mpgr-run/run-validation.ts
//
// Client-side validation boundaries for a completed MPGR Run.
//
// IMPORTANT — this is NOT secure anti-cheat. It's a client-side sanity
// filter that rejects obviously impossible or tampered results (negative
// values, durations that don't match physically-possible distance/coin/
// obstacle counts, a recomputed score that doesn't match the submitted
// one, a resubmitted session id). A determined attacker who controls the
// client can still forge a "valid" result. Real competitive MPGR rewards
// will require server-side/authoritative verification — this module is
// structured so that a future server check can reuse the exact same
// bounds and just add signature/replay verification on top.

import type { ValidationResult } from "../game-types";
import {
  MAX_PLAUSIBLE_SPEED_MPS,
  MAX_SESSION_DURATION_MS,
  MIN_METERS_PER_COIN,
  MIN_METERS_PER_OBSTACLE,
  MIN_SESSION_DURATION_MS,
} from "./run-config";
import { computeRunScore, type RunResult } from "./run-score";

export function validateRunResult(
  result: RunResult,
  sessionId: string,
  processedSessionIds: string[]
): ValidationResult {
  const reasons: string[] = [];

  if (processedSessionIds.includes(sessionId)) {
    reasons.push("Duplicate session — this run has already been recorded.");
  }

  if (result.durationMs < MIN_SESSION_DURATION_MS) {
    reasons.push("Run duration is too short to be a real run.");
  }
  if (result.durationMs > MAX_SESSION_DURATION_MS) {
    reasons.push("Run duration exceeds the maximum allowed session length.");
  }

  if (
    result.distanceMeters < 0 ||
    result.coinsCollected < 0 ||
    result.obstaclesPassed < 0
  ) {
    reasons.push("Negative values are not possible.");
  }

  const durationSeconds = result.durationMs / 1000;
  const impliedSpeed =
    durationSeconds > 0 ? result.distanceMeters / durationSeconds : Infinity;

  if (impliedSpeed > MAX_PLAUSIBLE_SPEED_MPS) {
    reasons.push(
      "Distance is not achievable within the run's duration at any in-game speed."
    );
  }

  const maxPossibleCoins =
    result.distanceMeters / MIN_METERS_PER_COIN + 2;

  if (result.coinsCollected > maxPossibleCoins) {
    reasons.push(
      "Coin count exceeds what's possible for the distance covered."
    );
  }

  const maxPossibleObstacles =
    result.distanceMeters / MIN_METERS_PER_OBSTACLE + 2;

  if (result.obstaclesPassed > maxPossibleObstacles) {
    reasons.push(
      "Obstacle-passed count exceeds what's possible for the distance covered."
    );
  }

  const recomputedScore = computeRunScore(result);

  if (recomputedScore !== result.score) {
    reasons.push(
      "Submitted score does not match the deterministic score formula."
    );
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}
