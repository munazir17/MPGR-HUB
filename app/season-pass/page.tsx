"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Crown } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SeasonPassHeader } from "@/components/features/season-pass/SeasonPassHeader";
import { SeasonProgressCard } from "@/components/features/season-pass/SeasonProgressCard";
import { SeasonCountdown } from "@/components/features/season-pass/SeasonCountdown";
import { FreeTrack } from "@/components/features/season-pass/FreeTrack";
import { PremiumTrack } from "@/components/features/season-pass/PremiumTrack";
import { SeasonMissions } from "@/components/features/season-pass/SeasonMissions";
import { useSeasonPass } from "@/hooks/useSeasonPass";
import { getSeasonEnd, getSeasonNumber } from "@/lib/xp-engine";

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

  // Public/static season info — safe to show without a wallet connected.
  // Falls back to these whenever `status` (wallet-derived) isn't available.
  const publicSeasonNumber = getSeasonNumber();
  const publicSeasonEnd = getSeasonEnd();

  const seasonNumber = status?.seasonNumber ?? publicSeasonNumber;
  const seasonEnd = status?.seasonEnd ?? publicSeasonEnd;

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        {!mounted ? null : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <SectionHeader
              title="Season Pass"
              subtitle="Earn Season Points to climb the Free and Premium reward tracks"
            />

            {/* Static header — always renders, wallet or not */}
            <SeasonPassHeader seasonNumber={seasonNumber} tier={status?.premiumTier ?? "none"} />

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 text-xs text-red-300">
                {error}
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              {!isConnected ? (
                <EmptyState
                  icon={Crown}
                  title="Connect your wallet"
                  description="Connect to view your Season Pass progress and rewards."
                />
              ) : loading || !status ? (
                <SkeletonCard lines={3} />
              ) : (
                <SeasonProgressCard levelProgress={status.levelProgress} seasonPoints={status.seasonPoints} />
              )}

              {/* Countdown is public/static — always renders */}
              <SeasonCountdown seasonEnd={seasonEnd} seasonNumber={seasonNumber} />
            </div>

            {!isConnected ? (
              <EmptyState
                icon={Crown}
                title="Connect your wallet to view reward tracks"
                description="Free and Premium track rewards are tied to your wallet's Season Points — connect to see and claim yours."
              />
            ) : loading || !status ? (
              <div className="space-y-4">
                <SkeletonCard lines={3} />
                <SkeletonCard lines={2} />
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  <FreeTrack track={track} onClaim={claimFree} />
                  <PremiumTrack track={track} isPremium={status.isPremium} onClaim={claimPremium} />
                </div>

                <SeasonMissions missions={missions} onClaim={claimMission} />
              </>
            )}
          </motion.div>
        )}
      </main>
    </>
  );
}
