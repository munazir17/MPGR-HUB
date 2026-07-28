"use client";

import { motion } from "framer-motion";
import { Lock, CheckCircle2, Gift, Sparkles } from "lucide-react";
import { clsx } from "clsx";
import type { SeasonReward } from "@/lib/season-config";

interface RewardNodeProps {
  level: number;
  reward: SeasonReward | null;
  unlocked: boolean;
  claimed: boolean;
  claimable: boolean;
  variant: "free" | "premium";
  onClaim?: () => void;
}

export function RewardNode({ level, reward, unlocked, claimed, claimable, variant, onClaim }: RewardNodeProps) {
  if (!reward) {
    return (
      <div className="flex w-16 shrink-0 flex-col items-center gap-1 opacity-30">
        <div className="h-12 w-12 rounded-xl border border-dashed border-white/10" />
        <span className="text-[10px] text-muted">Lv {level}</span>
      </div>
    );
  }

  const Icon = variant === "premium" ? Sparkles : Gift;

  return (
    <motion.button
      type="button"
      onClick={claimable ? onClaim : undefined}
      disabled={!claimable}
      whileHover={claimable ? { y: -2 } : undefined}
      whileTap={claimable ? { scale: 0.95 } : undefined}
      className={clsx(
        "flex w-16 shrink-0 flex-col items-center gap-1.5 rounded-xl border p-2 text-center transition-colors duration-200",
        claimed
          ? "border-gold/30 bg-gold/[0.06]"
          : claimable
          ? "cursor-pointer border-gold/40 bg-gold/[0.1] shadow-glow-gold"
          : unlocked
          ? "border-white/10 bg-white/[0.03]"
          : "border-white/[0.06] bg-white/[0.01] opacity-50"
      )}
      aria-label={`Level ${level} ${variant} reward — ${reward.label} — ${
        claimed ? "claimed" : claimable ? "claim" : unlocked ? "unlocked" : "locked"
      }`}
    >
      <div
        className={clsx(
          "flex h-9 w-9 items-center justify-center rounded-full",
          variant === "premium" ? "bg-gold/10" : "bg-primary/10"
        )}
      >
        {claimed ? (
          <CheckCircle2 className="h-4 w-4 text-gold" aria-hidden="true" />
        ) : unlocked ? (
          <Icon className={clsx("h-4 w-4", variant === "premium" ? "text-gold" : "text-primary")} aria-hidden="true" />
        ) : (
          <Lock className="h-4 w-4 text-muted" aria-hidden="true" />
        )}
      </div>
      <span className="text-[9px] font-medium leading-tight text-muted">{reward.label}</span>
      <span className="text-[9px] text-muted">Lv {level}</span>
    </motion.button>
  );
}
