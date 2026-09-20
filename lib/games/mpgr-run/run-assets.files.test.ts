import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALL_SPRITE_PATHS,
  BACKGROUND_STRIP_TARGETS,
  CHARACTER_SPRITES,
  CITY_ENVIRONMENT,
  CRITICAL_SPRITE_PATHS,
  OPTIONAL_SPRITE_PATHS,
  UI_SPRITES,
} from "./run-assets";
import { GAME_REGISTRY } from "@/lib/games/game-registry";

/**
 * Filesystem-level regression coverage for MPGR Run art (Task 12 — assets and
 * performance).
 *
 * run-assets.ts is a pure path manifest: nothing in that module touches the
 * disk, so a typo, a renamed file, or an asset deleted during an optimization
 * pass ships green and only fails at runtime — as a silently missing sprite in
 * the middle of a run. These tests close that gap: every exported path must
 * resolve to a real, non-empty file under public/, gameplay art must keep the
 * exact intrinsic dimensions the rendering code and the background flood-fill
 * already depended on before the earlier lossless-WebP pass, and the small
 * DOM-only HUD variants introduced by Task 12 must stay small.
 *
 * Dimensions are read from the PNG/WebP headers directly (no image library
 * dependency in the test suite).
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PUBLIC_DIR = path.join(REPO_ROOT, "public");

/** Resolve "/games/x.webp?v=1" to the absolute path of the public file. */
function publicFile(src: string): string {
  const pathname = src.split("?")[0].split("#")[0];
  return path.join(PUBLIC_DIR, pathname.replace(/^\//, ""));
}

function fileSize(src: string): number {
  return fs.statSync(publicFile(src)).size;
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.subarray(0, 4).toString("latin1") !== "RIFF") return null;
  if (buffer.subarray(8, 12).toString("latin1") !== "WEBP") return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunk = buffer.subarray(offset, offset + 4).toString("latin1");
    const size = buffer.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (chunk === "VP8X") {
      return {
        width: 1 + buffer.readUIntLE(payload + 4, 3),
        height: 1 + buffer.readUIntLE(payload + 7, 3),
      };
    }
    if (chunk === "VP8L") {
      const bits = buffer.readUInt32LE(payload + 1);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (chunk === "VP8 ") {
      return {
        width: buffer.readUInt16LE(payload + 6) & 0x3fff,
        height: buffer.readUInt16LE(payload + 8) & 0x3fff,
      };
    }
    offset = payload + size + (size % 2);
  }
  return null;
}

function imageDimensions(src: string): { width: number; height: number } {
  const buffer = fs.readFileSync(publicFile(src));
  const dims = pngDimensions(buffer) ?? webpDimensions(buffer);
  if (!dims) throw new Error(`not a readable PNG/WebP: ${src}`);
  return dims;
}

function candidatePaths(): string[] {
  return [
    ...ALL_SPRITE_PATHS,
    ...CRITICAL_SPRITE_PATHS,
    ...OPTIONAL_SPRITE_PATHS,
    ...BACKGROUND_STRIP_TARGETS,
  ];
}

describe("MPGR Run asset manifest resolves on disk", () => {
  it("has a non-empty file for every exported sprite path", () => {
    const paths = candidatePaths();
    expect(paths.length).toBeGreaterThan(0);
    for (const src of paths) {
      const file = publicFile(src);
      expect(fs.existsSync(file), `missing asset file for ${src}`).toBe(true);
      expect(fs.statSync(file).size, `empty asset file for ${src}`).toBeGreaterThan(0);
      expect(src.startsWith("/games/mpgr-run/"), `${src} must stay under /games/mpgr-run/`).toBe(true);
    }
  });

  it("keeps the background-strip targets resolvable (flood-fill inputs)", () => {
    // stripBackgroundToTransparent() reads naturalWidth/naturalHeight off
    // exactly these images; a missing file means a permanent procedural
    // fallback for the second run frame, the chest, or the checkpoint.
    expect(BACKGROUND_STRIP_TARGETS).toContain(CHARACTER_SPRITES.run2);
    for (const src of BACKGROUND_STRIP_TARGETS) {
      expect(fs.existsSync(publicFile(src)), src).toBe(true);
    }
  });

  it("still ships the game card image referenced by the registry", () => {
    const game = GAME_REGISTRY.find((entry) => entry.id === "mpgr-run");
    expect(game?.iconImage).toBeTruthy();
    const iconImage = game?.iconImage as string;
    expect(fs.existsSync(publicFile(iconImage)), iconImage).toBe(true);
    expect(fs.statSync(publicFile(iconImage)).size).toBeGreaterThan(0);
  });
});

describe("MPGR Run gameplay art keeps its intrinsic dimensions", () => {
  // These are the dimensions verified pixel-exact by the 2026-09 lossless
  // WebP pass. Hitboxes, draw scaling, and the edge flood-fill were all
  // validated against them, so an accidental re-encode/downscale of canvas
  // art must fail here rather than silently blur (or re-crop) the game.
  const EXPECTED: Array<[string, number, number]> = [
    [CHARACTER_SPRITES.idle, 1254, 1254],
    [CHARACTER_SPRITES.run, 1536, 1024],
    [CHARACTER_SPRITES.run2, 1536, 1024],
    [CHARACTER_SPRITES.jump, 1536, 1024],
    [CHARACTER_SPRITES.fall, 1536, 1024],
    [CHARACTER_SPRITES.slide, 1536, 1024],
    [CITY_ENVIRONMENT.background, 1536, 1024],
    [CITY_ENVIRONMENT.midground, 1536, 1024],
    [CITY_ENVIRONMENT.foreground, 1536, 1024],
  ];

  it.each(EXPECTED)("canvas sprite %s stays %ix%i", (src, width, height) => {
    expect(imageDimensions(src)).toEqual({ width, height });
  });
});

describe("DOM-only HUD art stays small", () => {
  // heart and powerupFrame are drawn exclusively as DOM <img> elements at
  // 16 / 24 CSS px (the canvas renderer never reads UI_SPRITES). Task 12
  // replaced the full-size originals with dedicated variants; this budget
  // fails if either is ever pointed back at multi-megabyte canvas art.
  const HUD_BUDGET_BYTES = 32 * 1024;

  it.each([
    ["heart", UI_SPRITES.heart, 16],
    ["powerupFrame", UI_SPRITES.powerupFrame, 24],
  ] as const)("%s is a small variant (%s) sized for its 3x render size", (_name, src, cssSize) => {
    const size = fileSize(src);
    expect(size, `${src} is ${(size / 1024).toFixed(1)} KiB`).toBeLessThanOrEqual(HUD_BUDGET_BYTES);

    const { width, height } = imageDimensions(src);
    // Aspect-preserving downscale: the longest edge must cover the 3x device
    // pixel size of the largest box the sprite is drawn into.
    expect(Math.max(width, height)).toBeGreaterThanOrEqual(cssSize * 3);
    expect(Math.max(width, height)).toBeLessThanOrEqual(256);
  });

  it("keeps the full-size originals on disk (nothing was deleted)", () => {
    const originals: Array<[string, number, number]> = [
      ["/games/mpgr-run/ui/mpgr-run-heart.webp", 1536, 1024],
      ["/games/mpgr-run/ui/mpgr-run-powerup-frame.webp", 1536, 1024],
      ["/games/mpgr-run/ui/mpgr-run-hud-frame.webp", 1672, 941],
    ];
    for (const [src, width, height] of originals) {
      expect(fs.existsSync(publicFile(src)), src).toBe(true);
      expect(imageDimensions(src)).toEqual({ width, height });
    }
  });

  it("keeps the game card variant small and the full idle sprite intact", () => {
    const game = GAME_REGISTRY.find((entry) => entry.id === "mpgr-run");
    const cardSrc = game?.iconImage as string;
    expect(fileSize(cardSrc)).toBeLessThanOrEqual(64 * 1024);
    const { width, height } = imageDimensions(cardSrc);
    // Drawn at 44 CSS px; 3x device pixels with margin.
    expect(width).toBeGreaterThanOrEqual(132);
    expect(width).toBeLessThanOrEqual(512);
    expect(width).toBe(height);
    // The canvas sprite the game itself loads is untouched.
    expect(imageDimensions(CHARACTER_SPRITES.idle)).toEqual({ width: 1254, height: 1254 });
    expect(fileSize(CHARACTER_SPRITES.idle)).toBeGreaterThan(300 * 1024);
  });

  it("keeps the favicon / brand-mark icon small while /icon.png stays the canonical icon", () => {
    for (const icon of ["/icon-128.png", "/icon-180.png"]) {
      expect(fs.existsSync(publicFile(icon)), icon).toBe(true);
      expect(fileSize(icon)).toBeLessThanOrEqual(96 * 1024);
    }
    expect(imageDimensions("/icon-128.png")).toEqual({ width: 128, height: 128 });
    expect(imageDimensions("/icon-180.png")).toEqual({ width: 180, height: 180 });

    // The Farcaster/Base mini-app icon (manifest + external clients) is
    // addressed by absolute URL and must keep its original bytes/size.
    expect(fs.existsSync(publicFile("/icon.png"))).toBe(true);
    expect(imageDimensions("/icon.png")).toEqual({ width: 1254, height: 1254 });
    expect(imageDimensions("/splash.png")).toEqual({ width: 1024, height: 1536 });
  });

  it("retains the storage-only art that is intentionally not wired up", () => {
    // Portal / screen / pad art is referenced by no code path, so it costs
    // nothing at runtime; the audit explicitly forbids deleting assets just
    // because they are large. This test records that the decision was to keep
    // them, so a future cleanup cannot drop them silently.
    const portal = [
      "/games/mpgr-run/portal/mpgr-hub-portal-01.webp",
      "/games/mpgr-run/portal/mpgr-hub-portal-02.webp",
      "/games/mpgr-run/portal/mpgr-hub-portal-03.webp",
      "/games/mpgr-run/portal/mpgr-hub-portal-04.webp",
    ];
    for (const src of portal) {
      expect(fs.existsSync(publicFile(src)), src).toBe(true);
      expect(imageDimensions(src)).toEqual({ width: 1536, height: 1024 });
    }
  });
});
