"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Gamepad2, Award, Flame, Star, Trophy } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { StatCard } from "@/components/ui/StatCard";
import { AchievementCard } from "@/components/ui/AchievementCard";
import { FloatingXP } from "@/components/ui/FloatingXP";
import { LevelUpModal } from "@/components/ui/LevelUpModal";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { GameCard } from "@/components/features/games/GameCard";
import { FeaturedGameBanner } from "@/components/features/games/FeaturedGameBanner";
import { useXP } from "@/hooks/useXP";
import { getLevelProgress, getAchievements, getSeasonPoints } from "@/lib/xp-engine";
import { GAME_REGISTRY, getFeaturedGame } from "@/lib/games/game-registry";
import { getGameStats } from "@/lib/games/game-storage";
import { toGameAchievementStats } from "@/lib/games/mpgr-run/run-rewards";
import { MPGR_RUN_GAME_ID } from "@/lib/games/mpgr-run/run-config";
import { formatCompactNumber } from "@/lib/format";

export default function GamesPage() {
  const [mounted, setMounted] = useState(false);
  const { record, claim, isConnected, lastEvent, leveledUp, dismissEvent, dismissLevelUp } = useXP();

  useEffect(() => setMounted(true), []);

  const levelInfo = record ? getLevelProgress(record.xp) : null;
  const seasonPoints = record ? getSeasonPoints(record) : 0;
  const gameStats = record ? getGameStats(MPGR_RUN_GAME_ID, record.address) : null;
  const gameAchievementStats = gameStats ? toGameAchievementStats(gameStats) : undefined;
  const achievements = record ? getAchievements(record, gameAchievementStats) : [];
  const featuredGame = getFeaturedGame();

  return (
    <>
      <Navbar />
      <FloatingXP amount={lastEvent?.amount ?? null} onComplete={dismissEvent} />
      <LevelUpModal level={leveledUp} onClose={dismissLevelUp} />

      <main className="mx-auto max-w-6xl px-4 py-10">
        {!mounted ? null : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-8">
            <SectionHeader
              title="🎮 MPGR HUB Games"
              subtitle="Play, earn XP and Season Points, and unlock achievements across the arcade"
            />

            {!isConnected && (
              <EmptyState
                icon={Gamepad2}
                title="Connect your wallet"
                description="Connect to save your level, achievements, and leaderboard rank while you play."
              />
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Level" value={String(levelInfo?.level ?? 1)} icon={Star} />
              <StatCard label="XP" value={formatCompactNumber(record?.xp ?? 0)} icon={Trophy} accent="gold" />
              <StatCard label="Season Points" value={formatCompactNumber(seasonPoints)} icon={Award} accent="gold" />
              <StatCard label="Streak" value={`${record?.streak ?? 0}d`} icon={Flame} />
            </div>

            <div>
              <SectionHeader title="Featured Game" />
              <FeaturedGameBanner game={featuredGame} bestScore={gameStats?.bestScore} />
            </div>

            <div>
              <SectionHeader title="All Games" subtitle="MPGR Run is live — the rest of the roadmap is on the way" />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {GAME_REGISTRY.map((game) => (
                  <GameCard
                    key={game.id}
                    game={game}
                    bestScore={game.id === MPGR_RUN_GAME_ID ? gameStats?.bestScore : undefined}
                  />
                ))}
              </div>
            </div>

            <div>
              <SectionHeader title="Achievements" />
              {achievements.length === 0 ? (
                <EmptyState icon={Award} title="No achievements yet" description="Start earning XP to unlock achievements." />
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
          </motion.div>
        )}
      </main>
    </>
  );
}
