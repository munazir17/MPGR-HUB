import { describe, expect, it } from "vitest";
import {
  computeAllocations,
  computeRawWeight,
  computeWeeklyPool,
  getWeekBounds,
  getWeekKey,
} from "./settlement-engine";

describe("settlement engine", () => {
  it("uses the minimum of weekly cap, remaining budget and vault balance", () => {
    expect(computeWeeklyPool(100n, 200n)).toBe(100n);
  });

  it("never allocates more than the pool", () => {
    const allocations = computeAllocations(
      [
        { wallet: "0x1", rawWeight: 100 },
        { wallet: "0x2", rawWeight: 50 },
        { wallet: "0x3", rawWeight: 1 },
      ],
      1_000_000n,
    );
    expect(allocations.reduce((sum, item) => sum + item.amountRaw, 0n)).toBeLessThanOrEqual(1_000_000n);
  });

  it("caps and bounds raw weights", () => {
    expect(computeRawWeight({
      validRunCount: 10_000,
      bestScore: 10_000_000,
      seasonPointsEarnedThisWeek: 10_000_000,
    })).toBeLessThanOrEqual(100);
  });

  it("uses ISO week boundaries", () => {
    const date = new Date("2026-08-24T12:00:00.000Z");
    const key = getWeekKey(date);
    const { weekStart, weekEnd } = getWeekBounds(key);
    expect(weekStart.getUTCDay()).toBe(1);
    expect(weekEnd.getTime() - weekStart.getTime()).toBe(7 * 86_400_000);
    expect(weekStart.getTime()).toBeLessThan(date.getTime());
    expect(weekEnd.getTime()).toBeGreaterThan(date.getTime());
  });
});
