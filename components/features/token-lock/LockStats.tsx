"use client";

import { Lock, Layers, Timer, CalendarClock } from "lucide-react";
import { StatCard } from "@/components/ui/StatCard";
import { formatCompactNumber } from "@/lib/format";

// All four figures are derived directly from on-chain getLock() reads
// (amount, unlockTime, withdrawn) for the connected wallet's lock ids --
// no bonus/APY field exists on the deployed contract to show here.
// "Avg. Days Left" replaces the old mock's "Avg. Lock Period" (which
// depended on a per-lock creation timestamp the contract does not store).

interface LockStatsProps {
  totalLocked: number;
  activeLocksCount: number;
  unlockingSoonCount: number;
  averageLockDaysRemaining: number;
  loading?: boolean;
}

export function LockStats({
  totalLocked,
  activeLocksCount,
  unlockingSoonCount,
  averageLockDaysRemaining,
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
      <StatCard label="Active Locks" value={`${activeLocksCount}`} icon={Layers} loading={loading} />
      <StatCard
        label="Unlocking Soon"
        value={`${unlockingSoonCount}`}
        icon={Timer}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Avg. Days Left"
        value={averageLockDaysRemaining > 0 ? `${averageLockDaysRemaining}d` : "—"}
        icon={CalendarClock}
        loading={loading}
      />
    </div>
  );
}
