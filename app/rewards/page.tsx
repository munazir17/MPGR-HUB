"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Gift, Trophy, HelpCircle, AlertCircle, X } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { OnChainRewardsSection } from "@/components/ui/OnChainRewardsSection";
import { RewardHubSummaryCards } from "@/components/ui/RewardHubSummaryCards";
import { RewardCategoryGrid } from "@/components/ui/RewardCategoryGrid";
import { RewardClaimHistoryList } from "@/components/ui/RewardClaimHistoryList";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { CountdownCard } from "@/components/ui/CountdownCard";
import { ActivityTimeline } from "@/components/ui/ActivityTimeline";
import { PremiumBadge } from "@/components/ui/PremiumBadge";
import { SeasonRewardsPreview } from "@/components/features/season-pass/SeasonRewardsPreview";
import { useRewardHub } from "@/hooks/useRewardHub";
import { useXP } from "@/hooks/useXP";
import { usePremium } from "@/hooks/usePremium";
import { useSeasonPass } from "@/hooks/useSeasonPass";
import { getSeasonEnd, getSeasonNumber, getSeasonPoints } from "@/lib/xp-engine";
import { formatCompactNumber } from "@/lib/format";

// Reward Vault Integration — Rewards page.
//
// This page has two data sources:
//
// 1. useRewardHub() — read-only aggregation across every reward category
//    (currently just "staking", real and read-only via
//    lib/rewards/providers/staking-rewards-provider.ts). Powers the
//    summary cards, the category grid, and the claim history list.
//    Claiming a staking reward still only ever happens on /staking via
//    hooks/useStaking.ts's claimRewards() — this page's category grid
//    links there instead of duplicating that transaction.
//
// 2. <OnChainRewardsSection /> (hooks/useRewardClaim.ts) — a fully
//    isolated section that reads and claims real MPGR rewards from the
//    deployed MPGRRewardVault contract on Base Mainnet. It shares no
//    state, cache, or claim path with #1, so it carries zero risk to the
//    read-only aggregator.
//
// Reward Vault cleanup — this page used to have a third data source:
// hooks/useRewards.ts, a local/mock claim system (check-in streaks,
// level milestones, referral and season milestones, all with hardcoded
// MPGR amounts, claimed via lib/storage.ts rather than any blockchain
// call). That entire local claim grid, its "Claim All" button, and its
// weekly local-claims chart have been removed — real MPGR reward
// claiming on this page now happens exclusively through
// <OnChainRewardsSection /> above. hooks/useRewards.ts and its
// mock-claim exports in lib/rewards-engine.ts were deleted outright
// (see repo-wide dependency scan before this change); lib/rewards-
// engine.ts's getRewardState()/RewardState were kept because
// lib/staking-engine.ts, lib/burn-engine.ts, and lib/token-lock-
// engine.ts still read getRewardState(address).totalClaimed for their
// own, unrelated "available balance" math.
//
// Season Points below is unrelated XP/gameplay progression (not an MPGR
// claim) and was intentionally left untouched.

const SEASON_MILESTONES = [250, 500, 1000];

export default function RewardsPage() {
  const [mounted, setMounted] = useState(false);
  const { isConnected } = useAccount();
  const { record } = useXP();
  const { status: premiumStatus } = usePremium();
  const { status: seasonPassStatus, track: seasonTrack } = useSeasonPass();

  const {
    summary: rewardHubSummary,
    history: rewardHubHistory,
    summaryLoading: rewardHubSummaryLoading,
    historyLoading: rewardHubHistoryLoading,
    isLoadingMore: rewardHubLoadingMore,
    summaryError: rewardHubSummaryError,
    historyError: rewardHubHistoryError,
    hasMoreHistory: rewardHubHasMore,
    refresh: refreshRewardHub,
    loadMoreHistory: loadMoreRewardHubHistory,
  } = useRewardHub();

  const [dismissedRewardHubError, setDismissedRewardHubError] = useState(false);

  useEffect(() => setMounted(true), []);
  // Phase 3I — Reward Hub loading fix. Summary and History now have
  // independent error states (see hooks/useRewardHub.ts); this banner
  // covers the Summary/Category section specifically. History has its
  // own error/retry UI inside RewardClaimHistoryList below, so a history
  // failure doesn't also need to (re-)trigger this banner.
  useEffect(() => setDismissedRewardHubError(false), [rewardHubSummaryError]);

  const seasonPoints = record ? getSeasonPoints(record) : 0;
  const seasonNumber = getSeasonNumber();
  const seasonEnd = getSeasonEnd();
  const seasonProgress = Math.min(100, Math.round((seasonPoints / 1000) * 100));
  const nextSeasonMilestone = SEASON_MILESTONES.find((m) => seasonPoints < m) ?? null;

  return (
    <>
      <Navbar />

      <main className="mx-auto max-w-4xl px-4 py-10">
        {!mounted ? null : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <SectionHeader
              title="Reward Hub"
              subtitle="Everything you've earned across staking and on-chain rewards"
            />

            {!isConnected && (
              <EmptyState
                icon={Gift}
                title="Connect your wallet"
                description="Connect to view and claim your MPGR rewards."
              />
            )}

            {rewardHubSummaryError && !dismissedRewardHubError && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}>
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 p-3.5 backdrop-blur-xl">
                  <span className="flex items-center gap-2 text-xs text-red-400">
                    <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {rewardHubSummaryError}
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

            <RewardHubSummaryCards summary={rewardHubSummary} loading={rewardHubSummaryLoading} />

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
              <RewardCategoryGrid categories={rewardHubSummary?.categories ?? null} loading={rewardHubSummaryLoading} />
            </div>

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
                isLoading={rewardHubHistoryLoading}
                isLoadingMore={rewardHubLoadingMore}
                error={rewardHubHistoryError}
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
                <li>• On-chain rewards are allocated to your wallet in the Reward Vault and claimed directly from Base Mainnet</li>
                <li>• Staking rewards accrue continuously — claim them from the Staking page</li>
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
