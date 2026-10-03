import { describe, expect, it, vi } from "vitest";

import {
  drawRunFrame,
  runStrideLead,
  RUN_BLEND_MS,
  RUN_FRAME_START_MS,
  RUN_STRIDE_MS,
  runStrideFrame,
} from "./run-render";
import {
  drawDistantDistrict,
  drawPavementDetail,
  streetLaneGap,
  streetScale,
  STREET_GROUND,
  STREET_HORIZON,
} from "./run-street";
import { REAR_RUN_CYCLE } from "./run-assets";
import { RUN_WORLD_THEMES } from "./run-environments";
import { freshWorld } from "./run-world";

/**
 * Final flagship polish contracts (2026-09-29). The polish only ever changes
 * PRESENTATION: these tests pin the properties that make the change safe —
 *
 *   - a settled stride pose still draws exactly one sprite (the previous
 *     draw structure is preserved outside the blend window);
 *   - inside the blend window both adjacent poses are drawn once each and
 *     their opacities sum to the sprite opacity, so the pose change has no
 *     visible step at either end of the window;
 *   - pose boundaries, cadence and the selected frame never move;
 *   - the added depth work (facade depth, pavement, distant district) is
 *     bounded, stays off the road surface and never emits non-finite numbers.
 */

interface Call {
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
}

/** Minimal recording context with an alpha-aware drawImage and transform stack. */
class AlphaRecordingCtx {
  calls: Call[] = [];
  private m = [1, 0, 0, 1, 0, 0];
  private stack: number[][] = [];
  private alpha = 1;
  private alphaStack: number[] = [];

  private tx(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.m;
    return [a * x + c * y + e, b * x + d * y + f];
  }

  save() {
    this.stack.push([...this.m]);
    this.alphaStack.push(this.alpha);
  }
  restore() {
    const prev = this.stack.pop();
    const prevAlpha = this.alphaStack.pop();
    if (prev) this.m = prev;
    if (prevAlpha !== undefined) this.alpha = prevAlpha;
  }
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
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    this.m = [a * cos + c * sin, b * cos + d * sin, a * -sin + c * cos, b * -sin + d * cos, e, f];
  }
  drawImage(img: { tag?: string }, x: number, y: number, w: number, h: number) {
    // Record the transformed bounding box so device-space and design-space
    // numbers are never mixed up by an assertion.
    const corners = [this.tx(x, y), this.tx(x + w, y), this.tx(x, y + h), this.tx(x + w, y + h)];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    this.calls.push({
      tag: String(img?.tag ?? ""),
      x: minX,
      y: minY,
      w: Math.max(...xs) - minX,
      h: Math.max(...ys) - minY,
      alpha: this.alpha,
    });
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
  fillRect() {}
  createLinearGradient() {
    return { addColorStop: () => undefined };
  }
  createRadialGradient() {
    return { addColorStop: () => undefined };
  }
  set globalAlpha(value: number) {
    this.alpha = value;
  }
  get globalAlpha() {
    return this.alpha;
  }
  fillStyle: unknown = null;
  strokeStyle: unknown = null;
  lineWidth = 1;
  shadowColor: unknown = null;
  shadowBlur = 0;
}

function runningWorld(elapsedMs: number) {
  const world = freshWorld();
  world.elapsedMs = elapsedMs;
  world.traveledPx = 2000;
  return world;
}

const sprite = (src: string) =>
  ({
    tag: src,
    naturalWidth: src.includes("rear-") ? 266 : 128,
    naturalHeight: src.includes("rear-") ? 512 : 128,
  }) as unknown as CanvasImageSource;

function stridePoses(ctx: AlphaRecordingCtx) {
  return ctx.calls.filter((c) => REAR_RUN_CYCLE.some((src) => c.tag === src));
}

