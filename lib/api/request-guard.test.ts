import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readJsonBody, requestIdFromRequest, verifyTrustedOrigin, protectApiRequest } from "./request-guard";

describe("request guard", () => {
  it("rejects a body larger than the byte limit", async () => {
    const request = new Request("http://localhost/api/xp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(17 * 1024),
    });
    const parsed = await readJsonBody(request, 16 * 1024);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.status).toBe(413);
  });

  it("rejects invalid JSON inside the size limit", async () => {
    const request = new Request("http://localhost/api/xp", {
      method: "POST",
      body: "{not-json",
    });
    const parsed = await readJsonBody(request);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.status).toBe(400);
  });

  it("accepts a valid JSON object and prefers a well-formed request id", async () => {
    const request = new Request("http://localhost/api/xp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-123" },
      body: JSON.stringify({ action: "DAILY_CHECK_IN" }),
    });
    const parsed = await readJsonBody<{ action: string }>(request);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.action).toBe("DAILY_CHECK_IN");
    expect(requestIdFromRequest(request)).toBe("req-123");
  });
});

// ---------------------------------------------------------------------
// verifyTrustedOrigin — the CSRF gate added when production auth
// cookies became `SameSite=None` (see lib/auth/config.ts). Deliberately
// uses the REAL implementation end to end (no mocking of
// verifyTrustedOrigin, getAppOrigin, or getSessionFromRequest) so this
// exercises exactly what a real request hits.
// ---------------------------------------------------------------------
describe("verifyTrustedOrigin", () => {
  const APP_ORIGIN = "https://mpgrhub.xyz";
  let savedAppOrigin: string | undefined;

  beforeEach(() => {
    savedAppOrigin = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = APP_ORIGIN;
  });

  afterEach(() => {
    if (savedAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = savedAppOrigin;
  });

  function requestWithHeaders(method: string, headers: Record<string, string> = {}): Request {
    return new Request(`${APP_ORIGIN}/api/xp`, { method, headers });
  }

  it("allows a same-origin POST", () => {
    expect(verifyTrustedOrigin(requestWithHeaders("POST", { origin: APP_ORIGIN }))).toBeNull();
  });

  it("allows a same-origin PUT", () => {
    expect(verifyTrustedOrigin(requestWithHeaders("PUT", { origin: APP_ORIGIN }))).toBeNull();
  });

  it("allows a same-origin PATCH", () => {
    expect(verifyTrustedOrigin(requestWithHeaders("PATCH", { origin: APP_ORIGIN }))).toBeNull();
  });

  it("allows a same-origin DELETE", () => {
    expect(verifyTrustedOrigin(requestWithHeaders("DELETE", { origin: APP_ORIGIN }))).toBeNull();
  });

  it("rejects a cross-origin POST with 403", () => {
    const response = verifyTrustedOrigin(requestWithHeaders("POST", { origin: "https://evil.com" }));
    expect(response).not.toBeNull();
    expect(response?.status).toBe(403);
  });

  it("rejects cross-origin PUT, PATCH, and DELETE with 403", () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const response = verifyTrustedOrigin(requestWithHeaders(method, { origin: "https://evil.com" }));
      expect(response?.status).toBe(403);
    }
  });

  it("allows when the Origin header matches the configured app origin", () => {
    expect(verifyTrustedOrigin(requestWithHeaders("POST", { origin: APP_ORIGIN }))).toBeNull();
  });

  it("rejects when the Origin header does not match (cross-site mismatch)", () => {
    const response = verifyTrustedOrigin(requestWithHeaders("POST", { origin: "https://attacker.example" }));
    expect(response?.status).toBe(403);
  });

  it("falls back to a matching Referer when Origin is absent", () => {
    const response = verifyTrustedOrigin(
      requestWithHeaders("POST", { referer: `${APP_ORIGIN}/games/mpgr-run` }),
    );
    expect(response).toBeNull();
  });

  it("rejects when both Origin and Referer are absent", () => {
    const response = verifyTrustedOrigin(requestWithHeaders("POST"));
    expect(response).not.toBeNull();
    expect(response?.status).toBe(403);
  });

  it("rejects a malformed Origin header", () => {
    const response = verifyTrustedOrigin(requestWithHeaders("POST", { origin: "not-a-valid-url" }));
    expect(response?.status).toBe(403);
  });

  it("allows GET regardless of origin", () => {
    expect(verifyTrustedOrigin(requestWithHeaders("GET", { origin: "https://evil.com" }))).toBeNull();
  });

  it("allows HEAD regardless of origin", () => {
    expect(verifyTrustedOrigin(requestWithHeaders("HEAD", { origin: "https://evil.com" }))).toBeNull();
  });

  it("allows OPTIONS regardless of origin", () => {
    expect(verifyTrustedOrigin(requestWithHeaders("OPTIONS", { origin: "https://evil.com" }))).toBeNull();
  });

  it("respects a configured APP_ORIGIN even when the request URL's own host differs", () => {
    process.env.APP_ORIGIN = "https://mpgrhub.xyz";
    const request = new Request("http://localhost:3000/api/xp", {
      method: "POST",
      headers: { origin: "https://mpgrhub.xyz" },
    });
    expect(verifyTrustedOrigin(request)).toBeNull();
  });

  it("rejects an Origin that matches the request's own host but not the configured APP_ORIGIN", () => {
    process.env.APP_ORIGIN = "https://mpgrhub.xyz";
    const request = new Request("http://localhost:3000/api/xp", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    });
    const response = verifyTrustedOrigin(request);
    expect(response?.status).toBe(403);
  });
});

