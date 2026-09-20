import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_SPRITE_PATHS,
  BACKGROUND_STRIP_TARGETS,
  CRITICAL_SPRITE_PATHS,
  OPTIONAL_SPRITE_PATHS,
} from "@/lib/games/mpgr-run/run-assets";
import { GAME_REGISTRY } from "@/lib/games/game-registry";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PUBLIC_DIR = join(REPO_ROOT, "public");

function publicFile(publicPath: string): string {
  const withoutHash = publicPath.split("#")[0];
  const pathname = withoutHash.split("?")[0];
  return join(PUBLIC_DIR, pathname);
}

function readMagic(path: string, length: number): string {
  const buf = readFileSync(path);
  return buf.subarray(0, length).toString("ascii");
}

/**
 * Minimal WebP dimension reader (no image dependency).
 * Supports simple lossy (VP8), lossless (VP8L), and extended (VP8X,
 * which libwebp emits when the image carries an alpha chunk) bitstreams.
 */
export function readWebpDimensions(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  if (buf.length < 30) throw new Error(`too small to be WebP: ${path}`);
  if (buf.subarray(0, 4).toString("ascii") !== "RIFF") throw new Error(`not RIFF: ${path}`);
  if (buf.subarray(8, 12).toString("ascii") !== "WEBP") throw new Error(`not WEBP: ${path}`);
  const fourcc = buf.subarray(12, 16).toString("ascii");
  if (fourcc === "VP8X") {
    // Extended format: canvas size lives in this header — 24-bit LE
    // (width-1) at offset 24 and 24-bit LE (height-1) at offset 27.
    if (buf.length < 30) throw new Error(`truncated VP8X: ${path}`);
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  if (fourcc === "VP8 ") {
    // 3-byte frame tag, then 0x9D 0x01 0x2A start code, then 14-bit LE w/h.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) {
      throw new Error(`bad VP8 start code: ${path}`);
    }
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { width, height };
  }
  if (fourcc === "VP8L") {
    // 1-byte signature 0x2F, then 14-bit (width-1) + 14-bit (height-1) LE.
    if (buf[20] !== 0x2f) throw new Error(`bad VP8L signature: ${path}`);
    const b1 = buf[21];
    const b2 = buf[22];
    const b3 = buf[23];
    const b4 = buf[24];
    const width = 1 + (b1 | ((b2 & 0x3f) << 8));
    const height = 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10));
    return { width, height };
  }
  throw new Error(`unsupported WebP chunk ${fourcc}: ${path}`);
}

describe("game sprite manifest on disk (Task 12 regression guard)", () => {
  it("resolves every gameplay sprite path to a real file under public/", () => {
    const paths = new Set([...ALL_SPRITE_PATHS, ...BACKGROUND_STRIP_TARGETS]);
    expect(paths.size).toBeGreaterThan(0);
    for (const src of paths) {
      const file = publicFile(src);
      expect(existsSync(file), `missing on disk: ${src}`).toBe(true);
      // Guards against empty/placeholder files (the 1-byte `...` placeholders
      // elsewhere in the tree must never satisfy a sprite path).
      expect(statSync(file).size, `suspiciously small: ${src}`).toBeGreaterThan(1024);
    }
  });

  it("keeps critical/optional catalogs as a partition of the full manifest", () => {
    const all = new Set(ALL_SPRITE_PATHS);
    for (const src of [...CRITICAL_SPRITE_PATHS, ...OPTIONAL_SPRITE_PATHS]) {
      expect(all.has(src), `catalog drift: ${src}`).toBe(true);
    }
    const critical = new Set(CRITICAL_SPRITE_PATHS);
    for (const src of OPTIONAL_SPRITE_PATHS) {
      expect(critical.has(src), `overlap: ${src}`).toBe(false);
    }
  });
});

describe("portal thumbnail variants", () => {
  const THUMBS = [
    {
      thumb: "/brand/mpgr-mark-128.webp",
      full: "/icon.png",
      width: 128,
      height: 128,
      maxBytes: 32 * 1024,
    },
    {
      thumb: "/games/mpgr-run/character/mpgr-runner-idle-128.webp",
      full: "/games/mpgr-run/character/mpgr-runner-idle.webp",
      width: 128,
      height: 128,
      maxBytes: 32 * 1024,
    },
    {
      thumb: "/games/mpgr-run/character/mpgr-runner-run-256.webp",
      full: "/games/mpgr-run/character/mpgr-runner-run.webp",
      width: 256,
      height: 171,
      maxBytes: 48 * 1024,
    },
  ];

  it.each(THUMBS)("$thumb is a small valid WebP, not a copy of $full", (row) => {
    const thumbFile = publicFile(row.thumb);
    const fullFile = publicFile(row.full);
    expect(existsSync(thumbFile), `missing thumbnail: ${row.thumb}`).toBe(true);
    expect(existsSync(fullFile), `missing full art (game still needs it): ${row.full}`).toBe(true);
    expect(readMagic(thumbFile, 4)).toBe("RIFF");
    expect(readWebpDimensions(thumbFile)).toEqual({ width: row.width, height: row.height });
    const thumbBytes = statSync(thumbFile).size;
    const fullBytes = statSync(fullFile).size;
    expect(thumbBytes).toBeLessThan(row.maxBytes);
    // A "thumbnail" that costs nearly as much as the source is a regression.
    expect(thumbBytes).toBeLessThan(fullBytes * 0.05);
  });

  it("keeps every registry iconImage on a small on-disk file", () => {
    const withIcons = GAME_REGISTRY.filter((g) => g.iconImage);
    expect(withIcons.length).toBeGreaterThan(0);
    for (const game of withIcons) {
      const file = publicFile(game.iconImage as string);
      expect(existsSync(file), `missing iconImage for ${game.id}: ${game.iconImage}`).toBe(true);
      const { width, height } = readWebpDimensions(file);
      // Card slot is 44px; anything over 256px on any side does not belong here.
      expect(Math.max(width, height), `oversized iconImage for ${game.id}`).toBeLessThanOrEqual(256);
    }
  });
});
