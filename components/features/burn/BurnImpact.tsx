"use client";

import { motion } from "framer-motion";
import { ArrowDown, Flame, Layers, Percent, Target } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { formatCompactNumber } from "@/lib/format";
import { calculateCommunityProgress } from "@/lib/burn-engine";
import type { BurnImpactPreview } from "@/lib/burn-types";

interface BurnImpactProps {
  impact: BurnImpactPreview;
  communityBurnGoal: number;
  communityBurnProgressBefore: number;
  hasAmount: boolean;
}

// Live "while typing" calculator (Feature 4). Purely presentational — all
// numbers are computed once in lib/burn-engine.ts (estimateSupplyImpact /
// calculateCommunityProgress) so this component never re-derives burn math.
export function BurnImpact({ impact, communityBurnGoal, communityBurnProgressBefore, hasAmount }: BurnImpactProps) {
  const communityProgressAfter = calculateCommunityProgress(impact.yourTotalBurnedAfter, communityBurnGoal);

  return (
    <GlassCard className="relative overflow-hidden p-5 sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-14 -bottom-14 h-48 w-48 rounded-full bg-gradient-gold opacity-10 blur-3xl"
      />
      <div className="relative flex items-center gap-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold/10">
          <Layers className="h-4 w-4 text-gold" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-semibold text-white">Burn Impact</p>
          <p className="text-[11px] text-muted">Live preview of this transaction&apos;s effect on supply</p>
        </div>
      </div>

      <div className="relative mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
        <div>
          <p className="text-muted">Current Supply</p>
          <p className="mt-0.5 font-semibold text-white">{formatCompactNumber(impact.currentSupply)} MPGR</p>
        </div>
        <div>
          <p className="text-muted">Supply After Burn</p>
          <motion.p
            key={impact.supplyAfterBurn}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-0.5 font-semibold text-white"
          >
            {formatCompactNumber(impact.supplyAfterBurn)} MPGR
          </motion.p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-muted">
            <Flame className="h-3 w-3 text-gold" aria-hidden="true" /> Tokens Removed
          </p>
          <p className="mt-0.5 font-semibold text-gold">
            -{formatCompactNumber(impact.tokensRemoved)} MPGR
          </p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-muted">
            <Percent className="h-3 w-3" aria-hidden="true" /> Burn %
          </p>
          <p className="mt-0.5 font-semibold text-white">
            {impact.burnPercentageBefore}%{" "}
            {hasAmount && (
              <span className="text-gold">
                <ArrowDown className="inline h-3 w-3 rotate-[-90deg]" aria-hidden="true" /> {impact.burnPercentageAfter}%
              </span>
            )}
          </p>
        </div>
        <div>
          <p className="text-muted">Your Total Burned</p>
          <p className="mt-0.5 font-semibold text-white">
            <AnimatedNumber value={impact.yourTotalBurnedAfter} decimals={0} suffix=" MPGR" />
          </p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-muted">
            <Target className="h-3 w-3" aria-hidden="true" /> Community Burn %
          </p>
          <p className="mt-0.5 font-semibold text-white">{communityProgressAfter}%</p>
        </div>
      </div>

      <div className="relative mt-4">
        <ProgressBar
          progress={hasAmount ? communityProgressAfter : communityBurnProgressBefore}
          label="Community goal progress"
        />
      </div>
    </GlassCard>
  );
}
