"use client";

import { Trophy, Lock, Percent, Vault, Landmark } from "lucide-react";
import { StatCard } from "./StatCard";
import { formatTokenBalance } from "@/lib/format";

// Phase 3E Part 4 — Staking Analytics Cards.
//
// Total Rewards Claimed comes from useStakingHistory (a real historical
// sum of on-chain RewardPaid events, not an estimate). Active Stake,
// APR, and Reward Pool reuse the same useStaking() values StakingStats
// already reads — no duplicated RPC calls. Total Value Locked is
// expressed in MPGR (totalStakedRaw), not USD: this codebase has no
// price feed anywhere, and inventing one here would violate the same
// "never fabricate a number" convention every other read in
// lib/staking/ and lib/token/ already follows.

interface StakingAnalyticsCardsProps {
  totalRewardsClaimedRaw: bigint;
  stakedBalanceRaw: bigint;
  currentAPRPercent: number | null;
  rewardPoolBalanceRaw: bigint;
  totalStakedRaw: bigint;
  decimals: number;
  loading?: boolean;
  historyLoading?: boolean;
}

export function StakingAnalyticsCards({
  totalRewardsClaimedRaw,
  stakedBalanceRaw,
  currentAPRPercent,
  rewardPoolBalanceRaw,
  totalStakedRaw,
  decimals,
  loading,
  historyLoading,
}: StakingAnalyticsCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
      <StatCard
        label="Total Rewards Claimed"
        value={`${formatTokenBalance(totalRewardsClaimedRaw, decimals)} MPGR`}
        icon={Trophy}
        accent="gold"
        loading={loading || historyLoading}
      />
      <StatCard
        label="Active Stake"
        value={`${formatTokenBalance(stakedBalanceRaw, decimals)} MPGR`}
        icon={Lock}
        loading={loading}
      />
      <StatCard
        label="APR"
        value={currentAPRPercent === null ? "Not set" : `${currentAPRPercent}%`}
        icon={Percent}
        loading={loading}
      />
      <StatCard
        label="Reward Pool"
        value={`${formatTokenBalance(rewardPoolBalanceRaw, decimals)} MPGR`}
        icon={Vault}
        loading={loading}
      />
      <StatCard
        label="Total Value Locked"
        value={`${formatTokenBalance(totalStakedRaw, decimals)} MPGR`}
        icon={Landmark}
        accent="gold"
        loading={loading}
      />
    </div>
  );
}
