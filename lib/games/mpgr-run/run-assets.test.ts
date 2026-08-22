import { describe, expect, it } from "vitest";
import {
  RUN_ASSET_VERSION,
  withAssetVersion,
  CHARACTER_SPRITES,
  CITY_ENVIRONMENT,
  CRITICAL_SPRITE_PATHS,
  OPTIONAL_SPRITE_PATHS,
  ALL_SPRITE_PATHS,
  BACKGROUND_STRIP_TARGETS,
} from "./run-assets";

describe("withAssetVersion", () => {
  it("stamps a path with the current version", () => {
    expect(withAssetVersion("/games/mpgr-run/character/mpgr-runner-run.png")).toBe(
      `/games/mpgr-run/character/mpgr-runner-run.png?v=${RUN_ASSET_VERSION}`
    );
  });

  it("replaces an existing v= rather than duplicating it", () => {
    expect(withAssetVersion("/x.png?v=old")).toBe(`/x.png?v=${RUN_ASSET_VERSION}`);
  });

  it("preserves other query params and hashes", () => {
    expect(withAssetVersion("/x.png?foo=1#hero")).toBe(`/x.png?foo=1&v=${RUN_ASSET_VERSION}#hero`);
  });
});

describe("MPGR Run sprite catalogs", () => {
  it("versions every exported gameplay path", () => {
    for (const src of ALL_SPRITE_PATHS) {
      expect(src).toContain(`v=${RUN_ASSET_VERSION}`);
      expect(src.startsWith("/games/mpgr-run/")).toBe(true);
    }
  });

  it("keeps critical hero art in the immediate-load set", () => {
    const required = [
      CHARACTER_SPRITES.idle,
      CHARACTER_SPRITES.run,
      CHARACTER_SPRITES.run2,
      CHARACTER_SPRITES.jump,
      CHARACTER_SPRITES.fall,
      CHARACTER_SPRITES.slide,
      CITY_ENVIRONMENT.background,
      CITY_ENVIRONMENT.midground,
      CITY_ENVIRONMENT.foreground,
    ];
    for (const src of required) {
      expect(CRITICAL_SPRITE_PATHS).toContain(src);
    }
  });

  it("does not overlap critical and optional catalogs", () => {
    const critical = new Set(CRITICAL_SPRITE_PATHS);
    for (const src of OPTIONAL_SPRITE_PATHS) {
      expect(critical.has(src)).toBe(false);
    }
    expect(CRITICAL_SPRITE_PATHS.length + OPTIONAL_SPRITE_PATHS.length).toBe(ALL_SPRITE_PATHS.length);
  });

  it("strips backgrounds using the versioned path identity", () => {
    expect(BACKGROUND_STRIP_TARGETS).toContain(CHARACTER_SPRITES.run2);
    for (const src of BACKGROUND_STRIP_TARGETS) {
      expect(src).toContain(`v=${RUN_ASSET_VERSION}`);
    }
  });
});
