"use client";

import { motion } from "framer-motion";
import { Lock, Unlock, CheckCircle2 } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import type { TokenLockPositionView } from "@/lib/token-lock/token-lock-types";
import { formatCompactNumber } from "@/lib/format";

// Positions arrive already sorted newest-first by lockId (see
// useTokenLock's loadPositions) -- lockId is the contract's own
// monotonically increasing nextLockId counter, so this is exact creation
// order without needing a per-lock timestamp the contract doesn't store.
// No "(early exit)" tag: the contract doesn't distinguish early vs mature
// withdrawals in getLock()'s return value, only in event logs, which this
// view doesn't scan.

const STATUS_LABEL: Record<TokenLockPositionView["status"], string> = {
  locked: "Locked",
  unlocking_soon: "Unlocking Soon",
  unlocked: "Unlocked",
  withdrawn: "Withdrawn",
};

const STATUS_ICON: Record<TokenLockPositionView["status"], typeof Lock> = {
  locked: Lock,
  unlocking_soon: Lock,
  unlocked: Unlock,
  withdrawn: CheckCircle2,
};

interface LockHistoryTimelineProps {
  positions: TokenLockPositionView[];
  limit?: number;
}

export function LockHistoryTimeline({ positions, limit = 12 }: LockHistoryTimelineProps) {
  const items = positions.slice(0, limit);

  return (
    <div className="space-y-2">
      {items.map((position, i) => {
        const Icon = STATUS_ICON[position.status];
        return (
          <motion.div
            key={position.id.toString()}
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
                  {formatCompactNumber(position.amountFormatted)} MPGR · Lock #{position.id.toString()}
                </p>
                <p className="text-[11px] text-muted">
                  Unlocks {new Date(Number(position.unlockTime) * 1000).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </p>
              </div>
              <span className="shrink-0 text-[11px] font-semibold text-gold">{STATUS_LABEL[position.status]}</span>
            </GlassCard>
          </motion.div>
        );
      })}
    </div>
  );
}
