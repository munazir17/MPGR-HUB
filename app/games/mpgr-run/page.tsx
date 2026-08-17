"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { Gamepad2 } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { RunGame } from "@/components/features/games/mpgr-run/RunGame";

export default function MPGRRunPage() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected } = useAccount();

  useEffect(() => setMounted(true), []);

  return (
    <>
      {/*
        Mobile UX (below sm/640px only): pin the page to exactly the
        viewport height left after the sticky Navbar and the fixed
        BottomNav (5rem = BottomNav's own height + safe-area), so the
        game viewport below can flex-grow to fill nearly the entire
        screen instead of sitting in a small vh-capped card inside a
        centered, padded page. At sm (640px) and up this reverts to the
        original desktop layout — mx-auto max-w-2xl px-4 py-6, natural
        height, page-level scroll — nothing about desktop changes. Same
        pattern already used by app/agent/page.tsx.
      */}
      <div className="flex min-h-[calc(100dvh-5rem)] flex-col sm:min-h-[100dvh] sm:block sm:min-h-0">
        <Navbar />
        <main className="flex flex-1 min-h-0 flex-col px-3 pb-2 pt-2 sm:mx-auto sm:block sm:max-w-2xl sm:flex-none sm:px-4 sm:py-6">
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
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex min-h-0 flex-1 flex-col sm:block sm:flex-none"
            >
              <RunGame address={address} />
            </motion.div>
          )}
        </main>
      </div>
    </>
  );
}
