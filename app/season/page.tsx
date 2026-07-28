"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Crown } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { SeasonPassHeader } from "@/components/features/season-pass/SeasonPassHeader";
import { SeasonProgressCard } from "@/components/features/season-pass/SeasonProgressCard";
import { SeasonCountdown } from "@/components/features/season-pass/SeasonCountdown";
import { FreeTrack } from "@/components/features/season-pass/FreeTrack";
import { PremiumTrack } from "@/components/features/season-pass/PremiumTrack";
import { SeasonMissions } from "@/components/features/season-pass/SeasonMissions";
import { useSeasonPass } from "@/hooks/useSeasonPass";

export default function SeasonPassPage() {
  const [mounted, setMounted] = useState(false);
  const {
    status,
    track,
    missions,
    isConnected,
    loading,
    error,
    claimFree,
    claimPremium,
    claimMission,
  } = useSeasonPass();

  useEffect(() => setMounted(true), []);

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        {!mounted || !isConnected ? (
          <EmptyState
            icon={Crown}
            title="Connect your wallet"
            description="Connect to view your Season Pass progress and rewards."
          />
        ) : loading || !status ? (
          <div className="space-y-4">
            <SkeletonCard lines={3} />
            <SkeletonCard lines={2} />
          </div>
        ) : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <SeasonPassHeader seasonNumber={status.seasonNumber} tier={status.premiumTier} />

            <div className="grid gap-4 lg:grid-cols-2">
              <SeasonProgressCard levelProgress={status.levelProgress} seasonPoints={status.seasonPoints} />
              <SeasonCountdown seasonEnd={status.seasonEnd} seasonNumber={status.seasonNumber} />
            </div>

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 text-xs text-red-300">
                {error}
              </div>
            )}

            <div className="space-y-3">
              <FreeTrack track={track} onClaim={claimFree} />
              <PremiumTrack track={track} isPremium={status.isPremium} onClaim={claimPremium} />
            </div>

            <SeasonMissions missions={missions} onClaim={claimMission} />
          </motion.div>
        )}
      </main>
    </>
  );
}
