"use client";

import { motion } from "framer-motion";
import { TrendingUp } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { formatCompactNumber } from "@/lib/format";
import type { SeasonLevelProgress } from "@/lib/season-engine";

interface SeasonProgressCardProps {
  levelProgress: SeasonLevelProgress;
  seasonPoints: number;
}

export function SeasonProgressCard({ levelProgress, seasonPoints }: SeasonProgressCardProps) {
  return (
    <GlassCard className="relative overflow-hidden p-5">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gradient-premium opacity-20 blur-3xl"
      />

      <div className="relative flex items-center justify-between">
        <p className="text-xs text-muted">Season Level</p>
        <span className="flex items-center gap-1 text-xs text-muted">
          <TrendingUp className="h-3 w-3" aria-hidden="true" />
          {formatCompactNumber(seasonPoints)} Season Points
        </span>
      </div>

      <motion.p
        key={levelProgress.level}
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative mt-2 text-3xl font-bold text-white"
      >
        Level {levelProgress.level}
      </motion.p>

      <div className="relative mt-4">
        <ProgressBar progress={levelProgress.progress} />
        {/* getSeasonLevelProgress() (lib/season-engine.ts) computes this
            entirely from seasonPoints, never from account XP — labeling
            it "XP" here was the same XP/Season Points conflation this
            pass exists to fix, just one level down from the top-line
            stat above. */}
        <p className="mt-1 text-[11px] text-muted">
          {levelProgress.isMaxLevel
            ? "Max level reached this season"
            : `${levelProgress.pointsIntoLevel}/${levelProgress.pointsNeededForLevel} pts to Level ${levelProgress.level + 1}`}
        </p>
      </div>
    </GlassCard>
  );
}
