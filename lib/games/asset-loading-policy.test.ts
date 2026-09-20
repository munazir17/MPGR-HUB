import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Loading-policy regression tests (Task 12 — assets and performance).
 *
 * The asset work has three rules that are easy to undo by accident in a later
 * refactor, so each one is pinned to the source file that must obey it:
 *
 * 1. In-game art is never lazily deferred. MPGR Run drives its own two-tier
 *    loader (lib/games/mpgr-run/asset-loader.ts, covered by
 *    asset-loader.test.ts) and the canvas must have its sprites the moment
 *    they are drawn — `loading="lazy"` on any game sprite would add a
 *    browser-controlled delay the pipeline cannot see.
 * 2. Non-critical page art is lazy/off-thread: the 44 px game-card avatar is
 *    below the fold and decodes async.
 * 3. The mini-app icon contract is unchanged: public/.well-known/
 *    farcaster.json keeps pointing at the full-size /icon.png and
 *    /splash.png, while the page favicon/touch icon and the brand mark use
 *    small purpose-built PNGs. Removing those files or repointing the
 *    manifest breaks the Farcaster/Base mini-app listing.
 *
 * There is no jsdom in this suite, so these assertions read the component
 * sources directly — the same approach used by the agentkit ESM boundary
 * test. They are deliberately narrow: one attribute per file, no markup
 * snapshots.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRaw(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/**
 * Strip comments before asserting on source text, so a comment *describing*
 * an attribute (for example the note explaining why the banner is eager and
 * not `loading="lazy"`) can never satisfy or trip a rule that is meant to
 * apply to real JSX/props. Small hand-rolled scanner: string and template
 * literals are preserved verbatim, comments are removed.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
      out += char;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += char;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // inside a string/template literal: keep everything, honour escapes
    out += char;
    if (char === "\\") {
      out += next ?? "";
      i += 2;
      continue;
    }
    if (
      (state === "single" && char === "'") ||
      (state === "double" && char === '"') ||
      (state === "template" && char === "`")
    ) {
      state = "code";
    }
    i += 1;
  }
  return out;
}

function read(relativePath: string): string {
  return stripComments(readRaw(relativePath));
}

const GAME_COMPONENT_FILES = [
  "components/features/games/mpgr-run/RunGame.tsx",
  "components/features/games/mpgr-run/RunGameHud.tsx",
  "lib/games/mpgr-run/asset-loader.ts",
  "lib/games/mpgr-run/run-render.ts",
];

describe("in-game art is never lazily deferred", () => {
  it.each(GAME_COMPONENT_FILES)("%s contains no loading=\"lazy\"", (file) => {
    expect(read(file)).not.toMatch(/loading=["']lazy["']/);
  });

  it("keeps the two-tier sprite pipeline as the only game loader", () => {
    const loader = read("lib/games/mpgr-run/asset-loader.ts");
    // Concurrency + gating contract is tested in asset-loader.test.ts; here we
    // only pin that the loader is still the single entry point.
    expect(loader).toContain("export function startRunAssetPipeline");
    expect(read("components/features/games/mpgr-run/RunGame.tsx")).toContain("startRunAssetPipeline({");
  });

  it("does not defer the HUD art that is visible from the first frame", () => {
    // The hearts and the active-powerup frame are rendered as DOM <img> in the
    // in-run HUD; they must stay in the critical lane (eager, immediate).
    const assets = read("lib/games/mpgr-run/run-assets.ts");
    const critical = assets.slice(assets.indexOf("export const CRITICAL_SPRITE_PATHS"));
    expect(critical).toContain("UI_SPRITES.heart");
    expect(critical).toContain("UI_SPRITES.powerupFrame");
  });
});

describe("non-critical page art loads lazily and off-thread", () => {
  it("lazy-loads the game card avatar", () => {
    const card = read("components/features/games/GameCard.tsx");
    expect(card).toMatch(/loading=["']lazy["']/);
    expect(card).toMatch(/decoding=["']async["']/);
  });

  it("keeps the above-the-fold featured banner eager", () => {
    const banner = read("components/features/games/FeaturedGameBanner.tsx");
    expect(banner).not.toMatch(/loading=["']lazy["']/);
    expect(banner).toMatch(/decoding=["']async["']/);
    // ... but it must be the small banner variant, not the full-size sprite.
    expect(banner).toContain("/games/mpgr-run/character/mpgr-runner-run-banner.webp");
    expect(banner).not.toContain('src="/games/mpgr-run/character/mpgr-runner-run.webp"');
  });

  it("keeps the brand mark on the small icon and the full-size icon untouched", () => {
    const mark = read("components/brand/BrandMark.tsx");
    expect(mark).toContain('src="/icon-128.png"');
    expect(mark).toMatch(/decoding=["']async["']/);
    expect(mark).not.toContain('src="/icon.png"');
  });

  it("declares the small favicon and touch icon in the app metadata", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toContain('icon: "/icon-128.png"');
    expect(layout).toContain('apple: "/icon-180.png"');
  });
});

describe("mini-app icon contract is unchanged", () => {
  it("keeps the Farcaster/Base manifest on the canonical icon and splash", () => {
    const manifest = JSON.parse(read("public/.well-known/farcaster.json")) as {
      miniapp: { iconUrl: string; splashImageUrl: string };
    };
    expect(manifest.miniapp.iconUrl).toBe("https://mpgrhub.xyz/icon.png");
    expect(manifest.miniapp.splashImageUrl).toBe("https://mpgrhub.xyz/splash.png");
    for (const file of ["public/icon.png", "public/splash.png"]) {
      expect(fs.existsSync(path.join(REPO_ROOT, file)), file).toBe(true);
    }
  });
});

describe("no remote or optimizer-backed images were introduced", () => {
  it("imports next/image nowhere (remotePatterns stays empty by design)", () => {
    const roots = ["app", "components", "hooks", "lib"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const source = fs.readFileSync(full, "utf8");
        if (/from\s+["']next\/image["']/.test(source)) offenders.push(path.relative(REPO_ROOT, full));
      }
    };
    for (const root of roots) walk(path.join(REPO_ROOT, root));
    expect(offenders).toEqual([]);
  });
});
