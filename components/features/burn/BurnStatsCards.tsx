"use client";

import { Flame, CalendarDays, CalendarRange, Calendar, TrendingDown, Percent, Repeat, BarChart3, Trophy, Target } from "lucide-react";
import { StatCard } from "@/components/ui/StatCard";
import { formatCompactNumber } from "@/lib/format";
import type { BurnDashboardStats } from "@/lib/burn-types";

interface BurnStatsCardsProps {
  stats: BurnDashboardStats;
  loading?: boolean;
}

export function BurnStatsCards({ stats, loading }: BurnStatsCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-3 lg:grid-cols-5">
      <StatCard
        label="Total Burned"
        value={`${formatCompactNumber(stats.totalBurned)} MPGR`}
        icon={Flame}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Burned Today"
        value={`${formatCompactNumber(stats.burnedToday)} MPGR`}
        icon={CalendarDays}
        loading={loading}
      />
      <StatCard
        label="Burned This Week"
        value={`${formatCompactNumber(stats.burnedThisWeek)} MPGR`}
        icon={CalendarRange}
        loading={loading}
      />
      <StatCard
        label="Burned This Month"
        value={`${formatCompactNumber(stats.burnedThisMonth)} MPGR`}
        icon={Calendar}
        loading={loading}
      />
      <StatCard
        label="Remaining Supply"
        value={`${formatCompactNumber(stats.remainingSupply)} MPGR`}
        icon={TrendingDown}
        loading={loading}
      />
      <StatCard
        label="Burn Percentage"
        value={`${stats.burnPercentage}%`}
        icon={Percent}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Total Transactions"
        value={`${stats.totalTransactions}`}
        icon={Repeat}
        loading={loading}
      />
      <StatCard
        label="Average Burn"
        value={`${formatCompactNumber(stats.averageBurn)} MPGR`}
        icon={BarChart3}
        loading={loading}
      />
      <StatCard
        label="Largest Burn"
        value={`${formatCompactNumber(stats.largestBurn)} MPGR`}
        icon={Trophy}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Community Burn Goal"
        value={`${stats.communityBurnProgress}% of ${formatCompactNumber(stats.communityBurnGoal)}`}
        icon={Target}
        loading={loading}
      />
    </div>
  );
}
