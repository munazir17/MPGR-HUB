"use client";

import { Wallet, Lock, Coins, Percent, Vault } from "lucide-react";
import { StatCard } from "./StatCard";
import { formatTokenBalance } from "@/lib/format";

// Phase 3E Part 3 — redesigned for the live, single-balance, no-lock
// MPGRStaking contract. Five values, each read directly from the deployed
// contract (via useStaking -> stakingService -> stakingClient): Available
// Balance, Your Staked, Earned Rewards, Current APR, Reward Pool. No
// per-position or lock-duration stats — the contract has none.

interface StakingStatsProps {
  walletBalanceRaw: bigint;
  stakedBalanceRaw: bigint;
  earnedRewardsRaw: bigint;
  rewardPoolBalanceRaw: bigint;
  currentAPRPercent: number | null;
  decimals: number;
  loading?: boolean;
}

export function StakingStats({
  walletBalanceRaw,
  stakedBalanceRaw,
  earnedRewardsRaw,
  rewardPoolBalanceRaw,
  currentAPRPercent,
  decimals,
  loading,
}: StakingStatsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
      <StatCard
        label="Available Balance"
        value={`${formatTokenBalance(walletBalanceRaw, decimals)} MPGR`}
        icon={Wallet}
        loading={loading}
      />
      <StatCard
        label="Your Staked"
        value={`${formatTokenBalance(stakedBalanceRaw, decimals)} MPGR`}
        icon={Lock}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Earned Rewards"
        value={`${formatTokenBalance(earnedRewardsRaw, decimals)} MPGR`}
        icon={Coins}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Current APR"
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
    </div>
  );
}
