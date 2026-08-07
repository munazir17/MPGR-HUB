"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { base } from "wagmi/chains";
import { formatUnits } from "viem";
import { motion } from "framer-motion";
import {
  Coins,
  Flame,
  Trophy,
  Users,
  Wallet,
  Award,
  Gamepad2,
  ArrowUpRight,
  ArrowUpCircle,
  ArrowDownCircle,
  History,
  Bot,
  Bell,
  Eye,
  TrendingUp,
  LineChart,
  Dices,
  Brain,
  Zap,
  HelpCircle,
  Gem,
  Sparkles,
  Gift,
  Vault,
  PieChart,
  Lock as LockIcon,
  Users2,
} from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { StatCard } from "@/components/ui/StatCard";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { StakingSummaryCard } from "@/components/ui/StakingSummaryCard";
import { TokenLockSummaryCard } from "@/components/ui/TokenLockSummaryCard";
import { QuickActions } from "@/components/ui/QuickActions";
import { LeaderboardRow } from "@/components/ui/LeaderboardRow";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { LevelUpModal } from "@/components/ui/LevelUpModal";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { AddressAvatar } from "@/components/AddressAvatar";
import { PremiumBadge } from "@/components/ui/PremiumBadge";
import { SeasonRewardsPreview } from "@/components/features/season-pass/SeasonRewardsPreview";
import { HolderTierOverview } from "@/components/features/holder-tier/HolderTierOverview";
import { useXP } from "@/hooks/useXP";
import { useStaking } from "@/hooks/useStaking";
import { useRewards } from "@/hooks/useRewards";
import { useTokenLock } from "@/hooks/useTokenLock";
import { usePremium } from "@/hooks/usePremium";
import { useSeasonPass } from "@/hooks/useSeasonPass";
import { getLevelProgress, getSeasonPoints, getSeasonNumber, XP_ACTIONS } from "@/lib/xp-engine";
import { getRewardState } from "@/lib/rewards-engine";
import { erc20Abi } from "@/lib/erc20-abi";
import type { StakingLiveActivityEntry } from "@/lib/staking/staking-types";
import {
  formatAddress,
  formatCompactNumber,
  formatTokenAmount,
  formatTokenBalance,
  formatRelativeTime,
} from "@/lib/format";

const MPGR_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_MPGR_TOKEN_ADDRESS as
  | `0x${string}`
  | undefined;

const MINI_GAMES = [
  { name: "Lucky Spin", icon: Dices },
  { name: "Memory Game", icon: Brain },
  { name: "Tap Challenge", icon: Zap },
  { name: "Quiz", icon: HelpCircle },
  { name: "Treasure Hunt", icon: Gem },
  { name: "Prediction", icon: LineChart },
];

const STAKING_TX_LABEL: Record<StakingLiveActivityEntry["kind"], string> = {
  Staked: "Staked MPGR",
  Unstaked: "Unstaked MPGR",
  RewardPaid: "Claimed Staking Reward",
};

const STAKING_TX_ICON: Record<StakingLiveActivityEntry["kind"], typeof ArrowUpCircle> = {
  Staked: ArrowUpCircle,
  Unstaked: ArrowDownCircle,
  RewardPaid: Coins,
};

const LOCK_TX_LABEL: Record<string, string> = {
  lock: "Locked MPGR",
  release: "Released Lock",
  early_unlock: "Early Unlocked MPGR",
};

const LOCK_TX_ICON: Record<string, typeof ArrowUpCircle> = {
  lock: ArrowUpCircle,
  release: ArrowDownCircle,
  early_unlock: ArrowDownCircle,
};

