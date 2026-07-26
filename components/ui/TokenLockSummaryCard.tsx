"use client";

import Link from "next/link";
import { Vault, CalendarClock, Layers, ArrowUpRight } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { Skeleton } from "./Skeleton";
import { formatCompactNumber } from "@/lib/format";

interface TokenLockSummaryCardProps {
  totalLocked: number;
  activeLocksCount: number;
  upcomingUnlockAt: string | null;
  loading?: boolean;
}

export function TokenLockSummaryCard({
  totalLocked,
  activeLocksCount,
  upcomingUnlockAt,
  loading,
}: TokenLockSummaryCardProps) {
  const upcomingLabel = upcomingUnlockAt
    ? new Date(upcomingUnlockAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "—";

  return (
    <GlassCard className="relative overflow-hidden p-5 sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-14 -top-14 h-48 w-48 rounded-full bg-gradient-gold opacity-10 blur-3xl animate-glow-pulse"
      />

      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-primary-glow/25 to-primary/10 ring-1 ring-primary/25 shadow-glow">
            <Vault className="h-4.5 w-4.5 text-primary" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Token Lock</p>
            <p className="text-[11px] text-muted">Lock MPGR for a maturity bonus</p>
          </div>
        </div>

        <Link
          href="/app/token-lock"
          className="flex min-h-[36px] shrink-0 items-center gap-1 rounded-xl bg-gradient-premium px-3.5 py-1.5 text-xs font-semibold text-white shadow-glow-gold transition-transform duration-200 hover:scale-[1.03] active:scale-95"
        >
          Manage
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      <div className="relative mt-6 grid grid-cols-3 divide-x divide-white/[0.06]">
        <div className="pr-3">
          <p className="text-[11px] text-muted">Total Locked</p>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-16" />
          ) : (
            <p className="mt-1 text-lg font-bold tracking-tight text-white sm:text-xl">
              {formatCompactNumber(totalLocked)}
            </p>
          )}
        </div>
        <div className="px-3">
          <p className="flex items-center gap-1 text-[11px] text-muted">
            <Layers className="h-3 w-3" aria-hidden="true" />
            Active Locks
          </p>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-10" />
          ) : (
            <p className="mt-1 text-lg font-bold tracking-tight text-white sm:text-xl">{activeLocksCount}</p>
          )}
        </div>
        <div className="pl-3">
          <p className="flex items-center gap-1 text-[11px] text-muted">
            <CalendarClock className="h-3 w-3" aria-hidden="true" />
            Next Unlock
          </p>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-16" />
          ) : (
            <p className="mt-1 text-lg font-bold tracking-tight text-gradient-gold sm:text-xl">
              {upcomingLabel}
            </p>
          )}
        </div>
      </div>
    </GlassCard>
  );
}
