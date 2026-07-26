"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Vault, Sparkles, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import type { LockDurationOption, LockPeriodDays, TokenLockActionResult } from "@/lib/token-lock-engine";
import { formatCompactNumber } from "@/lib/format";

interface CreateLockCardProps {
  availableBalance: number;
  lockDurationOptions: LockDurationOption[];
  estimateLockBonus: (amount: number, days: LockPeriodDays) => number;
  onCreateLock: (amount: number, days: LockPeriodDays) => TokenLockActionResult;
  loading?: boolean;
}

export function CreateLockCard({
  availableBalance,
  lockDurationOptions,
  estimateLockBonus,
  onCreateLock,
  loading,
}: CreateLockCardProps) {
  const [amountInput, setAmountInput] = useState("");
  const [selectedDays, setSelectedDays] = useState<LockPeriodDays>(
    lockDurationOptions[0]?.days ?? 30
  );
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<{ amount: number; days: LockPeriodDays } | null>(
    null
  );

  const amount = parseFloat(amountInput);
  const validAmount = Number.isFinite(amount) && amount > 0;
  const exceedsBalance = validAmount && amount > availableBalance;
  const selectedOption =
    lockDurationOptions.find((o) => o.days === selectedDays) ?? lockDurationOptions[0];
  const estimatedBonus = validAmount ? estimateLockBonus(amount, selectedDays) : 0;
  const unlockDateLabel = new Date(Date.now() + selectedDays * 86_400_000).toLocaleDateString(
    "en-US",
    { month: "short", day: "numeric", year: "numeric" }
  );

  const canSubmit = validAmount && !exceedsBalance && availableBalance > 0 && !submitting && !loading;

  const handleMax = () => setAmountInput(String(availableBalance));

  const handleSubmit = () => {
    if (!canSubmit) return;
    setLocalError(null);
    setSubmitting(true);
    // Simulated confirmation delay — mirrors the latency a real Base
    // transaction would introduce. Phase 2B swap point: replace with an
    // awaited lock contract call.
    setTimeout(() => {
      const result = onCreateLock(amount, selectedDays);
      setSubmitting(false);
      if (result.success) {
        setJustCreated({ amount, days: selectedDays });
        setAmountInput("");
        setTimeout(() => setJustCreated(null), 2200);
      } else {
        setLocalError(result.error ?? "Unable to create lock right now.");
      }
    }, 450);
  };

  return (
    <GlassCard className="relative overflow-hidden p-5 sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gradient-premium opacity-20 blur-3xl"
      />

      <div className="relative flex items-center gap-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold/10">
          <Vault className="h-4 w-4 text-gold" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-semibold text-white">Create Lock</p>
          <p className="text-[11px] text-muted">Lock MPGR for a fixed term to earn a maturity bonus</p>
        </div>
      </div>

      <p className="relative mt-3 text-xs text-muted">
        Available:{" "}
        <span className="font-semibold text-white">{formatCompactNumber(availableBalance)} MPGR</span>
      </p>

      <div className="relative mt-4">
        <label htmlFor="lock-amount" className="text-xs text-muted">
          Amount
        </label>
        <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-white/10 bg-background/50 px-3 py-2.5">
          <input
            id="lock-amount"
            type="number"
            inputMode="decimal"
            min={0}
            placeholder="0.00"
            value={amountInput}
            disabled={submitting || loading}
            onChange={(e) => setAmountInput(e.target.value)}
            className="w-full bg-transparent text-lg font-semibold text-white placeholder:text-muted focus:outline-none"
          />
          <button
            onClick={handleMax}
            disabled={submitting || loading}
            className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary disabled:opacity-40"
          >
            Max
          </button>
        </div>
        {exceedsBalance && (
          <p className="mt-1.5 text-[11px] text-red-400">Amount exceeds available balance.</p>
        )}
      </div>

      <div className="relative mt-4">
        <p className="text-xs text-muted">Lock duration</p>
        <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {lockDurationOptions.map((option) => {
            const selected = option.days === selectedDays;
            return (
              <button
                key={option.days}
                onClick={() => setSelectedDays(option.days)}
                disabled={submitting || loading}
                aria-pressed={selected}
                className={`min-h-[44px] rounded-xl border px-3 py-2 text-left text-xs transition-colors disabled:opacity-40 ${
                  selected
                    ? "border-primary/50 bg-primary/10 text-white"
                    : "border-white/10 bg-white/[0.03] text-muted hover:text-white"
                }`}
              >
                <span className="block font-semibold">{option.label}</span>
                <span className={selected ? "text-gold" : "text-muted"}>+{option.bonusPercent}% bonus</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="relative mt-4 space-y-2 rounded-xl bg-background/50 p-3.5">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-muted">
            <Sparkles className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
            Lock Bonus
          </span>
          <span className="font-semibold text-gold">{selectedOption?.bonusPercent ?? 0}%</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">Estimated Rewards</span>
          <span className="font-semibold text-white">+{formatCompactNumber(estimatedBonus)} MPGR</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">Unlock Date</span>
          <span className="font-semibold text-white">{unlockDateLabel}</span>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {localError && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="relative mt-3 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400"
          >
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {localError}
          </motion.div>
        )}
        {justCreated && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="relative mt-3 flex items-center gap-2 rounded-xl border border-gold/20 bg-gold/10 px-3 py-2 text-xs text-gold"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            {formatCompactNumber(justCreated.amount)} MPGR locked for {justCreated.days} days
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        onClick={handleSubmit}
        disabled={!canSubmit}
        whileHover={canSubmit ? { scale: 1.02 } : undefined}
        whileTap={canSubmit ? { scale: 0.97 } : undefined}
        aria-label="Confirm create lock"
        className="relative mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-gold text-sm font-semibold text-background transition-transform disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Locking...
          </>
        ) : (
          "Create Lock"
        )}
      </motion.button>
    </GlassCard>
  );
}
