import { describe, expect, it } from "vitest";

import { drawRunFrame } from "@/lib/games/mpgr-run/run-render";
import { freshWorld, type World } from "@/lib/games/mpgr-run/run-world";
import { ENVIRONMENT_SETS } from "@/lib/games/mpgr-run/run-assets";
import {
  resolveRunWorld,
  resolveRunWorldFromPx,
  RUN_WORLD_LENGTH_M,
  RUN_WORLD_ORDER,
} from "@/lib/games/mpgr-run/run-environments";
import { PX_PER_METER } from "@/lib/games/mpgr-run/run-config";

/**
 * World-environment contract (next-gen visual upgrade, PR #62 follow-up):
 *   1. distance-based world cycling is deterministic, cyclic and continuous
 *      (fog peaks exactly at the boundary that hides the swap);
 *   2. the renderer surrounds the playable track with world art on BOTH
 *      sides and connects the road to the horizon (no black void);
 *   3. each world draws its own environment set;
 *   4. presentation only: resolving/drawing worlds never mutates the sim.
 */

interface StubImage {
  tag: string;
  naturalWidth: number;
  naturalHeight: number;
}

interface Call {
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
  fill?: unknown;
}

class EnvRecordingCtx {
  calls: Call[] = [];
  rects: Call[] = [];
  numbers: number[] = [];
  private m = [1, 0, 0, 1, 0, 0];
  private stack: number[][] = [];
  globalAlpha = 1;
  fillStyle: unknown = null;
  strokeStyle: unknown = null;
  lineWidth = 1;
  shadowColor: unknown = null;
  shadowBlur = 0;

