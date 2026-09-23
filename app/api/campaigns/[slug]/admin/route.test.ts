// app/api/campaigns/[slug]/admin/route.test.ts
//
// Admin/internal results endpoint: CRON_SECRET bearer gate (same posture
// as the game settlement route) + winner identification payloads +
// reward bookkeeping writes.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));

const APP_ORIGIN = "https://mpgrhub.xyz";
const ADMIN_SECRET = "c".repeat(32);
vi.stubEnv("AUTH_SESSION_SECRET", "s".repeat(32));
vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
vi.stubEnv("CRON_SECRET", ADMIN_SECRET);

const BASE = Date.parse("2026-09-20T12:00:00.000Z");
let suiteTick = 0;

const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";

async function adminGet(slug: string, bearer?: string): Promise<Response> {
  const { GET } = await import("./route");
  return GET(
    new Request(`${APP_ORIGIN}/api/campaigns/${slug}/admin`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }),
    { params: Promise.resolve({ slug }) },
  );
}

async function adminPost(slug: string, body: unknown, bearer?: string): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request(`${APP_ORIGIN}/api/campaigns/${slug}/admin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );
}

/** Seed two participants with deterministic scores via the real store. */
async function seedParticipants() {
  const { campaignStore } = await import("@/lib/campaigns/campaign-store");
  const { findCampaignBySlug } = await import("@/lib/campaigns/campaign-registry");
  const campaign = findCampaignBySlug("mpgr-run-weekly")!;
  const now = new Date(BASE + suiteTick * 61_000);
  await campaignStore.joinCampaign(
    campaign,
    { wallet: W1, farcasterId: null, displayName: "Alpha", eligibility: "eligible", eligibilityReason: null },
    now,
  );
  await campaignStore.joinCampaign(
    campaign,
    { wallet: W2, farcasterId: null, displayName: null, eligibility: "eligible", eligibilityReason: null },
    now,
  );
  await campaignStore.recordAction(campaign, W1, { actionId: "verified_run", points: 500, metricDelta: 9_000, eventId: "seed-1" }, now);
  await campaignStore.recordAction(campaign, W2, { actionId: "verified_run", points: 300, metricDelta: 7_000, eventId: "seed-2" }, now);
}

beforeEach(() => {
  redis.reset();
  suiteTick += 1;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE + suiteTick * 61_000));
  vi.stubEnv("CRON_SECRET", ADMIN_SECRET);
});

describe("admin auth gate", () => {
  it("rejects requests with no bearer token", async () => {
    expect((await adminGet("mpgr-run-weekly")).status).toBe(401);
    expect((await adminPost("mpgr-run-weekly", { wallet: W1, rewardStatus: "distributed" })).status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    expect((await adminGet("mpgr-run-weekly", "wrong-secret")).status).toBe(401);
    expect((await adminGet("mpgr-run-weekly", ADMIN_SECRET.slice(0, -1) + "d")).status).toBe(401);
  });

  it("fails closed when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await adminGet("mpgr-run-weekly", ADMIN_SECRET)).status).toBe(401);
  });
});

describe("GET admin results — winner identification", () => {
  it("returns ranked participants with wallet, score, and reward fields", async () => {
    await seedParticipants();
    const res = await adminGet("mpgr-run-weekly", ADMIN_SECRET);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.campaign.slug).toBe("mpgr-run-weekly");
    expect(data.participantCount).toBe(2);
    expect(data.top).toHaveLength(2);

    const [first, second] = data.participants;
    // WHO WON / WHAT SCORE / WHICH WALLET
    expect(first.wallet).toBe(W1);
    expect(first.rank).toBe(1);
    expect(first.points).toBe(600); // 100 join + 500
    expect(first.displayName).toBe("Alpha");
    expect(first.eligibility).toBe("eligible");
    expect(first.rewardStatus).toBe("pending");
    // WHAT REWARD
    expect(data.campaign.rewardPool).toBe("1000000");
    expect(data.campaign.rewardType).toBe("MPGR");
    expect(data.campaign.rewardDistribution).toBeTruthy();

    expect(second.wallet).toBe(W2);
    expect(second.rank).toBe(2);
    expect(second.points).toBe(400);
    expect(second.joinedAt).toBeTruthy();
    expect(second.lastActivityAt).toBeTruthy();
  });

  it("404s an unknown campaign", async () => {
    expect((await adminGet("no-such-campaign", ADMIN_SECRET)).status).toBe(404);
  });
});

describe("POST admin reward bookkeeping", () => {
  it("records a distributed reward against the participant", async () => {
    await seedParticipants();
    const res = await adminPost(
      "mpgr-run-weekly",
      {
        wallet: W1,
        rewardStatus: "distributed",
        rewardAmount: "400000 MPGR",
        rewardTxHash: "0x" + "ab".repeat(32),
      },
      ADMIN_SECRET,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.participant.rewardStatus).toBe("distributed");
    expect(data.participant.rewardTxHash).toBe("0x" + "ab".repeat(32));

    // Persisted for later retrieval.
    const check = await adminGet("mpgr-run-weekly", ADMIN_SECRET);
    const results = await check.json();
    const winner = results.participants.find((p: { wallet: string }) => p.wallet === W1);
    expect(winner.rewardStatus).toBe("distributed");
    expect(winner.points).toBe(600); // scores untouched by reward writes
  });

  it("validates the body shape", async () => {
    expect((await adminPost("mpgr-run-weekly", { rewardStatus: "distributed" }, ADMIN_SECRET)).status).toBe(400);
    expect(
      (await adminPost("mpgr-run-weekly", { wallet: W1, rewardStatus: "exploded" }, ADMIN_SECRET)).status,
    ).toBe(400);
    expect(
      (
        await adminPost(
          "mpgr-run-weekly",
          { wallet: W1, rewardStatus: "distributed", rewardTxHash: "not-a-hash" },
          ADMIN_SECRET,
        )
      ).status,
    ).toBe(400);
  });

  it("404s reward updates for wallets that never joined", async () => {
    const res = await adminPost(
      "mpgr-run-weekly",
      { wallet: "0x9999999999999999999999999999999999999999", rewardStatus: "distributed" },
      ADMIN_SECRET,
    );
    expect(res.status).toBe(404);
  });
});
