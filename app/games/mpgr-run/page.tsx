"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Gamepad2 } from "lucide-react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { RunGame } from "@/components/features/games/mpgr-run/RunGame";
import { WeeklyGameRewardsPanel } from "@/components/features/games/mpgr-run/WeeklyGameRewardsPanel";
import { BrandMark } from "@/components/brand/BrandMark";

export default function MPGRRunPage() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();

  useEffect(() => setMounted(true), []);

  return (
    // The full site chrome (Navbar's ~9-link nav row + BottomNav's 5 tabs,
    // see components/BottomNav.tsx) is intentionally NOT rendered on this
    // page — the game should be the primary viewport element, not a small
    // card squeezed between a full desktop-sized header and a mobile tab
    // bar. -mb-20 cancels out the bottom padding <body> reserves globally
    // for BottomNav (app/layout.tsx), so the game genuinely fills 100dvh
    // on mobile instead of leaving that reserved strip as dead space below
    // the fold.
    <div className="-mb-20 flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden sm:mb-0">
      <div
        className="flex shrink-0 items-center justify-between gap-2 px-2 sm:px-4"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <BrandMark />
        <ConnectButton showBalance={false} />
      </div>
      <main className="flex min-h-0 flex-1 flex-col px-2 pb-2 pt-1 sm:px-4 sm:pb-4">
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
  );
}
