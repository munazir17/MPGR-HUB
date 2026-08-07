"use client";

import Link from "next/link";
import { Lock, Coins, ArrowUpRight, Percent } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { Skeleton } from "./Skeleton";
import { formatTokenBalance } from "@/lib/format";

interface StakingSummaryCardProps {
  stakedBalanceRaw: bigint;
  earnedRewardsRaw: bigint;
  currentAPRPercent: number | null;
  decimals: number;
  loading?: boolean;
}

export function StakingSummaryCard({
  stakedBalanceRaw,
  earnedRewardsRaw,
  currentAPRPercent,
  decimals,
  loading,
}: StakingSummaryCardProps) {
  return (
    <GlassCard className="relative overflow-hidden p-5 sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-14 -top-14 h-48 w-48 rounded-full bg-gradient-premium opacity-20 blur-3xl animate-glow-pulse"
      />

      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-gold-glow/25 to-gold/10 ring-1 ring-gold/25 shadow-glow-gold">
            <Lock className="h-4.5 w-4.5 text-gold" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Staking</p>
            <p className="text-[11px] text-muted">Stake MPGR to earn yield — no lock</p>
          </div>
        </div>

        <Link
          href="/staking"
          className="flex min-h-[36px] shrink-0 items-center gap-1 rounded-xl bg-gradient-premium px-3.5 py-1.5 text-xs font-semibold text-white shadow-glow-gold transition-transform duration-200 hover:scale-[1.03] active:scale-95"
        >
          Manage
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      <div className="relative mt-6 grid grid-cols-3 divide-x divide-white/[0.06]">
        <div className="pr-3">
          <p className="text-[11px] text-muted">Your Staked</p>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-16" />
          ) : (
            <p className="mt-1 text-lg font-bold tracking-tight text-white sm:text-xl">
              {formatTokenBalance(stakedBalanceRaw, decimals)}
            </p>
          )}
        </div>
        <div className="px-3">
          <p className="flex items-center gap-1 text-[11px] text-muted">
            <Coins className="h-3 w-3" aria-hidden="true" />
            Earned
          </p>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-16" />
          ) : (
            <p className="mt-1 text-lg font-bold tracking-tight text-gradient-gold sm:text-xl">
              {formatTokenBalance(earnedRewardsRaw, decimals)}
            </p>
          )}
        </div>
        <div className="pl-3">
          <p className="flex items-center gap-1 text-[11px] text-muted">
            <Percent className="h-3 w-3" aria-hidden="true" />
            APR
          </p>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-14" />
          ) : (
            <p className="mt-1 text-lg font-bold tracking-tight text-white sm:text-xl">
              {currentAPRPercent === null ? "—" : `${currentAPRPercent}%`}
            </p>
          )}
        </div>
      </div>
    </GlassCard>
  );
}
