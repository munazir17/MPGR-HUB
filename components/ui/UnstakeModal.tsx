"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Loader2, CheckCircle2, AlertCircle, Lock, ArrowDownToLine } from "lucide-react";
import type { StakingPositionView } from "@/lib/staking-engine";
import { formatCompactNumber } from "@/lib/format";

type Phase = "idle" | "submitting" | "success" | "error";

interface UnstakeModalProps {
  open: boolean;
  onClose: () => void;
  position: StakingPositionView | null;
  onConfirm: (positionId: string) => void;
  error: string | null;
  successSignal: number | null;
}

export function UnstakeModal({
  open,
  onClose,
  position,
  onConfirm,
  error,
  successSignal,
}: UnstakeModalProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const baseline = useRef<{ error: string | null; signal: number | null }>({
    error: null,
    signal: null,
  });

  useEffect(() => {
    if (open) setPhase("idle");
  }, [open, position?.id]);

  useEffect(() => {
    if (phase !== "submitting") return;
    if (error && error !== baseline.current.error) {
      setPhase("error");
      return;
    }
    if (successSignal !== null && successSignal !== baseline.current.signal) {
      setPhase("success");
      const timer = setTimeout(onClose, 1400);
      return () => clearTimeout(timer);
    }
  }, [phase, error, successSignal, onClose]);

  if (!position) return null;

  const { id, amount, claimableReward, isUnlocked, daysRemaining } = position;
  const payout = amount + claimableReward;
  const canSubmit = isUnlocked && phase !== "submitting";

  const handleConfirm = () => {
    if (!canSubmit) return;
    baseline.current = { error, signal: successSignal };
    setPhase("submitting");
    // Phase 2B swap point: replace with an awaited unstake contract call.
    setTimeout(() => {
      onConfirm(id);
    }, 500);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={phase === "submitting" ? undefined : onClose}
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:px-4"
        >
          <motion.div
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md rounded-t-2xl border border-white/10 bg-surface p-6 shadow-glow sm:rounded-2xl"
            style={{ paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
          >
            <button
              onClick={onClose}
              disabled={phase === "submitting"}
              aria-label="Close unstake dialog"
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:text-white disabled:opacity-40"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>

            <AnimatePresence mode="wait">
              {phase === "success" ? (
                <motion.div
                  key="success"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center py-8 text-center"
                >
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gold/10">
                    <CheckCircle2 className="h-7 w-7 text-gold" aria-hidden="true" />
                  </div>
                  <p className="mt-4 text-sm font-semibold text-white">Unstaked</p>
                  <p className="mt-1 text-xs text-muted">
                    {formatCompactNumber(payout)} MPGR returned to your balance
                  </p>
                </motion.div>
              ) : (
                <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <p className="text-sm font-semibold text-white">Unstake MPGR</p>
                  <p className="mt-1 text-xs text-muted">
                    Review your payout before confirming.
                  </p>

                  <div className="mt-4 space-y-2 rounded-xl bg-background/50 p-3.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted">Principal</span>
                      <span className="font-semibold text-white">{formatCompactNumber(amount)} MPGR</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted">Accrued reward</span>
                      <span className="font-semibold text-gold">
                        +{formatCompactNumber(claimableReward)} MPGR
                      </span>
                    </div>
                    <div className="my-1 h-px bg-white/10" />
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-1.5 text-white">
                        <ArrowDownToLine className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
                        Total payout
                      </span>
                      <span className="font-bold text-white">{formatCompactNumber(payout)} MPGR</span>
                    </div>
                  </div>

                  {!isUnlocked && (
                    <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-muted">
                      <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
                      Still locked — {daysRemaining} day{daysRemaining === 1 ? "" : "s"} remaining.
                    </div>
                  )}

                  {phase === "error" && (
                    <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {error ?? "Unable to unstake right now."}
                    </div>
                  )}

                  <button
                    onClick={handleConfirm}
                    disabled={!canSubmit}
                    aria-label="Confirm unstake"
                    className="mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-gold py-2.5 text-sm font-semibold text-background transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
                  >
                    {phase === "submitting" ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        Unstaking...
                      </>
                    ) : (
                      "Confirm Unstake"
                    )}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
