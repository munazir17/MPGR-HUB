"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Coins, Lock, CheckCircle2 } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { ProgressBar } from "./ProgressBar";
import type { RewardClaim } from "@/lib/rewards-engine";

export function RewardClaimCard({
  reward,
  onClaim,
}: {
  reward: RewardClaim;
  onClaim: () => void;
}) {
  const { title, description, amount, unlocked, claimed, progress, target } = reward;
  const pct = target === 0 ? 0 : Math.round((progress / target) * 100);

  return (
    <motion.div whileHover={{ y: -3 }} transition={{ type: "spring", stiffness: 300, damping: 22 }}>
      <GlassCard className={`relative overflow-hidden p-4 ${unlocked || claimed ? "" : "opacity-60"}`}>
        <div className="flex items-start justify-between">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gold/10">
            <AnimatePresence mode="wait">
              {claimed ? (
                <motion.span
                  key="claimed"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 400, damping: 15 }}
                >
                  <CheckCircle2 className="h-5 w-5 text-gold" aria-hidden="true" />
                </motion.span>
              ) : unlocked ? (
                <Coins className="h-5 w-5 text-gold" aria-hidden="true" />
              ) : (
                <Lock className="h-5 w-5 text-muted" aria-hidden="true" />
              )}
            </AnimatePresence>
          </div>
          <span className="rounded-full bg-gold/10 px-2 py-0.5 text-[10px] font-semibold text-gold">
            +{amount} MPGR
          </span>
        </div>

        <p className="mt-3 text-sm font-semibold text-white">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>

        <div className="mt-3">
          <ProgressBar progress={pct} />
          <p className="mt-1 text-[10px] text-muted">
            {progress}/{target}
          </p>
        </div>

        <button
          onClick={onClaim}
          disabled={!unlocked || claimed}
          aria-label={`${title} — ${claimed ? "claimed" : unlocked ? "claim reward" : "locked"}`}
          className="mt-3 min-h-[36px] w-full rounded-lg bg-gradient-gold py-1.5 text-xs font-semibold text-background transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
        >
          {claimed ? "Claimed" : unlocked ? "Claim" : "Locked"}
        </button>
      </GlassCard>
    </motion.div>
  );
}
