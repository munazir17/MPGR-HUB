// lib/campaigns/campaign-store.test.ts
//
// Persistent campaign participation store — runs the REAL Lua scripts
// through the fengari Redis double (same harness as xp-ledger durability
// and referral-store tests), so join idempotency, cap enforcement,
// ranking, finalization, and historical isolation are proven over actual
// script execution.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";
import type { CampaignDefinition } from "./campaign-types";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));

import { campaignStore } from "./campaign-store";
import { findCampaignBySlug } from "./campaign-registry";

const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";
const W3 = "0x3333333333333333333333333333333333333333";

function identity(wallet: string) {
  return {
    wallet,
    farcasterId: null,
    displayName: null,
    eligibility: "eligible" as const,
    eligibilityReason: null,
  };
}

/** Small test campaign exercising every store feature. */
function makeCampaign(id: string, patch: Partial<CampaignDefinition> = {}): CampaignDefinition {
  return {
    id,
    slug: id,
    title: "Test Campaign",
    description: "Test campaign for the store.",
    startAt: "2026-09-01T00:00:00.000Z",
    endAt: "2026-09-30T00:00:00.000Z",
    status: "auto",
    eventType: "social",
    trackingMetric: "points",
    rules: [],
    rewardPool: "100",
    rewardType: "MPGR",
    leaderboardEnabled: true,
    points: {
      participation: 10,
      actions: [
        { id: "check_in", label: "Check in", points: 5, maxPerDay: 3 },
        { id: "big", label: "Big", points: 1000 },
      ],
      dailyCap: 10_000,
      maxPoints: 1_100,
    },
    ...patch,
  };
}

async function join(campaign: CampaignDefinition, wallet: string) {
  return campaignStore.joinCampaign(campaign, identity(wallet), new Date("2026-09-20T12:00:00.000Z"));
}

async function track(
  campaign: CampaignDefinition,
  wallet: string,
  actionId: string,
  points: number,
  eventId: string,
) {
  return campaignStore.recordAction(
    campaign,
    wallet,
    { actionId, points, metricDelta: 0, eventId },
    new Date("2026-09-20T12:00:00.000Z"),
  );
}

