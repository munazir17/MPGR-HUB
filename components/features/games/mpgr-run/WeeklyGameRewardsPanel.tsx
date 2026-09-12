"use client";

import { GlassCard } from "@/components/ui/GlassCard";
import { useWeeklyGameStats } from "@/hooks/useWeeklyGameStats";
import { formatUnits } from "viem";

const ELIGIBILITY_COPY: Record<string, string> = {
  eligible: "Eligible for this week's Game pool",
  pending: "Keep playing this week",
  ineligible: "Not eligible this week",
};

export function WeeklyGameRewardsPanel({ address }: { address: string }) {
  const { stats, isLoading } = useWeeklyGameStats(address);

  if (isLoading && !stats) {
    return (
      <GlassCard className="mt-0 shrink-0 p-2">
        <div className="h-8 animate-pulse rounded-lg bg-white/5" />
      </GlassCard>
    );
  }

  if (!stats) return null;

  return (
    <GlassCard className="mt-0 shrink-0 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold text-white/90">Weekly Game Rewards</div>
        <div className="text-[10px] text-white/50">
          {ELIGIBILITY_COPY[stats.eligibilityStatus]}
        </div>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-white/45">Runs this week</div>
          <div className="font-medium text-white">{stats.validRunCount}</div>
        </div>
        <div>
          <div className="text-white/45">Best score</div>
          <div className="font-medium text-white">{stats.bestScore.toLocaleString()}</div>
        </div>
      </div>
      {stats.allocationStatus === "allocated" && stats.allocatedAmountRaw && (
        <div className="mt-1 text-[10px] text-emerald-300">
          Last week: {formatUnits(BigInt(stats.allocatedAmountRaw), 18)} MPGR — claim on Rewards.
        </div>
      )}
    </GlassCard>
  );
}
