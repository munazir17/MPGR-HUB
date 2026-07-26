"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Loader2, CheckCircle2, AlertCircle, Sparkles } from "lucide-react";
import type { LockDurationDays, LockOption } from "@/lib/staking-engine";
import { formatCompactNumber } from "@/lib/format";

type Phase = "idle" | "submitting" | "success" | "error";

interface StakeModalProps {
  open: boolean;
  onClose: () => void;
  availableBalance: number;
  lockOptions: LockOption[];
  estimateRewards: (amount: number, lockDurationDays: LockDurationDays) => number;
  onConfirm: (amount: number, lockDurationDays: LockDurationDays) => void;
  error: string | null;
  successSignal: number | null;
}

export function StakeModal({
  open,
  onClose,
  availableBalance,
  lockOptions,
  estimateRewards,
  onConfirm,
  error,
  successSignal,
}: StakeModalProps) {
  const [amountInput, setAmountInput] = useState("");
  const [lockDurationDays, setLockDurationDays] = useState<LockDurationDays>(
    lockOptions[0]?.days ?? 30
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const baseline = useRef<{ error: string | null; signal: number | null }>({
    error: null,
    signal: null,
  });

  useEffect(() => {
    if (open) {
      setAmountInput("");
      setLockDurationDays(lockOptions[0]?.days ?? 30);
      setPhase("idle");
    }
  }, [open, lockOptions]);

  // Watch for the outcome of a submitted stake — the hook updates `error`
  // or `successSignal` (a fresh lastEvent id) once the action resolves.
  // Phase 2B swap point: once staking is a real contract call, this effect
  // becomes an awaited try/catch around the transaction instead.
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

  const amount = parseFloat(amountInput);
  const validAmount = Number.isFinite(amount) && amount > 0;
  const exceedsBalance = validAmount && amount > availableBalance;
  const estimatedReward = validAmount ? estimateRewards(amount, lockDurationDays) : 0;
  const selectedOption = lockOptions.find((o) => o.days === lockDurationDays) ?? lockOptions[0];

  const canSubmit = validAmount && !exceedsBalance && availableBalance > 0 && phase !== "submitting";

  const handleMax = () => setAmountInput(String(availableBalance));

  const handleConfirm = () => {
    if (!canSubmit) return;
    baseline.current = { error, signal: successSignal };
    setPhase("submitting");
    // Simulated confirmation delay — mirrors the latency a real Base
    // transaction would introduce, so the loading state is exercised
    // consistently once this becomes an on-chain call.
    setTimeout(() => {
      onConfirm(amount, lockDurationDays);
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
              aria-label="Close stake dialog"
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
                  <p className="mt-4 text-sm font-semibold text-white">MPGR Staked</p>
                  <p className="mt-1 text-xs text-muted">
                    {formatCompactNumber(amount)} MPGR locked for {lockDurationDays} days
                  </p>
                </motion.div>
              ) : (
                <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <p className="text-sm font-semibold text-white">Stake MPGR</p>
                  <p className="mt-1 text-xs text-muted">
                    Available: {formatCompactNumber(availableBalance)} MPGR
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
                        disabled={phase === "submitting"}
                        onChange={(e) => setAmountInput(e.target.value)}
                        className="w-full bg-transparent text-lg font-semibold text-white placeholder:text-muted focus:outline-none"
                      />
                      <button
                        onClick={handleMax}
                        disabled={phase === "submitting"}
                        className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary disabled:opacity-40"
                      >
                        Max
                      </button>
                    </div>
                    {exceedsBalance && (
                      <p className="mt-1.5 text-[11px] text-red-400">Amount exceeds available balance.</p>
                    )}
                  </div>

                  <div className="mt-4">
                    <p className="text-xs text-muted">Lock duration</p>
                    <div className="mt-1.5 grid grid-cols-2 gap-2">
                      {lockOptions.map((option) => {
                        const selected = option.days === lockDurationDays;
                        return (
                          <button
                            key={option.days}
                            onClick={() => setLockDurationDays(option.days)}
                            disabled={phase === "submitting"}
                            aria-pressed={selected}
                            className={`min-h-[44px] rounded-xl border px-3 py-2 text-left text-xs transition-colors disabled:opacity-40 ${
                              selected
                                ? "border-primary/50 bg-primary/10 text-white"
                                : "border-white/10 bg-white/[0.03] text-muted hover:text-white"
                            }`}
                          >
                            <span className="block font-semibold">{option.label}</span>
                            <span className={selected ? "text-gold" : "text-muted"}>{option.apy}% APY</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-between rounded-xl bg-background/50 px-3 py-2.5">
                    <span className="flex items-center gap-1.5 text-xs text-muted">
                      <Sparkles className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
                      Est. reward at {selectedOption?.label ?? ""}
                    </span>
                    <span className="text-sm font-semibold text-gold">
                      +{formatCompactNumber(estimatedReward)} MPGR
                    </span>
                  </div>

                  {phase === "error" && (
                    <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {error ?? "Unable to stake right now."}
                    </div>
                  )}

                  <button
                    onClick={handleConfirm}
                    disabled={!canSubmit}
                    aria-label="Confirm stake"
                    className="mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-gold py-2.5 text-sm font-semibold text-background transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
                  >
                    {phase === "submitting" ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        Staking...
                      </>
                    ) : (
                      "Confirm Stake"
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
