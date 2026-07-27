"use client";

import { motion } from "framer-motion";
import { Flame, Lock, Sparkles } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { formatCompactNumber } from "@/lib/format";
import type { BurnMilestone } from "@/lib/burn-types";

interface BurnMilestonesProps {
  milestones: BurnMilestone[];
}

export function BurnMilestones({ milestones }: BurnMilestonesProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {milestones.map((milestone, i) => (
        <motion.div
          key={milestone.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i, 8) * 0.04 }}
          whileHover={{ y: -3 }}
        >
          <GlassCard
            className={`relative overflow-hidden p-4 ${
              milestone.achieved ? "border-gold/30 shadow-glow-gold" : ""
            }`}
          >
            {milestone.achieved && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-gradient-gold opacity-20 blur-2xl animate-glow-pulse"
              />
            )}
            <div className="relative flex items-start justify-between">
              <div
                className={`flex h-11 w-11 items-center justify-center rounded-full ${
                  milestone.achieved ? "bg-gradient-gold shadow-glow-gold" : "bg-white/5"
                }`}
              >
                {milestone.achieved ? (
                  <Flame className="h-5 w-5 text-background" aria-hidden="true" />
                ) : (
                  <Lock className="h-4 w-4 text-muted" aria-hidden="true" />
                )}
              </div>
              {milestone.achieved && (
                <span className="rounded-full bg-gold/10 px-2 py-0.5 text-[10px] font-semibold text-gold">
                  Unlocked
                </span>
              )}
            </div>

            <p className="relative mt-3 text-sm font-semibold text-white">{milestone.label}</p>
            <p className="relative mt-1 flex items-center gap-1 text-xs text-muted">
              <Sparkles className="h-3 w-3 text-gold" aria-hidden="true" />
              {milestone.rewardPreviewLabel}
            </p>

            <div className="relative mt-3">
              <ProgressBar progress={milestone.progress} />
              <p className="mt-1 text-[10px] text-muted">
                {milestone.progress}% of {formatCompactNumber(milestone.threshold)} MPGR
              </p>
            </div>
          </GlassCard>
        </motion.div>
      ))}
    </div>
  );
}
