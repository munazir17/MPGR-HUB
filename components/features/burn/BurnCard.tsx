"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Flame, Fuel, Loader2, AlertCircle } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { BurnImpact } from "@/components/features/burn/BurnImpact";
import { formatCompactNumber } from "@/lib/format";
import type { BurnActionResult, BurnImpactPreview } from "@/lib/burn-types";

interface BurnCardProps {
  availableBalance: number;
  communityBurnGoal: number;
  communityBurnProgress: number;
  previewImpact: (amount: number) => BurnImpactPreview;
  previewRemainingBalance: (amount: number) => number;
  onBurn: (amount: number) => BurnActionResult;
  onSuccess: (amount: number) => void;
  loading?: boolean;
}

const QUICK_PERCENTS = [25, 50, 75, 100] as const;

export function BurnCard({
  availableBalance,
  communityBurnGoal,
  communityBurnProgress,
  previewImpact,
  previewRemainingBalance,
  onBurn,
  onSuccess,
  loading,
}: BurnCardProps) {
  const [amountInput, setAmountInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const amount = parseFloat(amountInput);
  const validAmount = Number.isFinite(amount) && amount > 0;
  const exceedsBalance = validAmount && amount > availableBalance;
  const canSubmit = validAmount && !exceedsBalance && availableBalance > 0 && !submitting && !loading;

  const impact = previewImpact(validAmount ? amount : 0);
  const remainingBalance = previewRemainingBalance(validAmount ? amount : 0);

  const handleQuickPercent = (pct: number) => {
    const value = (availableBalance * pct) / 100;
    setAmountInput(value > 0 ? String(value) : "");
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    setLocalError(null);
    setSubmitting(true);
    // Simulated confirmation delay — mirrors the latency a real Base
    // transaction would introduce. Phase 2B swap point: replace with an
    // awaited writeContract burn call using lib/burn-engine.ts prepareTransaction().
    setTimeout(() => {
      const result = onBurn(amount);
      setSubmitting(false);
      if (result.success) {
        onSuccess(result.amount ?? amount);
        setAmountInput("");
      } else {
        setLocalError(result.error ?? "Unable to burn MPGR right now.");
      }
    }, 500);
  };

  return (
    <div className="space-y-4">
      <GlassCard className="relative overflow-hidden p-5 sm:p-6">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gradient-gold opacity-20 blur-3xl"
        />

        <div className="relative flex items-center gap-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold/10">
            <Flame className="h-4 w-4 text-gold" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Burn MPGR</p>
            <p className="text-[11px] text-muted">Permanently remove tokens from circulation</p>
          </div>
        </div>

        <p className="relative mt-3 text-xs text-muted">
          Wallet Balance:{" "}
          <span className="font-semibold text-white">{formatCompactNumber(availableBalance)} MPGR</span>
        </p>

        <div className="relative mt-4">
          <label htmlFor="burn-amount" className="text-xs text-muted">
            Amount
          </label>
          <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-white/10 bg-background/50 px-3 py-2.5">
            <input
              id="burn-amount"
              type="number"
              inputMode="decimal"
              min={0}
              placeholder="0.00"
              value={amountInput}
              disabled={submitting || loading}
              onChange={(e) => setAmountInput(e.target.value)}
              className="w-full bg-transparent text-lg font-semibold text-white placeholder:text-muted focus:outline-none"
            />
          </div>
          {exceedsBalance && (
            <p className="mt-1.5 text-[11px] text-red-400">Amount exceeds available balance.</p>
          )}
        </div>

        <div className="relative mt-3 grid grid-cols-4 gap-2">
          {QUICK_PERCENTS.map((pct) => (
            <button
              key={pct}
              onClick={() => handleQuickPercent(pct)}
              disabled={submitting || loading || availableBalance <= 0}
              aria-label={pct === 100 ? "Max amount" : `${pct} percent of balance`}
              className="min-h-[40px] rounded-xl border border-white/10 bg-white/[0.03] text-xs font-semibold text-muted transition-colors hover:text-white disabled:opacity-40"
            >
              {pct === 100 ? "MAX" : `${pct}%`}
            </button>
          ))}
        </div>

        <div className="relative mt-4 space-y-2 rounded-xl bg-background/50 p-3.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted">Estimated Remaining Balance</span>
            <span className="font-semibold text-white">{formatCompactNumber(remainingBalance)} MPGR</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted">Estimated Supply After Burn</span>
            <span className="font-semibold text-white">{formatCompactNumber(impact.supplyAfterBurn)} MPGR</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted">Estimated Burn %</span>
            <span className="font-semibold text-gold">{impact.burnPercentageAfter}%</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-muted">
              <Fuel className="h-3.5 w-3.5" aria-hidden="true" />
              Network Fee
            </span>
            <span className="font-semibold text-muted">Calculated at confirmation (Base)</span>
          </div>
        </div>

        <AnimatePresence>
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
        </AnimatePresence>

        <motion.button
          onClick={handleSubmit}
          disabled={!canSubmit}
          whileHover={canSubmit ? { scale: 1.02 } : undefined}
          whileTap={canSubmit ? { scale: 0.97 } : undefined}
          aria-label="Confirm burn"
          className="relative mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-gold text-sm font-semibold text-background transition-transform disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Burning...
            </>
          ) : (
            "Confirm Burn"
          )}
        </motion.button>
      </GlassCard>

      <BurnImpact
        impact={impact}
        communityBurnGoal={communityBurnGoal}
        communityBurnProgressBefore={communityBurnProgress}
        hasAmount={validAmount}
      />
    </div>
  );
}
