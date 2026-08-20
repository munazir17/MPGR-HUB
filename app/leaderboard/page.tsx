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
import { usePremium } from "@/hooks/usePremium";
import { useLeaderboard } from "@/hooks/useLeaderboard";

// Bug fix — global leaderboard.
//
// Previously this page only ever rendered a single hardcoded row for
// the currently connected wallet (rank 1, always) — it never fetched
// anyone else's data, because there was no shared backend for it to
// read from. It now reads from /api/leaderboard, which is backed by a
// real, server-side, Redis-stored ranking (lib/leaderboard/leaderboard
// -store.ts) that every wallet writes to and reads from — so wallet A
// can see wallet B, C, D, etc. The connected wallet is only ever
// highlighted as "you", never treated as the whole leaderboard.
//
// UI/markup is unchanged: same Navbar, SectionHeader, SkeletonCard,
// EmptyState, and LeaderboardRow components as before.

export default function LeaderboardPage() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();
  const { status: premiumStatus } = usePremium();
  const { top, me, loading, error } = useLeaderboard();

  useEffect(() => setMounted(true), []);

  const showSkeleton = !mounted || loading;
  const meInTop = me ? top.some((entry) => entry.wallet === me.wallet) : false;

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <SectionHeader
            title="Leaderboard"
            subtitle="Global rankings across every MPGR HUB wallet"
          />

          {showSkeleton ? (
            <div className="space-y-3">
              <SkeletonCard lines={1} />
              <SkeletonCard lines={1} />
              <SkeletonCard lines={1} />
            </div>
          ) : error ? (
            <EmptyState
              icon={Users}
              title="Couldn't load the leaderboard"
              description="Something went wrong reaching the leaderboard. Please try again shortly."
            />
          ) : top.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No rankings yet"
              description="Connect your wallet and start earning XP — you could be the first name on the global leaderboard."
            />
          ) : (
            <div className="space-y-2">
              {top.map((entry) => {
                const isCurrentUser =
                  isConnected && !!address && entry.wallet === address.toLowerCase();
                return (
                  <LeaderboardRow
                    key={entry.wallet}
                    rank={entry.rank}
                    address={entry.wallet}
                    xp={entry.xp}
                    seasonPoints={entry.seasonPoints}
                    referrals={entry.referrals}
                    tier={isCurrentUser ? premiumStatus?.tier : undefined}
                    isCurrentUser={isCurrentUser}
                  />
                );
              })}

              {me && !meInTop && (
                <>
                  <p className="pt-2 text-center text-[11px] uppercase tracking-wide text-muted">
                    Your rank
                  </p>
                  <LeaderboardRow
                    rank={me.rank}
                    address={me.wallet}
                    xp={me.xp}
                    seasonPoints={me.seasonPoints}
                    referrals={me.referrals}
                    tier={premiumStatus?.tier}
                    isCurrentUser
                  />
                </>
              )}

              {isConnected && !me && (
                <p className="mt-4 text-center text-xs text-muted">
                  You're not ranked yet — earn XP to join the global leaderboard.
                </p>
              )}
            </div>
          )}
        </motion.div>
      </main>
    </>
  );
}
