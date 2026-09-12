import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { RunInputTrace } from "./input-trace";
import type { RunResult } from "./run-score";
import { verifyAuthoritativeRun } from "./authoritative-verifier";

const wallet = "0x0000000000000000000000000000000000000001" as Address;
const seed = "0000000000000000000000000000000000000000000000000000000000000001";

const trace: RunInputTrace = {
  version: 1,
  events: [],
};

const result: RunResult = {
  distanceMeters: 0,
  durationMs: 1000,
  coinsCollected: 0,
  gemsCollected: 0,
  xpOrbsCollected: 0,
  keysCollected: 0,
  chestsCollected: 0,
  powerupsCollected: 0,
  obstaclesPassed: 0,
  checkpointsReached: 0,
  bonusScore: 0,
  hitsTaken: 0,
  collided: false,
  maxSpeedTierReached: 0,
  score: 1,
};

function makeInput(overrides: Partial<Parameters<typeof verifyAuthoritativeRun>[0]> = {}) {
  return {
    sessionId: "test-session",
    wallet,
    result,
    inputTrace: trace,
    seed,
    protocolVersion: 1,
    sessionCreatedAt: "2026-09-12T00:00:00.000Z",
    sessionExpiresAt: "2026-09-12T01:00:00.000Z",
    ...overrides,
  };
}

describe("authoritative game verifier", () => {
  it("accepts a genuine deterministic terminal replay", () => {
    const verification = verifyAuthoritativeRun(
      makeInput({
        result: {
          distanceMeters: 361.9763888888887,
          durationMs: 14333,
          coinsCollected: 8,
          gemsCollected: 1,
          xpOrbsCollected: 1,
          keysCollected: 0,
          chestsCollected: 1,
          powerupsCollected: 1,
          obstaclesPassed: 8,
          checkpointsReached: 0,
          bonusScore: 0,
          hitsTaken: 3,
          collided: true,
          maxSpeedTierReached: 1,
          score: 726,
        },
      }),
    );

    expect(verification.verified).toBe(true);
    expect(verification.proofId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an unsupported protocol version", () => {
    const verification = verifyAuthoritativeRun(
      makeInput({ protocolVersion: 999 }),
    );

    expect(verification.verified).toBe(false);
    expect(verification.reason).toContain("Unsupported");
  });

  it("rejects an invalid server seed", () => {
    const verification = verifyAuthoritativeRun(
      makeInput({ seed: "not-a-valid-seed" }),
    );

    expect(verification.verified).toBe(false);
    expect(verification.reason).toContain("Invalid");
  });

  it("fails closed when the submitted result cannot be reproduced", () => {
    const verification = verifyAuthoritativeRun(
      makeInput({
        result: {
          ...result,
          durationMs: 1000,
          score: 999999,
        },
      }),
    );

    expect(verification.verified).toBe(false);
    expect(verification.reason).toContain("authoritative");
  });
});