// ---------------------------------------------------------------------
// protectApiRequest — with the REAL verifyTrustedOrigin wired in (not
// mocked). No Redis env vars are configured in this test environment,
// so a request that clears the origin gate falls through to
// enforceRateLimit's own fail-closed 503 ("Rate limiting is not
// configured") rather than to `error: null` — that 503 (not a 403) is
// exactly what proves the real origin check let the request through
// before failing later for an unrelated reason.
// ---------------------------------------------------------------------
describe("protectApiRequest (real verifyTrustedOrigin, unmocked)", () => {
  const APP_ORIGIN = "https://mpgrhub.xyz";
  let savedAppOrigin: string | undefined;
  let savedRedisEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedAppOrigin = process.env.APP_ORIGIN;
    savedRedisEnv = {
      UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    };
    process.env.APP_ORIGIN = APP_ORIGIN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  });

  afterEach(() => {
    if (savedAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = savedAppOrigin;
    for (const [key, value] of Object.entries(savedRedisEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("rejects a cross-origin request with 403 before it ever reaches rate limiting", async () => {
    const request = new Request(`${APP_ORIGIN}/api/xp`, {
      method: "POST",
      headers: { origin: "https://evil.com" },
    });
    const result = await protectApiRequest(request, "test-bucket", 10, 60);
    expect(result.error).not.toBeNull();
    expect(result.error?.status).toBe(403);
  });

  it("lets a same-origin request past the origin gate", async () => {
    const request = new Request(`${APP_ORIGIN}/api/xp`, {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    const result = await protectApiRequest(request, "test-bucket", 10, 60);
    // Not a 403 — the origin gate passed. It fails later (503) purely
    // because this test environment has no Redis configured, which is
    // enforceRateLimit's own unrelated fail-closed behavior.
    expect(result.error?.status).toBe(503);
  });
});

describe("verifyTrustedOrigin — Preview vs production configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails safely when origin configuration is missing in production", async () => {
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    const request = new Request("https://mpgrhub.xyz/api/trade/quote", {
      method: "POST",
      headers: { origin: "https://mpgrhub.xyz", "content-type": "application/json" },
      body: JSON.stringify({ fromToken: "ETH", toToken: "USDC" }),
    });
    const response = verifyTrustedOrigin(request);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: "Origin verification is not configured" });
  });

  it("enforces origin verification on Vercel Preview using the request origin", async () => {
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    const preview = "https://mpgr-hub-git-fix.vercel.app";
    const ok = verifyTrustedOrigin(
      new Request(`${preview}/api/trade/quote`, {
        method: "POST",
        headers: { origin: preview },
      }),
    );
    expect(ok).toBeNull();

    const rejected = verifyTrustedOrigin(
      new Request(`${preview}/api/trade/quote`, {
        method: "POST",
        headers: { origin: "https://evil.com" },
      }),
    );
    expect(rejected?.status).toBe(403);
    expect(await rejected?.json()).toEqual({ error: "Cross-site request rejected" });
  });

  it("still rejects a missing Origin header on Preview", () => {
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    const response = verifyTrustedOrigin(
      new Request("https://mpgr-hub-git-fix.vercel.app/api/trade/quote", { method: "POST" }),
    );
    expect(response?.status).toBe(403);
  });
});
