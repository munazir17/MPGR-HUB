"use client";

import { motion } from "framer-motion";
import { Flame } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { BurnSummaryCards } from "@/components/features/burn/BurnSummaryCards";
import { BurnStatsCards } from "@/components/features/burn/BurnStatsCards";
import type { BurnDashboardStats, BurnMilestone } from "@/lib/burn-types";

interface BurnDashboardProps {
  stats: BurnDashboardStats;
  milestones: BurnMilestone[];
  loading?: boolean;
}

export function BurnDashboard({ stats, milestones, loading }: BurnDashboardProps) {
  const nextMilestone = milestones.find((m) => !m.achieved) ?? null;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.03] p-5 backdrop-blur-xl shadow-glow sm:p-7">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-16 -top-20 h-64 w-64 rounded-full bg-gradient-gold opacity-20 blur-3xl animate-glow-pulse"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-24 -right-16 h-56 w-56 rounded-full bg-gradient-premium opacity-10 blur-3xl"
        />

        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-gold shadow-glow-gold">
            <Flame className="h-5 w-5 text-background" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">Burn Portal</h1>
            <p className="text-sm text-muted">
              Permanently remove MPGR from circulation and track your impact on supply.
            </p>
          </div>
        </div>

        <div className="relative mt-6">
          <BurnSummaryCards
            totalBurned={stats.totalBurned}
            communityBurnProgress={stats.communityBurnProgress}
            nextMilestoneLabel={nextMilestone?.label ?? null}
            loading={loading}
          />
        </div>
      </div>

      <div>
        <SectionHeader title="Burn Statistics" subtitle="Full breakdown of burn activity and supply impact" />
        <BurnStatsCards stats={stats} loading={loading} />
      </div>
    </motion.div>
  );
}
