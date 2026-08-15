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
      <Navbar />
      <main className="mx-auto max-w-2xl px-4 py-6">
        {!mounted ? (
          <SkeletonCard lines={6} />
        ) : !isConnected || !address ? (
          <EmptyState
            icon={Gamepad2}
            title="Connect your wallet"
            description="Connect to play MPGR Run and save your XP, achievements, and personal best."
          />
        ) : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <RunGame address={address} />
          </motion.div>
        )}
      </main>
    </>
  );
}
