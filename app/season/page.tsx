"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Sparkles, Trophy, Gift } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { CountdownCard } from "@/components/ui/CountdownCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { useXP } from "@/hooks/useXP";
import { getSeasonEnd, getSeasonNumber, getSeasonPoints } from "@/lib/xp-engine";
import { formatCompactNumber } from "@/lib/format";

export default function SeasonPage() {
  const [mounted, setMounted] = useState(false);
  const { record, isConnected } = useXP();

  useEffect(() => setMounted(true), []);

  const seasonPoints = record ? getSeasonPoints(record) : 0;
  const seasonNumber = getSeasonNumber();
  const seasonEnd = getSeasonEnd();
  const seasonProgress = Math.min(100, Math.round((seasonPoints / 1000) * 100));

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-3xl px-4 py-10">
        {!mounted || !isConnected ? (
          <EmptyState
            icon={Sparkles}
            title="Connect your wallet"
            description="Connect to track your season progress and points."
          />
        ) : !record ? (
          <div className="space-y-4">
            <SkeletonCard lines={2} />
            <SkeletonCard lines={1} />
          </div>
        ) : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <SectionHeader title={`Season ${seasonNumber}`} subtitle="Earn XP this month to climb the season ranking" />

            <div className="grid gap-4 sm:grid-cols-2">
              <GlassCard className="p-5">
                <div className="flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-gold" />
                  <p className="text-xs text-muted">Season Points</p>
                </div>
                <p className="mt-2 text-3xl font-bold text-white">{formatCompactNumber(seasonPoints)}</p>
                <div className="mt-3">
                  <ProgressBar progress={seasonProgress} label="Progress to 1,000 pts" />
                </div>
              </GlassCard>

              <CountdownCard target={seasonEnd} label="Season ends in" />
            </div>

            <GlassCard className="mt-4 p-5">
              <div className="flex items-center gap-2">
                <Gift className="h-4 w-4 text-primary" />
                <p className="text-sm font-medium text-white">Estimated Reward</p>
              </div>
              <p className="mt-2 text-xs text-muted">
                Reward pool and distribution are finalized at season end. This is a placeholder
                until Season {seasonNumber} rewards are announced.
              </p>
              <span className="mt-3 inline-block rounded-full bg-surface px-3 py-1 text-xs text-muted">
                Not yet claimable
              </span>
            </GlassCard>

            <SectionHeader title="Recent Activity" />
            <div className="space-y-2">
              {record.history.length > 0 ? (
                [...record.history]
                  .reverse()
                  .slice(0, 8)
                  .map((entry, i) => (
                    <GlassCard key={i} className="flex items-center justify-between p-3">
                      <span className="text-sm text-white">{entry.action.replace(/_/g, " ")}</span>
                      <span className="text-sm text-gold">+{entry.xp} XP</span>
                    </GlassCard>
                  ))
              ) : (
                <EmptyState
                  icon={Sparkles}
                  title="No activity yet"
                  description="Check in daily or complete quests to start earning season points."
                />
              )}
            </div>
          </motion.div>
        )}
      </main>
    </>
  );
}
