import { describe, expect, it } from "vitest";

import { drawRunFrame, runViewScale, RUN_FRAME_ALIGN_X, RUN_FRAME_START_MS, RUN_STRIDE_MS } from "@/lib/games/mpgr-run/run-render";
import { freshWorld, type World } from "@/lib/games/mpgr-run/run-world";
import { ENVIRONMENT_SETS } from "@/lib/games/mpgr-run/run-assets";
import {
  resolveRunWorld,
  resolveRunWorldFromPx,
  runTransitionFogFromPx,
  RUN_WORLD_LENGTH_M,
  RUN_WORLD_ORDER,
  RUN_WORLD_THEMES,
} from "@/lib/games/mpgr-run/run-environments";
import { stepSimulation } from "@/components/features/games/mpgr-run/RunGameSimulation";
import { collectiblePresentationHeight } from "./run-coin-presentation";
import { STREET_GROUND, STREET_HORIZON, RUNNER_HEIGHT_FRACTION, streetLaneGap } from "./run-street";
import { COLLECTIBLE_TYPES, PLAYER_X, PLAYER_SIZE } from "@/lib/games/mpgr-run/run-config";
import { MPGR_RUN_SIMULATION_WIDTH } from "@/lib/games/mpgr-run/authoritative-replay";
import { createDeterministicRng } from "@/lib/games/mpgr-run/deterministic-rng";
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
  polys: Call[] = [];
  private pts: number[][] = [];
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
  beginPath() { this.pts = []; }
  closePath() {}
  moveTo(x: number, y: number) { this.pts.push(this.tx(x, y)); }
  lineTo(x: number, y: number) { this.pts.push(this.tx(x, y)); }
  arc() {}
  ellipse() {}
  quadraticCurveTo() {}
  fill() {
    if (this.pts.length > 2) {
      const xs = this.pts.map((p) => p[0]);
      const ys = this.pts.map((p) => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      this.polys.push({ tag: "poly", x: minX, y: minY, w: maxX - minX, h: maxY - minY, alpha: this.globalAlpha, fill: this.fillStyle });
      this.numbers.push(minX, maxX, minY, maxY);
    }
    this.pts = [];
  }
  stroke() { this.pts = []; }
  clip() {}
  clearRect() {}
  fillRect(x: number, y: number, w: number, h: number) {
    this.rects.push({ ...this.box(x, y, w, h), tag: "rect", alpha: this.globalAlpha, fill: this.fillStyle });
  }
  drawImage(img: StubImage, ...args: number[]) {
    const [x, y, w, h] = args.length === 8 ? args.slice(4) : args;
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
      const sides = ctx.calls.filter((c) => c.tag === set.facade || c.tag === set.prop);
      expect(sides.length).toBeGreaterThan(4);
      const left = sides.filter((c) => c.x + c.w / 2 < vw * 0.32);
      const right = sides.filter((c) => c.x + c.w / 2 > vw * 0.68);
      expect(left.length).toBeGreaterThan(0);
      expect(right.length).toBeGreaterThan(0);
      // Skyline panorama sits on the horizon band.
      const sky = ctx.calls.filter((c) => c.tag === set.skyline);
      expect(sky.length).toBeGreaterThan(0);
      for (const band of sky) {
        expect(band.y + band.h).toBeLessThan(vh * (STREET_HORIZON + 0.01));
        expect(band.y + band.h).toBeGreaterThan(vh * (STREET_HORIZON - 0.01));
      }
      // Full-width ground fill covers the lower screen (no void rows).
      const ground = ctx.rects.filter(
        (r) => r.x <= 0 && r.x + r.w >= vw && r.y <= vh * STREET_HORIZON && r.y + r.h >= vh,
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
      expect(player!.y + player!.h).toBeCloseTo(vh * STREET_GROUND, 1);
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

describe("world integration details (visual-polish pass)", () => {
  const vw = 390;
  const vh = 844;

  function frame(meters: number): EnvRecordingCtx {
    const ctx = new EnvRecordingCtx();
    drawRunFrame(ctx as unknown as CanvasRenderingContext2D, worldAt(meters), vw, vh, makeGetSprite());
    return ctx;
  }

  it("lays themed curb/shoulder strips on both sides of the track", () => {
    for (const [meters, worldId] of [
      [120, "city"],
      [620, "ice"],
      [1060, "desert"],
    ] as Array<[number, keyof typeof RUN_WORLD_THEMES]>) {
      const ctx = frame(meters);
      const curbs = ctx.polys.filter((p) => p.fill === RUN_WORLD_THEMES[worldId].curb);
      expect(curbs.length, `${worldId} curbs`).toBe(2);
      const left = curbs.some((c) => c.x + c.w / 2 < vw / 2);
      const right = curbs.some((c) => c.x + c.w / 2 > vw / 2);
      expect(left && right).toBe(true);
    }
  });

  it("elevates existing real coins without adding client-only spawns", () => {
    const world = worldAt(0);
    const rng = createDeterministicRng(7);
    let nextId = 9000, elevated = 0;
    for (let i = 0; i < 60 * 15; i++) {
      stepSimulation(world, 1 / 60, () => nextId++, rng);
      for (const c of world.collectibles) {
        if (collectiblePresentationHeight(c, world.traveledPx, world.obstacles) > 0) elevated++;
        expect(c.airHeight).toBeUndefined(); // no simulation-side formation data
      }
    }
    expect(elevated).toBeGreaterThan(0);
  });

  it("renders airborne coins above the grounded track line", () => {
    const world = worldAt(0);
    const rng = createDeterministicRng(7);
    let nextId = 9000;
    // Advance until an arc coin is in the near-depth window (s >= ~0.5),
    // i.e. clearly visible above the track in front of the runner.
    const playerDepth = MPGR_RUN_SIMULATION_WIDTH * PLAYER_X;
    let placed = false;
    for (let i = 0; i < 60 * 90 && !placed; i++) {
      stepSimulation(world, 1 / 60, () => nextId++, rng);
      placed = world.collectibles.some((c) => {
        if (collectiblePresentationHeight(c, world.traveledPx, world.obstacles) <= 24) return false;
        const z = c.x - playerDepth;
        return z > 20 && z < 240;
      });
    }
    expect(placed, "arc coin reached near depth").toBe(true);
    const ctx = new EnvRecordingCtx();
    drawRunFrame(ctx as unknown as CanvasRenderingContext2D, world, vw, vh, makeGetSprite());
    const radius = COLLECTIBLE_TYPES.coin.radius;
    const coins = ctx.calls.filter((c) => c.tag.includes("collectible") || c.tag.includes("coin"));
    // Recover each coin's perspective scale from its drawn size, then compare
    // its centre height against the lane baseline at that same scale:
    // grounded coins sit 8..20*s above it, airborne arc coins >= 34*s.
    const u = runViewScale(vw);
    const airborne = coins.filter((c) => {
      const sc = c.h / (radius * 3.4 * vh * RUNNER_HEIGHT_FRACTION / (PLAYER_SIZE * 2.4)); // recover perspective scale
      if (sc < 0.45 || sc > 2.6) return false;
      const gy = vh * (STREET_HORIZON + (STREET_GROUND - STREET_HORIZON) * sc);
      return gy - (c.y + c.h / 2) > 24 * sc * u;
    });
    expect(airborne.length).toBeGreaterThan(0);
  });

  it("keeps the run cycle head-stable: feet grounded, shifts bounded by the alignment table", () => {
    const vw2 = 900;
    const vh2 = 600;
    const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (let f = 0; f < 4; f++) {
      const world = worldAt(120);
      world.elapsedMs = RUN_STRIDE_MS * 4 + RUN_FRAME_START_MS[f] + 10; // cycle index == f
      const ctx = new EnvRecordingCtx();
      drawRunFrame(ctx as unknown as CanvasRenderingContext2D, world, vw2, vh2, makeGetSprite());
      const p = ctx.calls.find((c) => c.tag.includes("/character/mpgr-runner-rear-run-"));
      expect(p, `frame ${f}`).toBeTruthy();
      boxes.push({ x: p!.x, y: p!.y, w: p!.w, h: p!.h });
    }
    for (let f = 1; f < 4; f++) {
      // Feet stay exactly grounded across the whole cycle.
      expect(boxes[f].y + boxes[f].h).toBeCloseTo(boxes[0].y + boxes[0].h, 6);
      // Horizontal shift between consecutive frames is exactly the measured
      // head-sway correction (no other oscillation source).
      const expected = (RUN_FRAME_ALIGN_X[f] - RUN_FRAME_ALIGN_X[f - 1]) * boxes[f].w;
      expect(boxes[f].x - boxes[f - 1].x).toBeCloseTo(expected, 6);
      expect(Math.abs(boxes[f].x - boxes[f - 1].x)).toBeLessThan(boxes[f].w * 0.04);
    }
  });
});

describe("street placement contracts (no penetration / no dead gaps)", () => {
  const vw = 390;
  const vh = 844;

  function frame(meters: number): EnvRecordingCtx {
    const ctx = new EnvRecordingCtx();
    drawRunFrame(ctx as unknown as CanvasRenderingContext2D, worldAt(meters), vw, vh, makeGetSprite());
    return ctx;
  }

  function sideBoxes(ctx: EnvRecordingCtx) {
    return ctx.calls.filter(
      (c) => c.tag.includes("-side") || c.tag.includes("-props"),
    );
  }

  it("keeps every roadside structure outside the playable track", () => {
    for (const meters of [120, 620, 1060]) {
      const ctx = frame(meters);
      for (const b of sideBoxes(ctx)) {
        // Recover the instance depth from its grounded base line.
        const sRoad = ((b.y + b.h) / vh - STREET_HORIZON) / (STREET_GROUND - STREET_HORIZON);
        if (sRoad <= 0.05 || sRoad > 2.6) continue;
        const trackHalfScreen = streetLaneGap(vw, vh) * 1.5 * sRoad;
        const inner = b.x + b.w / 2 < vw / 2 ? b.x + b.w : b.x;
        const edge = vw / 2 + (b.x + b.w / 2 < vw / 2 ? -trackHalfScreen : trackHalfScreen);
        if (b.x + b.w / 2 < vw / 2) {
          expect(inner, `left structure at ${meters}m`).toBeLessThanOrEqual(edge + 2);
        } else {
          expect(inner, `right structure at ${meters}m`).toBeGreaterThanOrEqual(edge - 2);
        }
      }
    }
  });

  it("has roadside content in every depth band on both sides (no dead gaps)", () => {
    for (const meters of [120, 620, 1060]) {
      const ctx = frame(meters);
      const boxes = ctx.calls.filter((c) => c.tag.includes("-facade"));
      for (const band of [0.42, 0.52, 0.62, 0.72]) {
        const y = vh * band;
        const hit = boxes.filter((b) => b.y <= y && b.y + b.h >= y);
        expect(hit.some((b) => b.x + b.w / 2 < vw / 2), `left band ${band} @${meters}m`).toBe(true);
        expect(hit.some((b) => b.x + b.w / 2 > vw / 2), `right band ${band} @${meters}m`).toBe(true);
      }
    }
  });

  it("grounds every structure exactly on its depth ground line", () => {
    const ctx = frame(120);
    for (const b of sideBoxes(ctx)) {
      const sRoad = ((b.y + b.h) / vh - STREET_HORIZON) / (STREET_GROUND - STREET_HORIZON);
      if (sRoad <= 0.05 || sRoad > 2.6) continue;
      const gy = vh * (STREET_HORIZON + (STREET_GROUND - STREET_HORIZON) * sRoad);
      expect(b.y + b.h).toBeCloseTo(gy, 1);
    }
  });

  it("draws continuous street-light rows along both curbs", () => {
    for (const [meters, worldId] of [
      [120, "city"],
      [620, "ice"],
      [1060, "desert"],
    ] as Array<[number, keyof typeof RUN_WORLD_THEMES]>) {
      const ctx = frame(meters);
      const lights = ctx.rects.filter((r) => r.fill === RUN_WORLD_THEMES[worldId].curbEdge && r.w < 12);
      const left = lights.filter((r) => r.x + r.w / 2 < vw / 2);
      const right = lights.filter((r) => r.x + r.w / 2 > vw / 2);
      expect(left.length, `${worldId} left lights`).toBeGreaterThan(3);
      expect(right.length, `${worldId} right lights`).toBeGreaterThan(3);
    }
  });
});


describe("presentation fog colour continuity", () => {
  it("does not switch colour at any world boundary, including the cycle wrap", () => {
    for (const boundary of [0, 450, 900, 1350, 1800]) {
      expect(runTransitionFogFromPx((boundary - 0.001) * PX_PER_METER))
        .toBe(runTransitionFogFromPx((boundary + 0.001) * PX_PER_METER));
    }
  });
  it("joins the adjacent world palettes outside the transition window", () => {
    expect(runTransitionFogFromPx(415 * PX_PER_METER)).toBe(RUN_WORLD_THEMES.city.fog.toLowerCase());
    expect(runTransitionFogFromPx(485 * PX_PER_METER)).toBe(RUN_WORLD_THEMES.ice.fog.toLowerCase());
    expect(runTransitionFogFromPx(1385 * PX_PER_METER)).toBe(RUN_WORLD_THEMES.city.fog.toLowerCase());
  });
});
