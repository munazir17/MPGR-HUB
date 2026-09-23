// lib/campaigns/campaigns/mpgr-run-example.ts
//
// Example campaign definition — weekly MPGR Run competition.
// To launch a real campaign: copy this file, change the fields (new id!),
// and register the export in ./index.ts. No UI or engine changes needed.

import type { CampaignDefinition } from "@/lib/campaigns/campaign-types";

const campaign: CampaignDefinition = {
  id: "mpgr-run-weekly-001",
  slug: "mpgr-run-weekly",
  title: "MPGR Run Weekly Challenge",
  description:
    "Compete for the weekly MPGR reward pool. Submit verified MPGR Run sessions — every valid run earns campaign points on top of a participation bonus.",
  banner: "/campaigns/mpgr-run-weekly.jpg",
  startAt: "2026-09-16T00:00:00.000Z",
  endAt: "2026-09-30T23:59:59.000Z",
  status: "auto",
  eventType: "game",
  trackingMetric: "score",
  rules: [
    "Join the campaign with your connected wallet.",
    "Points come from server-verified MPGR Run sessions only — client scores are never trusted.",
    "Each verified run earns a base bonus plus a score-based bonus (capped per run).",
    "Maximum 10 verified runs counted per day.",
    "Campaign points are separate from global XP and Season Points.",
  ],
  rewardPool: "1000000",
  rewardType: "MPGR",
  rewardSymbol: "MPGR",
  rewardDescription: "1,000,000 MPGR split across the top finishers.",
  rewardDistribution: "Top 10 — 40/20/12/10/6/4/2.5/2/2/1.5%",
  leaderboardEnabled: true,
  eligibility: {
    requiresAuthentication: true,
    description: "Any authenticated MPGR HUB wallet with a verified run.",
  },
  points: {
    participation: 100,
    dailyCap: 5_000,
    maxPoints: 60_000,
    actions: [
      {
        id: "verified_run",
        label: "Verified run",
        description: "Recorded automatically from each server-verified MPGR Run session.",
        points: 50,
        evidence: "game-run",
        bonus: { field: "score", divisor: 100, maxBonus: 450 },
        maxPerDay: 10,
      },
    ],
  },
  featured: true,
};

export default campaign;
