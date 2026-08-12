"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Loader2, CheckCircle2, AlertCircle, AlertTriangle, ArrowDownToLine, ExternalLink } from "lucide-react";
import type { TokenLockPositionView, TokenLockActionState } from "@/lib/token-lock/token-lock-types";
import { formatCompactNumber } from "@/lib/format";

// Real earlyUnlock(lockId) transaction, driven directly by useTokenLock's
// earlyUnlockState. The penalty split (90% returned / 10% to
// penaltyRecipient) is computed and executed entirely on-chain by the
// deployed contract -- the figures shown here are a preview only (see
// token-lock-config.ts's earlyUnlockPenaltyBps comment), never used to
// decide what gets transferred. No maturity-bonus forfeiture copy: the
// deployed contract has no bonus mechanism.

interface EarlyUnlockModalProps {
  open: boolean;
  onClose: () => void;
  position: TokenLockPositionView | null;
  penaltyPercent: number;
  earlyUnlockState: TokenLockActionState;
  onConfirm: (lockId: bigint) => void;
  onReset: () => void;
}

export function EarlyUnlockModal({
  open,
  onClose,
  position,
  penaltyPercent,
  earlyUnlockState,
  onConfirm,
  onReset,
}: EarlyUnlockModalProps) {
  useEffect(() => {
    if (open) onReset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, position?.id]);

  if (!position) return null;

  const { id, amountFormatted, daysRemaining, earlyUnlockPenaltyPreview, earlyUnlockPayoutPreview } = position;

  const isBusy =
    earlyUnlockState.phase === "simulating" ||
    earlyUnlockState.phase === "pending" ||
    earlyUnlockState.phase === "confirming";
  const isSuccess = earlyUnlockState.phase === "success";
  const isError = earlyUnlockState.phase === "error";
  const canSubmit = !isBusy && !isSuccess;

  const busyLabel =
    earlyUnlockState.phase === "simulating"
      ? "Confirm in wallet..."
      : earlyUnlockState.phase === "pending"
        ? "Submitting..."
        : earlyUnlockState.phase === "confirming"
          ? "Confirming on Base..."
          : null;

  const handleConfirm = () => {
    if (!canSubmit) return;
    onConfirm(id);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={isBusy ? undefined : onClose}
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:px-4"
        >
          <motion.div
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md rounded-t-2xl border border-red-500/20 bg-surface p-6 shadow-glow sm:rounded-2xl"
            style={{ paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
          >
            <button
              onClick={onClose}
              disabled={isBusy}
              aria-label="Close early unlock dialog"
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:text-white disabled:opacity-40"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>

            <AnimatePresence mode="wait">
              {isSuccess ? (
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
                  <p className="mt-4 text-sm font-semibold text-white">Lock Released Early</p>
                  <p className="mt-1 text-xs text-muted">
                    ~{formatCompactNumber(earlyUnlockPayoutPreview)} MPGR returned to your wallet
                  </p>
                  {earlyUnlockState.hash && (
                    <a
                      href={`https://basescan.org/tx/${earlyUnlockState.hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                    >
                      View on BaseScan <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </motion.div>
              ) : (
                <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <div className="flex items-center gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500/10">
                      <AlertTriangle className="h-4 w-4 text-red-400" aria-hidden="true" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-white">Early Unlock</p>
                      <p className="text-[11px] text-muted">
                        {daysRemaining} day{daysRemaining === 1 ? "" : "s"} remaining on this lock
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 p-3.5 text-xs text-red-400">
                    Withdrawing before the lock matures applies a{" "}
                    <span className="font-semibold">{penaltyPercent}% penalty</span> to your principal, enforced
                    on-chain by the Token Lock contract.
                  </div>

                  <div className="mt-4 space-y-2 rounded-xl bg-background/50 p-3.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted">Locked Principal</span>
                      <span className="font-semibold text-white">{formatCompactNumber(amountFormatted)} MPGR</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted">Penalty ({penaltyPercent}%, estimate)</span>
                      <span className="font-semibold text-red-400">
                        -{formatCompactNumber(earlyUnlockPenaltyPreview)} MPGR
                      </span>
                    </div>
                    <div className="my-1 h-px bg-white/10" />
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-1.5 text-white">
                        <ArrowDownToLine className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
                        Est. Net Payout
                      </span>
                      <span className="font-bold text-white">
                        {formatCompactNumber(earlyUnlockPayoutPreview)} MPGR
                      </span>
                    </div>
                  </div>

                  {isError && (
                    <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {earlyUnlockState.error ?? "Unable to process early unlock right now."}
                    </div>
                  )}

                  <button
                    onClick={handleConfirm}
                    disabled={!canSubmit}
                    aria-label="Confirm early unlock"
                    className="mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-red-500/40 bg-red-500/15 py-2.5 text-sm font-semibold text-red-300 transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isBusy ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        {busyLabel ?? "Processing..."}
                      </>
                    ) : (
                      "Confirm Early Unlock"
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
