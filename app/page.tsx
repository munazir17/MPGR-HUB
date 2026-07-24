"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { base } from "wagmi/chains";
import { motion } from "framer-motion";
import { Coins, Flame, Trophy, Users, Wallet, Award, CheckCircle2 } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { StatCard } from "@/components/ui/StatCard";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { AchievementCard } from "@/components/ui/AchievementCard";
import { ActivityTimeline } from "@/components/ui/ActivityTimeline";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { LevelUpModal } from "@/components/ui/LevelUpModal";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { AddressAvatar } from "@/components/AddressAvatar";
import { useXP } from "@/hooks/useXP";
import { getLevelProgress, getSeasonPoints, getAchievements, getSeasonNumber } from "@/lib/xp-engine";
import { erc20Abi } from "@/lib/erc20-abi";
import { formatAddress, formatCompactNumber, formatTokenAmount, formatTokenBalance } from "@/lib/format";

const MPGR_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_MPGR_TOKEN_ADDRESS as
  | `0x${string}`
  | undefined;

export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { record, checkIn, claim, lastEvent, leveledUp, dismissEvent, dismissLevelUp } = useXP();
  const [checkInMessage, setCheckInMessage] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);

  const { data: ethBalance, isLoading: ethLoading } = useBalance({
    address,
    chainId: base.id,
    query: { enabled: mounted && isConnected },
  });

  const { data: mprBalanceRaw, isLoading: mprLoading } = useReadContract({
    address: MPGR_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: base.id,
    query: { enabled: mounted && isConnected && Boolean(MPGR_TOKEN_ADDRESS) },
  });

  const { data: mprDecimals } = useReadContract({
    address: MPGR_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "decimals",
    chainId: base.id,
    query: { enabled: mounted && Boolean(MPGR_TOKEN_ADDRESS) },
  });

  const loading = !mounted || (isConnected && !record);
  const levelInfo = record ? getLevelProgress(record.xp) : null;
  const seasonPoints = record ? getSeasonPoints(record) : 0;
  const achievements = record ? getAchievements(record) : [];
  const today = new Date().toISOString().slice(0, 10);
  const alreadyCheckedInToday = record?.lastCheckIn === today;

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
              className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-center gap-4">
                <AddressAvatar address={address ?? ""} size={56} />
                <div className="min-w-0">
                  <p className="text-xs text-muted">Welcome back</p>
                  <h1 className="truncate text-xl font-semibold text-white">
                    {formatAddress(address ?? "")}
                  </h1>
                  <p className="mt-0.5 text-xs text-muted">
                    Level {levelInfo?.level ?? 1} · {formatCompactNumber(record?.xp ?? 0)} XP ·{" "}
                    {record?.streak ?? 0}-day streak · Season {getSeasonNumber()}
                  </p>
                </div>
              </div>

              <motion.button
                onClick={handleCheckIn}
                disabled={alreadyCheckedInToday}
                whileHover={!alreadyCheckedInToday ? { scale: 1.03 } : undefined}
                whileTap={!alreadyCheckedInToday ? { scale: 0.97 } : undefined}
                aria-label={alreadyCheckedInToday ? "Already checked in today" : "Daily check-in, earn XP"}
                className="flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed
                  bg-gradient-premium shadow-glow-gold
                  disabled:bg-none disabled:bg-surface disabled:text-muted disabled:shadow-none"
              >
                {alreadyCheckedInToday ? (
                  <>
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    Checked In
                  </>
                ) : (
                  "Daily Check-In"
                )}
              </motion.button>
            </motion.div>

            {checkInMessage && (
              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 text-sm text-gold">
                {checkInMessage}
              </motion.p>
            )}

            {levelInfo && (
              <GlassCard className="mt-6 p-5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-white">
                    Level {levelInfo.level} → {levelInfo.nextLevel}
                  </span>
                  <span className="text-xs text-muted">
                    {levelInfo.xpIntoLevel}/{levelInfo.xpNeededForLevel} XP ({levelInfo.progress}%)
                  </span>
                </div>
                <ProgressBar progress={levelInfo.progress} />
              </GlassCard>
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
                    ? `${formatTokenBalance(mprBalanceRaw as bigint | undefined, mprDecimals as number | undefined)} MPGR`
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

            <SectionHeader title="Achievements" />
            {achievements.length === 0 ? (
              <EmptyState icon={Award} title="No achievements yet" description="Start earning XP to unlock achievements." />
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {achievements.map((achievement) => (
                  <AchievementCard
                    key={achievement.id}
                    achievement={achievement}
                    onClaim={() => claim(achievement.id)}
                  />
                ))}
              </div>
            )}

            <SectionHeader title="Recent Activity" />
            {record && record.history.length > 0 ? (
              <ActivityTimeline entries={record.history} limit={6} />
            ) : (
              <EmptyState icon={Trophy} title="No activity yet" description="Check in daily to start building your history." />
            )}
          </>
        )}
      </main>
    </>
  );
}
