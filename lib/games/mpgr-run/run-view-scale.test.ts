import { describe, expect, it } from "vitest";
import { runVerticalScale } from "@/lib/games/mpgr-run/run-render";
import { MPGR_RUN_SIMULATION_WIDTH } from "@/lib/games/mpgr-run/authoritative-replay";

// The responsive renderer scales the game with the real viewport. The
// contract these tests lock:
//
//   1. phones never shrink below the current readable sizes (floor 1);
//   2. desktop widths scale the vertical gameplay units proportionally
//      with the horizontal fit (sx = w/960), so characters, obstacles
//      and hitboxes grow together instead of leaving tiny sprites in a
//      big canvas;
//   3. absurdly wide monitors are capped (2.25) so the game never gets
//      cartoonishly large;
//   4. the horizontal fit always shows the FULL simulation width —
//      entities spawn at x = MPGR_RUN_SIMULATION_WIDTH and the
//      authoritative replay verifies collisions in those fixed units,
//      so the field of view must never be cropped (that would change
//      reaction time, i.e. gameplay, not layout).
describe("runVerticalScale (responsive game scaling)", () => {
  it("floors at 1 on phone-width canvases — sprites keep today's readable sizes", () => {
    expect(runVerticalScale(320)).toBe(1);
    expect(runVerticalScale(390)).toBe(1);
    expect(runVerticalScale(480)).toBe(1);
  });

  it("is exactly 1 at the simulation width", () => {
    expect(runVerticalScale(MPGR_RUN_SIMULATION_WIDTH)).toBe(1);
  });

  it("scales proportionally on desktop widths", () => {
    expect(runVerticalScale(1024)).toBeCloseTo(1024 / MPGR_RUN_SIMULATION_WIDTH, 10);
    expect(runVerticalScale(1280)).toBeCloseTo(1280 / MPGR_RUN_SIMULATION_WIDTH, 10);
    expect(runVerticalScale(1920)).toBeCloseTo(1920 / MPGR_RUN_SIMULATION_WIDTH, 10);
  });

  it("caps at 2.25 on ultrawide viewports", () => {
    expect(runVerticalScale(2560)).toBe(2.25);
    expect(runVerticalScale(3440)).toBe(2.25);
  });

  it("never exceeds the horizontal fit — entities stay proportional or narrower, never bloated", () => {
    for (const w of [320, 480, 768, 1024, 1280, 1536, 1920, 2560, 3440]) {
      const sx = w / MPGR_RUN_SIMULATION_WIDTH;
      expect(runVerticalScale(w)).toBeLessThanOrEqual(Math.max(sx, 1) + 1e-9);
    }
  });

  it("is monotonically non-decreasing with viewport width", () => {
    let prev = 0;
    for (let w = 240; w <= 3200; w += 80) {
      const next = runVerticalScale(w);
      expect(next).toBeGreaterThanOrEqual(prev);
      prev = next;
    }
  });
});
