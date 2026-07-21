"use client";

import { useEffect, useState } from "react";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { base } from "wagmi/chains";
import { motion } from "framer-motion";
import { Coins, Flame, Trophy, Users, Wallet, Award } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { StatCard } from "@/components/ui/StatCard";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { AddressAvatar } from "@/components/AddressAvatar";
import { useXP } from "@/hooks/useXP";
import {
  getLevelProgress,
  getSeasonPoints,
  getAchievements,
} from "@/lib/xp-engine";
import { erc20Abi } from "@/lib/erc20-abi";
import { formatAddress, formatTokenAmount } from "@/lib/format";

const MPGR_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_MPGR_TOKEN_ADDRESS as
  | `0x${string}`
  | undefined;

export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { record, checkIn } = useXP();
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
  const achievements = record ? getAchievements(record) : [];

  const handleCheckIn = () => {
    const result = checkIn();
    if (!result) return;
    setCheckInMessage(
      result.alreadyCheckedIn
        ? "Already checked in today"
        : `+${result.xpAwarded} XP — streak: ${result.record.streak} days`
    );
    setTimeout(() => setCheckInMessage(null), 3000);
  };

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        {!mounted || !isConnected ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl border border-white/10 bg-white/[0.03] p-10 text-center text-muted"
          >
            Connect your wallet to view your dashboard.
          </motion.div>
        ) : (
          <>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="flex flex-wrap items-center justify-between gap-4"
            >
              <div className="flex items-center gap-4">
                <AddressAvatar address={address ?? ""} size={56} />
                <div>
                  <h1 className="text-xl font-semibold text-white">
                    {formatAddress(address ?? "")}
                  </h1>
                  <p className="text-sm text-muted">Welcome back to MPGR HUB</p>
                </div>
              </div>
              <button
                onClick={handleCheckIn}
                className="rounded-xl bg-gradient-premium px-5 py-2.5 text-sm font-semibold text-white shadow-glow-gold transition-transform hover:scale-[1.03]"
              >
                Daily Check-In
              </button>
            </motion.div>

            {checkInMessage && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-3 text-sm text-gold"
              >
                {checkInMessage}
              </motion.p>
            )}

            {levelInfo && (
              <GlassCard className="mt-6 p-5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-white">Level {levelInfo.level}</span>
                  <span className="text-xs text-muted">
                    {levelInfo.xpIntoLevel} / {levelInfo.xpNeededForLevel} XP
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
                    ? mprBalance
                      ? formatTokenAmount(mprBalance.toString(), 2)
                      : "0"
                    : "Not launched"
                }
                icon={Coins}
                accent="gold"
                loading={mprLoading}
              />
              <StatCard label="XP" value={record ? String(record.xp) : "0"} icon={Trophy} loading={loading} />
              <StatCard
                label="Daily Streak"
                value={record ? `${record.streak} days` : "0 days"}
                icon={Flame}
                loading={loading}
              />
              <StatCard
                label="Season Points"
                value={String(seasonPoints)}
                icon={Award}
                accent="gold"
                loading={loading}
              />
              <StatCard
                label="Referrals"
                value={record ? String(record.referralCount) : "0"}
                icon={Users}
                loading={loading}
              />
            </div>

            <h2 className="mt-8 mb-3 text-sm font-medium text-white">Achievements</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {achievements.map((achievement) => (
                <GlassCard
                  key={achievement.id}
                  className={`p-4 ${achievement.unlocked ? "" : "opacity-40"}`}
                >
                  <p className="text-sm font-medium text-white">{achievement.label}</p>
                  <p className="mt-1 text-xs text-muted">{achievement.description}</p>
                </GlassCard>
              ))}
            </div>
          </>
        )}
      </main>
    </>
  );
}
