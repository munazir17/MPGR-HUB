"use client";

import { Wallet, CheckCircle2, Gift, LayoutGrid } from "lucide-react";
import { StatCard } from "./StatCard";
import { formatTokenBalance } from "@/lib/format";
import type { RewardHubSummary } from "@/lib/rewards/reward-types";

// Phase 3F Part 1 — Reward Hub Summary Cards.
//
// Covers "Reward Summary" / "Reward Analytics" / "Reward Statistics" /
// "Live Reward Totals" from the Phase 3F Part 1 feature list in one grid,
// the same way components/ui/StakingAnalyticsCards.tsx does for staking.
// Every value comes straight from RewardHubSummary — nothing computed
// here beyond a MPGR_TOKEN_DECIMALS-aware display format and an active-
// category count. "Live" comes from hooks/useRewardHub.ts's polling and
// event-driven refresh (staking_changed / rewards_claimed) — this
// component itself just renders whatever summary it's given.

const MPGR_DECIMALS = 18;

interface RewardHubSummaryCardsProps {
  summary: RewardHubSummary | null;
  loading?: boolean;
}

export function RewardHubSummaryCards({ summary, loading }: RewardHubSummaryCardsProps) {
  const activeCategoryCount = summary ? summary.categories.filter((c) => c.isActive).length : 0;
  const totalCategoryCount = summary ? summary.categories.length : 0;

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <StatCard
        label="Total Earned"
        value={`${formatTokenBalance(summary?.totalEarnedRaw, MPGR_DECIMALS)} MPGR`}
        icon={Wallet}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Total Claimed"
        value={`${formatTokenBalance(summary?.totalClaimedRaw, MPGR_DECIMALS)} MPGR`}
        icon={CheckCircle2}
        loading={loading}
      />
      <StatCard
        label="Claimable Now"
        value={`${formatTokenBalance(summary?.totalClaimableRaw, MPGR_DECIMALS)} MPGR`}
        icon={Gift}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Active Categories"
        value={summary ? `${activeCategoryCount} / ${totalCategoryCount}` : "0 / 0"}
        icon={LayoutGrid}
        loading={loading}
      />
    </div>
  );
}
