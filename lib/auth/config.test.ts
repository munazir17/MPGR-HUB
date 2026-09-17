import { afterEach, describe, expect, it, vi } from "vitest";

import { getAppOrigin, shouldDeriveOriginFromRequest } from "./config";

describe("getAppOrigin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses APP_ORIGIN when configured", () => {
    vi.stubEnv("APP_ORIGIN", "https://mpgrhub.xyz/");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(getAppOrigin("https://ignored.example/api")).toBe("https://mpgrhub.xyz");
  });

  it("fails closed in production when APP_ORIGIN is missing", () => {
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(() => getAppOrigin("https://mpgrhub.xyz/api/trade/quote")).toThrow(
      /APP_ORIGIN must be configured in production/,
    );
    expect(shouldDeriveOriginFromRequest()).toBe(false);
  });

  it("derives the request origin on Vercel Preview when APP_ORIGIN is unset", () => {
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(shouldDeriveOriginFromRequest()).toBe(true);
    expect(getAppOrigin("https://mpgr-hub-git-fix.vercel.app/api/trade/quote")).toBe(
      "https://mpgr-hub-git-fix.vercel.app",
    );
  });

  it("still requires a request URL to derive on Preview", () => {
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(() => getAppOrigin()).toThrow(/APP_ORIGIN must be configured in production/);
  });
});
