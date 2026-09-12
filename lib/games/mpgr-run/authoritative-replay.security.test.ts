import { describe, expect, it } from "vitest";
import { replayAuthoritativeRun } from "./authoritative-replay";

const seed = "0".repeat(64);

const result = {
  distanceMeters: 0,
  durationMs: 0,
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
  score: 0,
};

describe("authoritative replay security validation", () => {
  it("rejects unsupported input event types", () => {
    const replay = replayAuthoritativeRun({
      seed,
      inputTrace: {
        version: 1,
        events: [
          {
            type: "teleport",
            atMs: 0,
          } as never,
        ],
      },
      result,
    });

    expect(replay.verified).toBe(false);
    expect(replay.reason).toBe("Unsupported input event type.");
  });

  it("rejects input timestamps that are off the fixed simulation clock", () => {
    const replay = replayAuthoritativeRun({
      seed,
      inputTrace: {
        version: 1,
        events: [
          {
            type: "jump",
            atMs: 1,
          },
        ],
      },
      result,
    });

    expect(replay.verified).toBe(false);
    expect(replay.reason).toBe(
      "Input timestamp is not aligned to the fixed simulation clock.",
    );
  });
});
