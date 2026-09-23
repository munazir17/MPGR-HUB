// app/api/campaigns/[slug]/route.test.ts
//
// Campaign detail + participation writes against the REAL handlers and
// the fengari Redis double (real sessions, real origin check, real rate
// limiter, real store scripts). Only the game-evidence store is mocked
// at its module boundary — the adapter still validates everything it
// returns.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";
import type { RunRecord } from "@/lib/reward-allocation/allocation-types";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));

const { getRunRecord } = vi.hoisted(() => ({
  getRunRecord: vi.fn(async (_sessionId: string): Promise<RunRecord | null> => null),
}));
vi.mock("@/lib/reward-allocation/kv-allocation-store", () => ({
  kvAllocationStore: { getRunRecord },
}));

const APP_ORIGIN = "https://mpgrhub.xyz";
vi.stubEnv("AUTH_SESSION_SECRET", "s".repeat(32));
vi.stubEnv("APP_ORIGIN", APP_ORIGIN);

const BASE = Date.parse("2026-10-16T12:00:00.000Z");
let suiteTick = 0;

const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";

async function cookieFor(wallet: `0x${string}`): Promise<string> {
  const { issueSession } = await import("@/lib/auth/session-store");
  const { value } = await issueSession(wallet);
  return `mpgr_session=${value}`;
}

async function get(slug: string, cookie?: string): Promise<Response> {
  const { GET } = await import("./route");
  return GET(
    new Request(`${APP_ORIGIN}/api/campaigns/${slug}`, { headers: cookie ? { cookie } : {} }),
    { params: Promise.resolve({ slug }) },
  );
}

