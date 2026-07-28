"use client";

import { TrendingUp, Gauge } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { HolderTierBadge } from "./HolderTierBadge";
import { formatCompactNumber } from "@/lib/format";
import type { HolderTierStatus } from "@/lib/holder-tier-engine";

interface HolderTierCardProps {
  status: HolderTierStatus;
}

export function HolderTierCard({ status }: HolderTierCardProps) {
  const { tier, score, currentTierDef, nextTierDef, progressToNextTier, amountToNextTier, cosmetics } = status;

  const accentClass = cosmetics?.dashboardAccentClass ?? "bg-gradient-blue";

  return (
    <GlassCard className="relative overflow-hidden p-5 sm:p-6">
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full ${accentClass} opacity-20 blur-3xl`}
      />

      <div className="relative flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-primary" aria-hidden="true" />
          <p className="text-xs text-muted">Holder Tier</p>
        </div>
        <HolderTierBadge tier={tier} />
      </div>

      <p className="relative mt-2 text-2xl font-bold text-white">
        {currentTierDef ? `${currentTierDef.label} Holder` : "No Tier Yet"}
      </p>
      <p className="relative mt-1 flex items-baseline gap-1 text-xs text-muted">
        <AnimatedNumber value={score.totalScore} className="font-semibold text-white" />
        <span>Holder Score</span>
      </p>

      {nextTierDef ? (
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
      ) : (
        <div className="relative mt-4 rounded-xl border border-primary/20 bg-primary/[0.06] p-3">
          <p className="text-[11px] leading-relaxed text-muted">
            You&apos;ve reached the highest Holder Tier — Diamond. Thanks for being a top holder.
          </p>
        </div>
      )}
    </GlassCard>
  );
}
