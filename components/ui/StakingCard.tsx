"use client";

import { motion } from "framer-motion";
import { PiggyBank, TrendingUp } from "lucide-react";
import { GlassCard } from "./GlassCard";
import type { LockOption } from "@/lib/staking-engine";
import { formatCompactNumber } from "@/lib/format";

interface StakingCardProps {
  availableBalance: number;
  lockOptions: LockOption[];
  onStake: () => void;
  loading?: boolean;
}

export function StakingCard({ availableBalance, lockOptions, onStake, loading }: StakingCardProps) {
  const bestApy = lockOptions.reduce((max, o) => Math.max(max, o.apy), 0);
  const canStake = !loading && availableBalance > 0;

  return (
    <GlassCard className="relative overflow-hidden p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gradient-premium opacity-20 blur-3xl"
      />

      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold/10">
              <PiggyBank className="h-4 w-4 text-gold" aria-hidden="true" />
            </div>
            <p className="text-sm font-semibold text-white">Stake MPGR</p>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Lock your claimed MPGR to earn up to{" "}
            <span className="font-semibold text-gold">{bestApy}% APY</span>. Longer terms earn
            higher rates.
          </p>
          <p className="mt-3 text-xs text-muted">
            Available to stake:{" "}
            <span className="font-semibold text-white">
              {formatCompactNumber(availableBalance)} MPGR
            </span>
          </p>
        </div>

        <motion.button
          onClick={onStake}
          disabled={!canStake}
          whileHover={canStake ? { scale: 1.03 } : undefined}
          whileTap={canStake ? { scale: 0.97 } : undefined}
          aria-label="Open stake MPGR dialog"
          className="flex min-h-[44px] w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-gold px-5 py-2.5 text-sm font-semibold text-background transition-colors disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted sm:w-auto"
        >
          Stake Now
        </motion.button>
      </div>

      <div className="relative mt-5 flex flex-wrap gap-2">
        {lockOptions.map((option) => (
          <span
            key={option.days}
            className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] text-muted"
          >
            <TrendingUp className="h-3 w-3 text-gold" aria-hidden="true" />
            {option.label}
            <span className="font-semibold text-white">{option.apy}%</span>
          </span>
        ))}
      </div>
    </GlassCard>
  );
}
