import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALL_SPRITE_PATHS,
  CITY_ENVIRONMENT,
  CRITICAL_SPRITE_PATHS,
  OPTIONAL_SPRITE_PATHS,
} from "./run-assets";

/**
 * Byte budgets measured on main @ 3fb5eb82 before this pass, then again
 * after unreferenced art was removed and the legacy city panoramas left
 * the critical preload. Equality is the regression lock: a new sprite or
 * a deleted live sprite fails here instead of quietly changing the
 * download.
 */
const BASELINE = {
  criticalBytes: 13_941_098,
  allSpriteBytes: 45_357_918,
  publicGamesBytes: 93_340_966,
} as const;

const BUDGET = {
  criticalBytes: 7_822_192,
  allSpriteBytes: 45_357_918,
  publicGamesBytes: 54_482_009,
} as const;

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const GAMES_DIR = path.join(REPO_ROOT, "public", "games");

function publicFile(src: string): string {
  const pathname = src.split("?")[0].split("#")[0];
  return path.join(REPO_ROOT, "public", pathname.replace(/^\//, ""));
}

function catalogBytes(srcs: readonly string[]): number {
  let total = 0;
  for (const src of srcs) total += fs.statSync(publicFile(src)).size;
  return total;
}

function treeBytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += treeBytes(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

describe("MPGR Run asset byte budget", () => {
  it("keeps the critical preload under the verified baseline", () => {
    const critical = catalogBytes(CRITICAL_SPRITE_PATHS);
    const all = catalogBytes(ALL_SPRITE_PATHS);
    const shipped = treeBytes(GAMES_DIR);
    expect(critical).toBe(BUDGET.criticalBytes);
    expect(all).toBe(BUDGET.allSpriteBytes);
    expect(shipped).toBe(BUDGET.publicGamesBytes);
    expect(critical).toBeLessThan(BASELINE.criticalBytes);
    expect(all).toBeLessThanOrEqual(BASELINE.allSpriteBytes);
    expect(shipped).toBeLessThan(BASELINE.publicGamesBytes);
  });

  it("still ships the legacy city panoramas for the decode fallback", () => {
    for (const src of [CITY_ENVIRONMENT.background, CITY_ENVIRONMENT.midground, CITY_ENVIRONMENT.foreground]) {
      expect(fs.statSync(publicFile(src)).size).toBeGreaterThan(0);
      expect(CRITICAL_SPRITE_PATHS).not.toContain(src);
      expect(OPTIONAL_SPRITE_PATHS).toContain(src);
    }
    expect(CRITICAL_SPRITE_PATHS).toHaveLength(21);
    expect(ALL_SPRITE_PATHS).toHaveLength(61);
  });
});
