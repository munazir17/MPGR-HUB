import type { IncomingMessage } from "node:http";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import loadConfig from "next/dist/server/config";
import { PHASE_PRODUCTION_BUILD } from "next/dist/shared/lib/constants";
import { ImageOptimizerCache } from "next/dist/server/image-optimizer";
import type { NextConfigComplete } from "next/dist/server/config-shared";

// Regression tests for next.config.mjs (Task 4 of the 2026-08 audit follow-up).
//
// `/_next/image` is an always-on route in every Next.js app, even when no
// component imports `next/image`. Which *remote* URLs it will fetch and
// re-serve is governed solely by `images.remotePatterns`. A wildcard hostname
// turns that route into an open image proxy: anyone can make the production
// origin fetch arbitrary https URLs and burn Vercel image-optimisation quota.
//
// The whole repository was audited: no first-party file imports `next/image`
// and no bundled dependency does either — every image in the app is a local
// `/public` file rendered with a plain `<img>`. So no remote host is required
// and the allowlist must stay empty. If a remote host is ever needed, add it
// here explicitly (protocol + full hostname) and extend these tests.
//
// These tests go through Next's *real* config loader and the *real* image
// optimizer parameter validation (the exact code path production uses), not
// a re-implementation.

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// The optimizer only reads headers off the request during validation.
const fakeRequest = { headers: {} } as unknown as IncomingMessage;

function validateImageUrl(config: NextConfigComplete, url: string) {
  return ImageOptimizerCache.validateParams(fakeRequest, { url, w: "64", q: "75" }, config, false);
}

// A representative sample of remote origins an attacker (or a careless future
// change) could point the optimizer at. None of them is used by the app.
const REMOTE_URLS = [
  "https://github.com/fluidicon.png",
  "https://evil.example/anything.png",
  "https://mpgrhub.xyz/icon.png", // even our own public origin must go through the local path, not the remote fetcher
  "https://mpgr-hub-git-fix.vercel.app/icon.png",
  "https://127.0.0.1/secret.png",
  "https://169.254.169.254/latest/meta-data/",
  "http://example.com/plain-http.png",
  "https://sub.domain.example.com/deep/path/image.webp",
];

// Real local assets the UI references today (see components/brand/BrandMark.tsx,
// lib/games/game-registry.ts, components/features/games/FeaturedGameBanner.tsx).
const LOCAL_URLS = [
  "/icon.png",
  "/splash.png",
  "/games/mpgr-run/character/mpgr-runner-idle.webp",
  "/games/mpgr-run/character/mpgr-runner-run.webp",
];

describe("next.config.mjs — images.remotePatterns", () => {
  let config: NextConfigComplete;

  beforeAll(async () => {
    config = await loadConfig(PHASE_PRODUCTION_BUILD, REPO_ROOT, { silent: true });
  });

  it("does not use a wildcard hostname (no open image proxy)", () => {
    const patterns = config.images.remotePatterns ?? [];
    for (const pattern of patterns) {
      expect(pattern.hostname, JSON.stringify(pattern)).not.toContain("*");
      expect(pattern.protocol, JSON.stringify(pattern)).toBe("https");
    }
  });

  it("keeps the remote allowlist empty because the app has no remote next/image source", () => {
    expect(config.images.remotePatterns).toEqual([]);
    // The deprecated `images.domains` escape hatch must not be used either.
    expect(config.images.domains ?? []).toEqual([]);
  });

  it.each(REMOTE_URLS)("rejects remote URL %s at the image optimizer boundary", (url) => {
    const result = validateImageUrl(config, url);
    expect(result).toEqual({ errorMessage: '"url" parameter is not allowed' });
  });

  it.each(LOCAL_URLS)("still accepts the local asset %s", (url) => {
    const result = validateImageUrl(config, url);
    expect(result).not.toHaveProperty("errorMessage");
    expect(result).toMatchObject({ href: url, isAbsolute: false, width: 64, quality: 75 });
  });

  it("rejects protocol-relative and recursive optimizer URLs", () => {
    expect(validateImageUrl(config, "//github.com/fluidicon.png")).toEqual({
      errorMessage: '"url" parameter cannot be a protocol-relative URL (//)',
    });
    expect(validateImageUrl(config, "/_next/image?url=%2Ficon.png&w=64&q=75")).toEqual({
      errorMessage: '"url" parameter cannot be recursive',
    });
  });
});

describe("next.config.mjs — response headers (unchanged by the images fix)", () => {
  let config: NextConfigComplete;

  beforeAll(async () => {
    config = await loadConfig(PHASE_PRODUCTION_BUILD, REPO_ROOT, { silent: true });
  });

  it("keeps the immutable cache rule for versioned MPGR Run assets", async () => {
    const rules = await config.headers();
    const gameRule = rules.find((rule) => rule.source === "/games/mpgr-run/:path*");
    expect(gameRule?.headers).toEqual([
      { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
    ]);
  });

  it("keeps the global security headers exactly as deployed today", async () => {
    // NOTE: the framing policy (X-Frame-Options: DENY) is intentionally still
    // in place. Replacing it with a CSP frame-ancestors allowlist for the
    // Farcaster/Base mini-app hosts is a separate, owner-approved change.
    const rules = await config.headers();
    const globalRule = rules.find((rule) => rule.source === "/:path*");
    expect(globalRule?.headers).toEqual([
      { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ]);
  });
});
