// lib/campaigns/campaign-registry.test.ts
//
// Config-driven campaign engine: registration, validation, lookup, and
// the start/end status lifecycle. Uses fake timers pinned to specific
// instants so active/upcoming/completed transitions are deterministic.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findCampaignByIdOrSlug,
  findCampaignBySlug,
  getAllCampaigns,
  getCampaignsByStatus,
  isCampaignActive,
  resolveCampaignStatus,
  toPublicCampaign,
  validateCampaignDefinitions,
} from "./campaign-registry";
import type { CampaignDefinition } from "./campaign-types";

function override(campaign: CampaignDefinition, patch: Partial<CampaignDefinition>): CampaignDefinition {
  return { ...campaign, ...patch };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Inside the mpgr-run example window (2026-09-16 → 2026-09-30).
  vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("campaign registration", () => {
  it("exposes at least the three example campaigns", () => {
    const all = getAllCampaigns();
    expect(all.length).toBeGreaterThanOrEqual(3);
    const slugs = all.map((c) => c.slug);
    expect(slugs).toContain("mpgr-run-weekly");
    expect(slugs).toContain("trading-competition");
    expect(slugs).toContain("agent-competition");
  });

  it("returns a copy — callers cannot mutate the registry", () => {
    const first = getAllCampaigns();
    first.pop();
    expect(getAllCampaigns().length).toBe(first.length + 1);
  });

  it("every registered campaign passes validation", () => {
    expect(validateCampaignDefinitions()).toEqual([]);
  });

  it("validation catches duplicate ids, bad windows, and bad actions", () => {
    const base = getAllCampaigns()[0];
    const problems = validateCampaignDefinitions([
      base,
      override(base, { slug: "other-slug" }), // duplicate id
      override(base, {
        id: "x-1",
        slug: "x-1",
        startAt: "2026-01-10T00:00:00.000Z",
        endAt: "2026-01-01T00:00:00.000Z", // end before start
        points: { ...base.points, actions: [{ id: "a", label: "A", points: -5 }] },
      }),
    ]);
    expect(problems.some((p) => p.includes("duplicate id"))).toBe(true);
    expect(problems.some((p) => p.includes("endAt must be after startAt"))).toBe(true);
    expect(problems.some((p) => p.includes("points must be >= 0"))).toBe(true);
  });
});

describe("campaign lifecycle status (start/end)", () => {
  const mpgrRun = findCampaignBySlug("mpgr-run-weekly")!;

  it("is upcoming before startAt", () => {
    vi.setSystemTime(new Date("2026-09-15T23:59:59.000Z"));
    expect(resolveCampaignStatus(mpgrRun)).toBe("upcoming");
    expect(isCampaignActive(mpgrRun)).toBe(false);
  });

  it("is active exactly inside the window", () => {
    vi.setSystemTime(new Date("2026-09-16T00:00:00.000Z"));
    expect(resolveCampaignStatus(mpgrRun)).toBe("active");
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    expect(resolveCampaignStatus(mpgrRun)).toBe("active");
  });

  it("is completed at/after endAt", () => {
    vi.setSystemTime(new Date("2026-09-30T23:59:59.000Z"));
    // endAt is inclusive to the last second (status flips when now >= end).
    const atEnd = resolveCampaignStatus(mpgrRun);
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    expect(resolveCampaignStatus(mpgrRun)).toBe("completed");
    expect(["active", "completed"]).toContain(atEnd);
    expect(isCampaignActive(mpgrRun)).toBe(false);
  });

  it("honours a pinned status over the dates", () => {
    const paused = override(mpgrRun, { status: "paused" });
    expect(resolveCampaignStatus(paused)).toBe("paused");
    expect(isCampaignActive(paused)).toBe(false);
  });

  it("throws on unparseable dates instead of mis-rendering", () => {
    const broken = override(mpgrRun, { startAt: "not-a-date" });
    expect(() => resolveCampaignStatus(broken)).toThrow(/invalid startAt\/endAt/);
  });
});

describe("multiple campaigns coexist", () => {
  it("serves active, upcoming and completed campaigns at the same instant", () => {
    expect(getCampaignsByStatus("active").map((c) => c.slug)).toContain("mpgr-run-weekly");
    expect(getCampaignsByStatus("upcoming").map((c) => c.slug)).toContain("trading-competition");
    expect(getCampaignsByStatus("completed").map((c) => c.slug)).toContain("agent-competition");
    expect(getCampaignsByStatus("all")).toEqual(getAllCampaigns());
  });

  it("finds campaigns by id or slug", () => {
    expect(findCampaignByIdOrSlug("mpgr-run-weekly-001")?.slug).toBe("mpgr-run-weekly");
    expect(findCampaignByIdOrSlug("trading-competition")?.id).toBe("trading-competition-001");
    expect(findCampaignByIdOrSlug("nope")).toBeNull();
  });
});

describe("public serialization", () => {
  it("normalizes every field the UI consumes", () => {
    const campaign = findCampaignBySlug("mpgr-run-weekly")!;
    const view = toPublicCampaign(campaign, { participantCount: 7, viewer: null });
    expect(view.status).toBe("active");
    expect(view.participantCount).toBe(7);
    expect(view.rewardPool).toBe("1000000");
    expect(view.rewardType).toBe("MPGR");
    expect(view.leaderboardEnabled).toBe(true);
    expect(view.points.actions.length).toBeGreaterThan(0);
    expect(view.points.actions[0]).toMatchObject({
      id: "verified_run",
      evidence: "game-run",
      maxPerDay: 10,
    });
    expect(view.rules.length).toBeGreaterThan(0);
    expect(view.banner).toBe("/campaigns/mpgr-run-weekly.jpg");
  });
});
