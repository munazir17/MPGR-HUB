"use client";

import { Lock, Layers, Timer, CalendarClock } from "lucide-react";
import { StatCard } from "@/components/ui/StatCard";
import { formatCompactNumber } from "@/lib/format";

interface LockStatsProps {
  totalLocked: number;
  activeLocksCount: number;
  unlockingSoonCount: number;
  averageLockPeriodDays: number;
  loading?: boolean;
}

export function LockStats({
  totalLocked,
  activeLocksCount,
  unlockingSoonCount,
  averageLockPeriodDays,
  loading,
}: LockStatsProps) {
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
        label="Active Locks"
        value={`${activeLocksCount}`}
        icon={Layers}
        loading={loading}
      />
      <StatCard
        label="Unlocking Soon"
        value={`${unlockingSoonCount}`}
        icon={Timer}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Avg. Lock Period"
        value={averageLockPeriodDays > 0 ? `${averageLockPeriodDays}d` : "—"}
        icon={CalendarClock}
        loading={loading}
      />
    </div>
  );
}
