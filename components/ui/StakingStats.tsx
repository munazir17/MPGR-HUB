"use client";

import { Wallet, Lock, Coins, Layers } from "lucide-react";
import { StatCard } from "./StatCard";
import { formatCompactNumber } from "@/lib/format";

interface StakingStatsProps {
  availableBalance: number;
  totalStaked: number;
  totalClaimableRewards: number;
  activePositionsCount: number;
  loading?: boolean;
}

export function StakingStats({
  availableBalance,
  totalStaked,
  totalClaimableRewards,
  activePositionsCount,
  loading,
}: StakingStatsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <StatCard
        label="Available Balance"
        value={`${formatCompactNumber(availableBalance)} MPGR`}
        icon={Wallet}
        loading={loading}
      />
      <StatCard
        label="Total Staked"
        value={`${formatCompactNumber(totalStaked)} MPGR`}
        icon={Lock}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Claimable Rewards"
        value={`${formatCompactNumber(totalClaimableRewards)} MPGR`}
        icon={Coins}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Active Positions"
        value={`${activePositionsCount}`}
        icon={Layers}
        loading={loading}
      />
    </div>
  );
}
