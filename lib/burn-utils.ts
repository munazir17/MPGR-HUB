import type { BurnAchievement, BurnMilestone, BurnTransaction } from "@/lib/burn-types";

// Fixed protocol parameter (mock, like LOCK_DURATION_OPTIONS in
// token-lock-engine.ts). Phase 2B swap point: read from the token
// contract's totalSupply() once the burn contract is live.
export const BURN_TOTAL_SUPPLY = 1_000_000_000;

export const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

// This wallet's share of a shared season goal — see the honesty note in
// the chat message above re: not fabricating cross-wallet totals.
export const COMMUNITY_BURN_GOAL = 250_000;

export const BURN_MILESTONE_DEFS: { id: string; threshold: number; label: string; rewardPreviewLabel: string }[] = [
  { id: "m-1m", threshold: 1_000_000, label: "1M Burned", rewardPreviewLabel: "Milestone Badge" },
  { id: "m-5m", threshold: 5_000_000, label: "5M Burned", rewardPreviewLabel: "+500 XP Preview" },
  { id: "m-10m", threshold: 10_000_000, label: "10M Burned", rewardPreviewLabel: "+1,000 XP Preview" },
  { id: "m-25m", threshold: 25_000_000, label: "25M Burned", rewardPreviewLabel: "Exclusive Frame" },
  { id: "m-50m", threshold: 50_000_000, label: "50M Burned", rewardPreviewLabel: "+2,500 XP Preview" },
  { id: "m-100m", threshold: 100_000_000, label: "100M Burned", rewardPreviewLabel: "Season Multiplier" },
  { id: "m-250m", threshold: 250_000_000, label: "250M Burned", rewardPreviewLabel: "+10,000 XP Preview" },
  { id: "m-500m", threshold: 500_000_000, label: "500M Burned", rewardPreviewLabel: "Legendary Frame" },
  { id: "m-1b", threshold: 1_000_000_000, label: "1B Burned", rewardPreviewLabel: "Genesis Burner Title" },
];

export const BURN_ACHIEVEMENT_DEFS: {
  id: BurnAchievement["id"];
  title: string;
  description: string;
  xpRewardPreview: number;
  target: number;
  check: (s: { totalBurned: number; count: number; largestBurn: number }) => number; // returns current progress
}[] = [
  {
    id: "first-burn",
    title: "First Burn",
    description: "Burn MPGR for the first time",
    xpRewardPreview: 25,
    target: 1,
    check: (s) => Math.min(s.count, 1),
  },
  {
    id: "burn-100k",
    title: "100K Burned",
    description: "Burn a cumulative 100,000 MPGR",
    xpRewardPreview: 100,
    target: 100_000,
    check: (s) => Math.min(s.totalBurned, 100_000),
  },
  {
    id: "million-burner",
    title: "Million Burner",
    description: "Burn a cumulative 1,000,000 MPGR",
    xpRewardPreview: 500,
    target: 1_000_000,
    check: (s) => Math.min(s.totalBurned, 1_000_000),
  },
  {
    id: "diamond-burner",
    title: "Diamond Burner",
    description: "Complete 10 separate burn transactions",
    xpRewardPreview: 150,
    target: 10,
    check: (s) => Math.min(s.count, 10),
  },
  {
    id: "legend-burner",
    title: "Legend Burner",
    description: "Burn a cumulative 10,000,000 MPGR",
    xpRewardPreview: 1000,
    target: 10_000_000,
    check: (s) => Math.min(s.totalBurned, 10_000_000),
  },
  {
    id: "phoenix",
    title: "Phoenix",
    description: "Burn 50,000 MPGR in a single transaction",
    xpRewardPreview: 300,
    target: 50_000,
    check: (s) => Math.min(s.largestBurn, 50_000),
  },
];

// Sum of `amount` for transactions within [now - daysAgoStart, now - daysAgoEnd).
// Deliberately its own small helper rather than importing rewards-engine's
// getClaimedInWindow: that function's parameter type is RewardClaimHistoryEntry
// (requires a `rewardId` field), which BurnTransaction structurally doesn't
// satisfy — reusing it would mean widening a completed module's public type
// just for this call site. This version is generic over any {amount, timestamp}.
export function sumInWindow<T extends { amount: number; timestamp: string }>(
  entries: T[],
  daysAgoStart: number,
  daysAgoEnd: number
): number {
  const now = Date.now();
  const start = now - daysAgoStart * 86_400_000;
  const end = now - daysAgoEnd * 86_400_000;
  return entries
    .filter((e) => {
      const t = new Date(e.timestamp).getTime();
      return t >= start && t < end;
    })
    .reduce((sum, e) => sum + e.amount, 0);
}

export function buildMilestones(communityProgressAmount: number): BurnMilestone[] {
  return BURN_MILESTONE_DEFS.map((def) => ({
    id: def.id,
    threshold: def.threshold,
    label: def.label,
    rewardPreviewLabel: def.rewardPreviewLabel,
    achieved: communityProgressAmount >= def.threshold,
    progress: Math.min(100, Math.round((communityProgressAmount / def.threshold) * 100)),
  }));
}

export function buildAchievements(transactions: BurnTransaction[], totalBurned: number): BurnAchievement[] {
  const confirmed = transactions.filter((t) => t.status === "confirmed");
  const largestBurn = confirmed.reduce((max, t) => Math.max(max, t.amount), 0);
  const stats = { totalBurned, count: confirmed.length, largestBurn };

  return BURN_ACHIEVEMENT_DEFS.map((def) => {
    const progress = def.check(stats);
    return {
      id: def.id,
      title: def.title,
      description: def.description,
      xpRewardPreview: def.xpRewardPreview,
      progress,
      target: def.target,
      unlocked: progress >= def.target,
    };
  });
}
