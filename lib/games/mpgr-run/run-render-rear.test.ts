import { describe, expect, it } from "vitest";

import { drawRunFrame, runViewScale } from "@/lib/games/mpgr-run/run-render";
import { freshWorld, type World } from "@/lib/games/mpgr-run/run-world";
import { CHARACTER_REAR_SPRITES } from "@/lib/games/mpgr-run/run-assets";
import { MPGR_RUN_SIMULATION_WIDTH } from "@/lib/games/mpgr-run/authoritative-replay";
import { PLAYER_X } from "@/lib/games/mpgr-run/run-config";

/**
 * Rear-camera projection contract (2026-09-26 Subway-Surfers-style
 * conversion). The simulation is untouched side-scroll math; these tests
 * pin what the PRESENTATION must do with it:
 *
 *   1. the runner is drawn from behind (rear sprite set), grounded on the
 *      near track surface, lower-center of the screen;
 *   2. jumps lift the sprite exactly playerY units (no float/offset);
 *   3. depth compresses: farther entities render strictly smaller and
 *      higher (toward the horizon), nearer ones strictly larger;
 *   4. the three lanes sit left/center/right and converge (same-depth
 *      lane spread is centered on the viewport);
 *   5. painter's algorithm: ahead-of-player hazards draw before the
 *      runner, already-passed ones after (they sweep past the camera);
 *   6. the whole framing scales uniformly between phone and desktop
 *      viewports (no hardcoded per-device dimensions);
 *   7. no NaN/Infinity ever reaches the context.
 */

interface StubImage {
  tag: string;
  naturalWidth: number;
  naturalHeight: number;
}

interface DrawCall {
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Minimal recording 2D context with a real affine transform stack. */
class RecordingCtx {
  calls: DrawCall[] = [];
  numbers: number[] = [];
  private m = [1, 0, 0, 1, 0, 0]; // a b c d e f
  private stack: number[][] = [];

  private tx(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.m;
    return [a * x + c * y + e, b * x + d * y + f];
  }

  private record(tag: string, x: number, y: number, w: number, h: number) {
    const corners = [
      this.tx(x, y),
      this.tx(x + w, y),
      this.tx(x, y + h),
      this.tx(x + w, y + h),
    ];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    this.numbers.push(minX, maxX, minY, maxY);
    this.calls.push({ tag, x: minX, y: minY, w: maxX - minX, h: maxY - minY });
  }

