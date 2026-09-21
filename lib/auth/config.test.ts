import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allowRequestDerivedOrigin,
  getAppOrigin,
  getAuthCookieAttributes,
  resolveTrustedAppOrigin,
  shouldDeriveOriginFromRequest,
} from "./config";

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

describe("resolveTrustedAppOrigin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const proxyRequest = () =>
    new Request("http://3000-sandbox-preview.e2b.app/api/agent/complete", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
    });

  it("prefers a configured APP_ORIGIN and ignores request headers", () => {
    vi.stubEnv("APP_ORIGIN", "https://mpgrhub.xyz/");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(resolveTrustedAppOrigin(proxyRequest())).toBe("https://mpgrhub.xyz");
  });

  it("upgrades the derived scheme from x-forwarded-proto for TLS-terminating previews", () => {
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("APP_ORIGIN_ALLOW_REQUEST_DERIVED", "1");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "");
    expect(resolveTrustedAppOrigin(proxyRequest())).toBe("https://3000-sandbox-preview.e2b.app");
  });

  it("uses the proxy Host header, not the bind address, behind TLS", () => {
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("APP_ORIGIN_ALLOW_REQUEST_DERIVED", "1");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "");
    // Exactly what an ephemeral preview sees: the framework builds
    // request.url from the server's bind address while the public host only
    // arrives in the Host header.
    const bound = new Request("http://0.0.0.0:3000/api/agent/complete", {
      method: "POST",
      headers: { host: "3000-sandbox-preview.e2b.app", "x-forwarded-proto": "https" },
    });
    expect(bound.url).toBe("http://0.0.0.0:3000/api/agent/complete");
    expect(resolveTrustedAppOrigin(bound)).toBe("https://3000-sandbox-preview.e2b.app");
  });

  it("only honours the opt-in outside Vercel production", () => {
    vi.stubEnv("APP_ORIGIN_ALLOW_REQUEST_DERIVED", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(allowRequestDerivedOrigin()).toBe(false);
    vi.stubEnv("VERCEL_ENV", "");
    expect(allowRequestDerivedOrigin()).toBe(true);
  });

  it("throws without APP_ORIGIN when derivation is not allowed", () => {
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("APP_ORIGIN_ALLOW_REQUEST_DERIVED", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "");
    expect(() => resolveTrustedAppOrigin(proxyRequest())).toThrow(
      /APP_ORIGIN must be configured in production/,
    );
  });
});

describe("getAuthCookieAttributes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses SameSite=None; Secure; HttpOnly; Path=/ in production (Mini App)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const cookie = getAuthCookieAttributes();
    expect(cookie).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
    });
    expect(cookie).not.toHaveProperty("domain");
  });

  it("keeps SameSite=Lax on local HTTP development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(getAuthCookieAttributes()).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
    });
  });
});
