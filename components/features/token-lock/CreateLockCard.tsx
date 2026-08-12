"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Vault, Loader2, CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { formatCompactNumber } from "@/lib/format";
import type { LockDurationDays } from "@/hooks/useTokenLock";
import type { TokenLockActionState } from "@/lib/token-lock/token-lock-types";

// Real approve(TokenLockV1, amount) -> createLock(amount, unlockTime) flow,
// driven directly by useTokenLock's action state. No setTimeout confirmation
// delay, no fabricated result object -- transaction state is exactly what
// approveState/createLockState report. Duration is a fixed-preset
// convenience (30/90/180/365 days) that only sets unlockTime client-side;
// the deployed contract has no bonus/APY mechanism, so none is shown here.

interface CreateLockCardProps {
  availableBalance: number;
  lockDurationPresetsDays: readonly LockDurationDays[];
  approveState: TokenLockActionState;
  createLockState: TokenLockActionState;
  onCreateLock: (amount: number, days: LockDurationDays) => void;
  onResetApprove: () => void;
  onResetCreateLock: () => void;
  isWrongNetwork: boolean;
  onSwitchNetwork: () => void;
  loading?: boolean;
}

function busyLabel(phase: TokenLockActionState["phase"]): string | null {
  if (phase === "simulating") return "Confirm in wallet...";
  if (phase === "pending") return "Submitting...";
  if (phase === "confirming") return "Confirming on Base...";
  return null;
}

export function CreateLockCard({
  availableBalance,
  lockDurationPresetsDays,
  approveState,
  createLockState,
  onCreateLock,
  onResetApprove,
  onResetCreateLock,
  isWrongNetwork,
  onSwitchNetwork,
  loading,
}: CreateLockCardProps) {
  const [amountInput, setAmountInput] = useState("");
  const [selectedDays, setSelectedDays] = useState<LockDurationDays>(lockDurationPresetsDays[0] ?? 30);

  const amount = parseFloat(amountInput);
  const validAmount = Number.isFinite(amount) && amount > 0;
  const exceedsBalance = validAmount && amount > availableBalance;

  const unlockDateLabel = new Date(Date.now() + selectedDays * 86_400_000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const isBusy =
    approveState.phase === "simulating" ||
    approveState.phase === "pending" ||
    approveState.phase === "confirming" ||
    createLockState.phase === "simulating" ||
    createLockState.phase === "pending" ||
    createLockState.phase === "confirming";

  const isSuccess = createLockState.phase === "success";
  const isError = approveState.phase === "error" || createLockState.phase === "error";
  const errorMsg = createLockState.error ?? approveState.error;

  const canSubmit = validAmount && !exceedsBalance && availableBalance > 0 && !isBusy && !loading;

  const handleMax = () => setAmountInput(String(availableBalance));

  const handleSubmit = () => {
    if (isWrongNetwork) {
      onSwitchNetwork();
      return;
    }
    if (!canSubmit) return;
    onCreateLock(amount, selectedDays);
  };

  const handleDismissResult = () => {
    setAmountInput("");
    onResetApprove();
    onResetCreateLock();
  };

  const approveBusy = busyLabel(approveState.phase);
  const createBusy = busyLabel(createLockState.phase);
  const currentStepLabel = approveBusy ? `Approve: ${approveBusy}` : createBusy ? `Lock: ${createBusy}` : null;

  return (
    <GlassCard className="relative overflow-hidden p-5">
      <AnimatePresence mode="wait">
        {isSuccess ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center py-8 text-center"
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gold/10">
              <CheckCircle2 className="h-7 w-7 text-gold" aria-hidden="true" />
            </div>
            <p className="mt-4 text-sm font-semibold text-white">Lock Created</p>
            <p className="mt-1 text-xs text-muted">MPGR locked on Base until unlock date.</p>
            {createLockState.hash && (
              <a
                href={`https://basescan.org/tx/${createLockState.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
              >
                View on BaseScan <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            )}
            <button
              onClick={handleDismissResult}
              className="mt-5 min-h-[40px] rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-semibold text-white transition-transform active:scale-95"
            >
              Create Another Lock
            </button>
          </motion.div>
        ) : (
          <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <Vault className="h-4 w-4 text-primary" aria-hidden="true" />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">Lock MPGR</p>
                <p className="text-[11px] text-muted">Choose an amount and a term</p>
              </div>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between text-xs text-muted">
                <span>Amount</span>
                <span>
                  Available: {formatCompactNumber(availableBalance)} MPGR
                  <button onClick={handleMax} className="ml-2 font-semibold text-primary hover:underline">
                    Max
                  </button>
                </span>
              </div>
              <input
                type="number"
                inputMode="decimal"
                placeholder="0.0"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                disabled={isBusy}
                className="mt-1.5 w-full rounded-xl border border-white/10 bg-background/50 px-3.5 py-2.5 text-lg font-semibold text-white placeholder:text-muted/50 focus:border-primary/50 focus:outline-none disabled:opacity-50"
              />
              {exceedsBalance && (
                <p className="mt-1 text-[11px] text-red-400">Amount exceeds your available MPGR balance.</p>
              )}
            </div>

            <div className="mt-4">
              <p className="text-xs text-muted">Lock Term</p>
              <div className="mt-1.5 grid grid-cols-4 gap-2">
                {lockDurationPresetsDays.map((days) => (
                  <button
                    key={days}
                    onClick={() => setSelectedDays(days)}
                    disabled={isBusy}
                    className={`min-h-[40px] rounded-lg border py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      selectedDays === days
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-white/10 bg-white/[0.03] text-muted hover:text-white"
                    }`}
                  >
                    {days}d
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted">Unlocks {unlockDateLabel}</p>
            </div>

            {isError && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {errorMsg ?? "Unable to create this lock right now."}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={isWrongNetwork ? false : !canSubmit}
              aria-label="Create MPGR lock"
              className="mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-gold py-2.5 text-sm font-semibold text-background transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted"
            >
              {isWrongNetwork ? (
                "Switch to Base"
              ) : isBusy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {currentStepLabel ?? "Processing..."}
                </>
              ) : (
                "Create Lock"
              )}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </GlassCard>
  );
}
