// lib/games/mpgr-run/difficulty.ts
//
// Centralized difficulty resolution. Every place that needs "how hard is
// the game right now" (the spawn manager, the HUD) calls resolveDifficulty()
// instead of re-deriving thresholds — the bands themselves live in
// run-config.ts so tuning always stays in one place.

import { DIFFICULTY_BANDS, type DifficultyBand } from "./run-config";

/**
 * Resolves the active DifficultyBand for a given distance traveled.
 *
 * DIFFICULTY_BANDS is ordered ascending by minDistanceM — this returns the
 * last band whose threshold has been crossed, defaulting to the first band
 * if somehow called before any distance has been covered.
 */
export function resolveDifficulty(distanceMeters: number): DifficultyBand {
  let current: DifficultyBand = DIFFICULTY_BANDS[0];

  for (const band of DIFFICULTY_BANDS) {
    if (distanceMeters >= band.minDistanceM) {
      current = band;
    } else {
      break;
    }
  }

  return current;
}
