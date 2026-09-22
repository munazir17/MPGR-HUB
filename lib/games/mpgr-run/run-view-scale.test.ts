import { describe, expect, it } from "vitest";
import {
  RUN_MAX_VIEW_SCALE,
  RUN_MIN_VIEW_SCALE,
  runCameraOffsetX,
  runViewScale,
} from "@/lib/games/mpgr-run/run-render";
import { MPGR_RUN_SIMULATION_WIDTH } from "@/lib/games/mpgr-run/authoritative-replay";
import { PLAYER_X } from "@/lib/games/mpgr-run/run-config";

// The responsive game renderer uses ONE uniform scale + a camera window.
// The contract these tests lock:
//
//   1. uniform scaling — the player, obstacles, collectibles and
//      hitboxes all grow together with the viewport (no anisotropic
//      stretch, no thin sprites);
//   2. desktop/tablet: the FULL 960-unit simulation field stays visible
//      (entities spawn at x = 960 and the authoritative replay verifies
//      collisions in those fixed units, so cropping the field on a big
//      screen would cut reaction time);
//   3. phones: the scale is floored so gameplay objects stay clearly
//      visible; the field is cropped via runCameraOffsetX instead;
//   4. ultrawide: capped;
//   5. the camera window always keeps the player on screen.
describe("runViewScale (uniform responsive game scaling)", () => {
  it("is exactly the full-field fit on desktop/tablet widths", () => {
    expect(runViewScale(720)).toBe(720 / MPGR_RUN_SIMULATION_WIDTH);
    expect(runViewScale(1024)).toBeCloseTo(1024 / MPGR_RUN_SIMULATION_WIDTH, 10);
    expect(runViewScale(1280)).toBeCloseTo(1280 / MPGR_RUN_SIMULATION_WIDTH, 10);
    expect(runViewScale(1920)).toBeCloseTo(1920 / MPGR_RUN_SIMULATION_WIDTH, 10);
  });

  it("floors at the minimum on phone widths so gameplay objects stay visible", () => {
    expect(runViewScale(320)).toBe(RUN_MIN_VIEW_SCALE);
    expect(runViewScale(390)).toBe(RUN_MIN_VIEW_SCALE);
    expect(runViewScale(480)).toBe(RUN_MIN_VIEW_SCALE);
    // A phone player sprite is ~57 design units tall — at the floor it
    // renders ~43 px, square, instead of the old anamorphic 22x57 sliver.
    expect(57 * RUN_MIN_VIEW_SCALE).toBeGreaterThanOrEqual(40);
  });

  it("caps on ultrawide viewports", () => {
    expect(runViewScale(2560)).toBe(RUN_MAX_VIEW_SCALE);
    expect(runViewScale(3440)).toBe(RUN_MAX_VIEW_SCALE);
  });

  it("is monotonically non-decreasing with viewport width", () => {
    let prev = 0;
    for (let w = 240; w <= 3200; w += 80) {
      const next = runViewScale(w);
      expect(next).toBeGreaterThanOrEqual(prev);
      prev = next;
    }
  });
});

describe("runCameraOffsetX (camera window over the 960-unit field)", () => {
  const playerX = MPGR_RUN_SIMULATION_WIDTH * PLAYER_X;

  it("shows the full field (offset 0) whenever the whole 960 units fit", () => {
    for (const w of [720, 820, 1024, 1280, 1440, 1920]) {
      expect(runCameraOffsetX(w)).toBe(0);
    }
  });

  it("right-anchors past the field on capped ultrawide views — entities never pop in mid-screen", () => {
    for (const w of [2160, 2560, 3440]) {
      const u = runViewScale(w);
      const visible = w / u;
      const camX = runCameraOffsetX(w);
      expect(camX).toBe(MPGR_RUN_SIMULATION_WIDTH - visible);
      expect(camX + visible).toBe(MPGR_RUN_SIMULATION_WIDTH);
    }
  });

  it("crops narrow (phone) views but always keeps the player comfortably on screen", () => {
    for (const w of [320, 360, 390, 414, 480, 640]) {
      const u = runViewScale(w);
      const visible = w / u;
      const camX = runCameraOffsetX(w);
      expect(visible).toBeLessThan(MPGR_RUN_SIMULATION_WIDTH);
      // Player sits inside the window with run-up room behind it.
      expect(camX).toBeLessThanOrEqual(playerX - 100);
      expect(camX + visible).toBeLessThanOrEqual(MPGR_RUN_SIMULATION_WIDTH);
      // And never a negative offset in the cropped case.
      expect(camX).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps at least a base-speed beat of warning ahead of the player on phones", () => {
    // Obstacles spawn at x=960 but enter the window at camX+visible;
    // with the base scroll speed of 260 units/s the player must still
    // see an obstacle for a meaningful fraction of a second.
    for (const w of [320, 390, 480]) {
      const u = runViewScale(w);
      const edge = runCameraOffsetX(w) + w / u;
      const warningUnits = edge - playerX;
      expect(warningUnits / 260).toBeGreaterThanOrEqual(1.2); // seconds at base speed
    }
  });

  it("never moves when the field exactly fits", () => {
    const w = MPGR_RUN_SIMULATION_WIDTH * 1; // u = 1 exactly
    expect(runCameraOffsetX(w)).toBe(0);
  });
});
