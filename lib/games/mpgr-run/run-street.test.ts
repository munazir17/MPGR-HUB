import { describe, expect, it, vi } from "vitest";
import { drawStreetArchitecture, streetScale, streetGround, streetLaneGap, STREET_GROUND, STREET_HORIZON } from "./run-street";
import { RUN_WORLD_THEMES } from "./run-environments";
import { drawRunFrame } from "./run-render";
import { freshWorld } from "./run-world";
import { collectiblePresentationHeight } from "./run-coin-presentation";

function recordingContext() {
  const calls: unknown[][] = [];
  const gradient = { addColorStop: (...args: unknown[]) => calls.push(["stop", ...args]) };
  const target = { calls } as unknown as CanvasRenderingContext2D;
  const ctx = new Proxy(target, {
    get: (t, key) => key in t ? Reflect.get(t, key) : (...args: unknown[]) => {
      calls.push([String(key), ...args]);
      return key === "createLinearGradient" || key === "createRadialGradient" ? gradient : undefined;
    },
    set: (t, key, value) => { calls.push([String(key), value]); return Reflect.set(t, key, value); },
  });
  return { ctx, calls };
}

describe("solid streets: projection, determinism and bounded work", () => {
  it("projects vertical edges upright and grounds the player depth exactly", () => {
    expect(streetScale(0)).toBe(1);
    for (const height of [320, 720, 844, 1024]) {
      expect(streetGround(height, 0)).toBe(height * STREET_GROUND);
      expect(streetGround(height, 5000)).toBeGreaterThan(height * STREET_HORIZON);
      expect(streetGround(height, 5000)).toBeLessThan(streetGround(height, 500));
    }
    expect(streetLaneGap(390, 844) * 3).toBeCloseTo(390 * 0.72);
    expect(streetLaneGap(1920, 720) * 3).toBeCloseTo(720 * 0.63);
  });

  for (const theme of Object.values(RUN_WORLD_THEMES)) {
    it(`${theme.id}: bounds texture work, culls walls, and produces finite coordinates`, () => {
      const {ctx, calls} = recordingContext();
      const image = { naturalWidth: 512, naturalHeight: 768 } as HTMLImageElement;
      drawStreetArchitecture(ctx, 390, 844, streetLaneGap(390,844)*1.5, 0, 3012, 8000, theme, image);
      const draws = calls.filter(c => c[0] === "drawImage");
      expect(draws.length).toBeGreaterThan(20);
      expect(draws.length).toBeLessThan(900);
      for (const call of calls) for (const n of call) if (typeof n === "number") expect(Number.isFinite(n)).toBe(true);
      // Every mapped source rectangle is inside the atlas.
      for (const call of draws) {
        const [, , sx, sy, sw, sh] = call as [string, unknown, number, number, number, number];
        expect(sx).toBeGreaterThanOrEqual(0); expect(sy).toBeGreaterThanOrEqual(0);
        expect(sx + sw).toBeLessThanOrEqual(512.00001); expect(sy + sh).toBeLessThanOrEqual(768.00001);
      }
    });
  }

  it("renders identical hit/jetpack frames without random reads or simulation writes", () => {
    const world = freshWorld(); world.elapsedMs = 5010; world.traveledPx = 3000;
    world.screenShake = 4; world.activePowerups.jetpack = 10000;
    const before = JSON.stringify(world);
    const random = vi.spyOn(Math, "random").mockImplementation(() => { throw Error("renderer read RNG"); });
    try {
      const a = recordingContext(), b = recordingContext();
      drawRunFrame(a.ctx, world, 390, 844, () => null);
      drawRunFrame(b.ctx, world, 390, 844, () => null);
      expect(JSON.stringify(a.calls)).toEqual(JSON.stringify(b.calls));
      expect(JSON.stringify(world)).toBe(before);
    } finally { random.mockRestore(); }
  });

  it("elevates only existing coins and keeps airborne height world-locked", () => {
    const coin = { id: 1, type: "coin" as const, lane: 1, x: 480, radius: 8, collected: false };
    const before = JSON.stringify(coin);
    const height = collectiblePresentationHeight(coin, 0, []);
    expect(height).toBeGreaterThan(0);
    expect(collectiblePresentationHeight({...coin, x: 380}, 100, [])).toBeCloseTo(height, 8);
    expect(JSON.stringify(coin)).toBe(before);
    expect(collectiblePresentationHeight({...coin, type: "gem"}, 0, [])).toBe(0);
  });
});