beforeEach(() => {
  redis.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("participant persistence", () => {
  it("persists join server-side and awards participation points", async () => {
    const campaign = makeCampaign("persist-1");
    const result = await join(campaign, W1);
    expect(result.alreadyJoined).toBe(false);
    expect(result.points).toBe(10);

    const record = await campaignStore.getParticipant(campaign.id, W1);
    expect(record).not.toBeNull();
    expect(record!.wallet).toBe(W1);
    expect(record!.campaignId).toBe(campaign.id);
    expect(record!.joinedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(record!.eligibility).toBe("eligible");
    expect(record!.rewardStatus).toBe("pending");
    expect(record!.rewardType).toBe("MPGR");
    expect(await campaignStore.getParticipantCount(campaign.id)).toBe(1);
  });

  it("join is idempotent — a replay never overwrites the original record", async () => {
    const campaign = makeCampaign("persist-2");
    await join(campaign, W1);
    // Second join attempts to change identity metadata.
    const replay = await campaignStore.joinCampaign(
      campaign,
      { ...identity(W1), displayName: "Replayed" },
      new Date("2026-09-21T00:00:00.000Z"),
    );
    expect(replay.alreadyJoined).toBe(true);
    const record = await campaignStore.getParticipant(campaign.id, W1);
    expect(record!.displayName).toBeNull(); // original wins
    expect(record!.joinedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(record!.points).toBe(10);
    expect(await campaignStore.getPoints(campaign.id, W1)).toBe(10); // no double participation
  });

  it("stores display identity + eligibility verdicts", async () => {
    const campaign = makeCampaign("persist-3");
    await campaignStore.joinCampaign(
      campaign,
      {
        wallet: W1,
        farcasterId: "12345",
        displayName: "Runner <script>!",
        eligibility: "ineligible",
        eligibilityReason: "Requires XP",
      },
      new Date("2026-09-20T12:00:00.000Z"),
    );
    const record = await campaignStore.getParticipant(campaign.id, W1);
    expect(record!.farcasterId).toBe("12345");
    expect(record!.displayName).toBe("Runner script"); // markup stripped by sanitizer
    expect(record!.eligibility).toBe("ineligible");
    expect(record!.eligibilityReason).toBe("Requires XP");
  });
});

describe("action recording, caps and anti-duplicate", () => {
  it("awards points, tracks counters, and updates lastActivityAt", async () => {
    const campaign = makeCampaign("track-1");
    await join(campaign, W1);
    const result = await track(campaign, W1, "check_in", 5, "evt-1");
    expect(result).toEqual({ status: "awarded", points: 5 });
    expect(await campaignStore.getPoints(campaign.id, W1)).toBe(15); // 10 join + 5
    const record = await campaignStore.getParticipant(campaign.id, W1);
    expect(record!.completedActions).toEqual({ check_in: 1 });
    expect(record!.lastActivityAt).toBe("2026-09-20T12:00:00.000Z");
  });

  it("the same event id is counted exactly once", async () => {
    const campaign = makeCampaign("track-2");
    await join(campaign, W1);
    expect((await track(campaign, W1, "check_in", 5, "evt-x")).status).toBe("awarded");
    expect((await track(campaign, W1, "check_in", 5, "evt-x")).status).toBe("duplicate");
    expect(await campaignStore.getPoints(campaign.id, W1)).toBe(15);
  });

  it("rejects non-participants and ineligible participants", async () => {
    const campaign = makeCampaign("track-3");
    expect((await track(campaign, W1, "check_in", 5, "evt-1")).status).toBe("not-participant");

    await campaignStore.joinCampaign(
      campaign,
      { ...identity(W1), eligibility: "ineligible", eligibilityReason: "no" },
      new Date("2026-09-20T12:00:00.000Z"),
    );
    expect((await track(campaign, W1, "check_in", 5, "evt-2")).status).toBe("ineligible");
  });

  it("enforces the per-action daily cap", async () => {
    const campaign = makeCampaign("track-4");
    await join(campaign, W1);
    expect((await track(campaign, W1, "check_in", 5, "a1")).status).toBe("awarded");
    expect((await track(campaign, W1, "check_in", 5, "a2")).status).toBe("awarded");
    expect((await track(campaign, W1, "check_in", 5, "a3")).status).toBe("awarded");
    expect((await track(campaign, W1, "check_in", 5, "a4")).status).toBe("action-daily-cap");
    // A capped attempt that fails must not consume its event id — a later
    // retry after the cap resets can still count it.
    expect((await track(campaign, W1, "check_in", 5, "a4")).status).toBe("action-daily-cap");
  });

  it("enforces the campaign daily points cap", async () => {
    const campaign = makeCampaign("track-5", {
      points: { participation: 0, dailyCap: 12, actions: [{ id: "chunk", label: "C", points: 10 }] },
    });
    await join(campaign, W1);
    expect((await track(campaign, W1, "chunk", 10, "c1")).status).toBe("awarded");
    expect((await track(campaign, W1, "chunk", 10, "c2")).status).toBe("daily-cap");
    expect(await campaignStore.getPoints(campaign.id, W1)).toBe(10);
  });

  it("enforces the total campaign points ceiling", async () => {
    const campaign = makeCampaign("track-6", {
      points: { participation: 0, maxPoints: 30, actions: [{ id: "chunk", label: "C", points: 25 }] },
    });
    await join(campaign, W1);
    expect((await track(campaign, W1, "chunk", 25, "t1")).status).toBe("awarded");
    expect((await track(campaign, W1, "chunk", 25, "t2")).status).toBe("total-cap");
    expect(await campaignStore.getPoints(campaign.id, W1)).toBe(25);
  });
});

describe("campaign leaderboard", () => {
  it("ranks participants by campaign points (desc)", async () => {
    const campaign = makeCampaign("lb-1", { points: { participation: 0, actions: [] } });
    await join(campaign, W1);
    await join(campaign, W2);
    await join(campaign, W3);
    await track(campaign, W1, "big", 100, "x1");
    await track(campaign, W2, "big", 500, "x2");
    await track(campaign, W3, "big", 300, "x3");

    const board = await campaignStore.getLeaderboard(campaign, 10);
    expect(board.map((e) => e.wallet)).toEqual([W2, W3, W1]);
    expect(board.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(board[0].points).toBe(500);

    expect(await campaignStore.getRank(campaign.id, W2)).toBe(1);
    expect(await campaignStore.getRank(campaign.id, W3)).toBe(2);
    expect(await campaignStore.getRank(campaign.id, W1)).toBe(3);
    expect(await campaignStore.getRank(campaign.id, "0x9999999999999999999999999999999999999999")).toBeNull();
  });

  it("keeps campaign points separate across campaigns", async () => {
    const a = makeCampaign("iso-a");
    const b = makeCampaign("iso-b");
    await join(a, W1);
    await join(b, W1);
    await track(a, W1, "big", 100, "e1");
    expect(await campaignStore.getPoints(a.id, W1)).toBe(110);
    expect(await campaignStore.getPoints(b.id, W1)).toBe(10);
  });
});

describe("finalization and historical records", () => {
  it("refuses to finalize an active campaign", async () => {
    const campaign = makeCampaign("fin-1");
    expect(await campaignStore.finalizeCampaign(campaign)).toBeNull();
  });

  it("freezes the final leaderboard once, immutably", async () => {
    const campaign = makeCampaign("fin-2");
    await join(campaign, W1);
    await join(campaign, W2);
    await track(campaign, W1, "big", 100, "x1");
    await track(campaign, W2, "big", 500, "x2");

    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z")); // past endAt
    const first = await campaignStore.finalizeCampaign(campaign);
    expect(first).not.toBeNull();
    expect(first!.entries.map((e) => e.wallet)).toEqual([W2, W1]);
    expect(first!.entries[0].rank).toBe(1);
    expect(first!.entries[0].points).toBe(510);

    // A second finalize (e.g. another reader) must not rewrite history,
    // even if the underlying ZSET somehow changes afterwards.
    await redis.client().eval(
      `redis.call("ZINCRBY", KEYS[1], 9999, ARGV[1])`,
      [`mpgrhub:campaign:score:${campaign.id}`],
      [W2],
    );
    const second = await campaignStore.finalizeCampaign(campaign);
    expect(second!.finalizedAt).toBe(first!.finalizedAt);
    expect(second!.entries.find((e) => e.wallet === W2)!.points).toBe(510);
    // Reads serve the frozen snapshot, not the mutated live ZSET.
    const board = await campaignStore.getLeaderboard(campaign, 10);
    expect(board.map((e) => e.points)).toEqual([510, 110]);
  });

  it("new campaigns never touch old campaign records", async () => {
    const oldCampaign = makeCampaign("history-old");
    await join(oldCampaign, W1);
    await track(oldCampaign, W1, "big", 100, "h1");
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    await campaignStore.finalizeCampaign(oldCampaign);

    const newCampaign = makeCampaign("history-new", { startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-10-31T00:00:00.000Z" });
    await join(newCampaign, W1);

    // Old records intact…
    expect(await campaignStore.getPoints(oldCampaign.id, W1)).toBe(110);
    expect((await campaignStore.getLeaderboard(oldCampaign, 10))[0].points).toBe(110);
    expect((await campaignStore.getFinalSnapshot(oldCampaign.id))!.entries).toHaveLength(1);
    // …and the new campaign starts clean (participation only).
    expect(await campaignStore.getPoints(newCampaign.id, W1)).toBe(10);
    expect(await campaignStore.getFinalSnapshot(newCampaign.id)).toBeNull();
  });
});

describe("admin reward bookkeeping", () => {
  it("records reward outcomes without touching scores", async () => {
    const campaign = makeCampaign("reward-1");
    await join(campaign, W1);
    await track(campaign, W1, "big", 100, "r1");

    const updated = await campaignStore.setRewardOutcome(campaign.id, W1, {
      rewardStatus: "distributed",
      rewardAmount: "500 MPGR",
      rewardTxHash: "0x" + "ab".repeat(32),
    });
    expect(updated!.rewardStatus).toBe("distributed");
    expect(updated!.rewardAmount).toBe("500 MPGR");
    expect(updated!.rewardTxHash).toBe("0x" + "ab".repeat(32));

    const record = await campaignStore.getParticipant(campaign.id, W1);
    expect(record!.rewardStatus).toBe("distributed");
    // Reward bookkeeping must not move scores: JSON cache keeps its
    // pre-outcome value and the ZSET stays authoritative at 110.
    expect(await campaignStore.getPoints(campaign.id, W1)).toBe(110);
    expect(record!.joinedAt).toBe("2026-09-20T12:00:00.000Z");

    // Unknown wallet → null (no records invented).
    expect(await campaignStore.setRewardOutcome(campaign.id, W2, { rewardStatus: "distributed" })).toBeNull();
  });
});

// Sanity: the example campaign configs run through the same paths.
describe("example campaigns load through the store", () => {
  it("mpgr-run example joins with its configured participation points", async () => {
    const campaign = findCampaignBySlug("mpgr-run-weekly")!;
    const result = await join(campaign, W1);
    expect(result.points).toBe(campaign.points.participation);
  });
});
