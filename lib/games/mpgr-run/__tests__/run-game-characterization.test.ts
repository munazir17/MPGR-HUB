import { describe, expect, it } from "vitest";
import { freshWorld } from "@/lib/games/mpgr-run/run-world";
import { snapDurationToSimulationTicks } from "@/lib/games/mpgr-run/input-trace";
import { finalizeRun } from "@/lib/games/mpgr-run/run-score";
import {
  STARTING_HP,
  LANE_COUNT,
  SPEED_TIERS,
  RAMP_DURATION_MS,
  PX_PER_METER,
} from "@/lib/games/mpgr-run/run-config";
import { clamp } from "@/lib/games/mpgr-run/run-physics";

describe("RunGame simulation and HUD contracts (Task 13 Characterization)", () => {
  it("initializes freshWorld with standard starting conditions", () => {
    const world = freshWorld();
    expect(world.player.hp).toBe(STARTING_HP);
    expect(world.player.lane).toBe(1); // middle lane
    expect(world.player.playerY).toBe(0);
    expect(world.player.velocityY).toBe(0);
    expect(world.player.sliding).toBe(false);
    expect(world.traveledPx).toBe(0);
    expect(world.elapsedMs).toBe(0);
    expect(world.gameOver).toBe(false);
    expect(world.obstacles).toEqual([]);
    expect(world.collectibles).toEqual([]);
    expect(world.powerups).toEqual([]);
  });

  it("clamps lane changes correctly within [0, LANE_COUNT - 1]", () => {
    let lane = 1;
    // shift left
    lane = clamp(lane - 1, 0, LANE_COUNT - 1);
    expect(lane).toBe(0);
    // shift left again (should remain at 0)
    lane = clamp(lane - 1, 0, LANE_COUNT - 1);
    expect(lane).toBe(0);

    // shift right twice
    lane = clamp(lane + 1, 0, LANE_COUNT - 1);
    expect(lane).toBe(1);
    lane = clamp(lane + 1, 0, LANE_COUNT - 1);
    expect(lane).toBe(2);
    // shift right again (should remain at 2)
    lane = clamp(lane + 1, 0, LANE_COUNT - 1);
    expect(lane).toBe(2);
  });

  it("calculates run stats matching snapDurationToSimulationTicks", () => {
    const world = freshWorld();
    world.traveledPx = 1000;
    world.elapsedMs = 1234.56;
    world.stats.coins = 12;
    world.stats.gems = 3;

    const stats = {
      distanceMeters: world.traveledPx / PX_PER_METER,
      durationMs: snapDurationToSimulationTicks(world.elapsedMs),
      coinsCollected: world.stats.coins,
      gemsCollected: world.stats.gems,
      xpOrbsCollected: world.stats.xpOrbs,
      keysCollected: world.stats.keys,
      chestsCollected: world.stats.chests,
      powerupsCollected: world.stats.powerups,
      obstaclesPassed: world.stats.obstaclesPassed,
      checkpointsReached: world.stats.checkpoints,
      bonusScore: world.bonusScore,
      hitsTaken: world.stats.hits,
      collided: world.stats.hits > 0,
      maxSpeedTierReached: Math.floor(Math.min(1, world.elapsedMs / RAMP_DURATION_MS) * SPEED_TIERS),
    };

    const finalized = finalizeRun(stats);
    expect(finalized.distanceMeters).toBe(world.traveledPx / PX_PER_METER);
    expect(finalized.coinsCollected).toBe(12);
    expect(finalized.score).toBeGreaterThan(0);
  });
});
