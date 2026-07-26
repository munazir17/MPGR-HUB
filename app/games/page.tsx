"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Gamepad2, Award, Sparkles } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { AchievementCard } from "@/components/ui/AchievementCard";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { LevelUpModal } from "@/components/ui/LevelUpModal";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { useXP } from "@/hooks/useXP";
import { getLevelProgress, getAchievements } from "@/lib/xp-engine";

export default function GamesPage() {
  const [mounted, setMounted] = useState(false);
  const { record, claim, isConnected, lastEvent, leveledUp, dismissEvent, dismissLevelUp } = useXP();

  useEffect(() => setMounted(true), []);

  const levelInfo = record ? getLevelProgress(record.xp) : null;
  const achievements = record ? getAchievements(record) : [];

  return (
    <>
      <Navbar />
      <FloatingXP amount={lastEvent?.amount ?? null} onComplete={dismissEvent} />
      <LevelUpModal level={leveledUp} onClose={dismissLevelUp} />

      <main className="mx-auto max-w-6xl px-4 py-10">
        {!mounted || !isConnected ? (
          <EmptyState
            icon={Gamepad2}
            title="Connect your wallet"
            description="Connect to track your level, achievements, and games progress."
          />
        ) : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <SectionHeader
              title="Games"
              subtitle="Level up, unlock achievements, and earn XP across MPGR HUB"
            />

            {levelInfo && (
              <GlassCard className="p-5">
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

            <SectionHeader title="More Games" />
            <GlassCard className="flex flex-col items-center gap-3 p-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Sparkles className="h-6 w-6 text-primary" aria-hidden="true" />
              </div>
              <p className="text-sm font-medium text-white">More games coming soon</p>
              <p className="max-w-xs text-xs text-muted">
                New ways to earn XP and MPGR are on the way. Keep checking in and leveling up in the meantime.
              </p>
            </GlassCard>
          </motion.div>
        )}
      </main>
    </>
  );
}
