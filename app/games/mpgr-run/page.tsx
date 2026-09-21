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
    // The game IS the first viewport: a full 100dvh play surface with
    // only a minimal brand/wallet strip above it — no Navbar, no bottom
    // tab bar (this route is in BottomNav's IMMERSIVE_ROUTES list), no
    // panels stealing playable height. -mb-20 cancels the bottom padding
    // <body> reserves globally for the mobile bottom nav so the game
    // genuinely fills the phone screen.
    //
    // "Weekly Game Rewards" lives BELOW that viewport now — the player
    // gets the full game first and scrolls down for rewards info after.
    // The page scrolls normally; the game section itself stays a fixed
    // 100dvh stage so the canvas can size itself to the real viewport
    // (and scale the world up on desktop — see run-render.ts).
    <div className="-mb-20 sm:mb-0">
      <section className="relative flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden">
        <div
          className="flex shrink-0 items-center justify-between gap-2 px-2 sm:px-4"
          style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
        >
          <BrandMark />
          <ConnectButton showBalance={false} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 pt-1 sm:px-4 sm:pb-4">
          {!mounted ? (
            <div className="flex min-h-0 flex-1 flex-col justify-center">
              <SkeletonCard lines={6} />
            </div>
          ) : !isConnected || !address ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
              <EmptyState
                icon={Gamepad2}
                title="Connect your wallet"
                description="Connect to play MPGR Run and save your XP, achievements, and personal best."
              />
            </div>
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <RunGame address={address} />
            </motion.div>
          )}
        </div>
      </section>

      {/* Below the gameplay viewport — secondary info the player scrolls
          to after/around the game. */}
      <section
        aria-label="Weekly game rewards"
        className="mx-auto w-full max-w-6xl px-4 pb-10 pt-6 sm:px-6 lg:px-8"
      >
        {mounted && isConnected && address ? (
          <WeeklyGameRewardsPanel address={address} />
        ) : null}
      </section>
    </div>
  );
}
