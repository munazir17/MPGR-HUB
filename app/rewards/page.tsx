"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Gift, Coins, Trophy, Sparkles, Flag, HelpCircle } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { StatCard } from "@/components/ui/StatCard";
import { RewardClaimCard } from "@/components/ui/RewardClaimCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { CountdownCard } from "@/components/ui/CountdownCard";
import { ActivityTimeline } from "@/components/ui/ActivityTimeline";
import { useRewards } from "@/hooks/useRewards";
import { useXP } from "@/hooks/useXP";
import { getSeasonEnd, getSeasonNumber, getSeasonPoints } from "@/lib/xp-engine";
import { formatCompactNumber } from "@/lib/format";

const SEASON_MILESTONES = [250, 500, 1000];

export default function RewardsPage() {
  const [mounted, setMounted] = useState(false);
  const { isConnected } = useAccount();
  const {
    claims,
    claimableTotal,
    totalClaimed,
    claim,
    claimAll,
    lastClaimEvent,
    dismissClaimEvent,
    loading,
  } = useRewards();
  const { record } = useXP();

  useEffect(() => setMounted(true), []);

  const claimableCount = claims.filter((c) => c.unlocked && !c.claimed).length;

  const seasonPoints = record ? getSeasonPoints(record) : 0;
  const seasonNumber = getSeasonNumber();
  const seasonEnd = getSeasonEnd();
  const seasonProgress = Math.min(100, Math.round((seasonPoints / 1000) * 100));
  const nextSeasonMilestone = SEASON_MILESTONES.find((m) => seasonPoints < m) ?? null;

  return (
    <>
      <Navbar />
      <FloatingXP amount={lastClaimEvent?.amount ?? null} onComplete={dismissClaimEvent} unit="MPGR" />

      <main className="mx-auto max-w-4xl px-4 py-10">
        {!mounted || !isConnected ? (
          <EmptyState
            icon={Gift}
            title="Connect your wallet"
            description="Connect to view and claim your MPGR rewards."
          />
        ) : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <SectionHeader
              title="Reward Claim Center"
              subtitle="Claim MPGR earned from check-ins, streaks, levels, and season milestones"
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <StatCard
                label="Available to Claim"
                value={`${formatCompactNumber(claimableTotal)} MPGR`}
                icon={Gift}
                accent="gold"
                loading={loading}
              />
              <StatCard
                label="Total Claimed"
                value={`${formatCompactNumber(totalClaimed)} MPGR`}
                icon={Coins}
                loading={loading}
              />
            </div>

            <GlassCard className="flex flex-col items-center gap-3 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
              <div>
                <p className="text-sm font-medium text-white">
                  {claimableCount > 0
                    ? `${claimableCount} reward${claimableCount > 1 ? "s" : ""} ready to claim`
                    : "No rewards ready yet"}
                </p>
                <p className="mt-1 text-xs text-muted">
                  Keep checking in and earning XP to unlock more MPGR rewards.
                </p>
              </div>
              <motion.button
                onClick={claimAll}
                disabled={claimableCount === 0}
                whileHover={claimableCount > 0 ? { scale: 1.03 } : undefined}
                whileTap={claimableCount > 0 ? { scale: 0.97 } : undefined}
                aria-label="Claim all available rewards"
                className="flex min-h-[44px] w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-gold px-5 py-2.5 text-sm font-semibold text-background transition-colors disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted sm:w-auto"
              >
                Claim All
              </motion.button>
            </GlassCard>

            <SectionHeader title="All Rewards" />
            {loading ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <SkeletonCard lines={2} />
                <SkeletonCard lines={2} />
                <SkeletonCard lines={2} />
                <SkeletonCard lines={2} />
              </div>
            ) : claims.length === 0 ? (
              <EmptyState
                icon={Trophy}
                title="No rewards yet"
                description="Start earning XP to unlock MPGR rewards."
              />
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {claims.map((reward) => (
                  <RewardClaimCard key={reward.id} reward={reward} onClaim={() => claim(reward.id)} />
                ))}
              </div>
            )}

            <SectionHeader
              title={`Season ${seasonNumber}`}
              subtitle="Earn XP this month to climb the season ranking"
            />

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
                  {nextSeasonMilestone ? `${formatCompactNumber(nextSeasonMilestone)} pts` : "All reached"}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {nextSeasonMilestone
                    ? `${formatCompactNumber(nextSeasonMilestone - seasonPoints)} points to go`
                    : "You've hit every milestone this season"}
                </p>
              </GlassCard>
            </div>

            <GlassCard className="p-5">
              <div className="flex items-center gap-2">
                <Gift className="h-4 w-4 text-primary" aria-hidden="true" />
                <p className="text-sm font-medium text-white">Estimated Season Reward</p>
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

            {record && record.history.length > 0 && (
              <div>
                <SectionHeader title="Recent Activity" />
                <ActivityTimeline entries={record.history} limit={8} />
              </div>
            )}
          </motion.div>
        )}
      </main>
    </>
  );
}