export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { record, checkIn, lastEvent, leveledUp, dismissEvent, dismissLevelUp } = useXP();
  const {
    stakedBalanceRaw,
    earnedRewardsRaw,
    currentAPRPercent,
    decimals: stakingDecimals,
    liveActivity: stakingLiveActivity,
    loading: stakingLoading,
  } = useStaking();
  const {
    totalLocked,
    activeLocksCount,
    upcomingUnlockAt,
    transactions: lockTransactions,
    loading: lockLoading,
  } = useTokenLock();
  const { claims: rewardClaims, claimableTotal, loading: rewardsLoading } = useRewards();
  const { status: premiumStatus } = usePremium();
  const { status: seasonPassStatus, track: seasonTrack } = useSeasonPass();
  const [checkInMessage, setCheckInMessage] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);

  const { data: ethBalance, isLoading: ethLoading } = useBalance({
    address,
    chainId: base.id,
    query: { enabled: mounted && isConnected },
  });

  const { data: mprBalance, isLoading: mprLoading } = useReadContract({
    address: MPGR_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: base.id,
    query: { enabled: mounted && isConnected && Boolean(MPGR_TOKEN_ADDRESS) },
  });

  const loading = !mounted || (isConnected && !record);
  const levelInfo = record ? getLevelProgress(record.xp) : null;
  const seasonPoints = record ? getSeasonPoints(record) : 0;
  const seasonNumber = getSeasonNumber();

  const walletMPGR = MPGR_TOKEN_ADDRESS && mprBalance ? Number(formatUnits(mprBalance, 18)) : 0;
  const stakedMPGR = Number(formatUnits(stakedBalanceRaw, stakingDecimals));
  const totalMPGR = walletMPGR + stakedMPGR + totalLocked;
  const portfolioLoading = mprLoading || stakingLoading || lockLoading;

  const handleCheckIn = useCallback(() => {
    const result = checkIn();
    if (!result) return;
    setCheckInMessage(
      result.alreadyCheckedIn
        ? "Already checked in today"
        : `+${result.xpGained} XP — streak: ${result.record.streak} days`
    );
    setTimeout(() => setCheckInMessage(null), 3000);
  }, [checkIn]);

  // Recent Activity — derived from real, already-persisted data sources
  // (XP history, reward claim history, lock transactions) plus, for
  // staking, the live Staked/Unstaked/RewardPaid events observed this
  // session via useStaking's on-chain event watcher. The deployed
  // MPGRStaking contract has no indexer, so there is no backfilled
  // staking history to show — only what's been seen live. No mock data.
  const lastXPEntry =
    record && record.history.length > 0
      ? [...record.history].sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )[0]
      : null;

  const lastRewardClaim = (() => {
    if (!address) return null;
    const history = getRewardState(address).history;
    if (history.length === 0) return null;
    const latest = [...history].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )[0];
    const title = rewardClaims.find((c) => c.id === latest.rewardId)?.title ?? "Reward Claimed";
    return { title, amount: latest.amount, timestamp: latest.timestamp };
  })();

  const lastStakingTx = stakingLiveActivity[0] ?? null;
  const lastLockTx = lockTransactions[0] ?? null;

  return (
    <>
      <Navbar />
      <FloatingXP amount={lastEvent?.amount ?? null} onComplete={dismissEvent} />
      <LevelUpModal level={leveledUp} onClose={dismissLevelUp} />

      <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
        {!mounted || !isConnected ? (
          <EmptyState
            icon={Wallet}
            title="Connect your wallet"
            description="Connect to view your MPGR HUB dashboard, XP, and rewards."
          />
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="space-y-10 sm:space-y-12"
          >
            {/* Hero */}
            <div className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.03] p-5 backdrop-blur-xl shadow-glow sm:p-7">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -left-16 -top-20 h-64 w-64 rounded-full bg-gradient-premium opacity-20 blur-3xl"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-24 -right-16 h-56 w-56 rounded-full bg-gradient-gold opacity-10 blur-3xl"
              />

              <div className="relative flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-4">
                  <div className="relative shrink-0">
                    <div
                      aria-hidden="true"
                      className="absolute -inset-0.5 rounded-full bg-gradient-premium opacity-70 blur-[3px]"
                    />
                    <div className="relative rounded-full ring-2 ring-background">
                      <AddressAvatar address={address ?? ""} size={56} />
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted">
                      Welcome back
                    </p>
                    <h1 className="truncate text-xl font-bold tracking-tight text-white sm:text-2xl">
                      {formatAddress(address ?? "")}
                    </h1>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {levelInfo && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-gold/10 px-2 py-0.5 text-[11px] font-semibold text-gold ring-1 ring-gold/20">
                          <Award className="h-3 w-3" aria-hidden="true" />
                          Level {levelInfo.level}
                        </span>
                      )}
                      {premiumStatus && <PremiumBadge tier={premiumStatus.tier} size="sm" />}
                      {premiumStatus?.isPremium && (
                        <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary ring-1 ring-primary/20">
                          {premiumStatus.xpMultiplier}× XP · {premiumStatus.rewardsMultiplier}× Rewards
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleCheckIn}
                  className="shrink-0 rounded-xl bg-gradient-premium px-5 py-2.5 text-sm font-semibold text-white shadow-glow-gold-lg transition-shadow"
                >
                  Daily Check-In
                </motion.button>
              </div>

              {checkInMessage && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="relative mt-4 text-sm font-medium text-gold"
                >
                  {checkInMessage}
                </motion.p>
              )}
            </div>

            {/* Quick Actions */}
            <div>
              <SectionHeader title="Quick Actions" subtitle="Jump straight into what you came here for" />
              <QuickActions />
            </div>

            {/* Season Pass Preview */}
            {record && seasonPassStatus && (
              <SeasonRewardsPreview track={seasonTrack} currentLevel={seasonPassStatus.levelProgress.level} />
            )}

            {/* Portfolio Overview */}
            <div>
              <SectionHeader
                title="Portfolio Overview"
                subtitle="Your MPGR across wallet, staking, and locks"
              />
              <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
                <StatCard
                  label="Total MPGR"
                  value={
                    MPGR_TOKEN_ADDRESS ? formatCompactNumber(totalMPGR) : "Not launched"
                  }
                  icon={PieChart}
                  accent="gold"
                  loading={portfolioLoading}
                />
                <StatCard
                  label="Staked MPGR"
                  value={formatCompactNumber(stakedMPGR)}
                  icon={Coins}
                  loading={stakingLoading}
                />
                <StatCard
                  label="Locked MPGR"
                  value={formatCompactNumber(totalLocked)}
                  icon={LockIcon}
                  loading={lockLoading}
                />
                <StatCard
                  label="Claimable Rewards"
                  value={formatCompactNumber(claimableTotal)}
                  icon={Gift}
                  accent="gold"
                  loading={rewardsLoading}
                />
              </div>
            </div>

            {/* Holder Tier */}
            <HolderTierOverview />

            {/* XP / Level progress */}
            {levelInfo && (
              <Link href="/games">
                <GlassCard className="p-5 sm:p-6">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm font-semibold text-white">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary-glow/20 to-primary/10 ring-1 ring-primary/20">
                        <Gamepad2 className="h-4 w-4 text-primary" aria-hidden="true" />
                      </span>
                      Level {levelInfo.level} → {levelInfo.nextLevel}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted">
                      {levelInfo.xpIntoLevel}/{levelInfo.xpNeededForLevel} XP
                      <span className="font-semibold text-gradient-gold">({levelInfo.progress}%)</span>
                      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                  </div>
                  <ProgressBar progress={levelInfo.progress} />
                </GlassCard>
              </Link>
            )}

            {/* Season Progress */}
            <Link href="/rewards">
              <GlassCard className="p-5 sm:p-6">
                <div className="mb-3 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm font-semibold text-white">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-gold-glow/20 to-gold/10 ring-1 ring-gold/20">
                      <Award className="h-4 w-4 text-gold" aria-hidden="true" />
                    </span>
                    Season {seasonNumber} Progress
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted">
                    {formatCompactNumber(seasonPoints)}/1,000 pts
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                </div>
                <ProgressBar progress={Math.min(100, Math.round((seasonPoints / 1000) * 100))} />
              </GlassCard>
            </Link>

            {/* Wallet & stats */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
              <StatCard
                label="Base ETH"
                value={ethBalance ? formatTokenAmount(ethBalance.formatted, 4) : "0"}
                icon={Wallet}
                loading={ethLoading}
              />
              <StatCard
                label="MPGR Balance"
                value={
                  MPGR_TOKEN_ADDRESS
                    ? mprBalance
                      ? formatCompactNumber(Number(formatUnits(mprBalance, 18)))
                      : "0"
                    : "Not launched"
                }
                icon={Coins}
                accent="gold"
                loading={mprLoading}
              />
              <StatCard label="XP" value={formatCompactNumber(record?.xp ?? 0)} icon={Trophy} loading={loading} />
              <StatCard
                label="Daily Streak"
                value={record ? `${record.streak} days` : "0 days"}
                icon={Flame}
                loading={loading}
              />
              <StatCard label="Season Points" value={formatCompactNumber(seasonPoints)} icon={Award} accent="gold" loading={loading} />
              <StatCard label="Referrals" value={formatCompactNumber(record?.referralCount ?? 0)} icon={Users} loading={loading} />
            </div>

            {/* 1. Staking + Token Lock Summary */}
            <div>
              <SectionHeader title="Staking & Token Lock" subtitle="Your locked and staked MPGR at a glance" />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <StakingSummaryCard
                  stakedBalanceRaw={stakedBalanceRaw}
                  earnedRewardsRaw={earnedRewardsRaw}
                  currentAPRPercent={currentAPRPercent}
                  decimals={stakingDecimals}
                  loading={stakingLoading}
                />
                <TokenLockSummaryCard
                  totalLocked={totalLocked}
                  activeLocksCount={activeLocksCount}
                  upcomingUnlockAt={upcomingUnlockAt}
                  loading={lockLoading}
                />
              </div>
            </div>

            {/* 2. Weekly Community Reward Pool */}
            <div>
              <SectionHeader
                title="Weekly Community Reward Pool"
                subtitle="Shared MPGR rewards distributed to the community"
              />
              <GlassCard className="relative overflow-hidden p-5 sm:p-6">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -left-12 -top-12 h-44 w-44 rounded-full bg-gradient-gold opacity-10 blur-3xl"
                />
                <div className="relative flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-gold shadow-glow-gold">
                      <Users2 className="h-5 w-5 text-background" aria-hidden="true" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-white">Community Pool</p>
                      <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-muted">
                        Coming Soon
                      </span>
                    </div>
                  </div>
                </div>
                <p className="relative mt-4 text-xs leading-relaxed text-muted">
                  A weekly MPGR pool shared across active community members is planned for a future
                  release. Once live, your share here will be based on real on-chain activity —
                  no placeholder numbers until then.
                </p>
              </GlassCard>
            </div>

            {/* 3. Games Preview */}
            <div>
              <SectionHeader title="Games" subtitle="Play to earn XP and MPGR rewards" />
              <GlassCard className="p-5 sm:p-6">
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                  {MINI_GAMES.map((game) => {
                    const Icon = game.icon;
                    return (
                      <motion.div
                        key={game.name}
                        whileHover={{ y: -2 }}
                        className="flex flex-col items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-center transition-colors duration-200 hover:border-primary/20 hover:bg-white/[0.05]"
                      >
                        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-primary-glow/20 to-primary/10 ring-1 ring-primary/15">
                          <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
                        </div>
                        <p className="text-[11px] font-medium leading-tight text-white">{game.name}</p>
                        <span className="rounded-full bg-surface px-2 py-0.5 text-[9px] font-medium text-muted">
                          Soon
                        </span>
                      </motion.div>
                    );
                  })}
                </div>
                <Link
                  href="/games"
                  className="mt-5 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-gradient-premium text-sm font-semibold text-white shadow-glow-gold transition-transform duration-200 hover:scale-[1.01] active:scale-95"
                >
                  Play Now
                </Link>
              </GlassCard>
            </div>

            {/* 4. Leaderboard Preview */}
            <div>
              <SectionHeader title="Leaderboard" subtitle="See where you rank this season" />
              <GlassCard className="p-4 sm:p-5">
                {record ? (
                  <>
                    <LeaderboardRow
                      rank={1}
                      address={address ?? ""}
                      xp={record.xp}
                      seasonPoints={seasonPoints}
                      referrals={record.referralCount}
                      tier={premiumStatus?.tier}
                      isCurrentUser
                    />
                    <p className="mt-3 text-center text-[11px] text-muted">
                      Global rankings launch soon — invite friends to climb faster.
                    </p>
                  </>
                ) : (
                  <p className="py-2 text-center text-xs text-muted">
                    Start earning XP to appear on the leaderboard.
                  </p>
                )}
                <Link
                  href="/leaderboard"
                  className="mt-4 flex min-h-[40px] w-full items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-xs font-semibold text-white transition-colors duration-200 hover:bg-white/[0.06]"
                >
                  View Leaderboard
                </Link>
              </GlassCard>
            </div>

            {/* 5. MPGR Agent Preview */}
            <div>
              <SectionHeader title="MPGR Agent" subtitle="Your AI assistant for MPGR HUB" />
              <GlassCard className="relative overflow-hidden p-5 sm:p-6">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -left-12 -top-12 h-44 w-44 rounded-full bg-gradient-premium opacity-20 blur-3xl animate-glow-pulse"
                />
                <div className="relative flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-premium shadow-glow-gold-lg">
                      <Bot className="h-5 w-5 text-white" aria-hidden="true" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-white">MPGR Agent</p>
                      <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-muted">
                        Coming Soon
                      </span>
                    </div>
                  </div>
                  <Link
                    href="/agent"
                    className="flex min-h-[36px] shrink-0 items-center gap-1 rounded-xl bg-gradient-premium px-3.5 py-1.5 text-xs font-semibold text-white shadow-glow-gold transition-transform duration-200 hover:scale-[1.03] active:scale-95"
                  >
                    Open Agent
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </div>

                <div className="relative mt-6 grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] py-3">
                    <TrendingUp className="mx-auto h-4 w-4 text-primary" aria-hidden="true" />
                    <p className="mt-1.5 text-[10px] leading-tight text-muted">Portfolio Analysis</p>
                  </div>
                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] py-3">
                    <Eye className="mx-auto h-4 w-4 text-primary" aria-hidden="true" />
                    <p className="mt-1.5 text-[10px] leading-tight text-muted">Whale Tracking</p>
                  </div>
                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] py-3">
                    <Bell className="mx-auto h-4 w-4 text-primary" aria-hidden="true" />
                    <p className="mt-1.5 text-[10px] leading-tight text-muted">Smart Alerts</p>
                  </div>
                </div>
              </GlassCard>
            </div>

            {/* 6. Recent Activity */}
            <div>
              <SectionHeader
                title="Recent Activity"
                subtitle="Your latest XP, reward, staking, and lock actions"
              />
              <GlassCard className="divide-y divide-white/[0.06] p-0">
                <div className="flex items-center gap-3 p-4 transition-colors duration-200 hover:bg-white/[0.02]">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-glow/20 to-primary/10 ring-1 ring-primary/15">
                    <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-white">
                      {lastXPEntry ? XP_ACTIONS[lastXPEntry.action]?.label ?? "XP Earned" : "No XP earned yet"}
                    </p>
                    {lastXPEntry && (
                      <p className="text-[11px] text-muted">{formatRelativeTime(lastXPEntry.timestamp)}</p>
                    )}
                  </div>
                  {lastXPEntry && (
                    <span className="shrink-0 text-sm font-semibold text-gradient-gold">+{lastXPEntry.xp} XP</span>
                  )}
                </div>

                <div className="flex items-center gap-3 p-4 transition-colors duration-200 hover:bg-white/[0.02]">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-gold-glow/20 to-gold/10 ring-1 ring-gold/15">
                    <Gift className="h-4 w-4 text-gold" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-white">
                      {lastRewardClaim ? lastRewardClaim.title : "No rewards claimed yet"}
                    </p>
                    {lastRewardClaim && (
                      <p className="text-[11px] text-muted">{formatRelativeTime(lastRewardClaim.timestamp)}</p>
                    )}
                  </div>
                  {lastRewardClaim && (
                    <span className="shrink-0 text-sm font-semibold text-gradient-gold">
                      +{formatCompactNumber(lastRewardClaim.amount)} MPGR
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3 p-4 transition-colors duration-200 hover:bg-white/[0.02]">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-glow/20 to-primary/10 ring-1 ring-primary/15">
                    {lastStakingTx ? (
                      (() => {
                        const Icon = STAKING_TX_ICON[lastStakingTx.kind];
                        return <Icon className="h-4 w-4 text-primary" aria-hidden="true" />;
                      })()
                    ) : (
                      <History className="h-4 w-4 text-primary" aria-hidden="true" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-white">
                      {lastStakingTx ? STAKING_TX_LABEL[lastStakingTx.kind] : "No staking activity yet"}
                    </p>
                    {lastStakingTx && (
                      <p className="text-[11px] text-muted">{formatRelativeTime(lastStakingTx.observedAt)}</p>
                    )}
                  </div>
                  {lastStakingTx && (
                    <span className="shrink-0 text-sm font-semibold text-gradient-gold">
                      {lastStakingTx.kind === "Staked" ? "-" : "+"}
                      {formatTokenBalance(lastStakingTx.amount, stakingDecimals)} MPGR
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3 p-4 transition-colors duration-200 hover:bg-white/[0.02]">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-gold-glow/20 to-gold/10 ring-1 ring-gold/15">
                    {lastLockTx ? (
                      (() => {
                        const Icon = LOCK_TX_ICON[lastLockTx.type];
                        return <Icon className="h-4 w-4 text-gold" aria-hidden="true" />;
                      })()
                    ) : (
                      <Vault className="h-4 w-4 text-gold" aria-hidden="true" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-white">
                      {lastLockTx ? LOCK_TX_LABEL[lastLockTx.type] : "No lock activity yet"}
                    </p>
                    {lastLockTx && (
                      <p className="text-[11px] text-muted">{formatRelativeTime(lastLockTx.timestamp)}</p>
                    )}
                  </div>
                  {lastLockTx && (
                    <span className="shrink-0 text-sm font-semibold text-gradient-gold">
                      {lastLockTx.type === "lock" ? "-" : "+"}
                      {formatCompactNumber(lastLockTx.amount)} MPGR
                    </span>
                  )}
                </div>
              </GlassCard>
            </div>
          </motion.div>
        )}
      </main>
    </>
  );
}
