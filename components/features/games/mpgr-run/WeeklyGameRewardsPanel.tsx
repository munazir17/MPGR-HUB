"use client";

// components/features/games/mpgr-run/WeeklyGameRewardsPanel.tsx
//
// Game Rewards Module — "Play more this week to improve your standing"
// panel (section 26). Every number shown comes straight from
// useWeeklyGameStats (server-verified) — no guaranteed MPGR, no fake
// rank, no fake earnings. Once a week is settled and this wallet's
// allocation status is "allocated", the real amount already lives as a
// claimable RewardType.GAME entry in the existing Reward Hub
// (<OnChainRewardsSection />) — this panel links there rather than
// duplicating the claim path.

import { GlassCard } from "@/components/ui/GlassCard";
import { useWeeklyGameStats } from "@/hooks/useWeeklyGameStats";
import { formatUnits } from "viem";

const ELIGIBILITY_COPY: Record<string, string> = {
  eligible: "Eligible for this week's Game pool",
  pending: "Not yet eligible — keep playing this week",
  ineligible: "Not eligible this week",
};

export function WeeklyGameRewardsPanel({ address }: { address: string }) {
  const { stats, isLoading } = useWeeklyGameStats(address);

  if (isLoading && !stats) {
    return (
      <GlassCard className="mt-4 p-4">
        <div className="h-16 animate-pulse rounded-lg bg-white/5" />
      </GlassCard>
    );
  }

  if (!stats) return null;

  return (
    <GlassCard className="mt-4 p-4">
      <div className="mb-2 text-sm font-semibold text-white/90">Weekly Game Rewards</div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-white/50">Runs this week</div>
          <div className="font-medium text-white">{stats.validRunCount}</div>
        </div>
        <div>
          <div className="text-white/50">Best score</div>
          <div className="font-medium text-white">{stats.bestScore.toLocaleString()}</div>
        </div>
      </div>
      <div className="mt-3 text-xs text-white/60">{ELIGIBILITY_COPY[stats.eligibilityStatus]}</div>
      {stats.allocationStatus === "allocated" && stats.allocatedAmountRaw && (
        <div className="mt-3 rounded-lg bg-emerald-500/10 p-2 text-xs text-emerald-300">
          Last settled week: {formatUnits(BigInt(stats.allocatedAmountRaw), 18)} MPGR allocated — claim it from the
          Rewards page.
        </div>
      )}
      <div className="mt-3 text-xs text-white/40">
        Play more this week to improve your standing — extra runs still count toward your weekly performance even
        after today&apos;s XP cap.
      </div>
    </GlassCard>
  );
}
