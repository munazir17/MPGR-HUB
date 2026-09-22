"use client";

import { motion } from "framer-motion";
import { PiggyBank, ArrowDownToLine, Coins, LogOut, Loader2, AlertTriangle } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { formatTokenBalance } from "@/lib/format";
import type { StakingActionState } from "@/lib/staking/staking-types";

// Phase 3E Part 3 — redesigned as the primary action hub for the live,
// no-lock MPGRStaking contract: one continuous staked balance, one earned
// amount, four direct actions (Stake, Unstake, Claim, Exit). No lock
// duration selector, no per-position APY — the contract has neither.

interface StakingCardProps {
  walletBalanceRaw: bigint;
  stakedBalanceRaw: bigint;
  earnedRewardsRaw: bigint;
  decimals: number;
  isPoolPaused: boolean;
  isWrongNetwork: boolean;
  loading?: boolean;
  claimState: StakingActionState;
  onOpenStake: () => void;
  onOpenUnstake: () => void;
  onOpenExit: () => void;
  onClaim: () => void;
  onSwitchNetwork: () => void;
}

function actionLabel(phase: StakingActionState["phase"], idleLabel: string): string {
  switch (phase) {
    case "simulating":
      return "Confirm in wallet...";
    case "pending":
      return "Submitting...";
    case "confirming":
      return "Confirming...";
    default:
      return idleLabel;
  }
}

export function StakingCard({
  walletBalanceRaw,
  stakedBalanceRaw,
  earnedRewardsRaw,
  decimals,
  isPoolPaused,
  isWrongNetwork,
  loading,
  claimState,
  onOpenStake,
  onOpenUnstake,
  onOpenExit,
  onClaim,
  onSwitchNetwork,
}: StakingCardProps) {
  const canStake = !loading && !isWrongNetwork && !isPoolPaused && walletBalanceRaw > 0n;
  const hasStaked = stakedBalanceRaw > 0n;
  const hasEarned = earnedRewardsRaw > 0n;
  const canUnstake = !loading && !isWrongNetwork && hasStaked;
  const canClaim = !loading && !isWrongNetwork && hasEarned && claimState.phase === "idle";
  const canExit = !loading && !isWrongNetwork && (hasStaked || hasEarned);
  const claimBusy = claimState.phase === "simulating" || claimState.phase === "pending" || claimState.phase === "confirming";

  return (
    <GlassCard className="relative overflow-hidden p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gradient-premium opacity-20 blur-3xl"
      />

      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold/10">
              <PiggyBank className="h-4 w-4 text-gold" aria-hidden="true" />
            </div>
            <p className="text-sm font-semibold text-white">Your Staking Position</p>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Stake MPGR at any time and claim or unstake whenever you like — there&apos;s no lock period on
            this pool.
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              Staked: <span className="font-semibold text-white">{formatTokenBalance(stakedBalanceRaw, decimals)} MPGR</span>
            </span>
            <span>
              Earned: <span className="font-semibold text-gold">{formatTokenBalance(earnedRewardsRaw, decimals)} MPGR</span>
            </span>
          </div>
        </div>
      </div>

      {isPoolPaused && (
        <div className="relative mt-5 flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          New staking is temporarily paused by the pool owner. Unstaking and claiming still work
          normally.
        </div>
      )}

      {isWrongNetwork ? (
        <button
          onClick={onSwitchNetwork}
          className="btn-gold relative mt-5 w-full text-sm"
        >
          Switch to Base to continue
        </button>
      ) : (
        <div className="relative mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <motion.button
            onClick={onOpenStake}
            disabled={!canStake}
            aria-label="Open stake MPGR dialog"
            className="btn-primary btn-primary-sm w-full"
          >
            <PiggyBank className="h-3.5 w-3.5" aria-hidden="true" />
            Stake
          </motion.button>

          <motion.button
            onClick={onOpenUnstake}
            disabled={!canUnstake}
            aria-label="Open unstake MPGR dialog"
            className="btn-ghost w-full text-xs"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />
            Unstake
          </motion.button>

          <motion.button
            onClick={onClaim}
            disabled={!canClaim}
            aria-label="Claim earned rewards"
            className="btn-gold btn-gold-sm w-full"
          >
            {claimBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Coins className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {claimBusy ? actionLabel(claimState.phase, "Claim") : "Claim"}
          </motion.button>

          <motion.button
            onClick={onOpenExit}
            disabled={!canExit}
            aria-label="Open exit staking dialog"
            className="btn-ghost w-full text-xs"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Exit
          </motion.button>
        </div>
      )}

      {claimState.phase === "error" && claimState.error && (
        <p className="relative mt-3 text-[11px] text-red-400">{claimState.error}</p>
      )}
    </GlassCard>
  );
}
