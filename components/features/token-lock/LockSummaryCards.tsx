"use client";

import { Lock, Clock, Trophy, CalendarClock } from "lucide-react";
import { StatCard } from "@/components/ui/StatCard";
import { formatCompactNumber } from "@/lib/format";

interface LockSummaryCardsProps {
  totalLocked: number;
  averageLockPeriodDays: number;
  longestLockDays: number;
  upcomingUnlockAt: string | null;
  loading?: boolean;
}

export function LockSummaryCards({
  totalLocked,
  averageLockPeriodDays,
  longestLockDays,
  upcomingUnlockAt,
  loading,
}: LockSummaryCardsProps) {
  const upcomingLabel = upcomingUnlockAt
    ? new Date(upcomingUnlockAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "—";

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <StatCard
        label="Total Locked"
        value={`${formatCompactNumber(totalLocked)} MPGR`}
        icon={Lock}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Avg. Lock Time"
        value={averageLockPeriodDays > 0 ? `${averageLockPeriodDays}d` : "—"}
        icon={Clock}
        loading={loading}
      />
      <StatCard
        label="Longest Lock"
        value={longestLockDays > 0 ? `${longestLockDays}d` : "—"}
        icon={Trophy}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Upcoming Unlock"
        value={upcomingLabel}
        icon={CalendarClock}
        loading={loading}
      />
    </div>
  );
}
