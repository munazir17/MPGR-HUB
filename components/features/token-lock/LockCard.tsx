"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Lock, Unlock, CheckCircle2, TrendingUp } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import type { TokenLockPositionView } from "@/lib/token-lock-engine";
import { formatCompactNumber } from "@/lib/format";

interface LockCardProps {
  position: TokenLockPositionView;
  onRelease: () => void;
  onEarlyUnlock: () => void;
  disabled?: boolean;
}

function getTimeLeft(target: number) {
  const diff = Math.max(0, target - Date.now());
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  return { days, hours, minutes };
}

const STATUS_LABEL: Record<TokenLockPositionView["status"], string> = {
  locked: "Locked",
  unlocking_soon: "Unlocking Soon",
  unlocked: "Unlocked",
  released: "Released",
};

const STATUS_CLASS: Record<TokenLockPositionView["status"], string> = {
  locked: "bg-primary/10 text-primary",
  unlocking_soon: "bg-gold/10 text-gold",
  unlocked: "bg-emerald-500/10 text-emerald-400",
  released: "bg-white/5 text-muted",
};

export function LockCard({ position, onRelease, onEarlyUnlock, disabled }: LockCardProps) {
  const {
    amount,
    bonusPercent,
    lockPeriodDays,
    lockedAt,
    unlocksAt,
    status,
    progress,
    daysRemaining,
    isUnlocked,
  } = position;

  const isReleased = status === "released";
  const [timeLeft, setTimeLeft] = useState(() => getTimeLeft(new Date(unlocksAt).getTime()));

  useEffect(() => {
    if (isReleased || isUnlocked) return;
    const target = new Date(unlocksAt).getTime();
    setTimeLeft(getTimeLeft(target));
    const id = setInterval(() => setTimeLeft(getTimeLeft(target)), 30_000);
    return () => clearInterval(id);
  }, [unlocksAt, isReleased, isUnlocked]);

  const lockDateLabel = new Date(lockedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const unlockDateLabel = new Date(unlocksAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  const canRelease = !isReleased && isUnlocked && !disabled;
  const canEarlyUnlock = !isReleased && !isUnlocked && !disabled;

  return (
    <motion.div whileHover={{ y: -3 }} transition={{ type: "spring", stiffness: 300, damping: 22 }}>
      <GlassCard className={`relative overflow-hidden p-4 ${isReleased ? "opacity-60" : ""}`}>
        <div className="flex items-start justify-between">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
            <AnimatePresence mode="wait">
              {isReleased ? (
                <motion.span
                  key="released"
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
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_CLASS[status]}`}>
            {STATUS_LABEL[status]}
          </span>
        </div>

        <p className="mt-3 text-lg font-bold text-white">{formatCompactNumber(amount)} MPGR</p>
        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
          <TrendingUp className="h-3 w-3 text-gold" aria-hidden="true" />
          {lockPeriodDays}-day lock · +{bonusPercent}% bonus
        </p>
        <p className="mt-1 text-[11px] text-muted">
          Locked {lockDateLabel} → Unlocks {unlockDateLabel}
        </p>

        {!isReleased && (
          <div className="mt-3">
            <ProgressBar progress={progress} />
            <p className="mt-1 text-[10px] text-muted">
              {isUnlocked ? "Ready to release" : `${daysRemaining} day${daysRemaining === 1 ? "" : "s"} remaining`}
            </p>
          </div>
        )}

        {!isReleased && !isUnlocked && (
          <div className="mt-3 flex gap-2">
            {[
              { value: timeLeft.days, unit: "d" },
              { value: timeLeft.hours, unit: "h" },
              { value: timeLeft.minutes, unit: "m" },
            ].map((t) => (
              <div
                key={t.unit}
                className="flex-1 rounded-lg bg-background/50 py-1.5 text-center"
              >
                <p className="text-sm font-semibold text-white">{t.value}</p>
                <p className="text-[9px] text-muted">{t.unit}</p>
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={onRelease}
            disabled={!canRelease}
            aria-label={`Release ${formatCompactNumber(amount)} MPGR lock`}
            className="min-h-[36px] rounded-lg bg-gradient-gold py-1.5 text-xs font-semibold text-background transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
          >
            {isReleased ? "Released" : isUnlocked ? "Release" : "Locked"}
          </button>
          <button
            onClick={onEarlyUnlock}
            disabled={!canEarlyUnlock}
            aria-label={`Early unlock ${formatCompactNumber(amount)} MPGR lock`}
            className="min-h-[36px] rounded-lg border border-white/10 bg-white/[0.03] py-1.5 text-xs font-semibold text-white transition-transform active:scale-95 disabled:cursor-not-allowed disabled:text-muted"
          >
            Early Unlock
          </button>
        </div>
      </GlassCard>
    </motion.div>
  );
}
