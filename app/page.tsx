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
} from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { StatCard } from "@/components/ui/StatCard";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { StakingSummaryCard } from "@/components/ui/StakingSummaryCard";
import { LeaderboardRow } from "@/components/ui/LeaderboardRow";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { LevelUpModal } from "@/components/ui/LevelUpModal";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { AddressAvatar } from "@/components/AddressAvatar";
import { useXP } from "@/hooks/useXP";
import { useStaking } from "@/hooks/useStaking";
import { useRewards } from "@/hooks/useRewards";
import { getLevelProgress, getSeasonPoints, XP_ACTIONS } from "@/lib/xp-engine";
import { getRewardState } from "@/lib/rewards-engine";
import { erc20Abi } from "@/lib/erc20-abi";
import {
  formatAddress,
  formatCompactNumber,
  formatTokenAmount,
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

const STAKING_TX_LABEL: Record<string, string> = {
  stake: "Staked MPGR",
  unstake: "Unstaked MPGR",
  claim: "Claimed Staking Reward",
};

const STAKING_TX_ICON: Record<string, typeof ArrowUpCircle> = {
  stake: ArrowUpCircle,
  unstake: ArrowDownCircle,
  claim: Coins,
};

export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { record, checkIn, lastEvent, leveledUp, dismissEvent, dismissLevelUp } = useXP();
  const {
    totalStaked,
    totalClaimableRewards,
    activePositionsCount,
    transactions: stakingTransactions,
    loading: stakingLoading,
  } = useStaking();
  const { claims: rewardClaims } = useRewards();
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
  // (XP history, reward claim history, staking transactions). No mock data.
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

  const lastStakingTx = stakingTransactions[0] ?? null;

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
                    {levelInfo && (
                      <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-gold/10 px-2 py-0.5 text-[11px] font-semibold text-gold ring-1 ring-gold/20">
                        <Award className="h-3 w-3" aria-hidden="true" />
                        Level {levelInfo.level}
                      </span>
                    )}
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

            {/* 1. Staking Summary */}
            <div>
              <SectionHeader title="Staking" subtitle="Your locked MPGR at a glance" />
              <StakingSummaryCard
                totalStaked={totalStaked}
                totalClaimableRewards={totalClaimableRewards}
                activePositionsCount={activePositionsCount}
                loading={stakingLoading}
              />
            </div>

            {/* 2. Games Preview */}
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

            {/* 3. Leaderboard Preview */}
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

            {/* 4. MPGR Agent Preview */}
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

            {/* 5. Recent Activity */}
            <div>
              <SectionHeader
                title="Recent Activity"
                subtitle="Your latest XP, reward, and staking actions"
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
                        const Icon = STAKING_TX_ICON[lastStakingTx.type];
                        return <Icon className="h-4 w-4 text-primary" aria-hidden="true" />;
                      })()
                    ) : (
                      <History className="h-4 w-4 text-primary" aria-hidden="true" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-white">
                      {lastStakingTx ? STAKING_TX_LABEL[lastStakingTx.type] : "No staking activity yet"}
                    </p>
                    {lastStakingTx && (
                      <p className="text-[11px] text-muted">{formatRelativeTime(lastStakingTx.timestamp)}</p>
                    )}
                  </div>
                  {lastStakingTx && (
                    <span className="shrink-0 text-sm font-semibold text-gradient-gold">
                      {lastStakingTx.type === "stake" ? "-" : "+"}
                      {formatCompactNumber(lastStakingTx.amount)} MPGR
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
