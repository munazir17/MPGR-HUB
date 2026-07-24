"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Sparkles, Trophy, Gift, Flag, HelpCircle } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { CountdownCard } from "@/components/ui/CountdownCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { ActivityTimeline } from "@/components/ui/ActivityTimeline";
import { useXP } from "@/hooks/useXP";
import { getSeasonEnd, getSeasonNumber, getSeasonPoints } from "@/lib/xp-engine";
import { formatCompactNumber } from "@/lib/format";

const MILESTONES = [250, 500, 1000];

export default function SeasonPage() {
  const [mounted, setMounted] = useState(false);
  const { record, isConnected } = useXP();

  useEffect(() => setMounted(true), []);

  const seasonPoints = record ? getSeasonPoints(record) : 0;
  const seasonNumber = getSeasonNumber();
  const seasonEnd = getSeasonEnd();
  const seasonProgress = Math.min(100, Math.round((seasonPoints / 1000) * 100));
  const nextMilestone = MILESTONES.find((m) => seasonPoints < m) ?? null;

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
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <SectionHeader title={`Season ${seasonNumber}`} subtitle="Earn XP this month to climb the season ranking" />

            <div className="grid gap-4 sm:grid-cols-2">
              <GlassCard className="p-5">
                <div className="flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-gold" aria-hidden="true" />
                  <p className="text-xs text-muted">Season Points</p>
                </div>
                <p className="mt-2 text-3xl font-bold text-white">{formatCompactNumber(seasonPoints)}</p>
                <div className="mt-3">
                  <ProgressBar progress={seasonProgress} label="Progress to 1,000 pts" />
                </div>
              </GlassCard>

              <CountdownCard target={seasonEnd} label="Season ends in" />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <GlassCard className="p-5">
                <div className="flex items-center gap-2">
                  <Flag className="h-4 w-4 text-primary" aria-hidden="true" />
                  <p className="text-sm font-medium text-white">Current Rank</p>
                </div>
                <p className="mt-2 text-2xl font-bold text-white">Unranked</p>
                <p className="mt-1 text-xs text-muted">
                  Global ranking launches once the MPGR HUB leaderboard backend is live.
                </p>
              </GlassCard>

              <GlassCard className="p-5">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-gold" aria-hidden="true" />
                  <p className="text-sm font-medium text-white">Next Milestone</p>
                </div>
                <p className="mt-2 text-2xl font-bold text-white">
                  {nextMilestone ? `${formatCompactNumber(nextMilestone)} pts` : "All reached"}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {nextMilestone
                    ? `${formatCompactNumber(nextMilestone - seasonPoints)} points to go`
                    : "You've hit every milestone this season"}
                </p>
              </GlassCard>
            </div>

            <GlassCard className="p-5">
              <div className="flex items-center gap-2">
                <Gift className="h-4 w-4 text-primary" aria-hidden="true" />
                <p className="text-sm font-medium text-white">Estimated Reward</p>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                Reward pool and distribution are finalized at season end. This is a placeholder
                until Season {seasonNumber} rewards are announced.
              </p>
              <span className="mt-3 inline-block rounded-full bg-surface px-3 py-1 text-xs text-muted">
                Not yet claimable
              </span>
            </GlassCard>

            <GlassCard className="p-5">
              <div className="flex items-center gap-2">
                <HelpCircle className="h-4 w-4 text-primary" aria-hidden="true" />
                <p className="text-sm font-medium text-white">How Seasons Work</p>
              </div>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted">
                <li>• Season points reset every calendar month</li>
                <li>• Every XP-earning action counts toward your season total</li>
                <li>• Milestones unlock as your season points grow</li>
                <li>• Rewards are calculated and distributed after the season ends</li>
              </ul>
            </GlassCard>

            <div>
              <SectionHeader title="Recent Activity" />
              {record.history.length > 0 ? (
                <ActivityTimeline entries={record.history} limit={8} />
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
}      </main>
    </>
  );
}
