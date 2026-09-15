"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Gift, Trophy, HelpCircle, AlertCircle, X, Gamepad2, Medal, Star, Flame, Award } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { StatCard } from "@/components/ui/StatCard";
import { OnChainRewardsSection } from "@/components/ui/OnChainRewardsSection";
import { RewardHubSummaryCards } from "@/components/ui/RewardHubSummaryCards";
import { RewardCategoryGrid } from "@/components/ui/RewardCategoryGrid";
import { RewardClaimHistoryList } from "@/components/ui/RewardClaimHistoryList";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { CountdownCard } from "@/components/ui/CountdownCard";
import { ActivityTimeline } from "@/components/ui/ActivityTimeline";
import { AchievementCard } from "@/components/ui/AchievementCard";
import { FeaturedGameBanner } from "@/components/features/games/FeaturedGameBanner";
import { GameCard } from "@/components/features/games/GameCard";
import { SeasonRewardsPreview } from "@/components/features/season-pass/SeasonRewardsPreview";
import { useRewardHub } from "@/hooks/useRewardHub";
import { useXP } from "@/hooks/useXP";
import { useSeasonPass } from "@/hooks/useSeasonPass";
import { getLevelProgress, getSeasonEnd, getSeasonNumber, getSeasonPoints, getAchievements } from "@/lib/xp-engine";
import { formatCompactNumber } from "@/lib/format";
import { GAME_REGISTRY, getFeaturedGame } from "@/lib/games/game-registry";
import { getGameStats } from "@/lib/games/game-storage";
import { toGameAchievementStats } from "@/lib/games/mpgr-run/run-rewards";
import { MPGR_RUN_GAME_ID } from "@/lib/games/mpgr-run/run-config";

const SEASON_MILESTONES = [250, 500, 1000];

export default function RewardsPage() {
  const [mounted, setMounted] = useState(false);
  const { isConnected } = useAccount();
  const { record, claim } = useXP();
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
  useEffect(() => setDismissedRewardHubError(false), [rewardHubSummaryError]);

  const seasonPoints = record ? getSeasonPoints(record) : 0;
  const seasonNumber = getSeasonNumber();
  const seasonEnd = getSeasonEnd();
  const seasonProgress = Math.min(100, Math.round((seasonPoints / 1000) * 100));
  const nextSeasonMilestone = SEASON_MILESTONES.find((m) => seasonPoints < m) ?? null;
  const featuredGame = getFeaturedGame();
  const gameStats = record ? getGameStats(MPGR_RUN_GAME_ID, record.address) : null;
  const levelInfo = record ? getLevelProgress(record.xp) : null;
  const gameAchievementStats = gameStats ? toGameAchievementStats(gameStats) : undefined;
  const achievements = record ? getAchievements(record, gameAchievementStats) : [];

  return (
    <>
      <Navbar />

      <main className="mx-auto max-w-4xl px-4 py-10">
        {!mounted ? null : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <SectionHeader
              title="Rewards"
              subtitle="Play, earn XP, follow seasons, and claim on-chain rewards"
            />

            <div className="flex flex-wrap gap-2">
              <Link
                href="/games/mpgr-run"
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3.5 text-xs font-medium text-white hover:bg-white/[0.06]"
              >
                <Gamepad2 className="h-3.5 w-3.5" aria-hidden="true" />
                MPGR Run
              </Link>
              <Link
                href="/season"
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3.5 text-xs font-medium text-white hover:bg-white/[0.06]"
              >
                Season {seasonNumber}
              </Link>
              <Link
                href="/leaderboard"
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3.5 text-xs font-medium text-white hover:bg-white/[0.06]"
              >
                <Medal className="h-3.5 w-3.5" aria-hidden="true" />
                Leaderboard
              </Link>
            </div>

            {!isConnected && (
              <EmptyState
                icon={Gift}
                title="Connect your wallet"
                description="Connect to view and claim your MPGR rewards."
              />
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Level" value={String(levelInfo?.level ?? 1)} icon={Star} />
              <StatCard label="XP" value={formatCompactNumber(record?.xp ?? 0)} icon={Trophy} accent="gold" />
              <StatCard label="Streak" value={`${record?.streak ?? 0}d`} icon={Flame} />
              <StatCard label="Season Points" value={formatCompactNumber(seasonPoints)} icon={Award} accent="gold" />
            </div>

            <div>
              <SectionHeader title="Play" subtitle="MPGR Run and the arcade" />
              <FeaturedGameBanner game={featuredGame} bestScore={gameStats?.bestScore} />
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {GAME_REGISTRY.filter((game) => game.id !== featuredGame.id).slice(0, 3).map((game) => (
                  <GameCard
                    key={game.id}
                    game={game}
                    bestScore={game.id === MPGR_RUN_GAME_ID ? gameStats?.bestScore : undefined}
                  />
                ))}
              </div>
              <Link
                href="/games"
                className="mt-3 flex min-h-[40px] w-full items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-xs font-semibold text-white transition-colors duration-200 hover:bg-white/[0.06]"
              >
                View all games
              </Link>
            </div>

            {rewardHubSummaryError && !dismissedRewardHubError && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}>
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 p-3.5">
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

            {seasonPassStatus && (
              <SeasonRewardsPreview track={seasonTrack} currentLevel={seasonPassStatus.levelProgress.level} />
            )}

            <div>
              <SectionHeader title="$MPGR Rewards" subtitle="Earned across every active reward system" />
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
              <SectionHeader title="Achievements" />
              {achievements.length === 0 ? (
                <EmptyState icon={Award} title="No achievements yet" description="Play and earn XP to unlock achievements." />
              ) : (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {achievements.map((achievement) => (
                    <AchievementCard
                      key={achievement.id}
                      achievement={achievement}
                      onClaim={() => claim(achievement.id, gameAchievementStats)}
                    />
                  ))}
                </div>
              )}
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
                <li>• Play MPGR Run and complete Hub actions to earn XP and season points</li>
                <li>• On-chain rewards are allocated to your wallet in the Reward Vault and claimed directly from Base Mainnet</li>
                <li>• Staking rewards accrue continuously — claim them from the Staking page</li>
                <li>• Season points and milestones reset every calendar month</li>
              </ul>
            </GlassCard>

            {record && record.history.length > 0 && (
              <div>
                <SectionHeader title="Game & reward activity" />
                <ActivityTimeline entries={record.history} limit={8} />
              </div>
            )}
          </motion.div>
        )}
      </main>
    </>
  );
}
