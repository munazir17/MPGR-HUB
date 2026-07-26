"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Lock, Coins, ArrowUpRight, Layers } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { Skeleton } from "./Skeleton";
import { formatCompactNumber } from "@/lib/format";

interface StakingSummaryCardProps {
  totalStaked: number;
  totalClaimableRewards: number;
  activePositionsCount: number;
  loading?: boolean;
}

export function StakingSummaryCard({
  totalStaked,
  totalClaimableRewards,
  activePositionsCount,
  loading,
}: StakingSummaryCardProps) {
  return (
    <GlassCard className="relative overflow-hidden p-5">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-gradient-premium opacity-20 blur-3xl"
      />

      <div className="relative flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gold/10">
            <Lock className="h-4 w-4 text-gold" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Staking</p>
            <p className="text-[11px] text-muted">Lock MPGR to earn yield</p>
          </div>
        </div>

        <Link
          href="/staking"
          className="flex min-h-[36px] shrink-0 items-center gap-1 rounded-xl bg-gradient-premium px-3 py-1.5 text-xs font-semibold text-white shadow-glow-gold transition-transform active:scale-95"
        >
          Manage
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      <div className="relative mt-5 grid grid-cols-3 gap-3">
        <div>
          <p className="text-[11px] text-muted">Total Staked</p>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-16" />
          ) : (
            <p className="mt-0.5 text-lg font-bold text-white">
              {formatCompactNumber(totalStaked)}
            </p>
          )}
        </div>
        <div>
          <p className="flex items-center gap-1 text-[11px] text-muted">
            <Coins className="h-3 w-3" aria-hidden="true" />
            Claimable
          </p>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-16" />
          ) : (
            <p className="mt-0.5 text-lg font-bold text-gold">
              {formatCompactNumber(totalClaimableRewards)}
            </p>
          )}
        </div>
        <div>
          <p className="flex items-center gap-1 text-[11px] text-muted">
            <Layers className="h-3 w-3" aria-hidden="true" />
            Positions
          </p>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-10" />
          ) : (
            <p className="mt-0.5 text-lg font-bold text-white">{activePositionsCount}</p>
          )}
        </div>
      </div>
    </GlassCard>
  );
}
