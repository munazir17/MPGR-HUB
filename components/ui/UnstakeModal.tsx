"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Loader2, CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";
import { formatTokenBalance } from "@/lib/format";
import { tokenUtils } from "@/lib/token/token-utils";
import type { StakingActionState } from "@/lib/staking/staking-types";

// Phase 3E Part 3 — redesigned for the live contract: unstake any amount
// up to the wallet's staked balance, any time — no lock/unlock state to
// display since this pool has none. No ERC20 approval needed for unstake
// (the contract sends staked principal back to the caller directly).

interface UnstakeModalProps {
  open: boolean;
  onClose: () => void;
  stakedBalanceRaw: bigint;
  decimals: number;
  unstakeState: StakingActionState;
  onUnstake: (amountRaw: bigint) => void;
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

export function UnstakeModal({
  open,
  onClose,
  stakedBalanceRaw,
  decimals,
  unstakeState,
  onUnstake,
  onReset,
  isWrongNetwork,
  onSwitchNetwork,
}: UnstakeModalProps) {
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
  const exceedsStaked = validAmount && amountRaw > stakedBalanceRaw;

  const busy = busyLabel(unstakeState.phase);
  const canSubmit = validAmount && !exceedsStaked && !isWrongNetwork && busy === null;

  const handleMax = () => setAmountInput(formatFullAmount(stakedBalanceRaw, decimals));

  const explorerUrl = unstakeState.hash ? `https://basescan.org/tx/${unstakeState.hash}` : null;

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
              aria-label="Close unstake dialog"
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:text-white disabled:opacity-40"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>

            <AnimatePresence mode="wait">
              {unstakeState.phase === "success" ? (
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
                    {formatTokenBalance(amountRaw, decimals)} MPGR returned to your wallet
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
                  <p className="text-sm font-semibold text-white">Unstake MPGR</p>
                  <p className="mt-1 text-xs text-muted">
                    Currently staked: {formatTokenBalance(stakedBalanceRaw, decimals)} MPGR
                  </p>

                  <div className="mt-4">
                    <label htmlFor="unstake-amount" className="text-xs text-muted">
                      Amount
                    </label>
                    <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-white/10 bg-background/50 px-3 py-2.5">
                      <input
                        id="unstake-amount"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        placeholder="0.00"
                        value={amountInput}
                        disabled={busy !== null}
                        onChange={(e) => setAmountInput(e.target.value)}
                        className="w-full bg-transparent text-lg font-semibold text-white placeholder:text-muted focus:outline-none"
                      />
                      <button
                        onClick={handleMax}
                        disabled={busy !== null}
                        className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary disabled:opacity-40"
                      >
                        Max
                      </button>
                    </div>
                    {exceedsStaked && (
                      <p className="mt-1.5 text-[11px] text-red-400">Amount exceeds your staked balance.</p>
                    )}
                  </div>

                  {unstakeState.phase === "error" && unstakeState.error && (
                    <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {unstakeState.error}
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
                      onClick={() => canSubmit && onUnstake(amountRaw)}
                      disabled={!canSubmit}
                      aria-label="Confirm unstake"
                      className="mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-gold py-2.5 text-sm font-semibold text-background transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
                    >
                      {busy ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          {busy}
                        </>
                      ) : (
                        "Confirm Unstake"
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

function formatFullAmount(raw: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  if (remainder === 0n) return whole.toString();
  const fraction = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fraction}`;
}
