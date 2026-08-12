"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Lock, Unlock, CheckCircle2, Loader2 } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import type { TokenLockPositionView, TokenLockActionState } from "@/lib/token-lock/token-lock-types";
import { formatCompactNumber } from "@/lib/format";

// Renders one on-chain lock exactly as getLock()/getLockStatus() report it.
// No bonus display (the deployed contract has no bonus mechanism) and no
// progress bar / "locked since" date (Lock struct only stores amount,
// unlockTime, withdrawn -- there is no on-chain creation timestamp to
// compute elapsed-term progress from). onWithdraw triggers the real
// withdraw(lockId) transaction; the card disables its own buttons only
// while THIS lock is the pendingLockId, not while any lock is busy.

interface LockCardProps {
  position: TokenLockPositionView;
  onWithdraw: () => void;
  onEarlyUnlock: () => void;
  isPending: boolean;
  actionState: TokenLockActionState;
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
  withdrawn: "Withdrawn",
};

const STATUS_CLASS: Record<TokenLockPositionView["status"], string> = {
  locked: "bg-primary/10 text-primary",
  unlocking_soon: "bg-gold/10 text-gold",
  unlocked: "bg-emerald-500/10 text-emerald-400",
  withdrawn: "bg-white/5 text-muted",
};

export function LockCard({ position, onWithdraw, onEarlyUnlock, isPending, actionState }: LockCardProps) {
  const { id, amountFormatted, unlockTime, status, daysRemaining, isUnlocked } = position;

  const isWithdrawn = status === "withdrawn";
  const unlockMs = Number(unlockTime) * 1000;
  const [timeLeft, setTimeLeft] = useState(() => getTimeLeft(unlockMs));

  useEffect(() => {
    if (isWithdrawn || isUnlocked) return;
    setTimeLeft(getTimeLeft(unlockMs));
    const t = setInterval(() => setTimeLeft(getTimeLeft(unlockMs)), 30_000);
    return () => clearInterval(t);
  }, [unlockMs, isWithdrawn, isUnlocked]);

  const unlockDateLabel = new Date(unlockMs).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const isBusy =
    isPending &&
    (actionState.phase === "simulating" || actionState.phase === "pending" || actionState.phase === "confirming");

  const canWithdraw = !isWithdrawn && isUnlocked && !isBusy;
  const canEarlyUnlock = !isWithdrawn && !isUnlocked && !isBusy;

  return (
    <motion.div whileHover={{ y: -3 }} transition={{ type: "spring", stiffness: 300, damping: 22 }}>
      <GlassCard className={`relative overflow-hidden p-4 ${isWithdrawn ? "opacity-60" : ""}`}>
        <div className="flex items-start justify-between">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
            <AnimatePresence mode="wait">
              {isWithdrawn ? (
                <motion.span
                  key="withdrawn"
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

        <p className="mt-3 text-lg font-bold text-white">{formatCompactNumber(amountFormatted)} MPGR</p>
        <p className="mt-0.5 text-[11px] text-muted">Lock #{id.toString()}</p>
        <p className="mt-1 text-[11px] text-muted">Unlocks {unlockDateLabel}</p>

        {!isWithdrawn && !isUnlocked && (
          <div className="mt-3 flex gap-2">
            {[
              { value: timeLeft.days, unit: "d" },
              { value: timeLeft.hours, unit: "h" },
              { value: timeLeft.minutes, unit: "m" },
            ].map((t) => (
              <div key={t.unit} className="flex-1 rounded-lg bg-background/50 py-1.5 text-center">
                <p className="text-sm font-semibold text-white">{t.value}</p>
                <p className="text-[9px] text-muted">{t.unit}</p>
              </div>
            ))}
          </div>
        )}

        {!isWithdrawn && isUnlocked && (
          <p className="mt-3 text-[10px] text-muted">Ready to withdraw</p>
        )}
        {!isWithdrawn && !isUnlocked && (
          <p className="mt-1 text-[10px] text-muted">
            {daysRemaining} day{daysRemaining === 1 ? "" : "s"} remaining
          </p>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={onWithdraw}
            disabled={!canWithdraw}
            aria-label={`Withdraw ${formatCompactNumber(amountFormatted)} MPGR lock`}
            className="flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg bg-gradient-gold py-1.5 text-xs font-semibold text-background transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
          >
            {isBusy && isUnlocked && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {isWithdrawn ? "Withdrawn" : isUnlocked ? (isBusy ? "Withdrawing..." : "Withdraw") : "Locked"}
          </button>
          <button
            onClick={onEarlyUnlock}
            disabled={!canEarlyUnlock}
            aria-label={`Early unlock ${formatCompactNumber(amountFormatted)} MPGR lock`}
            className="min-h-[36px] rounded-lg border border-white/10 bg-white/[0.03] py-1.5 text-xs font-semibold text-white transition-transform active:scale-95 disabled:cursor-not-allowed disabled:text-muted"
          >
            Early Unlock
          </button>
        </div>
      </GlassCard>
    </motion.div>
  );
}
