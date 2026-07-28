"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Gift, Coins, Trophy, Sparkles, Flag, HelpCircle, History, ListChecks, Loader2 } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { StatCard } from "@/components/ui/StatCard";
import { RewardClaimCard } from "@/components/ui/RewardClaimCard";
import { WeeklyRewardCard } from "@/components/ui/WeeklyRewardCard";
import { RewardTimeline } from "@/components/ui/RewardTimeline";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { CountdownCard } from "@/components/ui/CountdownCard";
import { ActivityTimeline } from "@/components/ui/ActivityTimeline";
import { PremiumBadge } from "@/components/ui/PremiumBadge";
import { SeasonRewardsPreview } from "@/components/features/season-pass/SeasonRewardsPreview";
import { useRewards } from "@/hooks/useRewards";
import { useXP } from "@/hooks/useXP";
import { usePremium } from "@/hooks/usePremium";
import { useSeasonPass } from "@/hooks/useSeasonPass";
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
    claimHistory,
    claim,
    claimAll,
    lastClaimEvent,
    dismissClaimEvent,
    loading,
    claimingId,
    claimingAll,
    weeklySeries,
    weeklyClaimed,
    previousWeekClaimed,
  } = useRewards();
  const { record } = useXP();
  const { status: premiumStatus } = usePremium();
  const { status: seasonPassStatus, track: seasonTrack } = useSeasonPass();

  useEffect(() => setMounted(true), []);

  const claimableCount = useMemo(
    () => claims.filter((c) => c.unlocked && !c.claimed).length,
    [claims]
  );

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

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
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
              <StatCard
                label="Rewards Ready"
                value={loading ? "0 of 0" : `${claimableCount} of ${claims.length}`}
                icon={ListChecks}
                loading={loading}
              />
            </div>

            {premiumStatus?.isPremium && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gold/20 bg-gold/[0.05] px-4 py-3">
                <PremiumBadge tier={premiumStatus.tier} size="sm" />
                <p className="text-xs text-muted">
                  Your {premiumStatus.currentTierDef?.label} tier unlocks a{" "}
                  <span className="font-semibold text-gold">{premiumStatus.xpMultiplier}× XP</span> and{" "}
                  <span className="font-semibold text-gold">{premiumStatus.rewardsMultiplier}× rewards</span>{" "}
                  multiplier — applied automatically once multiplier payouts go live.
                </p>
              </div>
            )}

            {seasonPassStatus && (
              <SeasonRewardsPreview track={seasonTrack} currentLevel={seasonPassStatus.levelProgress.level} />
            )}

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
                disabled={claimableCount === 0 || claimingAll || claimingId !== null}
                whileHover={claimableCount > 0 && !claimingAll ? { scale: 1.03 } : undefined}
                whileTap={claimableCount > 0 && !claimingAll ? { scale: 0.97 } : undefined}
                aria-label="Claim all available rewards"
                className="flex min-h-[44px] w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-gold px-5 py-2.5 text-sm font-semibold text-background transition-colors disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted sm:w-auto"
              >
                {claimingAll ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Claiming All
                  </>
                ) : (
                  "Claim All"
                )}
              </motion.button>
            </GlassCard>

            <div>
              <SectionHeader title="This Week" subtitle="Your weekly MPGR claim activity" />
              <WeeklyRewardCard
                series={weeklySeries}
                total={weeklyClaimed}
                previousTotal={previousWeekClaimed}
                loading={loading}
              />
            </div>

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
                  <RewardClaimCard
                    key={reward.id}
                    reward={reward}
                    onClaim={() => claim(reward.id)}
                    claiming={claimingId === reward.id}
                  />
                ))}
              </div>
            )}

            <div>
              <SectionHeader title="Season Progress" subtitle={`Season ${seasonNumber} milestones`} />
              <div className="grid gap-4 sm:grid-cols-2">
                <GlassCard className="p-5">
                  <div className="flex items-center gap-2">
                    <Trophy className="h-4 w-4 text-gold" aria-hidden="true" />
                    <p className="text-xs text-muted">Season Points</p>
                  </div>
                  <p className="mt-2 text-2xl font-bold text-white">{formatCompactNumber(seasonPoints)}</p>
                  <div className="mt-3">
                    <ProgressBar progress={seasonProgress} label="Progress to 1,000 pts" />
                  </div>
                  {nextSeasonMilestone && (
                    <p className="mt-2 text-[11px] text-muted">
                      {formatCompactNumber(nextSeasonMilestone - seasonPoints)} points to next milestone
                    </p>
                  )}
                </GlassCard>
                <CountdownCard target={seasonEnd} label="Season ends in" />
              </div>
            </div>

            <div>
              <SectionHeader title="Claim History" />
              {claimHistory.length > 0 ? (
                <RewardTimeline entries={claimHistory} limit={10} />
              ) : (
                <EmptyState
                  icon={History}
                  title="No claims yet"
                  description="Your reward claim history will appear here."
                />
              )}
            </div>

            <GlassCard className="p-5">
              <div className="flex items-center gap-2">
                <HelpCircle className="h-4 w-4 text-primary" aria-hidden="true" />
                <p className="text-sm font-medium text-white">How Rewards Work</p>
              </div>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted">
                <li>• Rewards unlock from daily check-ins, streaks, levels, referrals, and season milestones</li>
                <li>• Claim individually or all at once once unlocked</li>
                <li>• Season points and milestones reset every calendar month</li>
              </ul>
            </GlassCard>

            {record && record.history.length > 0 && (
              <div>
                <SectionHeader title="Recent XP Activity" />
                <ActivityTimeline entries={record.history} limit={8} />
              </div>
            )}
          </motion.div>
        )}
      </main>
    </>
  );
}
