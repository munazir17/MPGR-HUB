// Token Lock and Burn Portal are the two "consumes claimed MPGR" modules,
// so they intentionally share the same available-balance shape and action-
// result pattern (see BurnActionResult vs. TokenLockActionResult) for a
// consistent developer + UI experience across MPGR HUB.

export type BurnStatus = "confirmed" | "pending" | "failed";

export interface BurnTransaction {
  id: string;
  address: string;
  amount: number;
  timestamp: string;
  status: BurnStatus;
}

export interface BurnState {
  address: string;
  transactions: BurnTransaction[];
  totalBurned: number;
}

export interface BurnActionResult {
  success: boolean;
  error?: string;
  amount?: number;
  state: BurnState;
}

// Mirrors what a real Base burn call will eventually need (to address,
// value, memo). Phase 2B swap point: this becomes the `writeContract`
// args object once the burn contract exists — no shape change needed.
export interface PreparedBurnTransaction {
  from: string;
  amount: number;
  to: "0x000000000000000000000000000000000000dEaD";
  memo: string;
}

export interface BurnImpactPreview {
  currentSupply: number;
  supplyAfterBurn: number;
  tokensRemoved: number;
  burnPercentageBefore: number;
  burnPercentageAfter: number;
  yourTotalBurnedAfter: number;
}

export interface BurnDashboardStats {
  totalBurned: number;
  burnedToday: number;
  burnedThisWeek: number;
  burnedThisMonth: number;
  remainingSupply: number;
  burnPercentage: number;
  totalTransactions: number;
  averageBurn: number;
  largestBurn: number;
  communityBurnGoal: number;
  communityBurnProgress: number; // 0-100, this wallet's contribution vs. the goal
}

export interface BurnMilestone {
  id: string;
  threshold: number;
  label: string;
  rewardPreviewLabel: string;
  achieved: boolean;
  progress: number; // 0-100
}

export type BurnAchievementId =
  | "first-burn"
  | "burn-100k"
  | "million-burner"
  | "diamond-burner"
  | "legend-burner"
  | "phoenix";

export interface BurnAchievement {
  id: BurnAchievementId;
  title: string;
  description: string;
  xpRewardPreview: number; // display-only preview; not yet wired to lib/xp-engine.ts
  progress: number;
  target: number;
  unlocked: boolean;
}

// Rank is always 1 today (no cross-wallet backend yet) — same honesty rule
// app/leaderboard/page.tsx already follows. Shape is ready for real ranking
// the moment a backend exists; nothing else about the UI needs to change.
export interface BurnLeaderboardEntry {
  rank: number;
  address: string;
  totalBurned: number;
  contributionPercent: number;
  isCurrentUser: boolean;
}