async function post(
  slug: string,
  body: unknown,
  options: { cookie?: string; origin?: string } = {},
): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request(`${APP_ORIGIN}/api/campaigns/${slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: options.origin ?? APP_ORIGIN,
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );
}

function mockRun(sessionId: string, wallet: string, score: number, submittedAt = "2026-10-16T10:00:00.000Z") {
  getRunRecord.mockResolvedValueOnce({
    sessionId,
    wallet: wallet as RunRecord["wallet"],
    weekKey: "2026-W38",
    submittedAt,
    serverValidated: true,
    result: { score } as RunRecord["result"],
  });
}

beforeEach(() => {
  redis.reset();
  getRunRecord.mockReset();
  suiteTick += 1;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE + suiteTick * 61_000));
});

describe("GET /api/campaigns/[slug]", () => {
  it("returns the campaign with an empty leaderboard before anyone joins", async () => {
    const res = await get("mpgr-run-weekly");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.campaign.slug).toBe("mpgr-run-weekly");
    expect(data.campaign.status).toBe("active");
    expect(data.leaderboard).toEqual([]);
    expect(data.campaign.participantCount).toBe(0);
  });

  it("404s for an unknown slug", async () => {
    const res = await get("does-not-exist");
    expect(res.status).toBe(404);
  });

  it("serves the frozen leaderboard for a completed campaign", async () => {
    // Move past the agent window so it resolves to completed.
    vi.setSystemTime(new Date("2026-11-16T12:00:00.000Z"));
    const res = await get("agent-competition");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.campaign.status).toBe("completed");
    expect(data.campaign.finalized).toBe(true);
    expect(Array.isArray(data.leaderboard)).toBe(true);
  });
});

describe("POST join", () => {
  it("requires an authenticated session", async () => {
    const res = await post("mpgr-run-weekly", { action: "join" });
    expect(res.status).toBe(401);
  });

  it("rejects a cross-site request (cookie-only CSRF defense)", async () => {
    const cookie = await cookieFor(W1 as `0x${string}`);
    const res = await post("mpgr-run-weekly", { action: "join" }, { cookie, origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("joins an active campaign and awards participation points", async () => {
    const cookie = await cookieFor(W1 as `0x${string}`);
    const res = await post("mpgr-run-weekly", { action: "join", displayName: "ChainRunner" }, { cookie });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("joined");
    expect(data.standing).toMatchObject({ joined: true, points: 100, rank: 1 });
  });

  it("is idempotent — rejoining never double-pays participation", async () => {
    const cookie = await cookieFor(W1 as `0x${string}`);
    await post("mpgr-run-weekly", { action: "join" }, { cookie });
    const res = await post("mpgr-run-weekly", { action: "join" }, { cookie });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("already-joined");
    expect(data.standing.points).toBe(100);
  });

  it("refuses to join a campaign that has not started or has ended", async () => {
    const cookie = await cookieFor(W1 as `0x${string}`);
    const upcoming = await post("trading-competition", { action: "join" }, { cookie });
    expect(upcoming.status).toBe(409);
    const completed = await post("agent-competition", { action: "join" }, { cookie });
    expect(completed.status).toBe(409);
  });
});

describe("POST track", () => {
  it("requires join first", async () => {
    const cookie = await cookieFor(W1 as `0x${string}`);
    const res = await post("mpgr-run-weekly", { action: "track", actionId: "verified_run", payload: { sessionId: "session-abc-123" } }, { cookie });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.code).toBe("not-participant");
  });

  it("records a server-verified run and returns the new standing", async () => {
    const cookie = await cookieFor(W1 as `0x${string}`);
    await post("mpgr-run-weekly", { action: "join" }, { cookie });

    mockRun("session-abc-123", W1, 4_200);
    const res = await post(
      "mpgr-run-weekly",
      {
        action: "track",
        actionId: "verified_run",
        payload: { sessionId: "session-abc-123" },
      },
      { cookie },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("recorded");
    // 100 join + 50 base + min(floor(4200/100), 450)=42
    expect(data.pointsAwarded).toBe(92);
    expect(data.standing.points).toBe(192);
    expect(data.standing.rank).toBe(1);
    expect(data.standing.completedActions).toEqual({ verified_run: 1 });
  });

  it("counts the same run session exactly once (server evidence idempotency)", async () => {
    const cookie = await cookieFor(W1 as `0x${string}`);
    await post("mpgr-run-weekly", { action: "join" }, { cookie });

    mockRun("session-abc-123", W1, 4_200);
    const first = await post(
      "mpgr-run-weekly",
      { action: "track", actionId: "verified_run", payload: { sessionId: "session-abc-123" } },
      { cookie },
    );
    expect((await first.json()).status).toBe("recorded");

    // Even if the store still has the run, the second submission dedupes.
    mockRun("session-abc-123", W1, 4_200);
    const second = await post(
      "mpgr-run-weekly",
      { action: "track", actionId: "verified_run", payload: { sessionId: "session-abc-123" } },
      { cookie },
    );
    expect(second.status).toBe(200);
    const data = await second.json();
    expect(data.status).toBe("duplicate");
    expect(data.standing.points).toBe(192);
  });

  it("rejects a run belonging to another wallet", async () => {
    const cookie = await cookieFor(W1 as `0x${string}`);
    await post("mpgr-run-weekly", { action: "join" }, { cookie });
    mockRun("session-abc-123", W2, 4_200);
    const res = await post(
      "mpgr-run-weekly",
      { action: "track", actionId: "verified_run", payload: { sessionId: "session-abc-123" } },
      { cookie },
    );
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.code).toBe("adapter-rejected");
  });

  it("enforces the per-action daily cap (429)", async () => {
    const cookie = await cookieFor(W1 as `0x${string}`);
    await post("mpgr-run-weekly", { action: "join" }, { cookie });

    for (let i = 0; i < 10; i += 1) {
      mockRun(`session-day-${i}`, W1, 100 + i);
      const res = await post(
        "mpgr-run-weekly",
        { action: "track", actionId: "verified_run", payload: { sessionId: `session-day-${i}` } },
        { cookie },
      );
      expect(res.status).toBe(200);
    }
    mockRun("session-day-overflow", W1, 500);
    const overflow = await post(
      "mpgr-run-weekly",
      { action: "track", actionId: "verified_run", payload: { sessionId: "session-day-overflow" } },
      { cookie },
    );
    expect(overflow.status).toBe(429);
    expect((await overflow.json()).code).toBe("action-daily-cap");
  });

  it("rejects unknown actions and malformed bodies", async () => {
    const cookie = await cookieFor(W1 as `0x${string}`);
    await post("mpgr-run-weekly", { action: "join" }, { cookie });

    const unknown = await post("mpgr-run-weekly", { action: "track", actionId: "nope" }, { cookie });
    expect(unknown.status).toBe(400);

    const malformed = await post("mpgr-run-weekly", { action: "teleport" }, { cookie });
    expect(malformed.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await post("mpgr-run-weekly", { action: "track", actionId: "verified_run" });
    expect(res.status).toBe(401);
  });
});
