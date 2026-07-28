"use client";

import { motion } from "framer-motion";
import { Wallet, Coins, Lock as LockIcon, Landmark, Users, Layers } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { formatCompactNumber } from "@/lib/format";
import type { HolderTierStatus } from "@/lib/holder-tier-engine";

interface HolderScoreCardProps {
  status: HolderTierStatus;
}

export function HolderScoreCard({ status }: HolderScoreCardProps) {
  const { score, votingWeight, communityReputationScore } = status;

  const rows: { label: string; value: number; icon: typeof Wallet; accent?: "gold" }[] = [
    { label: "Wallet Balance", value: score.walletBalance, icon: Wallet },
    { label: "Staking Bonus", value: score.stakedBalance, icon: Coins },
    { label: "Locked Balance", value: score.lockedBalance, icon: LockIcon },
    { label: "Total Holder Score", value: score.totalScore, icon: Layers, accent: "gold" },
  ];

  return (
    <GlassCard className="p-5 sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <Layers className="h-4 w-4 text-primary" aria-hidden="true" />
        <p className="text-sm font-semibold text-white">Holder Score Breakdown</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {rows.map((row, i) => {
          const Icon = row.icon;
          const isGold = row.accent === "gold";
          return (
            <motion.div
              key={row.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05, duration: 0.3 }}
              className="rounded-xl border border-white/10 bg-white/[0.02] p-3"
            >
              <div className="flex items-center gap-1.5">
                <Icon className={isGold ? "h-3.5 w-3.5 text-gold" : "h-3.5 w-3.5 text-primary"} aria-hidden="true" />
                <p className="text-[10px] text-muted">{row.label}</p>
              </div>
              <AnimatedNumber
                value={row.value}
                className={isGold ? "mt-1 block text-sm font-semibold text-gold" : "mt-1 block text-sm font-semibold text-white"}
              />
            </motion.div>
          );
        })}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <Landmark className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[10px] text-muted">Voting Weight</p>
            <p className="text-sm font-semibold text-white">{formatCompactNumber(votingWeight)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <Users className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[10px] text-muted">Reputation Score</p>
            <p className="text-sm font-semibold text-white">{formatCompactNumber(communityReputationScore)}</p>
          </div>
        </div>
      </div>
    </GlassCard>
  );
}