  private tx(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.m;
    return [a * x + c * y + e, b * x + d * y + f];
  }
  private box(x: number, y: number, w: number, h: number) {
    const cs = [this.tx(x, y), this.tx(x + w, y), this.tx(x, y + h), this.tx(x + w, y + h)];
    const xs = cs.map((c) => c[0]);
    const ys = cs.map((c) => c[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    this.numbers.push(minX, maxX, minY, maxY);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  save() { this.stack.push([...this.m]); }
  restore() { const p = this.stack.pop(); if (p) this.m = p; }
  scale(sx: number, sy: number) {
    const [a, b, c, d, e, f] = this.m;
    this.m = [a * sx, b * sx, c * sy, d * sy, e, f];
  }
  translate(tx: number, ty: number) {
    const [a, b, c, d, e, f] = this.m;
    this.m = [a, b, c, d, a * tx + c * ty + e, b * tx + d * ty + f];
  }
  rotate(r: number) {
    const [a, b, c, d, e, f] = this.m;
    const cos = Math.cos(r), sin = Math.sin(r);
    this.m = [a * cos + c * sin, b * cos + d * sin, a * -sin + c * cos, b * -sin + d * cos, e, f];
  }
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  arc() {}
  ellipse() {}
  quadraticCurveTo() {}
  fill() {}
  stroke() {}
  clip() {}
  clearRect() {}
  fillRect(x: number, y: number, w: number, h: number) {
    this.rects.push({ ...this.box(x, y, w, h), tag: "rect", alpha: this.globalAlpha, fill: this.fillStyle });
  }
  drawImage(img: StubImage, x: number, y: number, w: number, h: number) {
    this.calls.push({ ...this.box(x, y, w, h), tag: img.tag, alpha: this.globalAlpha });
  }
  createLinearGradient() { return { addColorStop: () => undefined }; }
  createRadialGradient() { return { addColorStop: () => undefined }; }
}

function makeGetSprite(): (src: string) => CanvasImageSource | null {
  return (src: string) =>
    ({
      tag: src,
      naturalWidth: src.includes("skyline") ? 1280 : src.includes("-side") ? 340 : 160,
      naturalHeight: src.includes("skyline") ? 400 : src.includes("-side") ? 640 : 320,
    }) as unknown as CanvasImageSource;
}

function worldAt(meters: number): World {
  const world = freshWorld();
  world.elapsedMs = 6000;
  world.traveledPx = meters * PX_PER_METER;
  return world;
}

describe("resolveRunWorld (presentation-only distance cycling)", () => {
  it("starts in the city and cycles city -> ice -> desert -> city", () => {
    expect(resolveRunWorld(0).current).toBe("city");
    expect(resolveRunWorld(RUN_WORLD_LENGTH_M * 1.5).current).toBe("ice");
    expect(resolveRunWorld(RUN_WORLD_LENGTH_M * 2.5).current).toBe("desert");
    expect(resolveRunWorld(RUN_WORLD_LENGTH_M * 3.5).current).toBe("city");
    // Negative/odd inputs stay valid (defensive modulo).
    expect(resolveRunWorld(-10).current).toBe(RUN_WORLD_ORDER[2]);
  });

  it("peaks fog exactly at the boundary and stays clear mid-world", () => {
    expect(resolveRunWorld(RUN_WORLD_LENGTH_M * 0.5).fade).toBe(0);
    const atBoundary = resolveRunWorld(RUN_WORLD_LENGTH_M);
    expect(atBoundary.fade).toBeCloseTo(1, 5);
    // Continuous across the swap: just before and just after both ~1.
    expect(resolveRunWorld(RUN_WORLD_LENGTH_M - 0.5).fade).toBeGreaterThan(0.9);
    expect(resolveRunWorld(RUN_WORLD_LENGTH_M + 0.5).fade).toBeGreaterThan(0.9);
    // The swap target is advertised for the fade-in half.
    expect(resolveRunWorld(RUN_WORLD_LENGTH_M - 1).next).toBe("ice");
  });

  it("matches the px-based helper used by the renderer", () => {
    const meters = 620;
    expect(resolveRunWorldFromPx(meters * PX_PER_METER)).toEqual(resolveRunWorld(meters));
  });

  it("is pure presentation: resolving never mutates world state", () => {
    const world = worldAt(620);
    const before = JSON.stringify(world);
    resolveRunWorldFromPx(world.traveledPx);
    expect(JSON.stringify(world)).toBe(before);
  });
});

describe("world rendering surrounds the track (no black void)", () => {
  const vw = 390;
  const vh = 844;

  function frame(meters: number): EnvRecordingCtx {
    const ctx = new EnvRecordingCtx();
    drawRunFrame(ctx as unknown as CanvasRenderingContext2D, worldAt(meters), vw, vh, makeGetSprite());
    return ctx;
  }

  for (const [meters, worldId] of [
    [120, "city"],
    [620, "ice"],
    [1060, "desert"],
  ] as Array<[number, keyof typeof ENVIRONMENT_SETS]>) {
    it(`draws the ${worldId} environment on both sides and at the horizon`, () => {
      const ctx = frame(meters);
      const set = ENVIRONMENT_SETS[worldId];
      const sides = ctx.calls.filter((c) => c.tag === set.side || c.tag === set.prop);
      expect(sides.length).toBeGreaterThan(4);
      const left = sides.filter((c) => c.x + c.w / 2 < vw * 0.32);
      const right = sides.filter((c) => c.x + c.w / 2 > vw * 0.68);
      expect(left.length).toBeGreaterThan(0);
      expect(right.length).toBeGreaterThan(0);
      // Skyline panorama sits on the horizon band.
      const sky = ctx.calls.filter((c) => c.tag === set.skyline);
      expect(sky.length).toBeGreaterThan(0);
      for (const band of sky) {
        expect(band.y + band.h).toBeLessThan(vh * 0.42);
        expect(band.y + band.h).toBeGreaterThan(vh * 0.3);
      }
      // Full-width ground fill covers the lower screen (no void rows).
      const ground = ctx.rects.filter(
        (r) => r.x <= 0 && r.x + r.w >= vw && r.y < vh * 0.5 && r.y + r.h >= vh,
      );
      expect(ground.length).toBeGreaterThan(0);
      // Near scenery instances are big, far ones small (perspective).
      const widths = sides.map((c) => c.w);
      expect(Math.max(...widths)).toBeGreaterThan(2 * Math.min(...widths));
    });
  }

  it("keeps the rear runner grounded while the world changes", () => {
    for (const meters of [120, 620, 1060]) {
      const ctx = frame(meters);
      const player = ctx.calls.find((c) => c.tag.includes("/character/mpgr-runner-rear-"));
      expect(player, `rear runner drawn at ${meters}m`).toBeTruthy();
      expect(player!.y + player!.h).toBeCloseTo(vh * 0.82, 1);
    }
  });

  it("lays a fog wall over the frame exactly at the world boundary", () => {
    const clear = frame(RUN_WORLD_LENGTH_M * 0.5);
    const fogged = frame(RUN_WORLD_LENGTH_M - 0.2);
    const covers = (ctx: EnvRecordingCtx) =>
      ctx.rects.some(
        (r) =>
          typeof r.fill === "string" &&
          r.x <= 0 && r.y <= 0 && r.x + r.w >= vw && r.y + r.h >= vh && r.alpha > 0.5,
      );
    expect(covers(clear)).toBe(false);
    expect(covers(fogged)).toBe(true);
  });

  it("emits only finite coordinates in every world", () => {
    for (const meters of [0, 120, 449, 451, 620, 1060, 1349]) {
      const ctx = frame(meters);
      for (const n of ctx.numbers) {
        expect(Number.isFinite(n)).toBe(true);
      }
    }
  });
});
