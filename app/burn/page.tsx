"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Flame, History, Trophy, Target, Award } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { BurnDashboard } from "@/components/features/burn/BurnDashboard";
import { BurnCard } from "@/components/features/burn/BurnCard";
import { BurnTimeline } from "@/components/features/burn/BurnTimeline";
import { BurnLeaderboard } from "@/components/features/burn/BurnLeaderboard";
import { BurnMilestones } from "@/components/features/burn/BurnMilestones";
import { BurnAchievements } from "@/components/features/burn/BurnAchievements";
import { BurnSuccessModal } from "@/components/features/burn/BurnSuccessModal";
import { useBurn } from "@/hooks/useBurn";

export default function BurnPage() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const {
    totalBurned,
    availableBalance,
    stats,
    milestones,
    achievements,
    leaderboard,
    transactions,
    burn,
    previewImpact,
    previewRemainingBalance,
    loading,
  } = useBurn();

  const [successAmount, setSuccessAmount] = useState<number | null>(null);

  useEffect(() => setMounted(true), []);

  // useBurn() is the single source of truth — this page never re-derives
  // burn math (supply, percentages, milestones, achievements) itself, it
  // only decides layout and passes hook output straight through.
  const handleSuccess = useCallback((amount: number) => setSuccessAmount(amount), []);
  const handleCloseSuccess = useCallback(() => setSuccessAmount(null), []);

  const nextMilestoneLabel = useMemo(
    () => milestones.find((m) => !m.achieved)?.label ?? null,
    [milestones]
  );

  return (
    <>
      <Navbar />

      <BurnSuccessModal
        open={successAmount !== null}
        amount={successAmount ?? 0}
        address={address ?? ""}
        onClose={handleCloseSuccess}
      />

      <main className="mx-auto max-w-6xl px-4 py-8 pb-24 sm:py-12 sm:pb-12">
        {!mounted || !isConnected ? (
          <EmptyState
            icon={Flame}
            title="Connect your wallet"
            description="Connect to burn MPGR and track your impact on total supply."
          />
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-10 sm:space-y-12"
          >
            {/* Hero + Summary + Stats */}
            <BurnDashboard stats={stats} milestones={milestones} loading={loading} />

            {/* Burn Card + live Burn Impact (Impact is composed inside BurnCard) */}
            <div>
              <SectionHeader title="Burn MPGR" subtitle="Live preview updates as you type" />
              {loading ? (
                <SkeletonCard lines={5} />
              ) : (
                <BurnCard
                  availableBalance={availableBalance}
                  communityBurnGoal={stats.communityBurnGoal}
                  communityBurnProgress={stats.communityBurnProgress}
                  previewImpact={previewImpact}
                  previewRemainingBalance={previewRemainingBalance}
                  onBurn={burn}
                  onSuccess={handleSuccess}
                  loading={loading}
                />
              )}
            </div>

            {/* Burn Timeline */}
            <div>
              <SectionHeader title="Burn History" subtitle="Newest first" />
              {loading ? (
                <SkeletonCard lines={3} />
              ) : transactions.length === 0 ? (
                <EmptyState
                  icon={History}
                  title="No burns yet"
                  description="Your burn transactions will show up here once you burn MPGR above."
                />
              ) : (
                <BurnTimeline transactions={transactions} />
              )}
            </div>

            {/* Leaderboard */}
            <div>
              <SectionHeader title="Top Burners" subtitle="Ranked by total MPGR burned" />
              {loading ? <SkeletonCard lines={3} /> : <BurnLeaderboard entries={leaderboard} />}
            </div>

            {/* Milestones */}
            <div>
              <SectionHeader
                title="Burn Milestones"
                subtitle={
                  nextMilestoneLabel
                    ? `Next milestone: ${nextMilestoneLabel}`
                    : "All milestones reached"
                }
              />
              {loading ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <SkeletonCard lines={2} />
                  <SkeletonCard lines={2} />
                  <SkeletonCard lines={2} />
                </div>
              ) : (
                <BurnMilestones milestones={milestones} />
              )}
            </div>

            {/* Achievements */}
            <div>
              <SectionHeader title="Burn Achievements" subtitle="XP preview — full XP integration coming soon" />
              {loading ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <SkeletonCard lines={2} />
                  <SkeletonCard lines={2} />
                  <SkeletonCard lines={2} />
                </div>
              ) : (
                <BurnAchievements achievements={achievements} />
              )}
            </div>
          </motion.div>
        )}
      </main>
    </>
  );
}
