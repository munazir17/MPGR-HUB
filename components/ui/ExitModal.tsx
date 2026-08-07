"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Loader2, CheckCircle2, AlertCircle, LogOut, ExternalLink } from "lucide-react";
import { formatTokenBalance } from "@/lib/format";
import type { StakingActionState } from "@/lib/staking/staking-types";

// Phase 3E Part 3 — new. exit() withdraws the caller's full staked
// balance and claims all accrued reward in a single transaction. This
// modal is a confirmation step only — no amount input, since exit() takes
// none; it always acts on the caller's entire position.

interface ExitModalProps {
  open: boolean;
  onClose: () => void;
  stakedBalanceRaw: bigint;
  earnedRewardsRaw: bigint;
  decimals: number;
  exitState: StakingActionState;
  onExit: () => void;
  onReset: () => void;
  isWrongNetwork: boolean;
  onSwitchNetwork: () => void;
}

function busyLabel(phase: StakingActionState["phase"]): string | null {
  if (phase === "simulating") return "Confirm in wallet...";
  if (phase === "pending") return "Submitting...";
  if (phase === "confirming") return "Confirming on Base...";
  return null;
}

export function ExitModal({
  open,
  onClose,
  stakedBalanceRaw,
  earnedRewardsRaw,
  decimals,
  exitState,
  onExit,
  onReset,
  isWrongNetwork,
  onSwitchNetwork,
}: ExitModalProps) {
  useEffect(() => {
    if (open) onReset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const totalPayoutRaw = stakedBalanceRaw + earnedRewardsRaw;
  const busy = busyLabel(exitState.phase);
  const canSubmit = !isWrongNetwork && busy === null && (stakedBalanceRaw > 0n || earnedRewardsRaw > 0n);
  const explorerUrl = exitState.hash ? `https://basescan.org/tx/${exitState.hash}` : null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={busy ? undefined : onClose}
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
              disabled={busy !== null}
              aria-label="Close exit dialog"
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:text-white disabled:opacity-40"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>

            <AnimatePresence mode="wait">
              {exitState.phase === "success" ? (
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
                  <p className="mt-4 text-sm font-semibold text-white">Exited Staking</p>
                  <p className="mt-1 text-xs text-muted">
                    {formatTokenBalance(totalPayoutRaw, decimals)} MPGR returned to your wallet
                  </p>
                  {explorerUrl && (
                    <a
                      href={explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 flex items-center gap-1 text-[11px] text-primary hover:underline"
                    >
                      View on BaseScan
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </motion.div>
              ) : (
                <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <p className="text-sm font-semibold text-white">Exit Staking</p>
                  <p className="mt-1 text-xs text-muted">
                    Withdraws your full staked balance and claims all accrued reward, in one
                    transaction.
                  </p>

                  <div className="mt-4 space-y-2 rounded-xl bg-background/50 p-3.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted">Staked principal</span>
                      <span className="font-semibold text-white">
                        {formatTokenBalance(stakedBalanceRaw, decimals)} MPGR
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted">Accrued reward</span>
                      <span className="font-semibold text-gold">
                        +{formatTokenBalance(earnedRewardsRaw, decimals)} MPGR
                      </span>
                    </div>
                    <div className="my-1 h-px bg-white/10" />
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-1.5 text-white">
                        <LogOut className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
                        Total payout
                      </span>
                      <span className="font-bold text-white">
                        {formatTokenBalance(totalPayoutRaw, decimals)} MPGR
                      </span>
                    </div>
                  </div>

                  {exitState.phase === "error" && exitState.error && (
                    <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {exitState.error}
                    </div>
                  )}

                  {isWrongNetwork ? (
                    <button
                      onClick={onSwitchNetwork}
                      className="mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-gold py-2.5 text-sm font-semibold text-background transition-transform active:scale-95"
                    >
                      Switch to Base
                    </button>
                  ) : (
                    <button
                      onClick={() => canSubmit && onExit()}
                      disabled={!canSubmit}
                      aria-label="Confirm exit"
                      className="mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-gold py-2.5 text-sm font-semibold text-background transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
                    >
                      {busy ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          {busy}
                        </>
                      ) : (
                        "Confirm Exit"
                      )}
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
