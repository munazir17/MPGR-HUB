import { describe, expect, it } from "vitest";
import { clamp, laneBaselineScreenY, verticalOverlap } from "./run-physics";
import { LANE_CENTER_Y, LANE_GAP_PX, PLAYER_SIZE, SLIDE_HITBOX_SCALE } from "./run-config";
import type { ObstacleEntity } from "./spawn-manager";

function obstacle(overrides: Partial<ObstacleEntity>): ObstacleEntity {
  return {
    id: 1,
    type: "spikes",
    x: 100,
    lane: 1,
    width: 26,
    height: 24,
    groundHeight: 0,
    hit: false,
    passed: false,
    ...overrides,
  };
}

describe("run physics", () => {
  it("clamps to the inclusive range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it("places lane baselines using the shared config", () => {
    expect(laneBaselineScreenY(1000, 1)).toBe(1000 * LANE_CENTER_Y);
    expect(laneBaselineScreenY(1000, 2)).toBe(1000 * LANE_CENTER_Y + LANE_GAP_PX);
  });

  it("treats tnt and barrier as blocking the whole vertical band", () => {
    const standing = { sliding: false, playerY: 80 };
    expect(verticalOverlap(obstacle({ type: "tnt" }), standing)).toBe(true);
    expect(verticalOverlap(obstacle({ type: "barrier" }), standing)).toBe(true);
  });

  it("lets a jump clear a ground spike and a slide duck a high saw", () => {
    const jumping = { sliding: false, playerY: PLAYER_SIZE + 10 };
    expect(verticalOverlap(obstacle({ type: "spikes", height: 24, groundHeight: 0 }), jumping)).toBe(false);

    const sliding = { sliding: true, playerY: 0 };
    const saw = obstacle({ type: "saw", height: 28, groundHeight: 20 });
    const slideTop = PLAYER_SIZE * SLIDE_HITBOX_SCALE;
    expect(slideTop).toBeLessThan(saw.groundHeight);
    expect(verticalOverlap(saw, sliding)).toBe(false);
  });
});
