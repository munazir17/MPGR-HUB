"use client";

import { motion } from "framer-motion";
import { ArrowUpCircle, ArrowDownCircle, Coins, Activity, AlertCircle, RotateCw } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import { formatTokenBalance, formatRelativeTime } from "@/lib/format";
import type { StakingLiveActivityEntry, StakingHistoryEvent } from "@/lib/staking/staking-types";

// Phase 3E Part 4 — Staking Activity Timeline.
//
// History (useStakingHistory) is the source of truth for anything it has
// already scanned; a live entry (useStaking's liveActivity) only fills in
// for a brand-new tx history hasn't caught up to yet, keyed by
// `${txHash}:${kind}` so a just-confirmed action never renders twice once
// the history scan catches up to it.

type TimelineKind = "Staked" | "Unstaked" | "RewardPaid";

interface TimelineEntry {
  key: string;
  kind: TimelineKind;
  amount: bigint;
  txHash: string;
  timestampIso: string;
}

const ACTIVITY_LABEL: Record<TimelineKind, string> = {
  Staked: "Staked",
  Unstaked: "Unstaked",
  RewardPaid: "Claimed reward",
};

const ACTIVITY_ICON: Record<TimelineKind, typeof ArrowUpCircle> = {
  Staked: ArrowUpCircle,
  Unstaked: ArrowDownCircle,
  RewardPaid: Coins,
};

function mergeTimeline(history: StakingHistoryEvent[], live: StakingLiveActivityEntry[]): TimelineEntry[] {
  const byKey = new Map<string, TimelineEntry>();

  for (const event of history) {
    byKey.set(`${event.txHash}:${event.kind}`, {
      key: event.id,
      kind: event.kind,
      amount: event.amount,
      txHash: event.txHash,
      timestampIso: event.timestamp,
    });
  }

  for (const entry of live) {
    const dedupeKey = `${entry.txHash}:${entry.kind}`;
    if (byKey.has(dedupeKey)) continue;
    byKey.set(dedupeKey, {
      key: entry.id,
      kind: entry.kind,
      amount: entry.amount,
      txHash: entry.txHash,
      timestampIso: entry.observedAt,
    });
  }

  return [...byKey.values()].sort((a, b) => new Date(b.timestampIso).getTime() - new Date(a.timestampIso).getTime());
}

interface StakingActivityTimelineProps {
  liveActivity: StakingLiveActivityEntry[];
  historyEvents: StakingHistoryEvent[];
  decimals: number;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
}

export function StakingActivityTimeline({
  liveActivity,
  historyEvents,
  decimals,
  isLoading,
  isLoadingMore,
  error,
  hasMore,
  onLoadMore,
  onRetry,
}: StakingActivityTimelineProps) {
  const timeline = mergeTimeline(historyEvents, liveActivity);

  if (isLoading && timeline.length === 0) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <GlassCard key={i} className="flex items-center gap-3 p-3">
            <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-2.5 w-16" />
            </div>
            <Skeleton className="h-4 w-20 shrink-0" />
          </GlassCard>
        ))}
      </div>
    );
  }

  if (error && timeline.length === 0) {
    return (
      <GlassCard className="flex items-center justify-between gap-3 p-4">
        <span className="flex items-center gap-2 text-xs text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </span>
        <button
          onClick={onRetry}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-white/[0.06]"
        >
          <RotateCw className="h-3 w-3" aria-hidden="true" />
          Retry
        </button>
      </GlassCard>
    );
  }

  if (timeline.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No activity yet"
        description="Stake, unstake, or claim rewards and it will show up here."
      />
    );
  }

  return (
    <div className="space-y-2">
      {timeline.map((entry, i) => {
        const Icon = ACTIVITY_ICON[entry.kind];
        return (
          <motion.div
            key={entry.key}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(i, 8) * 0.03 }}
          >
            <a href={`https://basescan.org/tx/${entry.txHash}`} target="_blank" rel="noopener noreferrer" className="block">
              <GlassCard className="flex items-center gap-3 p-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-white">{ACTIVITY_LABEL[entry.kind]}</p>
                  <p className="text-[11px] text-muted">{formatRelativeTime(entry.timestampIso)}</p>
                </div>
                <span className="shrink-0 text-sm font-semibold text-gold">
                  {entry.kind === "Staked" ? "-" : "+"}
                  {formatTokenBalance(entry.amount, decimals)} MPGR
                </span>
              </GlassCard>
            </a>
          </motion.div>
        );
      })}

      {hasMore && (
        <button
          onClick={onLoadMore}
          disabled={isLoadingMore}
          className="w-full rounded-2xl border border-white/[0.06] bg-white/[0.02] py-3 text-xs font-medium text-muted transition-colors hover:bg-white/[0.05] hover:text-white disabled:opacity-50"
        >
          {isLoadingMore ? "Loading..." : "Load more"}
        </button>
      )}
    </div>
  );
}
