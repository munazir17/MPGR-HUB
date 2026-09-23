// lib/campaigns/campaigns/trading-example.ts
//
// Example campaign definition — trading competition with a non-MPGR
// reward, demonstrating that rewards are free-form (type/pool/symbol).

import type { CampaignDefinition } from "@/lib/campaigns/campaign-types";

const campaign: CampaignDefinition = {
  id: "trading-competition-001",
  slug: "trading-competition",
  title: "Trading Competition",
  description:
    "Put your Base trading to work. Log qualifying trading sessions during the event window and climb the campaign leaderboard for a tokenized-stock reward pool.",
  banner: "/campaigns/trading-competition.jpg",
  startAt: "2026-10-01T00:00:00.000Z",
  endAt: "2026-10-15T23:59:59.000Z",
  status: "auto",
  eventType: "trading",
  trackingMetric: "volume",
  rules: [
    "Join the campaign with your connected wallet.",
    "Log one qualifying trading session per entry with your reported session volume (USD).",
    "Reported volume is bounded and rate-limited server-side; campaign points are not global XP.",
    "Rewards are recorded by the operator after the campaign finalizes — nothing is transferred automatically.",
  ],
  rewardPool: "Tokenized Stock",
  rewardType: "Tokenized Stock",
  rewardAsset: "AAPLx basket",
  rewardDescription: "Tokenized stock reward pool shared across the top finishers.",
  rewardDistribution: "Top 5 — equal split",
  leaderboardEnabled: true,
  eligibility: {
    requiresAuthentication: true,
    description: "Any authenticated MPGR HUB wallet.",
  },
  points: {
    participation: 50,
    dailyCap: 2_000,
    maxPoints: 20_000,
    actions: [
      {
        id: "log_trade_session",
        label: "Log trading session",
        description: "Report one qualifying trading session and its volume.",
        points: 25,
        numericInput: { label: "Session volume (USD)", field: "volumeUsd", min: 0, max: 5_000_000 },
        bonus: { field: "volumeUsd", divisor: 1_000, maxBonus: 475 },
        maxPerDay: 6,
      },
    ],
  },
};

export default campaign;