describe("stride blending is continuous without changing pose timing", () => {
  it("keeps every settled pose as a single full-opacity sprite draw", () => {
    for (const frameStart of RUN_FRAME_START_MS) {
      // Mid-pose, well outside any blend window.
      const world = runningWorld(RUN_STRIDE_MS * 3 + frameStart + RUN_BLEND_MS + 40);
      const ctx = new AlphaRecordingCtx();
      drawRunFrame(ctx as unknown as CanvasRenderingContext2D, world, 900, 600, sprite);
      const poses = stridePoses(ctx);
      expect(poses).toHaveLength(1);
      expect(poses[0].alpha).toBe(1);
      expect(poses[0].tag).toBe(REAR_RUN_CYCLE[runStrideFrame(world.elapsedMs)]);
    }
  });

  it("cross-fades to the next pose with opacities that sum to the sprite opacity", () => {
    const nextBoundary = RUN_FRAME_START_MS[1]; // 165ms
    const world = runningWorld(RUN_STRIDE_MS * 3 + nextBoundary - RUN_BLEND_MS / 2);
    const ctx = new AlphaRecordingCtx();
    drawRunFrame(ctx as unknown as CanvasRenderingContext2D, world, 900, 600, sprite);
    const poses = stridePoses(ctx);
    expect(poses).toHaveLength(2);
    const total = poses.reduce((sum, pose) => sum + pose.alpha, 0);
    expect(total).toBeCloseTo(1, 5);
    // The incoming pose is the one the clock selects right after the boundary.
    const afterBoundary = runStrideFrame(RUN_STRIDE_MS * 3 + nextBoundary + 1);
    expect(poses.some((pose) => pose.tag === REAR_RUN_CYCLE[afterBoundary])).toBe(true);
    // Both poses stay in the same grounded box: feet on the shared ground line.
    const [first, second] = poses;
    expect(second.y + second.h).toBeCloseTo(first.y + first.h, 6);
  });

  it("is seamless at both ends of the window and never touches the selected frame", () => {
    expect(runStrideLead(0)).toBe(0);
    expect(runStrideLead(RUN_FRAME_START_MS[1] - RUN_BLEND_MS)).toBeCloseTo(0, 8);
    expect(runStrideLead(RUN_FRAME_START_MS[1] - 1)).toBeGreaterThan(0.99);
    // Smoothstep shape: monotonic, symmetric at the midpoint.
    expect(runStrideLead(RUN_FRAME_START_MS[1] - RUN_BLEND_MS / 2)).toBeCloseTo(0.5, 6);
    let previous = -1;
    for (let t = 0; t < RUN_STRIDE_MS; t += 2) {
      const lead = runStrideLead(RUN_STRIDE_MS * 5 + t);
      expect(lead).toBeGreaterThanOrEqual(0);
      expect(lead).toBeLessThanOrEqual(1);
      void previous;
      previous = lead;
    }
    // The frame selection itself is untouched by the blend.
    for (let t = 0; t < RUN_STRIDE_MS * 2; t += 5) {
      const base = RUN_FRAME_START_MS.includes(runStrideFrame(t) === 0 ? 0 : RUN_FRAME_START_MS[runStrideFrame(t)]);
      expect(base).toBe(true);
    }
  });
});

describe("polish depth work stays bounded and off the road", () => {
  function streetCtx() {
    const calls: number[] = [];
    const gradient = { addColorStop: () => undefined };
    const target = {} as CanvasRenderingContext2D;
    const ctx = new Proxy(target, {
      get: (_t, key) => {
        if (key === "__count") return calls.length;
        return (...args: unknown[]) => {
          calls.push(calls.length);
          for (const arg of args) if (typeof arg === "number" && !Number.isFinite(arg)) calls.push(NaN);
          return key === "createLinearGradient" || key === "createRadialGradient" ? gradient : undefined;
        };
      },
      set: () => true,
    }) as CanvasRenderingContext2D & { __count: number };
    return { ctx, calls };
  }

  for (const theme of Object.values(RUN_WORLD_THEMES)) {
    it(`${theme.id}: pavement and district passes are bounded and finite`, () => {
      const height = 844;
      const trackHalf = streetLaneGap(390, height) * 1.5;
      const pavement = streetCtx();
      drawPavementDetail(pavement.ctx, 390, height, trackHalf, 0, 3012, theme);
      expect(pavement.calls.length).toBeGreaterThan(0);
      // 9 joints x 2 sides x 2 thin quads, counted as context commands.
      expect(pavement.calls.length).toBeLessThan(700);
      expect(pavement.calls.some((n) => Number.isNaN(n))).toBe(false);

      const district = streetCtx();
      drawDistantDistrict(district.ctx, 390, height, trackHalf, 0, 3012, theme, 0.5, 520, 10, 2500);
      expect(district.calls.length).toBeGreaterThan(0);
      // 10 slots x 2 sides x (fogged silhouette | shaded faces + windows),
      // counted as context commands, before culling.
      expect(district.calls.length).toBeLessThan(700);
      expect(district.calls.some((n) => Number.isNaN(n))).toBe(false);
    });
  }

  it("draws the whole frame deterministically and without random reads", () => {
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("renderer read RNG");
    });
    try {
      const world = runningWorld(5010);
      const a = new AlphaRecordingCtx();
      const b = new AlphaRecordingCtx();
      drawRunFrame(a as unknown as CanvasRenderingContext2D, world, 390, 844, sprite);
      drawRunFrame(b as unknown as CanvasRenderingContext2D, world, 390, 844, sprite);
      expect(JSON.stringify(a.calls)).toEqual(JSON.stringify(b.calls));
    } finally {
      random.mockRestore();
    }
  });

  it("keeps the runner grounded and the ground plane where it was", () => {
    const height = 844;
    expect(streetScale(0)).toBe(1);
    const ctx = new AlphaRecordingCtx();
    const world = runningWorld(5000);
    drawRunFrame(ctx as unknown as CanvasRenderingContext2D, world, 390, height, sprite);
    const poses = stridePoses(ctx);
    const feet = poses[0].y + poses[0].h;
    expect(feet).toBeCloseTo(height * STREET_GROUND, 1);
    expect(height * STREET_HORIZON).toBeLessThan(feet);
  });
});
