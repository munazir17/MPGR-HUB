"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Gift, Sparkles } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { formatCompactNumber, formatRelativeTime } from "@/lib/format";
import type { PremiumState } from "@/lib/premium-engine";

interface PremiumTreasureBoxProps {
  state: PremiumState;
  canOpen: boolean;
  isPremium: boolean;
  onOpen: () => void;
}

export function PremiumTreasureBox({ state, canOpen, isPremium, onOpen }: PremiumTreasureBoxProps) {
  const { treasureBox } = state;

  return (
    <GlassCard className="relative overflow-hidden p-5">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-12 -top-12 h-44 w-44 rounded-full bg-gradient-gold opacity-20 blur-3xl animate-glow-pulse"
      />

      <div className="relative flex items-center gap-2">
        <Gift className="h-4 w-4 text-gold" aria-hidden="true" />
        <p className="text-sm font-medium text-white">Weekly Premium Treasure Box</p>
      </div>
      <p className="relative mt-1 text-xs text-muted">One free box every week, exclusively for Premium members.</p>

      <button
        onClick={onOpen}
        disabled={!isPremium || !canOpen}
        aria-label={!isPremium ? "Premium required" : canOpen ? "Open this week's box" : "Already opened this week"}
        className="relative mt-4 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-gold text-sm font-semibold text-black shadow-glow-gold transition-transform duration-200 hover:scale-[1.01] active:scale-95 disabled:cursor-not-allowed disabled:bg-none disabled:bg-surface disabled:text-muted disabled:shadow-none"
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        {!isPremium ? "Premium Required" : canOpen ? "Open This Week's Box" : "Already Opened This Week"}
      </button>

      <div className="relative mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <p className="text-[10px] text-muted">Lifetime Boxes</p>
          <p className="mt-1 text-sm font-semibold text-white">{treasureBox.claimsCount}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <p className="text-[10px] text-muted">Lifetime MPGR</p>
          <p className="mt-1 text-sm font-semibold text-gold">{formatCompactNumber(treasureBox.totalClaimed)}</p>
        </div>
      </div>

      {treasureBox.history.length > 0 && (
        <div className="relative mt-4 space-y-2">
          <AnimatePresence initial={false}>
            {treasureBox.history.slice(0, 5).map((entry, i) => (
              <motion.div
                key={`${entry.weekKey}-${i}`}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs"
              >
                <span className="text-muted">{formatRelativeTime(entry.timestamp)}</span>
                <span className="font-semibold text-gold">+{formatCompactNumber(entry.amount)} MPGR</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </GlassCard>
  );
}
