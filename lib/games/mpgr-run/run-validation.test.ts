import { describe, expect, it } from "vitest";
import { computeRunScore } from "./run-score";
import { validateRunResult } from "./run-validation";
import type { RunResult } from "./run-score";

const base: RunResult = {
  distanceMeters: 120,
  durationMs: 10_000,
  coinsCollected: 2,
  gemsCollected: 1,
  xpOrbsCollected: 0,
  keysCollected: 0,
  chestsCollected: 0,
  powerupsCollected: 0,
  obstaclesPassed: 1,
  checkpointsReached: 0,
  bonusScore: 0,
  hitsTaken: 0,
  collided: false,
  maxSpeedTierReached: 1,
  score: 0,
};

function validResult(overrides: Partial<RunResult> = {}): RunResult {
  const result = { ...base, ...overrides };
  return { ...result, score: computeRunScore(result) };
}

describe("validateRunResult", () => {
  it("accepts an internally consistent plausible result", () => {
    expect(validateRunResult(validResult(), "server-session-1", []).valid).toBe(true);
  });

  it("rejects a score that does not match the deterministic formula", () => {
    expect(validateRunResult({ ...validResult(), score: 1 }, "server-session-2", []).valid).toBe(false);
  });

  it("rejects impossible negative values", () => {
    const result = validResult({ coinsCollected: -1 });
    expect(validateRunResult(result, "server-session-3", []).valid).toBe(false);
  });

  it("rejects a replay when the session id is already processed", () => {
    expect(validateRunResult(validResult(), "server-session-4", ["server-session-4"]).valid).toBe(false);
  });
});
