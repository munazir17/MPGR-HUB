"use client";

import { motion } from "framer-motion";
import { Gift, History, AlertCircle, RotateCw } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import { formatTokenBalance, formatRelativeTime } from "@/lib/format";
import type { RewardClaimHistoryEntry } from "@/lib/rewards/reward-types";

// Phase 3F Part 1 — Reward Claim History List.
//
// Covers "Claim History" from the Phase 3F Part 1 feature list. Renders
// RewardHubSummary's merged, cross-category claim feed (from
// reward-service.ts / hooks/useRewardHub.ts) — every entry already
// carries its own category label via `title`, set by whichever provider
// produced it, so this component stays category-agnostic and needs no
// changes when a future category's provider starts contributing entries.
// Loading/error/empty states mirror components/ui/StakingActivityTimeline.tsx.

const MPGR_DECIMALS = 18;

interface RewardClaimHistoryListProps {
  entries: RewardClaimHistoryEntry[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
}

export function RewardClaimHistoryList({
  entries,
  isLoading,
  isLoadingMore,
  error,
  hasMore,
  onLoadMore,
  onRetry,
}: RewardClaimHistoryListProps) {
  if (isLoading && entries.length === 0) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <GlassCard key={i} className="flex items-center gap-3 p-3">
            <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-2.5 w-16" />
            </div>
            <Skeleton className="h-4 w-20 shrink-0" />
          </GlassCard>
        ))}
      </div>
    );
  }

  if (error && entries.length === 0) {
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

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="No claims yet"
        description="Claim a reward from any active category and it will show up here."
      />
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((entry, i) => (
        <motion.div
          key={entry.id}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: Math.min(i, 8) * 0.03 }}
        >
          <GlassCard className="flex items-center gap-3 p-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold/10">
              <Gift className="h-4 w-4 text-gold" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-white">{entry.title}</p>
              <p className="text-[11px] text-muted">{formatRelativeTime(entry.timestamp)}</p>
            </div>
            <span className="shrink-0 text-sm font-semibold text-gold">
              +{formatTokenBalance(entry.amountRaw, MPGR_DECIMALS)} MPGR
            </span>
          </GlassCard>
        </motion.div>
      ))}

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
