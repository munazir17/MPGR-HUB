"use client";

import { CheckCircle2, Vault, Layers, Trophy } from "lucide-react";
import { StatCard } from "@/components/ui/StatCard";

// Redesigned around what's actually derivable from getUserLockIds() +
// getLock() for the connected wallet, with no event-log scan:
// - the deployed contract has no bonus mechanism, so "Lifetime Bonus
//   Earned" is gone;
// - withdrawn locks aren't tagged on-chain as "matured" vs "early-exited"
//   (both just set withdrawn = true), so an Early-Unlocks-only count isn't
//   derivable from getLock() alone -- distinguishing that would require
//   scanning LockWithdrawn vs EarlyUnlocked event history, which is out of
//   scope here. "Withdrawn Locks" reports the combined total instead of
//   fabricating a split.

interface LockSummaryCardsProps {
  totalLocksCount: number;
  withdrawnCount: number;
  activeLocksCount: number;
  longestActiveLockDaysRemaining: number;
  loading?: boolean;
}

export function LockSummaryCards({
  totalLocksCount,
  withdrawnCount,
  activeLocksCount,
  longestActiveLockDaysRemaining,
  loading,
}: LockSummaryCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <StatCard label="Total Locks Created" value={`${totalLocksCount}`} icon={Vault} accent="gold" loading={loading} />
      <StatCard label="Active Locks" value={`${activeLocksCount}`} icon={Layers} loading={loading} />
      <StatCard label="Withdrawn Locks" value={`${withdrawnCount}`} icon={CheckCircle2} loading={loading} />
      <StatCard
        label="Longest Active Lock"
        value={longestActiveLockDaysRemaining > 0 ? `${longestActiveLockDaysRemaining}d left` : "—"}
        icon={Trophy}
        accent="gold"
        loading={loading}
      />
    </div>
  );
}
