// app/api/campaigns/route.test.ts
//
// Public campaign listing — config-driven responses, status filters, and
// viewer standing assembly against the real handlers + fengari Redis.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));

const APP_ORIGIN = "https://mpgrhub.xyz";
vi.stubEnv("AUTH_SESSION_SECRET", "s".repeat(32));
vi.stubEnv("APP_ORIGIN", APP_ORIGIN);

const BASE = Date.parse("2026-09-20T12:00:00.000Z");
let suiteTick = 0;

async function cookieFor(wallet: `0x${string}`): Promise<string> {
  const { issueSession } = await import("@/lib/auth/session-store");
  const { value } = await issueSession(wallet);
  return `mpgr_session=${value}`;
}

async function getList(url = `${APP_ORIGIN}/api/campaigns`, cookie?: string): Promise<Response> {
  const { GET } = await import("./route");
  return GET(
    new Request(url, {
      headers: cookie ? { cookie } : {},
    }),
  );
}

beforeEach(() => {
  redis.reset();
  suiteTick += 1;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE + suiteTick * 61_000));
});

describe("GET /api/campaigns", () => {
  it("returns every configured campaign with resolved statuses", async () => {
    const res = await getList();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.campaigns)).toBe(true);
    expect(data.campaigns.length).toBeGreaterThanOrEqual(3);

    const bySlug = Object.fromEntries(data.campaigns.map((c: { slug: string }) => [c.slug, c]));
    expect(bySlug["mpgr-run-weekly"].status).toBe("active");
    expect(bySlug["trading-competition"].status).toBe("upcoming");
    expect(bySlug["agent-competition"].status).toBe("completed");

    // Normalized public shape the UI consumes.
    const run = bySlug["mpgr-run-weekly"];
    expect(run.rewardPool).toBe("1000000");
    expect(run.rewardType).toBe("MPGR");
    expect(run.leaderboardEnabled).toBe(true);
    expect(run.rules.length).toBeGreaterThan(0);
    expect(run.participantCount).toBe(0);
    expect(run.viewer).toBeNull();
  });

  it("rejects an invalid status filter", async () => {
    const res = await getList(`${APP_ORIGIN}/api/campaigns?status=weird`);
    expect(res.status).toBe(400);
  });

  it("filters by status", async () => {
    const res = await getList(`${APP_ORIGIN}/api/campaigns?status=active`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.campaigns.every((c: { status: string }) => c.status === "active")).toBe(true);
    expect(data.campaigns.map((c: { slug: string }) => c.slug)).toContain("mpgr-run-weekly");
  });

  it("attaches the viewer standing when a session cookie is present", async () => {
    const wallet = "0x1111111111111111111111111111111111111111" as const;
    const cookie = await cookieFor(wallet);

    const { POST } = await import("./[slug]/route");
    const joinRes = await POST(
      new Request(`${APP_ORIGIN}/api/campaigns/mpgr-run-weekly`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN, cookie },
        body: JSON.stringify({ action: "join" }),
      }),
      { params: Promise.resolve({ slug: "mpgr-run-weekly" }) },
    );
    expect(joinRes.status).toBe(200);

    const res = await getList(`${APP_ORIGIN}/api/campaigns`, cookie);
    const data = await res.json();
    const run = data.campaigns.find((c: { slug: string }) => c.slug === "mpgr-run-weekly");
    expect(run.participantCount).toBe(1);
    expect(run.viewer).toMatchObject({ joined: true, points: 100, rank: 1 });
  });

  it("finalizes a completed campaign's leaderboard on read (write-once)", async () => {
    const res = await getList();
    expect(res.status).toBe(200);
    const data = await res.json();
    const agent = data.campaigns.find((c: { slug: string }) => c.slug === "agent-competition");
    expect(agent.finalized).toBe(true);
    const snapshot = await redis.client().get(`mpgrhub:campaign:final:agent-competition-001`);
    expect(snapshot).not.toBeNull();
  });
});
