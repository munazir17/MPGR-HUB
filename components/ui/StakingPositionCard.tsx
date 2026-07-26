"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Lock, Unlock, CheckCircle2, Coins } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { ProgressBar } from "./ProgressBar";
import type { StakingPositionView } from "@/lib/staking-engine";
import { formatCompactNumber } from "@/lib/format";

interface StakingPositionCardProps {
  position: StakingPositionView;
  onClaim: () => void;
  onUnstake: () => void;
  disabled?: boolean;
}

export function StakingPositionCard({
  position,
  onClaim,
  onUnstake,
  disabled,
}: StakingPositionCardProps) {
  const { amount, apy, lockDurationDays, status, progress, daysRemaining, isUnlocked, claimableReward, unlocksAt } =
    position;
  const unlockDateLabel = new Date(unlocksAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  const isUnstaked = status === "unstaked";
  const canClaim = !isUnstaked && claimableReward > 0 && !disabled;
  const canUnstake = !isUnstaked && isUnlocked && !disabled;

  return (
    <motion.div whileHover={{ y: -3 }} transition={{ type: "spring", stiffness: 300, damping: 22 }}>
      <GlassCard className={`relative overflow-hidden p-4 ${isUnstaked ? "opacity-60" : ""}`}>
        <div className="flex items-start justify-between">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
            <AnimatePresence mode="wait">
              {isUnstaked ? (
                <motion.span
                  key="unstaked"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 400, damping: 15 }}
                >
                  <CheckCircle2 className="h-5 w-5 text-muted" aria-hidden="true" />
                </motion.span>
              ) : isUnlocked ? (
                <Unlock className="h-5 w-5 text-gold" aria-hidden="true" />
              ) : (
                <Lock className="h-5 w-5 text-primary" aria-hidden="true" />
              )}
            </AnimatePresence>
          </div>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
            {apy}% APY
          </span>
        </div>

        <p className="mt-3 text-lg font-bold text-white">{formatCompactNumber(amount)} MPGR</p>
        <p className="mt-0.5 text-xs text-muted">
          {lockDurationDays}-day lock ·{" "}
          {isUnstaked
            ? "Unstaked"
            : isUnlocked
              ? "Ready to unstake"
              : `${daysRemaining} day${daysRemaining === 1 ? "" : "s"} remaining`}
        </p>

        {!isUnstaked && (
          <div className="mt-3">
            <ProgressBar progress={progress} />
            <p className="mt-1 text-[10px] text-muted">
              {isUnlocked ? "Unlocked" : `Unlocks ${unlockDateLabel}`}
            </p>
          </div>
        )}

        <div className="mt-3 flex items-center justify-between rounded-lg bg-background/50 px-3 py-2">
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <Coins className="h-3 w-3 text-gold" aria-hidden="true" />
            Claimable
          </span>
          <span className="text-xs font-semibold text-gold">
            +{formatCompactNumber(claimableReward)} MPGR
          </span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={onClaim}
            disabled={!canClaim}
            aria-label={`Claim rewards for ${formatCompactNumber(amount)} MPGR position`}
            className="min-h-[36px] rounded-lg bg-gradient-gold py-1.5 text-xs font-semibold text-background transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
          >
            Claim
          </button>
          <button
            onClick={onUnstake}
            disabled={!canUnstake}
            aria-label={`Unstake ${formatCompactNumber(amount)} MPGR position`}
            className="min-h-[36px] rounded-lg border border-white/10 bg-white/[0.03] py-1.5 text-xs font-semibold text-white transition-transform active:scale-95 disabled:cursor-not-allowed disabled:text-muted"
          >
            {isUnstaked ? "Unstaked" : isUnlocked ? "Unstake" : "Locked"}
          </button>
        </div>
      </GlassCard>
    </motion.div>
  );
}
