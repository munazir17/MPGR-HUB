"use client";

import { Sparkles, CheckCircle2, Zap, Trophy } from "lucide-react";
import { StatCard } from "@/components/ui/StatCard";
import { formatCompactNumber } from "@/lib/format";

interface LockSummaryCardsProps {
  lifetimeBonusEarned: number;
  locksReleasedCount: number;
  earlyUnlocksCount: number;
  longestLockDays: number;
  loading?: boolean;
}

export function LockSummaryCards({
  lifetimeBonusEarned,
  locksReleasedCount,
  earlyUnlocksCount,
  longestLockDays,
  loading,
}: LockSummaryCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <StatCard
        label="Lifetime Bonus Earned"
        value={`${formatCompactNumber(lifetimeBonusEarned)} MPGR`}
        icon={Sparkles}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Locks Released"
        value={`${locksReleasedCount}`}
        icon={CheckCircle2}
        loading={loading}
      />
      <StatCard
        label="Early Unlocks"
        value={`${earlyUnlocksCount}`}
        icon={Zap}
        loading={loading}
      />
      <StatCard
        label="Longest Lock"
        value={longestLockDays > 0 ? `${longestLockDays}d` : "—"}
        icon={Trophy}
        accent="gold"
        loading={loading}
      />
    </div>
  );
}
