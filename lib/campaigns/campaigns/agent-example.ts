// lib/campaigns/campaigns/agent-example.ts
//
// Example campaign definition — AI agent activity competition.
// The window is set in the future so the campaign currently resolves to
// upcoming; the operator activates campaigns later by editing startAt/endAt.

import type { CampaignDefinition } from "@/lib/campaigns/campaign-types";

const campaign: CampaignDefinition = {
  id: "agent-competition-001",
  slug: "agent-competition",
  title: "MPGR Agent Competition",
  description:
    "A community competition rewarding the wallets that put the MPGR AI Agent to work. Join with your connected wallet, complete agent tasks during the event window, and climb the campaign leaderboard.",
  banner: "/campaigns/agent-competition.jpg",
  startAt: "2026-11-01T00:00:00.000Z",
  endAt: "2026-11-15T23:59:59.000Z",
  status: "auto",
  eventType: "agent",
  trackingMetric: "activity",
  rules: [
    "Join the campaign with your connected wallet.",
    "Each completed agent task during the window earns campaign points.",
    "The leaderboard is frozen when the campaign window ends.",
    "Winners are recorded at finalization and paid manually by the operator — rewards are never auto-transferred.",
  ],
  rewardPool: "50000",
  rewardType: "MPGR",
  rewardSymbol: "MPGR",
  rewardDescription: "50,000 MPGR across the top 3 finishers (distributed manually).",
  rewardDistribution: "Top 3 — 50/30/20%",
  leaderboardEnabled: true,
  eligibility: {
    requiresAuthentication: true,
    description: "Any authenticated MPGR HUB wallet active during the event window.",
  },
  points: {
    participation: 25,
    maxPoints: 5_000,
    actions: [
      {
        id: "agent_task_completed",
        label: "Complete an agent task",
        description: "One campaign point event per completed MPGR Agent task.",
        points: 40,
        maxPerDay: 8,
      },
    ],
  },
};

export default campaign;
