"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Gift, Coins, Trophy } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { StatCard } from "@/components/ui/StatCard";
import { RewardClaimCard } from "@/components/ui/RewardClaimCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { useRewards } from "@/hooks/useRewards";
import { formatCompactNumber } from "@/lib/format";

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

  useEffect(() => setMounted(true), []);

  const claimableCount = claims.filter((c) => c.unlocked && !c.claimed).length;

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
          </motion.div>
        )}
      </main>
    </>
  );
}
