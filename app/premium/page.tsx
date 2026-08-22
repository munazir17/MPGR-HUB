"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Crown, ListChecks } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { AchievementCard } from "@/components/ui/AchievementCard";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { PremiumStatusCard } from "@/components/features/premium/PremiumStatusCard";
import { PremiumTierTable } from "@/components/features/premium/PremiumTierTable";
import { PremiumTreasureBox } from "@/components/features/premium/PremiumTreasureBox";
import { usePremium } from "@/hooks/usePremium";

export default function PremiumPage() {
  const [mounted, setMounted] = useState(false);
  const {
    status,
    state,
    achievements,
    quests,
    canOpenBox,
    isConnected,
    loading,
    error,
    lastEvent,
    claimAchievement,
    claimQuest,
    openTreasureBox,
    dismissEvent,
  } = usePremium();

  useEffect(() => setMounted(true), []);

  return (
    <>
      <Navbar />
      <FloatingXP amount={lastEvent?.kind === "quest" ? lastEvent.amount : null} onComplete={dismissEvent} />

      <main className="mx-auto max-w-6xl px-4 py-10">
        {!mounted ? null : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-8">
            <SectionHeader
              title="Premium"
              subtitle="Lock MPGR in Token Lock to unlock Premium tiers, multipliers, and exclusive rewards"
            />

            {!isConnected ? (
              <EmptyState
                icon={Crown}
                title="Connect your wallet"
                description="Connect to view your Premium tier, quests, and Treasure Box."
              />
            ) : loading || !status || !state ? (
              <div className="space-y-4">
                <SkeletonCard lines={3} />
                <SkeletonCard lines={2} />
              </div>
            ) : (
              <>
                <div className="grid gap-4 lg:grid-cols-2">
                  <PremiumStatusCard status={status} />
                  <PremiumTreasureBox
                    state={state}
                    canOpen={canOpenBox}
                    isPremium={status.isPremium}
                    onOpen={openTreasureBox}
                  />
                </div>

                {error && (
                  <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 text-xs text-red-300">
                    {error}
                  </div>
                )}

                <div>
                  <SectionHeader title="Premium Quests" />
                  {!status.isPremium ? (
                    <EmptyState
                      icon={ListChecks}
                      title="Premium required"
                      description="Reach Silver tier to unlock Premium-only quests."
                    />
                  ) : (
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      {quests.map((quest) => (
                        <AchievementCard key={quest.id} achievement={quest} onClaim={() => claimQuest(quest.id)} />
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <SectionHeader title="Premium Achievements" />
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    {achievements.map((achievement) => (
                      <AchievementCard
                        key={achievement.id}
                        achievement={achievement}
                        onClaim={() => claimAchievement(achievement.id)}
                      />
                    ))}
                  </div>
                </div>
              </>
            )}

            <div>
              <SectionHeader title="Tiers" subtitle="Lock more MPGR in Token Lock to move up a tier" />
              <PremiumTierTable currentTier={status?.tier ?? "none"} />
            </div>
          </motion.div>
        )}
      </main>
    </>
  );
}
