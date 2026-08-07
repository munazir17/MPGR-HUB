"use client";

import { Sparkles } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { Skeleton } from "./Skeleton";
import { formatTokenBalance } from "@/lib/format";

// Phase 3E Part 4 — Live Reward Counter.
//
// Renders useStaking()'s liveEarnedRewardsRaw, which re-evaluates the
// deployed contract's exact rewardPerToken()/earned() formulas
// (lib/staking/reward-math.ts) once per second against the last-fetched
// on-chain checkpoint. Purely a display component — no computation here.

interface LiveRewardCounterProps {
  liveEarnedRewardsRaw: bigint;
  decimals: number;
  loading?: boolean;
}

export function LiveRewardCounter({ liveEarnedRewardsRaw, decimals, loading }: LiveRewardCounterProps) {
  if (loading) {
    return (
      <GlassCard className="flex items-center gap-3 p-4">
        <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-5 w-40" />
        </div>
      </GlassCard>
    );
  }

  return (
    <GlassCard className="flex items-center gap-3 p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold/10">
        <Sparkles className="h-4 w-4 text-gold" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-muted">Earned rewards (live)</p>
        <p className="truncate text-lg font-semibold tabular-nums text-white">
          {formatTokenBalance(liveEarnedRewardsRaw, decimals)} <span className="text-sm text-muted">MPGR</span>
        </p>
      </div>
    </GlassCard>
  );
}
