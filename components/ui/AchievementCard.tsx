"use client";

import { motion } from "framer-motion";
import { Award, Lock, CheckCircle2 } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { ProgressBar } from "./ProgressBar";
import type { Achievement } from "@/lib/xp-engine";

export function AchievementCard({
  achievement,
  onClaim,
}: {
  achievement: Achievement;
  onClaim: () => void;
}) {
  const { title, description, unlocked, claimed, progress, target, comingSoon } = achievement;
  const pct = target === 0 ? 0 : Math.round((progress / target) * 100);

  return (
    <motion.div whileHover={{ y: -2 }}>
      <GlassCard className={`relative overflow-hidden p-4 ${unlocked ? "" : "opacity-60"}`}>
        <div className="flex items-start justify-between">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
            {claimed ? (
              <CheckCircle2 className="h-4 w-4 text-gold" />
            ) : unlocked ? (
              <Award className="h-4 w-4 text-primary" />
            ) : (
              <Lock className="h-4 w-4 text-muted" />
            )}
          </div>
          {claimed && (
            <span className="rounded-full bg-gold/10 px-2 py-0.5 text-[10px] font-medium text-gold">
              Claimed
            </span>
          )}
        </div>

        <p className="mt-3 text-sm font-medium text-white">{title}</p>
        <p className="mt-1 text-xs text-muted">{description}</p>

        {!comingSoon && (
          <div className="mt-3">
            <ProgressBar progress={pct} />
            <p className="mt-1 text-[10px] text-muted">
              {progress}/{target}
            </p>
          </div>
        )}

        <button
          onClick={onClaim}
          disabled={!unlocked || claimed || comingSoon}
          className="mt-3 w-full rounded-lg bg-gradient-premium py-1.5 text-xs font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
        >
          {comingSoon ? "Coming Soon" : claimed ? "Claimed" : unlocked ? "Claim" : "Locked"}
        </button>
      </GlassCard>
    </motion.div>
  );
}
