"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Loader2, CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";
import { formatTokenBalance } from "@/lib/format";
import { tokenUtils } from "@/lib/token/token-utils";
import type { StakingActionState } from "@/lib/staking/staking-types";

// Phase 3E Part 3 — redesigned for the live contract: a plain amount
// input (no lock-duration selector, since the pool has no lock terms),
// an approve-then-stake flow driven directly by useStaking's action
// state, and a real transaction hash linked to BaseScan on success.

interface StakeModalProps {
  open: boolean;
  onClose: () => void;
  walletBalanceRaw: bigint;
  minimumStakeRaw: bigint;
  decimals: number;
  needsApproval: (amountRaw: bigint) => boolean;
  approveState: StakingActionState;
  stakeState: StakingActionState;
  onApprove: (amountRaw: bigint) => void;
  onStake: (amountRaw: bigint) => void;
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

export function StakeModal({
  open,
  onClose,
  walletBalanceRaw,
  minimumStakeRaw,
  decimals,
  needsApproval,
  approveState,
  stakeState,
  onApprove,
  onStake,
  onReset,
  isWrongNetwork,
  onSwitchNetwork,
}: StakeModalProps) {
  const [amountInput, setAmountInput] = useState("");

  useEffect(() => {
    if (open) {
      setAmountInput("");
      onReset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const amountRaw = useMemo(() => {
    try {
      if (!amountInput || Number.isNaN(parseFloat(amountInput))) return 0n;
      return tokenUtils.parseTokenAmount(amountInput, decimals);
    } catch {
      return 0n;
    }
  }, [amountInput, decimals]);

  const validAmount = amountRaw > 0n;
  const exceedsBalance = validAmount && amountRaw > walletBalanceRaw;
  const belowMinimum = validAmount && amountRaw < minimumStakeRaw;
  const requiresApproval = validAmount && needsApproval(amountRaw);

  const approveBusy = busyLabel(approveState.phase);
  const stakeBusy = busyLabel(stakeState.phase);
  const isBusy = approveBusy !== null || stakeBusy !== null;

  const canSubmit = validAmount && !exceedsBalance && !belowMinimum && !isWrongNetwork && !isBusy;

  const handleMax = () => setAmountInput(formatFullAmount(walletBalanceRaw, decimals));

  const handlePrimaryAction = () => {
    if (!canSubmit) return;
    if (requiresApproval) {
      onApprove(amountRaw);
    } else {
      onStake(amountRaw);
    }
  };

  const explorerUrl = stakeState.hash ? `https://basescan.org/tx/${stakeState.hash}` : null;
  const anyError = approveState.error ?? stakeState.error;

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
            className="relative w-full max-w-md rounded-t-2xl border border-white/10 bg-surface p-6 shadow-glow sm:rounded-2xl"
            style={{ paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom))" }}
          >
            <button
              onClick={onClose}
              disabled={isBusy}
              aria-label="Close stake dialog"
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:text-white disabled:opacity-40"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>

            <AnimatePresence mode="wait">
              {stakeState.phase === "success" ? (
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
                  <p className="mt-4 text-sm font-semibold text-white">MPGR Staked</p>
                  <p className="mt-1 text-xs text-muted">
                    {formatTokenBalance(amountRaw, decimals)} MPGR added to your staked balance
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
                  <p className="text-sm font-semibold text-white">Stake MPGR</p>
                  <p className="mt-1 text-xs text-muted">
                    Available: {formatTokenBalance(walletBalanceRaw, decimals)} MPGR
                  </p>

                  <div className="mt-4">
                    <label htmlFor="stake-amount" className="text-xs text-muted">
                      Amount
                    </label>
                    <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-white/10 bg-background/50 px-3 py-2.5">
                      <input
                        id="stake-amount"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        placeholder="0.00"
                        value={amountInput}
                        disabled={isBusy}
                        onChange={(e) => setAmountInput(e.target.value)}
                        className="w-full bg-transparent text-lg font-semibold text-white placeholder:text-muted focus:outline-none"
                      />
                      <button
                        onClick={handleMax}
                        disabled={isBusy}
                        className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary disabled:opacity-40"
                      >
                        Max
                      </button>
                    </div>
                    {exceedsBalance && (
                      <p className="mt-1.5 text-[11px] text-red-400">Amount exceeds available balance.</p>
                    )}
                    {!exceedsBalance && belowMinimum && (
                      <p className="mt-1.5 text-[11px] text-red-400">
                        Minimum stake is {formatTokenBalance(minimumStakeRaw, decimals)} MPGR.
                      </p>
                    )}
                  </div>

                  {requiresApproval && !isBusy && (
                    <p className="mt-3 text-[11px] text-muted">
                      First-time staking requires a one-time approval so the contract can transfer
                      this amount from your wallet.
                    </p>
                  )}

                  {anyError && (
                    <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {anyError}
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
                      onClick={handlePrimaryAction}
                      disabled={!canSubmit}
                      aria-label={requiresApproval ? "Approve MPGR" : "Confirm stake"}
                      className="mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-gold py-2.5 text-sm font-semibold text-background transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
                    >
                      {isBusy ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          {approveBusy ?? stakeBusy}
                        </>
                      ) : requiresApproval ? (
                        "Approve MPGR"
                      ) : (
                        "Confirm Stake"
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

// Full (non-compact) decimal string for the Max button, so clicking Max
// stakes the wallet's exact balance rather than a rounded display figure.
function formatFullAmount(raw: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  if (remainder === 0n) return whole.toString();
  const fraction = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fraction}`;
}
