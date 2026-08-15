"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import {
  Gamepad2,
  Sparkles,
  Trophy,
  Zap,
} from "lucide-react";

import { Navbar } from "@/components/Navbar";
import { GlassCard } from "@/components/ui/GlassCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatCard } from "@/components/ui/StatCard";
import { AchievementCard } from "@/components/features/achievements/AchievementCard";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { FeaturedGameBanner } from "@/components/features/games/FeaturedGameBanner";
import { GameCard } from "@/components/features/games/GameCard";

import {
  GAME_REGISTRY,
  getFeaturedGame,
  getGameStats,
  getUserRecord,
  getAchievements,
} from "@/lib/games";

import { useXP } from "@/hooks/useXP";

export default function GamesPage() {
  const [mounted, setMounted] = useState(false);

  const { address, isConnected } = useAccount();

  const {
    xp,
    level,
    seasonPoints,
  } = useXP(address);

  useEffect(() => {
    setMounted(true);
  }, []);

  const featuredGame = getFeaturedGame();

  const memoryStats = useMemo(() => {
    if (!address) return null;

    return getGameStats("memory-challenge", address);
  }, [address]);

  const mpgrRunStats = useMemo(() => {
    if (!address) return null;

    return getGameStats("mpgr-run", address);
  }, [address]);

  const achievements = useMemo(() => {
    if (!address) return [];

    const userRecord = getUserRecord(address);

    return getAchievements(userRecord, {
      totalRuns: mpgrRunStats?.totalRuns ?? 0,
      bestDistance: mpgrRunStats?.bestDistance ?? 0,
      noCollisionRuns: mpgrRunStats?.noCollisionRuns ?? 0,
      totalCoinsCollected: mpgrRunStats?.totalCoinsCollected ?? 0,
    });
  }, [address, mpgrRunStats]);

  const unlockedAchievements = achievements.filter(
    (achievement) => achievement.unlocked
  );

  if (!mounted) {
    return (
      <>
        <Navbar />

        <main className="mx-auto max-w-6xl px-4 py-6">
          <SkeletonCard lines={8} />
        </main>
      </>
    );
  }

  if (!isConnected || !address) {
    return (
      <>
        <Navbar />

        <main className="mx-auto max-w-6xl px-4 py-8">
          <EmptyState
            icon={Gamepad2}
            title="Connect your wallet"
            description="Connect your wallet to play MPGR HUB games and track your XP, Season Points, achievements, and personal bests."
          />
        </main>
      </>
    );
  }

  return (
    <>
      <Navbar />

      <main className="mx-auto max-w-6xl px-4 py-6 pb-24">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6"
        >
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Gamepad2 className="h-5 w-5" />
            </div>

            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">
                MPGR Games
              </h1>

              <p className="text-sm text-muted-foreground">
                Play. Compete. Level up.
              </p>
            </div>
          </div>
        </motion.div>

        {/* Player Stats */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4"
        >
          <StatCard
            title="Level"
            value={level}
            icon={Zap}
          />

          <StatCard
            title="XP"
            value={xp}
            icon={Sparkles}
          />

          <StatCard
            title="Season Points"
            value={seasonPoints}
            icon={Trophy}
          />

          <StatCard
            title="Achievements"
            value={unlockedAchievements.length}
            icon={Gamepad2}
          />
        </motion.div>

        {/* Featured Game */}
        <section className="mb-8">
          <SectionHeader
            title="Featured Game"
            subtitle="Start your run and chase your personal best."
          />

          <FeaturedGameBanner
            game={featuredGame}
            bestScore={
              featuredGame.id === "mpgr-run"
                ? mpgrRunStats?.bestScore ?? 0
                : 0
            }
          />
        </section>

        {/* Games */}
        <section className="mb-8">
          <SectionHeader
            title="All Games"
            subtitle={`${GAME_REGISTRY.length} games planned for MPGR HUB`}
          />

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {GAME_REGISTRY.map((game) => {
              const bestScore =
                game.id === "mpgr-run"
                  ? mpgrRunStats?.bestScore ?? 0
                  : game.id === "memory-challenge"
                  ? memoryStats?.bestScore ?? 0
                  : 0;

              return (
                <GameCard
                  key={game.id}
                  game={game}
                  bestScore={bestScore}
                />
              );
            })}
          </div>
        </section>

        {/* Achievements */}
        <section>
          <SectionHeader
            title="Game Achievements"
            subtitle="Keep playing to unlock new milestones."
          />

          {achievements.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {achievements.map((achievement) => (
                <AchievementCard
                  key={achievement.id}
                  achievement={achievement}
                />
              ))}
            </div>
          ) : (
            <GlassCard className="p-6 text-center">
              <Trophy className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />

              <p className="text-sm font-medium text-foreground">
                No achievements yet
              </p>

              <p className="mt-1 text-xs text-muted-foreground">
                Start playing to unlock your first achievement.
              </p>
            </GlassCard>
          )}
        </section>
      </main>
    </>
  );
}
