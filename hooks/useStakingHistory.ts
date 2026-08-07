// hooks/useStakingHistory.ts

"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { stakingHistoryService } from "@/lib/staking/staking-history-service";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { MPGR_STAKING_CONFIG } from "@/lib/staking/staking-config";
import type { StakingHistoryEvent } from "@/lib/staking/staking-types";

// Phase 3E Part 4 — useStakingHistory Hook.
//
// On-chain Staked/Unstaked/RewardPaid history for the connected wallet,
// mirroring hooks/useMPGRTransactionHistory.ts's shape: loads the first
// page on mount/address change, exposes loadMore for pagination, and
// refreshes automatically off the existing "staking_changed" event
// (already emitted by refreshManager.refreshStaking after every
// confirmed staking action — see hooks/useStaking.ts's runAction)
// instead of introducing a second event or a separate poll.

interface UseStakingHistoryReturn {
  events: StakingHistoryEvent[];
  isLoading: boolean;
  isRefreshing: boolean;
  isLoadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  totalRewardsClaimedRaw: bigint;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

export function useStakingHistory(): UseStakingHistoryReturn {
  const { address, isConnected } = useAccount();
  const [events, setEvents] = useState<StakingHistoryEvent[]>([]);
  const [pageSize, setPageSize] = useState<number>(MPGR_STAKING_CONFIG.historyPageSize);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (limit: number, forceRefresh: boolean) => {
      if (!address) return;
      try {
        const result = await stakingHistoryService.getHistory(address, { limit, forceRefresh });
        setEvents(result);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load staking history");
      }
    },
    [address]
  );

  // Load first page on connect / address change.
  useEffect(() => {
    if (!isConnected || !address) {
      setEvents([]);
      setError(null);
      setPageSize(MPGR_STAKING_CONFIG.historyPageSize);
      return;
    }

    setIsLoading(true);
    setPageSize(MPGR_STAKING_CONFIG.historyPageSize);
    load(MPGR_STAKING_CONFIG.historyPageSize, false).finally(() => setIsLoading(false));
  }, [address, isConnected, load]);

  // Reuses the existing "staking_changed" event so a freshly-confirmed
  // approve/stake/unstake/claim/exit shows up here without polling.
  useEffect(() => {
    const unsubscribe = agentEventBus.on("staking_changed", (payload) => {
      if (!address || payload.address !== address) return;
      void load(pageSize, true);
    });
    return unsubscribe;
  }, [address, pageSize, load]);

  // Manual refresh — bypasses cache TTL to force a fresh chain check.
  const refresh = useCallback(async () => {
    if (!address) return;
    setIsRefreshing(true);
    try {
      await load(pageSize, true);
    } finally {
      setIsRefreshing(false);
    }
  }, [address, pageSize, load]);

  // Pagination — widens the requested page size and re-reads from cache.
  const loadMore = useCallback(async () => {
    if (!address) return;
    const nextPageSize = pageSize + MPGR_STAKING_CONFIG.historyPageSize;
    setIsLoadingMore(true);
    try {
      await load(nextPageSize, false);
      setPageSize(nextPageSize);
    } finally {
      setIsLoadingMore(false);
    }
  }, [address, pageSize, load]);

  const cachedAll = address ? stakingHistoryService.getCachedHistory(address) : null;
  const hasMore = cachedAll ? cachedAll.length > events.length : events.length >= pageSize;

  // Real sum over every RewardPaid event currently cached for this
  // wallet (the full cache, not just the paginated `events` slice) —
  // reads straight from the same cache the events themselves came from,
  // never recomputed or estimated.
  const totalRewardsClaimedRaw = (cachedAll ?? events)
    .filter((event) => event.kind === "RewardPaid")
    .reduce((sum, event) => sum + event.amount, 0n);

  return {
    events,
    isLoading,
    isRefreshing,
    isLoadingMore,
    error,
    hasMore,
    totalRewardsClaimedRaw,
    refresh,
    loadMore,
  };
}
