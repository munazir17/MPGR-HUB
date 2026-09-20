// Task 8 — referral endpoints stay rate-limited, dual-bucket.
//
// Separate file on purpose: these tests deliberately EXHAUST the shared
// per-IP bucket of the real limiter, which would make every other referral
// test in the suite flaky if it lived next to them. No mocking of the
// guard — the real protectApiRequest → verifyTrustedOrigin → enforceRateLimit
// chain runs against the Redis double.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));

const APP_ORIGIN = "https://mpgrhub.xyz";
vi.stubEnv("AUTH_SESSION_SECRET", "s".repeat(32));
vi.stubEnv("APP_ORIGIN", APP_ORIGIN);

const REFERRER = "0xaaaa000000000000000000000000000000000001" as Address;

beforeEach(() => {
  redis.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T03:00:00.000Z")); // fixed window
});

describe("POST /api/referral request guard", () => {
  it("allows 20 requests per minute then 429s (authed), keeping the 200/429 contract", async () => {
    const { issueSession } = await import("@/lib/auth/session-store");
    const { value } = await issueSession("0xbbbb000000000000000000000000000000000002" as Address);
    const cookie = `mpgr_session=${value}`;
    const { POST } = await import("./route");

    let ok = 0;
    for (let i = 0; i < 20; i++) {
      const res = await POST(
        new Request(`${APP_ORIGIN}/api/referral`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: APP_ORIGIN, cookie },
          body: JSON.stringify({ referrer: REFERRER }),
        }),
      );
      expect(res.status).toBeLessThan(300); // registered / already-attributed
      ok += 1;
    }
    expect(ok).toBe(20);

    const blocked = await POST(
      new Request(`${APP_ORIGIN}/api/referral`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN, cookie },
        body: JSON.stringify({ referrer: REFERRER }),
      }),
    );
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).code).toBe("RATE_LIMITED");
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  it("limits unauthenticated floods too — auth failures cannot dodge the limiter", async () => {
    const { POST } = await import("./route");
    const body = JSON.stringify({ referrer: REFERRER });
    for (let i = 0; i < 20; i++) {
      const res = await POST(
        new Request(`${APP_ORIGIN}/api/referral`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: APP_ORIGIN },
          body,
        }),
      );
      expect(res.status).toBe(401);
    }
    const blocked = await POST(
      new Request(`${APP_ORIGIN}/api/referral`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN },
        body,
      }),
    );
    expect(blocked.status).toBe(429);
  });

  it("separates buckets per IP: rotating source IPs does not reset the per-wallet bucket and vice versa", async () => {
    const { issueSession } = await import("@/lib/auth/session-store");
    const { value } = await issueSession("0xbbbb000000000000000000000000000000000002" as Address);
    const cookie = `mpgr_session=${value}`;
    const { POST } = await import("./route");
    const body = JSON.stringify({ referrer: REFERRER });

    // Same wallet, 20 DIFFERENT IPs: the wallet bucket still saturates at 20.
    let statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await POST(
        new Request(`${APP_ORIGIN}/api/referral`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: APP_ORIGIN,
            cookie,
            "x-forwarded-for": `203.0.113.${i}`,
          },
          body,
        }),
      );
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);

    // Fresh wallets from ONE IP saturate the IP bucket instead (Task 3 rule).
    statuses = [];
    for (let i = 0; i < 21; i++) {
      const { value: fresh } = await issueSession(
        (`0xcccc${i.toString(16).padStart(4, "0")}${"0".repeat(34)}`) as Address,
      );
      const res = await POST(
        new Request(`${APP_ORIGIN}/api/referral`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: APP_ORIGIN,
            cookie: `mpgr_session=${fresh}`,
            "x-forwarded-for": "198.51.100.7",
          },
          body: JSON.stringify({ referrer: "0xaaaa000000000000000000000000000000000009" }),
        }),
      );
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });
});
