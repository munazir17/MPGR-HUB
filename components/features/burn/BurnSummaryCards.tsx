"use client";

import { Flame, PieChart, Trophy } from "lucide-react";
import { StatCard } from "@/components/ui/StatCard";
import { formatCompactNumber } from "@/lib/format";

interface BurnSummaryCardsProps {
  totalBurned: number;
  communityBurnProgress: number; // 0-100
  nextMilestoneLabel: string | null;
  loading?: boolean;
}

// Distinct from BurnStatsCards on purpose: a compact "quick read" strip for
// the hero, not a repeat of the detailed stats grid below it — same
// separation of concerns as LockStats vs. LockSummaryCards in Token Lock.
export function BurnSummaryCards({
  totalBurned,
  communityBurnProgress,
  nextMilestoneLabel,
  loading,
}: BurnSummaryCardsProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard
        label="Your Total Burned"
        value={`${formatCompactNumber(totalBurned)} MPGR`}
        icon={Flame}
        accent="gold"
        loading={loading}
      />
      <StatCard
        label="Goal Contribution"
        value={`${communityBurnProgress}%`}
        icon={PieChart}
        loading={loading}
      />
      <StatCard
        label="Next Milestone"
        value={nextMilestoneLabel ?? "All Reached"}
        icon={Trophy}
        accent="gold"
        loading={loading}
      />
    </div>
  );
}
