"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Gift, Trophy, HelpCircle, Loader2, AlertCircle, X } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { RewardClaimCard } from "@/components/ui/RewardClaimCard";
import { OnChainRewardsSection } from "@/components/ui/OnChainRewardsSection";
import { WeeklyRewardCard } from "@/components/ui/WeeklyRewardCard";
import { RewardHubSummaryCards } from "@/components/ui/RewardHubSummaryCards";
import { RewardCategoryGrid } from "@/components/ui/RewardCategoryGrid";
import { RewardClaimHistoryList } from "@/components/ui/RewardClaimHistoryList";
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
import { useRewardHub } from "@/hooks/useRewardHub";
import { useXP } from "@/hooks/useXP";
import { usePremium } from "@/hooks/usePremium";
import { useSeasonPass } from "@/hooks/useSeasonPass";
import { getSeasonEnd, getSeasonNumber, getSeasonPoints } from "@/lib/xp-engine";
import { formatCompactNumber } from "@/lib/format";

// Phase 3F Part 2 — Reward Hub Integration.
//
// This page now has two data sources, deliberately kept separate:
//
// 1. useRewards() — UNCHANGED from before Phase 3F. Still the one and
//    only place that calls lib/rewards-engine.ts's claimReward()/
//    claimAllRewards(). Still drives the individual per-reward
//    RewardClaimCard grid, the "Claim All" button, and the weekly local-
//    claims chart — exactly as it did before this phase. Nothing about
//    how a local reward gets claimed changed.
//
// 2. useRewardHub() — new in Phase 3F. A read-only aggregation across
//    every reward category (local + on-chain staking), via
//    lib/rewards/reward-service.ts. It never claims anything itself on
//    this page; claimLocalReward/claimAllLocalRewards exist on the hook
//    for future use but are intentionally not wired to any button here,
//    so there is exactly one claim entry point on this page (#1 above).
//
// Because #1's claim path doesn't go through reward-service.ts's cache,
// a claim made via the RewardClaimCard grid or "Claim All" button won't
// automatically invalidate useRewardHub()'s cached summary/history. The
// effect below closes that gap: whenever useRewards() reports a
// completed claim (lastClaimEvent), it forces useRewardHub() to refresh
// — without touching hooks/useRewards.ts or lib/rewards-engine.ts at all.
//
// Staking rewards remain fully read-only here (see
// lib/rewards/providers/staking-rewards-provider.ts). Claiming a staking
// reward still only ever happens on /staking via hooks/useStaking.ts's
// claimRewards() — this page's category grid links there instead of
// duplicating that transaction.
//
// Reward Vault Integration — added a third, fully isolated data source:
// <OnChainRewardsSection /> (hooks/useRewardClaim.ts), which reads and
// claims real rewards from the deployed MPGRRewardVault contract on Base
// Mainnet. It shares no state, cache, or claim path with #1 or #2 above
// — it's a self-contained section with its own loading/error/empty/
// wrong-network states, so it carries zero risk to the existing local
// claim grid or the read-only aggregator.

const SEASON_MILESTONES = [250, 500, 1000];

export default function RewardsPage() {
  const [mounted, setMounted] = useState(false);
  const { isConnected } = useAccount();
  const {
    claims,
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

  const {
    summary: rewardHubSummary,
    history: rewardHubHistory,
    loading: rewardHubLoading,
    isLoadingMore: rewardHubLoadingMore,
    error: rewardHubError,
    hasMoreHistory: rewardHubHasMore,
    refresh: refreshRewardHub,
    loadMoreHistory: loadMoreRewardHubHistory,
  } = useRewardHub();

  const [dismissedRewardHubError, setDismissedRewardHubError] = useState(false);

  useEffect(() => setMounted(true), []);

  // Keeps the new Reward Hub aggregation in sync with claims made through
  // the existing, unchanged useRewards() claim path (see file header).
  useEffect(() => {
    if (lastClaimEvent) {
      void refreshRewardHub();
    }
  }, [lastClaimEvent, refreshRewardHub]);

  useEffect(() => setDismissedRewardHubError(false), [rewardHubError]);

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
              title="Reward Hub"
              subtitle="Everything you've earned across staking, check-ins, referrals, and seasons"
            />

            {rewardHubError && !dismissedRewardHubError && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}>
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 p-3.5 backdrop-blur-xl">
                  <span className="flex items-center gap-2 text-xs text-red-400">
                    <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {rewardHubError}
                  </span>
                  <button
                    onClick={() => setDismissedRewardHubError(true)}
                    aria-label="Dismiss error"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-red-400 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </motion.div>
            )}

            <RewardHubSummaryCards summary={rewardHubSummary} loading={rewardHubLoading} />

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

            <div>
              <SectionHeader title="Reward Categories" subtitle="Earned across every active reward system" />
              <RewardCategoryGrid categories={rewardHubSummary?.categories ?? null} loading={rewardHubLoading} />
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

            <SectionHeader title="All Rewards" subtitle="Individual check-in, streak, level, referral, and season rewards" />
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

            <OnChainRewardsSection />

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
              <SectionHeader title="Claim History" subtitle="Every claim across every active category" />
              <RewardClaimHistoryList
                entries={rewardHubHistory}
                isLoading={rewardHubLoading}
                isLoadingMore={rewardHubLoadingMore}
                error={rewardHubError}
                hasMore={rewardHubHasMore}
                onLoadMore={loadMoreRewardHubHistory}
                onRetry={refreshRewardHub}
              />
            </div>

            <GlassCard className="p-5">
              <div className="flex items-center gap-2">
                <HelpCircle className="h-4 w-4 text-primary" aria-hidden="true" />
                <p className="text-sm font-medium text-white">How Rewards Work</p>
              </div>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted">
                <li>• Rewards unlock from daily check-ins, streaks, levels, referrals, and season milestones</li>
                <li>• Staking rewards accrue continuously — claim them from the Staking page</li>
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
