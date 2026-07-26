"use client";

import { motion } from "framer-motion";
import { Lock, Unlock, CheckCircle2, Zap } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import type { TokenLockPositionView } from "@/lib/token-lock-engine";
import { formatCompactNumber, formatRelativeTime } from "@/lib/format";

const STATUS_LABEL: Record<TokenLockPositionView["status"], string> = {
  locked: "Locked",
  unlocking_soon: "Unlocking Soon",
  unlocked: "Unlocked",
  released: "Released",
};

const STATUS_ICON: Record<TokenLockPositionView["status"], typeof Lock> = {
  locked: Lock,
  unlocking_soon: Lock,
  unlocked: Unlock,
  released: CheckCircle2,
};

interface LockHistoryTimelineProps {
  positions: TokenLockPositionView[];
  limit?: number;
}

export function LockHistoryTimeline({ positions, limit = 12 }: LockHistoryTimelineProps) {
  // Newest first — positions are already sorted by lockedAt desc upstream.
  const items = positions.slice(0, limit);

  return (
    <div className="space-y-2">
      {items.map((position, i) => {
        const Icon = position.wasEarlyUnlock ? Zap : STATUS_ICON[position.status];
        return (
          <motion.div
            key={position.id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(i, 8) * 0.03 }}
          >
            <GlassCard className="flex items-center gap-3 p-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white">
                  {formatCompactNumber(position.amount)} MPGR · {position.lockPeriodDays}-day lock
                  {position.wasEarlyUnlock ? " (early exit)" : ""}
                </p>
                <p className="text-[11px] text-muted">{formatRelativeTime(position.lockedAt)}</p>
              </div>
              <span className="shrink-0 text-[11px] font-semibold text-gold">
                {STATUS_LABEL[position.status]}
              </span>
            </motion.div>
          </motion.div>
        );
      })}
    </div>
  );
}