  save() {
    this.stack.push([...this.m]);
  }
  restore() {
    const prev = this.stack.pop();
    if (prev) this.m = prev;
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
  drawImage(img: StubImage, x: number, y: number, w: number, h: number) {
    this.record(img.tag, x, y, w, h);
  }
  // Geometry-only ops: exercised for coverage, nothing to record.
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
  // Style props the renderer sets.
  globalAlpha = 1;
  fillStyle: unknown = null;
  strokeStyle: unknown = null;
  lineWidth = 1;
  shadowColor: unknown = null;
  shadowBlur = 0;
}

const REAR_ASPECT = 266 / 512;

function makeGetSprite(): (src: string) => CanvasImageSource | null {
  return (src: string) =>
    ({
      tag: src,
      naturalWidth: src.includes("rear-") ? 266 : src.includes("city-") ? 1536 : 128,
      naturalHeight: src.includes("rear-") ? 512 : src.includes("city-") ? 1024 : 128,
    }) as unknown as CanvasImageSource;
}

function runningWorld(): World {
  const world = freshWorld();
  world.elapsedMs = 5000; // mid-run: run cycle active, no countdown/idle pose
  world.traveledPx = 2000;
  return world;
}

function playerCall(ctx: RecordingCtx): DrawCall {
  const call = ctx.calls.find((c) => c.tag.includes("/character/mpgr-runner-rear-"));
  expect(call, "rear runner sprite must be drawn").toBeTruthy();
  return call as DrawCall;
}

describe("rear-camera projection (Subway Surfers style)", () => {
  it("draws the rear runner grounded at the lower-center of the screen", () => {
    const ctx = new RecordingCtx();
    const vw = 1280;
    const vh = 720;
    drawRunFrame(ctx as unknown as CanvasRenderingContext2D, runningWorld(), vw, vh, makeGetSprite());

    const player = playerCall(ctx);
    // Centered: lane 1 with zero lane offset puts the runner on the centre line.
    expect(player.x + player.w / 2).toBeCloseTo(vw / 2, 1);
    // Grounded: feet exactly on the near track surface (0.82 * viewport height).
    expect(player.y + player.h).toBeCloseTo(vh * 0.82, 1);
    // Lower-center framing, not floating mid-screen.
    expect(player.y + player.h).toBeGreaterThan(vh * 0.6);
    // Rear sprite set, never the side-view art.
    expect(player.tag).toContain("/character/mpgr-runner-rear-");
    // Upright rear aspect (no anisotropic stretch).
    expect(player.w / player.h).toBeCloseTo(REAR_ASPECT, 2);
  });

  it("lifts the runner exactly by playerY on jump and re-grounds on landing", () => {
    const vw = 900;
    const vh = 600;
    const u = runViewScale(vw);

    const grounded = new RecordingCtx();
    drawRunFrame(grounded as unknown as CanvasRenderingContext2D, runningWorld(), vw, vh, makeGetSprite());
    const groundBottom = (playerCall(grounded).y + playerCall(grounded).h);

    const jumping = new RecordingCtx();
    const world = runningWorld();
    world.player.playerY = 80;
    world.player.velocityY = 200;
    drawRunFrame(jumping as unknown as CanvasRenderingContext2D, world, vw, vh, makeGetSprite());
    const jump = playerCall(jumping);
    expect(jump.tag).toContain("rear-jump");
    expect(jump.y + jump.h).toBeCloseTo(groundBottom - 80 * u, 1);

    const landed = new RecordingCtx();
    const world2 = runningWorld();
    world2.player.playerY = 0;
    world2.player.velocityY = 0;
    drawRunFrame(landed as unknown as CanvasRenderingContext2D, world2, vw, vh, makeGetSprite());
    expect(playerCall(landed).y + playerCall(landed).h).toBeCloseTo(groundBottom, 1);
  });

  it("compresses depth: farther entities are strictly smaller and higher", () => {
    const ctx = new RecordingCtx();
    const vw = 1000;
    const vh = 700;
    const world = runningWorld();
    const playerX = MPGR_RUN_SIMULATION_WIDTH * PLAYER_X;
    const depths = [100, 400, 800];
    for (const z of depths) {
      world.collectibles.push({
        id: 900 + z,
        type: "coin",
        lane: 1,
        x: playerX + z,
        radius: 8,
        collected: false,
      });
    }
    drawRunFrame(ctx as unknown as CanvasRenderingContext2D, world, vw, vh, makeGetSprite());

    const coins = ctx.calls.filter((c) => c.tag.includes("mpgr-run-coin"));
    expect(coins).toHaveLength(3);
    // Draw order is far -> near, so coins[0] is the deepest = smallest.
    expect(coins[0].w).toBeLessThan(coins[1].w);
    expect(coins[1].w).toBeLessThan(coins[2].w);
    // And deeper means closer to the horizon (higher on screen).
    expect(coins[0].y).toBeLessThan(coins[1].y);
    expect(coins[1].y).toBeLessThan(coins[2].y);
    // Nothing pops in above the horizon line.
    for (const coin of coins) expect(coin.y).toBeGreaterThan(vh * 0.36);
  });

  it("lays the three lanes out left/center/right, centered on the viewport", () => {
    const ctx = new RecordingCtx();
    const vw = 800;
    const vh = 600;
    const world = runningWorld();
    const playerX = MPGR_RUN_SIMULATION_WIDTH * PLAYER_X;
    for (let lane = 0; lane < 3; lane++) {
      world.collectibles.push({
        id: 700 + lane,
        type: "coin",
        lane,
        x: playerX + 300,
        radius: 8,
        collected: false,
      });
    }
    drawRunFrame(ctx as unknown as CanvasRenderingContext2D, world, vw, vh, makeGetSprite());
    const coins = ctx.calls
      .filter((c) => c.tag.includes("mpgr-run-coin"))
      .sort((a, b) => a.x - b.x);
    expect(coins).toHaveLength(3);
    const centers = coins.map((c) => c.x + c.w / 2);
    expect(centers[0]).toBeLessThan(vw / 2);
    expect(centers[1]).toBeCloseTo(vw / 2, 1);
    expect(centers[2]).toBeGreaterThan(vw / 2);
    // Symmetric convergence around the centre line.
    expect(centers[1] - centers[0]).toBeCloseTo(centers[2] - centers[1], 1);
  });

  it("depth-sorts around the runner: ahead hazards behind him, passed ones in front", () => {
    const ctx = new RecordingCtx();
    const vw = 1000;
    const vh = 700;
    const world = runningWorld();
    const playerX = MPGR_RUN_SIMULATION_WIDTH * PLAYER_X;
    const ahead = {
      id: 1,
      type: "crate" as const,
      lane: 1,
      x: playerX + 50 - 17,
      width: 34,
      height: 42,
      groundHeight: 0,
      passed: false,
      hit: false,
    };
    const passed = {
      id: 2,
      type: "crate" as const,
      lane: 1,
      x: playerX - 60 - 17,
      width: 34,
      height: 42,
      groundHeight: 0,
      passed: true,
      hit: false,
    };
    world.obstacles.push(ahead, passed);
    drawRunFrame(ctx as unknown as CanvasRenderingContext2D, world, vw, vh, makeGetSprite());

    const crates = ctx.calls.filter((c) => c.tag.includes("mpgr-run-crate"));
    expect(crates).toHaveLength(2);
    const playerIndex = ctx.calls.findIndex((c) => c.tag.includes("rear-run"));
    // crates[0] is the far (ahead) one because of far->near draw order.
    expect(ctx.calls.indexOf(crates[0])).toBeLessThan(playerIndex);
    expect(ctx.calls.indexOf(crates[1])).toBeGreaterThan(playerIndex);
    // The passed crate is nearer the camera, so it renders larger.
    expect(crates[1].w).toBeGreaterThan(crates[0].w);
  });

  it("frames phone and desktop viewports proportionally (uniform scale)", () => {
    const phone = new RecordingCtx();
    drawRunFrame(phone as unknown as CanvasRenderingContext2D, runningWorld(), 390, 700, makeGetSprite());
    const desktop = new RecordingCtx();
    drawRunFrame(desktop as unknown as CanvasRenderingContext2D, runningWorld(), 1280, 720, makeGetSprite());

    const pPhone = playerCall(phone);
    const pDesk = playerCall(desktop);
    const ratio = pPhone.h / pDesk.h;
    expect(ratio).toBeCloseTo(runViewScale(390) / runViewScale(1280), 3);
    // Phone readability floor: the runner stays >= 40 css px tall.
    expect(pPhone.h).toBeGreaterThanOrEqual(40);
    // Both keep the lower-center framing.
    for (const [call, vw, vh] of [
      [pPhone, 390, 700],
      [pDesk, 1280, 720],
    ] as const) {
      expect(call.x + call.w / 2).toBeCloseTo(vw / 2, 1);
      expect(call.y + call.h).toBeCloseTo(vh * 0.82, 1);
    }
  });

  it("never emits non-finite coordinates", () => {
    const ctx = new RecordingCtx();
    const world = runningWorld();
    const playerX = MPGR_RUN_SIMULATION_WIDTH * PLAYER_X;
    world.player.laneOffset = -30;
    world.player.playerY = 40;
    world.obstacles.push({
      id: 5,
      type: "saw",
      lane: 0,
      x: playerX + 120,
      width: 34,
      height: 28,
      groundHeight: 20,
      passed: false,
      hit: false,
    });
    world.collectibles.push({ id: 6, type: "gem", lane: 2, x: playerX - 80, radius: 9, collected: false });
    world.powerups.push({ id: 7, type: "shield", lane: 1, x: playerX + 400, radius: 13, collected: false });
    drawRunFrame(ctx as unknown as CanvasRenderingContext2D, world, 390, 844, makeGetSprite());
    expect(ctx.calls.length).toBeGreaterThan(0);
    for (const n of ctx.numbers) expect(Number.isFinite(n)).toBe(true);
  });

  it("uses the rear slide/jump/fall poses for their states", () => {
    const vw = 800;
    const vh = 600;
    const slide = new RecordingCtx();
    const slideWorld = runningWorld();
    slideWorld.player.sliding = true;
    slideWorld.player.slideUntilMs = 999999;
    drawRunFrame(slide as unknown as CanvasRenderingContext2D, slideWorld, vw, vh, makeGetSprite());
    expect(playerCall(slide).tag).toBe(CHARACTER_REAR_SPRITES.slide);

    const fall = new RecordingCtx();
    const fallWorld = runningWorld();
    fallWorld.player.playerY = 60;
    fallWorld.player.velocityY = -100;
    drawRunFrame(fall as unknown as CanvasRenderingContext2D, fallWorld, vw, vh, makeGetSprite());
    expect(playerCall(fall).tag).toBe(CHARACTER_REAR_SPRITES.fall);
  });
});
