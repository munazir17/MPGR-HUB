"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Users } from "lucide-react";
import { useAccount } from "wagmi";
import { Navbar } from "@/components/Navbar";
import { LeaderboardRow } from "@/components/ui/LeaderboardRow";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { useXP } from "@/hooks/useXP";
import { getSeasonPoints } from "@/lib/xp-engine";

export default function LeaderboardPage() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { record } = useXP();

  useEffect(() => setMounted(true), []);

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <SectionHeader
            title="Leaderboard"
            subtitle="Global rankings launch once the MPGR HUB backend is live"
          />

          {!mounted ? (
            <div className="space-y-3">
              <SkeletonCard lines={1} />
              <SkeletonCard lines={1} />
              <SkeletonCard lines={1} />
            </div>
          ) : !isConnected || !record ? (
            <EmptyState
              icon={Users}
              title="No rankings yet"
              description="Connect your wallet and start earning XP — global rankings will appear here once the leaderboard backend launches."
            />
          ) : (
            <div className="space-y-2">
              <LeaderboardRow
                rank={1}
                address={address ?? ""}
                xp={record.xp}
                seasonPoints={getSeasonPoints(record)}
                referrals={record.referralCount}
                isCurrentUser
              />
              <p className="mt-4 text-center text-xs text-muted">
                You're the only ranked player right now — invite friends or check back once
                global rankings go live.
              </p>
            </div>
          )}
        </motion.div>
      </main>
    </>
  );
}
