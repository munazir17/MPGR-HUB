"use client";

import { motion } from "framer-motion";
import { CheckCircle2, Clock, Flame, XCircle } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { formatAddress, formatCompactNumber, formatRelativeTime } from "@/lib/format";
import type { BurnTransaction } from "@/lib/burn-types";

interface BurnHistoryItemProps {
  transaction: BurnTransaction;
  delay?: number;
}

const STATUS_ICON = {
  confirmed: CheckCircle2,
  pending: Clock,
  failed: XCircle,
} as const;

const STATUS_COLOR = {
  confirmed: "text-gold",
  pending: "text-primary",
  failed: "text-red-400",
} as const;

export function BurnHistoryItem({ transaction, delay = 0 }: BurnHistoryItemProps) {
  const StatusIcon = STATUS_ICON[transaction.status];

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay }}
      className="relative"
    >
      <span
        aria-hidden="true"
        className="absolute -left-4 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-gold shadow-glow-gold ring-4 ring-background"
      />
      <GlassCard className="flex items-center gap-3 p-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold/10">
          <Flame className="h-4 w-4 text-gold" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-white">{formatAddress(transaction.address)}</p>
          <p className="flex items-center gap-1 text-[11px] text-muted">
            <StatusIcon className={`h-3 w-3 ${STATUS_COLOR[transaction.status]}`} aria-hidden="true" />
            {formatRelativeTime(transaction.timestamp)}
          </p>
        </div>
        <span className="shrink-0 text-sm font-semibold text-gold">
          -{formatCompactNumber(transaction.amount)} MPGR
        </span>
      </GlassCard>
    </motion.div>
  );
}
