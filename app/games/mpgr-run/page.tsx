"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Gamepad2 } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { RunGame } from "@/components/features/games/mpgr-run/RunGame";
import { WeeklyGameRewardsPanel } from "@/components/features/games/mpgr-run/WeeklyGameRewardsPanel";

export default function MPGRRunPage() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();

  useEffect(() => setMounted(true), []);

  return (
    <>
      <div className="flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden">
        <Navbar />
        <main className="flex min-h-0 flex-1 flex-col px-2 pb-[5.75rem] pt-1 sm:px-4 sm:pb-4 lg:mx-auto lg:w-full lg:max-w-6xl">
          {!mounted ? (
            <SkeletonCard lines={6} />
          ) : !isConnected || !address ? (
            <EmptyState
              icon={Gamepad2}
              title="Connect your wallet"
              description="Connect to play MPGR Run and save your XP, achievements, and personal best."
            />
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex min-h-0 flex-1 flex-col gap-1"
            >
              <div className="flex min-h-0 flex-1 flex-col">
                <RunGame address={address} />
              </div>
              <WeeklyGameRewardsPanel address={address} />
            </motion.div>
          )}
        </main>
      </div>
    </>
  );
}
