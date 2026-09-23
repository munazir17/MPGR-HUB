// lib/campaigns/adapters.test.ts
//
// The campaign tracking adapter pipeline: window gating, unknown-action
// rejection, generic (future event type) fallback, server-evidence
// validation for game campaigns, and server-side point math.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunRecord } from "@/lib/reward-allocation/allocation-types";

const { getRunRecord } = vi.hoisted(() => ({
  getRunRecord: vi.fn(async (_sessionId: string): Promise<RunRecord | null> => null),
}));
vi.mock("@/lib/reward-allocation/kv-allocation-store", () => ({
  kvAllocationStore: { getRunRecord },
}));

import { resolveCampaignAction, getAdapterForEventType } from "./adapters/registry";
import { findCampaignBySlug } from "./campaign-registry";
import type { CampaignDefinition } from "./campaign-types";

const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";

function makeCampaign(patch: Partial<CampaignDefinition> = {}): CampaignDefinition {
  return {
    id: "adapter-test",
    slug: "adapter-test",
    title: "Adapter test",
    description: "Adapter test campaign.",
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
      participation: 0,
      actions: [
        {
          id: "log_session",
          label: "Log session",
          points: 25,
          numericInput: { label: "Volume", field: "volumeUsd", min: 0, max: 1_000_000 },
          bonus: { field: "volumeUsd", divisor: 1_000, maxBonus: 100 },
        },
        { id: "plain", label: "Plain", points: 10 },
      ],
    },
    ...patch,
  };
}

function runRecord(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    sessionId: "session-abc-123",
    wallet: W1 as RunRecord["wallet"],
    weekKey: "2026-W38",
    submittedAt: "2026-09-20T10:00:00.000Z",
    serverValidated: true,
    result: { score: 4_200 } as RunRecord["result"],
    ...patch,
  };
}

beforeEach(() => {
  getRunRecord.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shared validation pipeline", () => {
  const campaign = makeCampaign();
  const now = new Date("2026-09-20T12:00:00.000Z");

  it("rejects an inactive campaign window", async () => {
    const upcoming = makeCampaign({ startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-10-15T00:00:00.000Z" });
    const result = await resolveCampaignAction(upcoming, "plain", W1, undefined, now);
    expect(result).toMatchObject({ ok: false, code: "campaign-not-active" });

    const ended = makeCampaign({ startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-08-15T00:00:00.000Z" });
    expect(await resolveCampaignAction(ended, "plain", W1, undefined, now)).toMatchObject({
      ok: false,
      code: "campaign-not-active",
    });
  });

  it("rejects unknown actions", async () => {
    const result = await resolveCampaignAction(campaign, "not-real", W1, undefined, now);
    expect(result).toMatchObject({ ok: false, code: "unknown-action" });
  });

  it("computes points entirely server-side (base + bounded bonus)", async () => {
    const ok = await resolveCampaignAction(campaign, "log_session", W1, { volumeUsd: 50_000 }, now);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      // 25 base + min(floor(50000/1000), 100) = 25 + 50
      expect(ok.points).toBe(75);
      expect(ok.metricDelta).toBe(0);
    }
  });

  it("caps the bonus at maxBonus regardless of the submitted value", async () => {
    const ok = await resolveCampaignAction(campaign, "log_session", W1, { volumeUsd: 999_000 }, now);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.points).toBe(125); // 25 + 100 cap
  });

  it("rejects out-of-range, non-integer, and missing numeric input", async () => {
    for (const payload of [
      { volumeUsd: -1 },
      { volumeUsd: 1_000_001 },
      { volumeUsd: 12.5 },
      { volumeUsd: "5000" },
      {},
    ]) {
      const result = await resolveCampaignAction(campaign, "log_session", W1, payload, now);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("adapter-rejected");
    }
  });

  it("falls back to the generic adapter for unknown future event types", async () => {
    const future = makeCampaign({ eventType: "metaverse-racing", id: "future-1" });
    expect(getAdapterForEventType("metaverse-racing")).toBeNull();
    const ok = await resolveCampaignAction(future, "plain", W1, undefined, now);
    expect(ok).toMatchObject({ ok: true, points: 10, evidenceId: null });
    const bad = await resolveCampaignAction(future, "log_session", W1, { volumeUsd: 5 }, now);
    expect(bad.ok).toBe(true); // generic adapter still applies shared checks
    if (bad.ok) expect(bad.points).toBe(25);
  });

  it("never lets an evidence action fall back to trusting the client", async () => {
    // eventType without a registered adapter + evidence-backed action.
    const orphan = makeCampaign({
      eventType: "esports",
      points: {
        participation: 0,
        actions: [{ id: "verified_match", label: "Match", points: 50, evidence: "game-run" }],
      },
    });
    const result = await resolveCampaignAction(orphan, "verified_match", W1, { sessionId: "abc" }, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("adapter-rejected");
  });
});

describe("game adapter (server RunRecord evidence)", () => {
  const campaign = findCampaignBySlug("mpgr-run-weekly")!;
  const now = new Date("2026-09-20T12:00:00.000Z");

  it("derives score and idempotency id from the server record", async () => {
    getRunRecord.mockResolvedValueOnce(runRecord());
    const result = await resolveCampaignAction(campaign, "verified_run", W1, { sessionId: "session-abc-123" }, now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 50 base + min(floor(4200/100), 450) = 50 + 42
      expect(result.points).toBe(92);
      expect(result.metricDelta).toBe(4_200);
      expect(result.evidenceId).toBe("run:session-abc-123");
    }
    expect(getRunRecord).toHaveBeenCalledWith("session-abc-123");
  });

  it("rejects malformed session ids without hitting the store", async () => {
    const result = await resolveCampaignAction(campaign, "verified_run", W1, { sessionId: "short" }, now);
    expect(result.ok).toBe(false);
    expect(getRunRecord).not.toHaveBeenCalled();
  });

  it("rejects unknown, foreign-wallet, unvalidated, and out-of-window runs", async () => {
    getRunRecord.mockResolvedValueOnce(null);
    expect((await resolveCampaignAction(campaign, "verified_run", W1, { sessionId: "session-abc-123" }, now)).ok).toBe(false);

    getRunRecord.mockResolvedValueOnce(runRecord({ wallet: W2 as RunRecord["wallet"] }));
    expect((await resolveCampaignAction(campaign, "verified_run", W1, { sessionId: "session-abc-123" }, now)).ok).toBe(false);

    getRunRecord.mockResolvedValueOnce(runRecord({ serverValidated: false }));
    expect((await resolveCampaignAction(campaign, "verified_run", W1, { sessionId: "session-abc-123" }, now)).ok).toBe(false);

    getRunRecord.mockResolvedValueOnce(runRecord({ submittedAt: "2026-08-01T10:00:00.000Z" }));
    const outOfWindow = await resolveCampaignAction(campaign, "verified_run", W1, { sessionId: "session-abc-123" }, now);
    expect(outOfWindow.ok).toBe(false);
    if (!outOfWindow.ok) expect(outOfWindow.reason).toMatch(/outside the campaign window/);
  });

  it("fails closed when the evidence store throws", async () => {
    getRunRecord.mockRejectedValueOnce(new Error("redis down"));
    const result = await resolveCampaignAction(campaign, "verified_run", W1, { sessionId: "session-abc-123" }, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("adapter-rejected");
  });
});
