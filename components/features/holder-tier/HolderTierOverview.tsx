"use client";

import { motion } from "framer-motion";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { useHolderTier } from "@/lib/useHolderTier";
import { HolderTierCard } from "./HolderTierCard";
import { HolderScoreCard } from "./HolderScoreCard";
import { HolderBenefits } from "./HolderBenefits";

export function HolderTierOverview() {
  const { status, isConnected, loading } = useHolderTier();

  if (!isConnected) {
    return (
      <div>
        <SectionHeader title="Holder Benefits" subtitle="Perks unlocked by holding, staking, and locking MPGR" />
        <HolderBenefits />
      </div>
    );
  }

  if (loading || !status) {
    return (
      <div>
        <SectionHeader title="Holder Tier" subtitle="Your MPGR holder status, score, and perks" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={3} />
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <SectionHeader title="Holder Tier" subtitle="Your MPGR holder status, score, and perks" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <HolderTierCard status={status} />
        <HolderScoreCard status={status} />
      </div>

      <div className="mt-4">
        <HolderBenefits status={status} />
      </div>
    </motion.div>
  );
}
