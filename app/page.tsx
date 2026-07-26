"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { base } from "wagmi/chains";
import { formatUnits } from "viem";
import { motion } from "framer-motion";
import { Coins, Flame, Trophy, Users, Wallet, Award, Gamepad2, ArrowUpRight } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { StatCard } from "@/components/ui/StatCard";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { StakingSummaryCard } from "@/components/ui/StakingSummaryCard";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { LevelUpModal } from "@/components/ui/LevelUpModal";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { AddressAvatar } from "@/components/AddressAvatar";
import { useXP } from "@/hooks/useXP";
import { useStaking } from "@/hooks/useStaking";
import { getLevelProgress, getSeasonPoints } from "@/lib/xp-engine";
import { erc20Abi } from "@/lib/erc20-abi";
import { formatAddress, formatCompactNumber, formatTokenAmount } from "@/lib/format";

const MPGR_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_MPGR_TOKEN_ADDRESS as
  | `0x${string}`
  | undefined;

export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { record, checkIn, lastEvent, leveledUp, dismissEvent, dismissLevelUp } = useXP();
  const { totalStaked, totalClaimableRewards, activePositionsCount, loading: stakingLoading } = useStaking();
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

  return (
    <>
      <Navbar />
      <FloatingXP amount={lastEvent?.amount ?? null} onComplete={dismissEvent} />
      <LevelUpModal level={leveledUp} onClose={dismissLevelUp} />

      <main className="mx-auto max-w-6xl px-4 py-10">
        {!mounted || !isConnected ? (
          <EmptyState
            icon={Wallet}
            title="Connect your wallet"
            description="Connect to view your MPGR HUB dashboard, XP, and rewards."
          />
        ) : (
          <>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="flex flex-wrap items-center justify-between gap-4"
            >
              <div className="flex min-w-0 items-center gap-4">
                <AddressAvatar address={address ?? ""} size={56} />
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-semibold text-white">
                    {formatAddress(address ?? "")}
                  </h1>
                  <p className="text-sm text-muted">Welcome back to MPGR HUB</p>
                </div>
              </div>
              <button
                onClick={handleCheckIn}
                className="shrink-0 rounded-xl bg-gradient-premium px-5 py-2.5 text-sm font-semibold text-white shadow-glow-gold transition-transform active:scale-95"
              >
                Daily Check-In
              </button>
            </motion.div>

            {checkInMessage && (
              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 text-sm text-gold">
                {checkInMessage}
              </motion.p>
            )}

            {levelInfo && (
              <Link href="/games" className="mt-6 block">
                <GlassCard className="p-5">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-white">
                      <Gamepad2 className="h-4 w-4 text-primary" aria-hidden="true" />
                      Level {levelInfo.level} → {levelInfo.nextLevel}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted">
                      {levelInfo.xpIntoLevel}/{levelInfo.xpNeededForLevel} XP ({levelInfo.progress}%)
                      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                  </div>
                  <ProgressBar progress={levelInfo.progress} />
                </GlassCard>
              </Link>
            )}

            <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
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

            <SectionHeader title="Staking" />
            <StakingSummaryCard
              totalStaked={totalStaked}
              totalClaimableRewards={totalClaimableRewards}
              activePositionsCount={activePositionsCount}
              loading={stakingLoading}
            />

            <SectionHeader title="Games" />
            <Link href="/games">
              <GlassCard className="flex items-center justify-between gap-3 p-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
                    <Award className="h-4 w-4 text-primary" aria-hidden="true" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">Achievements &amp; Leveling</p>
                    <p className="text-[11px] text-muted">View your badges and progress</p>
                  </div>
                </div>
                <ArrowUpRight className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              </GlassCard>
            </Link>
          </>
        )}
      </main>
    </>
  );
}
