"use client";

import { motion } from "framer-motion";
import { ChevronDown, Target } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { HolderTierBadge } from "./HolderTierBadge";
import { formatCompactNumber } from "@/lib/format";
import type { HolderTierStatus } from "@/lib/holder-tier-engine";

interface HolderTierProgressProps {
  status: HolderTierStatus;
}

const fadeSlide = {
  hidden: { opacity: 0, y: 8 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.08, duration: 0.35, ease: "easeOut" },
  }),
};

export function HolderTierProgress({ status }: HolderTierProgressProps) {
  const { score, currentTierDef, nextTierDef, progressToNextTier, amountToNextTier } = status;

  return (
    <GlassCard className="p-5 sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <Target className="h-4 w-4 text-primary" aria-hidden="true" />
        <p className="text-sm font-semibold text-white">Tier Progress</p>
      </div>

      <div className="flex flex-col items-center gap-2 text-center">
        <motion.div custom={0} variants={fadeSlide} initial="hidden" animate="visible">
          <p className="text-[11px] uppercase tracking-wider text-muted">Current Score</p>
          <AnimatedNumber value={score.totalScore} className="text-3xl font-bold text-white" />
        </motion.div>

        <motion.div custom={1} variants={fadeSlide} initial="hidden" animate="visible">
          <ChevronDown className="h-4 w-4 text-muted" aria-hidden="true" />
        </motion.div>

        <motion.div custom={2} variants={fadeSlide} initial="hidden" animate="visible">
          <p className="mb-1.5 text-[11px] uppercase tracking-wider text-muted">Current Tier</p>
          {currentTierDef ? (
            <HolderTierBadge tier={currentTierDef.id} />
          ) : (
            <span className="inline-flex items-center rounded-full bg-white/[0.06] px-2.5 py-1 text-xs font-semibold text-muted">
              Unranked
            </span>
          )}
        </motion.div>

        <motion.div custom={3} variants={fadeSlide} initial="hidden" animate="visible">
          <ChevronDown className="h-4 w-4 text-muted" aria-hidden="true" />
        </motion.div>

        <motion.div
          custom={4}
          variants={fadeSlide}
          initial="hidden"
          animate="visible"
          className="w-full max-w-sm"
        >
          <ProgressBar progress={progressToNextTier} />
        </motion.div>

        <motion.div custom={5} variants={fadeSlide} initial="hidden" animate="visible">
          <ChevronDown className="h-4 w-4 text-muted" aria-hidden="true" />
        </motion.div>

        <motion.div custom={6} variants={fadeSlide} initial="hidden" animate="visible">
          <p className="text-[11px] uppercase tracking-wider text-muted">
            {nextTierDef ? `Score Needed for ${nextTierDef.label}` : "Max Tier Reached"}
          </p>
          <p className="text-lg font-bold text-gradient-gold">
            {nextTierDef ? `${formatCompactNumber(amountToNextTier)} MPGR to go` : "Diamond Unlocked"}
          </p>
        </motion.div>
      </div>
    </GlassCard>
  );
}
