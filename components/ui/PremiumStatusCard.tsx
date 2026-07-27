"use client";

import { Crown, TrendingUp, AlertTriangle } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { PremiumBadge } from "@/components/ui/PremiumBadge";
import { formatCompactNumber } from "@/lib/format";
import type { PremiumStatus } from "@/lib/premium-engine";

export function PremiumStatusCard({ status }: { status: PremiumStatus }) {
  const {
    tier,
    isPremium,
    activeLocked,
    currentTierDef,
    nextTierDef,
    progressToNextTier,
    amountToNextTier,
    nextUnlockAt,
    xpMultiplier,
    rewardsMultiplier,
  } = status;

  return (
    <GlassCard className="relative overflow-hidden p-5">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gradient-premium opacity-20 blur-3xl"
      />

      <div className="relative flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Crown className="h-4 w-4 text-gold" aria-hidden="true" />
          <p className="text-xs text-muted">Premium Status</p>
        </div>
        <PremiumBadge tier={tier} />
      </div>

      <p className="relative mt-2 text-2xl font-bold text-white">
        {isPremium ? `${currentTierDef?.label} Member` : "Not Premium"}
      </p>
      <p className="relative mt-1 text-xs text-muted">
        {formatCompactNumber(activeLocked)} MPGR actively locked
      </p>

      {isPremium && (
        <div className="relative mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-[10px] text-muted">XP Multiplier</p>
            <p className="mt-1 text-sm font-semibold text-gold">{xpMultiplier}×</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-[10px] text-muted">Rewards Multiplier</p>
            <p className="mt-1 text-sm font-semibold text-gold">{rewardsMultiplier}×</p>
          </div>
        </div>
      )}

      {nextTierDef && (
        <div className="relative mt-4">
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
            <span className="flex items-center gap-1">
              <TrendingUp className="h-3 w-3" aria-hidden="true" />
              Progress to {nextTierDef.label}
            </span>
            <span>{formatCompactNumber(amountToNextTier)} MPGR to go</span>
          </div>
          <ProgressBar progress={progressToNextTier} />
        </div>
      )}

      {isPremium && nextUnlockAt && (
        <div className="relative mt-4 flex items-start gap-2 rounded-xl border border-gold/20 bg-gold/[0.05] p-3">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold" aria-hidden="true" />
          <p className="text-[11px] leading-relaxed text-muted">
            Your earliest lock unlocks on {new Date(nextUnlockAt).toLocaleDateString()}. Releasing it may drop
            your active locked total below the {currentTierDef?.label} threshold and end Premium.
          </p>
        </div>
      )}
    </GlassCard>
  );
}
